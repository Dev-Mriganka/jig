// Roles are agent files: Markdown with a few fields of front matter and a prompt. They are read from three places and never from the
// project, which the model can write. Model, limits and extensions are not fields: they come from configuration, or are not allowed.
// A role can only narrow what its child may do. What it narrows is the tools, the actions of a tool, whether it writes, and what
// it reads (skills, project instructions). The fields that narrow what the child may do are enforced in the child (see role-gate.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_NAME_PATTERN, TOOL_NAME_PATTERN } from "../../jig-core/src/kit/role-policy.ts";
import type { ActionMap } from "../../jig-core/src/kit/role-policy.ts";
import {
    MAX_PRELOAD,
    MAX_SKILL_NAME,
    MAX_SKILLS,
    NAME_PATTERN,
    SKILL_NAME_PATTERN,
    THINKING_LEVELS,
} from "./config.ts";
import type { ContextMode, SkillChoice } from "./config.ts";

export interface Role {
    name: string;
    /** One line the parent agent reads. */
    description: string;
    /** The tools the child may use. Absent: the child's usual tools (only for a role that writes). */
    tools?: string[];
    writes: boolean;
    /** The only actions some tools may run. A tool not listed keeps all its actions. */
    actions?: ActionMap;
    /** Actions that ask even if the rules allow. */
    ask?: ActionMap;
    /** The skills the child sees: `none`, or exactly these. Absent: the skills that belong to its tools. */
    skills?: SkillChoice;
    /** Skills whose full text goes into the child's instructions at start. Each must be visible. */
    preload?: string[];
    /** `none`: the child does not read the project's AGENTS.md or CLAUDE.md. Absent: it does. */
    context?: ContextMode;
    /** The child's thinking level. Configuration can replace it. */
    thinking?: string;
    /** The system prompt addition: the Markdown body. */
    prompt: string;
    /** The file it came from. */
    file: string;
}

export interface RoleProblem {
    file: string;
    problem: string;
}

export interface LoadedRoles {
    roles: Map<string, Role>;
    problems: RoleProblem[];
}

/** The front matter fields of an agent file, in the order the README's table lists them. */
export const ROLE_FIELDS: readonly string[] = [
    "name",
    "description",
    "tools",
    "actions",
    "ask",
    "writes",
    "skills",
    "preload",
    "context",
    "thinking",
];
const FIELDS: ReadonlySet<string> = new Set(ROLE_FIELDS);
/** What the files may not say: these belong to configuration or are not allowed at all. */
const FORBIDDEN: Readonly<Record<string, string>> = {
    model: "the model comes from configuration (agents.roles.<role>.model), never from an agent file",
    limits: "limits come from configuration (agents.limits and agents.roles.<role>)",
    maxTurns: "limits come from configuration (agents.limits and agents.roles.<role>)",
    maxMinutes: "limits come from configuration (agents.limits and agents.roles.<role>)",
    maxCost: "limits come from configuration (agents.limits and agents.roles.<role>)",
    extensions: "a child always loads the same plugins as its parent",
    approvals: "approvals come from configuration (agents.roles.<role>.approvals)",
};
/** Tools that write files or run commands with nothing around them. A role that does not write may never list them. */
export const WRITING_TOOLS: readonly string[] = ["powershell", "write", "edit", "notebook_edit"];
/** Tools a role that does not write may list only when its child has jig-sandbox, which makes them read-only (see role-gate.ts). */
export const SANDBOXED_TOOLS: readonly string[] = ["bash"];
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOOLS = 40;
const MAX_ACTIONS = 60;

export class RoleError extends Error {}

function unquote(value: string): string {
    const v = value.trim();
    return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
}

/** The front matter (`key: value` lines between two `---` lines) and the body. */
function split(text: string): { fields: Map<string, string>; body: string } {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines[0]?.trim() !== "---") throw new RoleError("the file must start with a --- line and front matter");
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) throw new RoleError("the front matter has no closing --- line");
    const fields = new Map<string, string>();
    for (const line of lines.slice(1, end)) {
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
        if (match === null) throw new RoleError(`front matter line "${line.slice(0, 40)}" is not key: value`);
        const key = match[1] as string;
        if (fields.has(key)) throw new RoleError(`front matter field ${key} is given twice`);
        fields.set(key, match[2] as string);
    }
    return {
        fields,
        body: lines
            .slice(end + 1)
            .join("\n")
            .trim(),
    };
}

