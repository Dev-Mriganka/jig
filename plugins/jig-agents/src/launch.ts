// How a child Pi is started: its command line, its environment and the model it runs. Everything is built from fixed parts and the
// configuration. Nothing in an agent file, a tool call or the project reaches the command line as a flag.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseModel, THINKING_LEVELS } from "./config.ts";
import type { AgentsSettings } from "./config.ts";
import type { Role } from "./roles.ts";

/** Flags that would give a child fewer extensions than its parent, or trust more of the project. A test checks they never appear. */
export const NEVER_PASSED: readonly string[] = ["--no-extensions", "-ne", "-e", "--extension", "--approve", "-a"];

/** A start that is refused, with the reason the parent agent reads. */
export class StartError extends Error {}

export interface ModelChoice {
    /** `provider/id`. */
    model: string;
    thinking?: string;
    source: "role" | "parent";
}

/** The parent's own model, passed to a child whose role has no model of its own. */
export interface ParentModel {
    provider: string;
    id: string;
    thinking?: string;
}

/** `enabledModels` from Pi's global settings.json, or undefined when the file or the setting is absent (then any model Pi knows is allowed). */
export function readEnabledModels(agentDir: string): string[] | undefined {
    let text: string;
    try {
        text = readFileSync(path.join(agentDir, "settings.json"), "utf8");
    } catch {
        return undefined;
    }
    let settings: unknown;
    try {
        settings = JSON.parse(text);
    } catch {
        throw new StartError(`Pi's settings.json in ${agentDir} cannot be read, so the models it allows are not known`);
    }
    const list = (settings as { enabledModels?: unknown } | null)?.enabledModels;
    if (list === undefined) return undefined;
    if (!Array.isArray(list))
        throw new StartError("Pi's settings.json: enabledModels must be a list of model patterns");
    return list.filter((entry): entry is string => typeof entry === "string");
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

/** Whether an `enabledModels` pattern allows a model: a glob over `provider/id` or `id`, or, with no wildcard, a part of the name. */
export function patternAllows(pattern: string, provider: string, id: string): boolean {
    let text = pattern;
    const colon = text.lastIndexOf(":");
    if (colon > 0 && THINKING_LEVELS.includes(text.slice(colon + 1))) text = text.slice(0, colon);
    const full = `${provider}/${id}`;
    if (/[*?]/.test(text)) {
        const expression = globToRegExp(text);
        return expression.test(full) || expression.test(id);
    }
    const lower = text.toLowerCase();
    return full.toLowerCase().includes(lower);
}

/**
 * The model a child runs: the role's from configuration, checked against `enabledModels`; else the parent's own. A model outside the
 * allowed list refuses the start and names the patterns.
 */
export function chooseModel(
    settings: AgentsSettings,
    role: string,
    parent: ParentModel | undefined,
    enabled: readonly string[] | undefined,
): ModelChoice | undefined {
    const configured = settings.roles[role]?.model;
    if (configured !== undefined) {
        const parsed = parseModel(configured);
        if (parsed === undefined) throw new StartError(`agents.roles.${role}.model "${configured}" is not provider/id`);
        if (enabled !== undefined && !enabled.some((pattern) => patternAllows(pattern, parsed.provider, parsed.id))) {
            throw new StartError(
                `agents.roles.${role}.model "${parsed.model}" is not allowed by enabledModels in Pi's settings.json` +
                    ` (${enabled.length === 0 ? "the list is empty" : `allowed: ${enabled.join(", ")}`}). Add it there, or change the role's model.`,
            );
        }
        return {
            model: parsed.model,
            ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
            source: "role",
        };
    }
    if (parent === undefined) return undefined;
    return {
        model: `${parent.provider}/${parent.id}`,
        ...(parent.thinking === undefined ? {} : { thinking: parent.thinking }),
        source: "parent",
    };
}

export interface FlagSpec {
    role: Role;
    model: ModelChoice | undefined;
    /** The child's session id, `agent-<id>`. */
    sessionId: string;
    /** The file that holds the role's prompt. */
    promptFile: string;
}

/** The flags after Pi's own program and entry file. */
export function flagsFor(spec: FlagSpec): string[] {
    const flags = ["--mode", "rpc", "--session-id", spec.sessionId];
    if (spec.model !== undefined) {
        flags.push("--model", spec.model.model);
        if (spec.model.thinking !== undefined) flags.push("--thinking", spec.model.thinking);
    }
    const tools = spec.role.tools;
    if (tools !== undefined) flags.push("--tools", tools.join(","));
    // No children of children; no MCP tools unless the role names one, which `--tools` then narrows to.
    const namesMcp = tools?.some((tool) => tool.startsWith("mcp__")) === true;
    flags.push("--exclude-tools", namesMcp ? "subagent" : "subagent,mcp__*");
    flags.push("--append-system-prompt", spec.promptFile);
    // A `.pi/` folder the model wrote in the project does not load in the child.
    flags.push("--no-approve");
    return flags;
}

const KEPT_NAMES: ReadonlySet<string> = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TZ",
    "LANG",
    "TMPDIR",
    "JIG_STATE_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
]);
const KEPT_PREFIXES: readonly string[] = ["LC_", "XDG_", "PI_"];

export interface ChildIdentity {
    id: string;
    name: string;
    role: string;
    parentSession: string;
    parentPid: number;
}

/**
 * The environment a child gets: the names Pi and the shell need, proxy and certificate settings, `PI_*`, and the names in `agents.env`.
 * Every other name is left behind, a key, token or password included; Pi's own login in the agent folder needs no variable.
 */
export function childEnvironment(
    parent: NodeJS.ProcessEnv,
    extraNames: readonly string[],
    who: ChildIdentity,
): Record<string, string> {
    const extra = new Set(extraNames);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parent)) {
        if (value === undefined) continue;
        if (KEPT_NAMES.has(name) || extra.has(name) || KEPT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
            env[name] = value;
        }
    }
    // jig-core's records read the last two; jig-theme and jig-review read PI_SUBAGENT_ID.
    env.PI_SUBAGENT_ID = who.id;
    env.PI_SUBAGENT_NAME = who.name;
    env.PI_SUBAGENT_PARENT_PID = String(who.parentPid);
    env.JIG_PARENT_SESSION = who.parentSession;
    env.JIG_AGENT_ROLE = who.role;
    // A child has no use for a version check, and ten children should not each make one.
    env.PI_SKIP_VERSION_CHECK = "1";
    return env;
}