/** A comma-separated list, with or without brackets and quotes. */
function listOf(raw: string): string[] {
    return raw
        .trim()
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((item) => unquote(item))
        .filter((item) => item !== "");
}

function parseTools(raw: string, writes: boolean): string[] {
    const tools = listOf(raw);
    if (tools.length === 0 || tools.length > MAX_TOOLS) throw new RoleError(`tools: list 1 to ${MAX_TOOLS} tool names`);
    for (const tool of tools) {
        if (!TOOL_NAME_PATTERN.test(tool)) throw new RoleError(`tools: "${tool.slice(0, 40)}" is not a tool name`);
    }
    const unique = [...new Set(tools)];
    if (!writes) {
        const bad = unique.filter((tool) => WRITING_TOOLS.includes(tool));
        if (bad.length > 0) throw new RoleError(`tools: a role with writes: false must not list ${bad.join(", ")}`);
    }
    return unique;
}

/**
 * `git status|log|diff, jira get|search`: each tool with the actions that apply to it. A tool is named once, every name is a name, and
 * when the role has a tools list the tool is in it.
 */
function parseActionMap(raw: string, field: "actions" | "ask", tools: readonly string[] | undefined): ActionMap {
    const map: ActionMap = {};
    const groups = raw
        .split(",")
        .map((group) => group.trim())
        .filter((group) => group !== "");
    if (groups.length === 0 || groups.length > MAX_TOOLS) {
        throw new RoleError(`${field}: list 1 to ${MAX_TOOLS} tools, each with its actions, such as git status|log`);
    }
    for (const group of groups) {
        const match = /^(\S+)\s+(\S.*)$/.exec(group);
        if (match === null) {
            throw new RoleError(
                `${field}: "${group.slice(0, 40)}" needs actions after the tool, such as git status|log`,
            );
        }
        const tool = unquote(match[1] as string);
        if (!TOOL_NAME_PATTERN.test(tool)) throw new RoleError(`${field}: "${tool.slice(0, 40)}" is not a tool name`);
        if (Object.hasOwn(map, tool)) throw new RoleError(`${field}: ${tool} is given twice`);
        if (tools !== undefined && !tools.includes(tool)) {
            throw new RoleError(`${field}: ${tool} is not in tools, so the role cannot call it`);
        }
        const actions = (match[2] as string).split("|").map((action) => unquote(action));
        if (actions.length > MAX_ACTIONS) throw new RoleError(`${field}: ${tool} has more than ${MAX_ACTIONS} actions`);
        for (const action of actions) {
            if (!ACTION_NAME_PATTERN.test(action)) {
                throw new RoleError(`${field}: "${action.slice(0, 40)}" is not an action name`);
            }
        }
        map[tool] = [...new Set(actions)];
    }
    return map;
}

function parseSkillNames(raw: string, field: string, max: number): string[] {
    const names = listOf(raw);
    if (names.length === 0 || names.length > max) throw new RoleError(`${field}: list 1 to ${max} skill names`);
    for (const name of names) {
        if (name.length > MAX_SKILL_NAME || !SKILL_NAME_PATTERN.test(name)) {
            throw new RoleError(
                `${field}: "${name.slice(0, 40)}" is not a skill name (lowercase letters, digits and hyphens)`,
            );
        }
    }
    return [...new Set(names)];
}

/** What `ask` and `actions` say together: a tool that may not run an action cannot be made to ask about it. */
function checkAskAgainstActions(ask: ActionMap, actions: ActionMap | undefined): void {
    for (const [tool, asked] of Object.entries(ask)) {
        const allowed = actions?.[tool];
        const outside = allowed === undefined ? [] : asked.filter((action) => !allowed.includes(action));
        if (outside.length > 0) {
            throw new RoleError(
                `ask: ${tool} ${outside.join("|")} is not among the actions ${tool} may run (${allowed?.join("|")})`,
            );
        }
    }
}

/** The fields that choose what a child reads. */
function parseReading(fields: Map<string, string>): Pick<Role, "skills" | "preload" | "context" | "thinking"> {
    const out: Pick<Role, "skills" | "preload" | "context" | "thinking"> = {};
    const skills = fields.get("skills");
    if (skills !== undefined)
        out.skills = unquote(skills) === "none" ? "none" : parseSkillNames(skills, "skills", MAX_SKILLS);
    const preload = fields.get("preload");
    if (preload !== undefined) out.preload = parseSkillNames(preload, "preload", MAX_PRELOAD);
    if (out.preload !== undefined) {
        // A preloaded skill must also be visible, and `none` shows no skill.
        if (out.skills === "none")
            throw new RoleError("preload: a role with skills: none sees no skill, so it cannot preload one");
        const unseen = Array.isArray(out.skills)
            ? out.preload.filter((name) => !(out.skills as string[]).includes(name))
            : [];
        if (unseen.length > 0) throw new RoleError(`preload: ${unseen.join(", ")} must also be in skills`);
    }
    const context = fields.get("context");
    if (context !== undefined) {
        const value = unquote(context);
        if (value !== "project" && value !== "none") throw new RoleError('context: must be "project" or "none"');
        out.context = value;
    }
    const thinking = fields.get("thinking");
    if (thinking !== undefined) {
        const value = unquote(thinking);
        if (!THINKING_LEVELS.includes(value))
            throw new RoleError(`thinking: must be one of ${THINKING_LEVELS.join(", ")}`);
        out.thinking = value;
    }
    return out;
}

/** A role from a file's text. Throws a `RoleError` that names the field. `fallbackName` is the file name without `.md`. */
export function parseRole(text: string, file: string, fallbackName: string): Role {
    const { fields, body } = split(text);
    for (const key of fields.keys()) {
        const reason = FORBIDDEN[key];
        if (reason !== undefined) throw new RoleError(`${key}: ${reason}`);
        if (!FIELDS.has(key)) {
            throw new RoleError(`${key}: unknown field (use ${ROLE_FIELDS.join(", ")})`);
        }
    }
    const name = unquote(fields.get("name") ?? fallbackName);
    if (!NAME_PATTERN.test(name)) throw new RoleError(`name: "${name.slice(0, 40)}" must be letters, digits, - and _`);
    const description = unquote(fields.get("description") ?? "");
    if (description === "" || description.length > 200 || /[\u0000-\u001f\u007f]/.test(description)) {
        throw new RoleError("description: needed, one line of at most 200 characters");
    }
    const writesText = unquote(fields.get("writes") ?? "false");
    if (writesText !== "true" && writesText !== "false") throw new RoleError("writes: must be true or false");
    const writes = writesText === "true";

    const rawTools = fields.get("tools");
    const tools = rawTools === undefined ? undefined : parseTools(rawTools, writes);
    if (!writes && tools === undefined) {
        throw new RoleError(
            "tools: a role that does not write needs a tools list, because the child's usual tools include bash, write and edit",
        );
    }
    const rawActions = fields.get("actions");
    const actions = rawActions === undefined ? undefined : parseActionMap(rawActions, "actions", tools);
    const rawAsk = fields.get("ask");
    const ask = rawAsk === undefined ? undefined : parseActionMap(rawAsk, "ask", tools);
    if (ask !== undefined) checkAskAgainstActions(ask, actions);
    if (body === "") throw new RoleError("the prompt after the front matter is empty");
    return {
        name,
        description,
        ...(tools === undefined ? {} : { tools }),
        writes,
        ...(actions === undefined ? {} : { actions }),
        ...(ask === undefined ? {} : { ask }),
        ...parseReading(fields),
        prompt: body,
        file,
    };
}

/** The agent files that ship with the plugin. */
export function shippedFolder(): string {
    return fileURLToPath(new URL("../agents", import.meta.url));
}

function readFolder(folder: string, into: LoadedRoles): void {
    let names: string[];
    try {
        names = readdirSync(folder).sort();
    } catch {
        return;
    }
    for (const entry of names) {
        if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
        const file = path.join(folder, entry);
        try {
            const info = statSync(file);
            if (!info.isFile()) continue;
            if (info.size > MAX_FILE_BYTES) throw new RoleError(`the file is larger than ${MAX_FILE_BYTES / 1024} KiB`);
            const role = parseRole(readFileSync(file, "utf8"), file, entry.slice(0, -3));
            into.roles.set(role.name, role);
        } catch (error) {
            into.problems.push({ file, problem: error instanceof Error ? error.message : String(error) });
        }
    }
}

/** Roles from the folders, lowest first: a later file with the same name replaces an earlier one. A bad file is skipped and named. */
export function loadRoles(folders: readonly string[]): LoadedRoles {
    const loaded: LoadedRoles = { roles: new Map(), problems: [] };
    for (const folder of folders) readFolder(folder, loaded);
    return loaded;
}

/** The folders, lowest first: the plugin's own, the configured ones, then the user's agent folder. */
export function roleFolders(
    configured: readonly string[],
    agentDir: string,
    shipped: string = shippedFolder(),
): string[] {
    return [shipped, ...configured, path.join(agentDir, "agents")];
}
