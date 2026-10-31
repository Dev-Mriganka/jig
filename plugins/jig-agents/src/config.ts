// The `agents` section of jig.json: limits, roles' models, counts and waits. jig-core checks the section with `validateAgents` when it
// loads, so the rest of the plugin reads a section that is valid, or absent. An unknown field is an error, as in jig-core.
import os from "node:os";
import path from "node:path";
import { ACTION_NAME_PATTERN, TOOL_NAME_PATTERN } from "../../jig-core/src/kit/role-policy.ts";
import type { ActionMap } from "../../jig-core/src/kit/role-policy.ts";

export interface Limits {
    maxTurns: number;
    maxMinutes: number;
    maxCost: number;
}

export type ApprovalMode = "forward" | "deny";

/** Which skills a role sees: none, or exactly the ones named. Absent: those that follow the role's tools. */
export type SkillChoice = "none" | string[];
/** Whether a child reads the project's instruction files (AGENTS.md, CLAUDE.md). */
export type ContextMode = "project" | "none";

export interface RoleSettings {
    /** `provider/id`, with `:thinking` if wanted. Absent: the parent's model. */
    model?: string;
    approvals?: ApprovalMode;
    maxTurns?: number;
    maxMinutes?: number;
    maxCost?: number;
    /** Narrows the file's `actions`: a tool in both keeps the actions both list. A tool the file does not list is narrowed to these. */
    actions?: ActionMap;
    /** Adds to the file's `ask`. */
    ask?: ActionMap;
    /** Replace the file's values: they give a child less to read, and are not authority. */
    skills?: SkillChoice;
    preload?: string[];
    context?: ContextMode;
    thinking?: string;
}

export interface AgentsSettings {
    roles: Record<string, RoleSettings>;
    limits: Limits;
    approvals: ApprovalMode;
    maxRunning: number;
    maxStarted: number;
    approvalWaitMinutes: number;
    maxAsks: number;
    /** Absolute folders with more agent files. */
    folders: string[];
    /** Extra variable names a child's environment keeps. */
    env: string[];
    /** The branch a worker's worktree gets; `{name}` is the child's name. */
    branch: string;
}

export const DEFAULT_LIMITS: Readonly<Limits> = { maxTurns: 40, maxMinutes: 30, maxCost: 2 };
export const DEFAULT_BRANCH = "agent/{name}";

export const RANGES = {
    maxTurns: { min: 1, max: 500 },
    maxMinutes: { min: 1, max: 480 },
    maxCost: { min: 0, max: 100 },
    maxRunning: { min: 1, max: 16 },
    maxStarted: { min: 1, max: 200 },
    approvalWaitMinutes: { min: 1, max: 240 },
    maxAsks: { min: 0, max: 100 },
} as const;

/** The top-level fields of the section, in the order the README's table lists them. */
export const SECTION_FIELDS: readonly string[] = [
    "roles",
    "limits",
    "approvals",
    "maxRunning",
    "maxStarted",
    "approvalWaitMinutes",
    "maxAsks",
    "folders",
    "env",
    "branch",
];
const FIELDS: ReadonlySet<string> = new Set(SECTION_FIELDS);
const ROLE_FIELDS: ReadonlySet<string> = new Set([
    "model",
    "approvals",
    "maxTurns",
    "maxMinutes",
    "maxCost",
    "actions",
    "ask",
    "skills",
    "preload",
    "context",
    "thinking",
]);
/** What configuration may not say about a role, with where it belongs: a role only narrows what its file gave it. */
const ROLE_FILE_ONLY: Readonly<Record<string, string>> = {
    writes: "whether a role writes is in its agent file, and configuration cannot change it: a role only narrows",
    tools: "a role's tools are in its agent file, and configuration cannot change them: a role only narrows",
    description: "a role's description is in its agent file",
    prompt: "a role's prompt is the body of its agent file",
    name: "a role is named by the key it is under",
};
const LIMIT_FIELDS: ReadonlySet<string> = new Set(["maxTurns", "maxMinutes", "maxCost"]);
const COUNT_FIELDS = ["maxRunning", "maxStarted", "approvalWaitMinutes", "maxAsks"] as const;

export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** A role, child or branch word: letters, digits, `-` and `_`. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A skill's name, as Pi writes the rule: lowercase letters, digits and single hyphens, at most 64 characters. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
/** The most skills a role names to see or to preload. */
export const MAX_SKILLS = 30;
export const MAX_PRELOAD = 10;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/{}-]{0,99}$/;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number, whole: boolean): value is number {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!whole || Number.isInteger(value))
    );
}

/** A model setting split into the model pattern and the thinking level, when the text ends in one. */
export function parseModel(
    text: string,
): { model: string; provider: string; id: string; thinking?: string } | undefined {
    if (text.length === 0 || text.length > 200 || /[\s\u0000-\u001f\u007f]/.test(text)) return undefined;
    let model = text;
    let thinking: string | undefined;
    const colon = text.lastIndexOf(":");
    if (colon > 0 && THINKING_LEVELS.includes(text.slice(colon + 1))) {
        model = text.slice(0, colon);
        thinking = text.slice(colon + 1);
    }
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return undefined;
    return {
        model,
        provider: model.slice(0, slash),
        id: model.slice(slash + 1),
        ...(thinking === undefined ? {} : { thinking }),
    };
}

function checkLimit(errors: string[], at: string, name: string, value: unknown): void {
    if (value === undefined) return;
    if (name === "maxCost") {
        if (!inRange(value, 0, RANGES.maxCost.max, false) || value <= 0) {
            errors.push(`${at}.maxCost: must be a number of dollars above 0, up to ${RANGES.maxCost.max}`);
        }
        return;
    }
    const range = RANGES[name as "maxTurns" | "maxMinutes"];
    if (!inRange(value, range.min, range.max, true)) {
        errors.push(`${at}.${name}: must be a whole number from ${range.min} to ${range.max}`);
    }
}

function checkApprovals(errors: string[], at: string, value: unknown): void {
    if (value !== undefined && value !== "forward" && value !== "deny")
        errors.push(`${at}: must be "forward" or "deny"`);
}

/** `{ tool: [action, ...] }`: names that are names, at most 40 tools and 60 actions each. An `ask` list may not be empty. */
function checkActionMap(errors: string[], at: string, value: unknown, allowEmpty: boolean): void {
    if (value === undefined) return;
    if (!isObject(value)) {
        errors.push(`${at}: must be an object from a tool to its actions, such as { "git": ["status", "log"] }`);
        return;
    }
    const tools = Object.keys(value);
    if (tools.length > 40) errors.push(`${at}: names more than 40 tools`);
    for (const tool of tools.slice(0, 40)) {
        const list = value[tool];
        if (!TOOL_NAME_PATTERN.test(tool)) {
            errors.push(`${at}: "${tool.slice(0, 40)}" is not a tool name`);
        } else if (!Array.isArray(list) || list.length > 60 || (list.length === 0 && !allowEmpty)) {
            errors.push(`${at}.${tool}: must be a list of ${allowEmpty ? "" : "one or more "}actions`);
        } else if (list.some((action) => typeof action !== "string" || !ACTION_NAME_PATTERN.test(action))) {
            errors.push(`${at}.${tool}: every action must be a name such as status or push`);
        }
    }
}

function checkSkillNames(errors: string[], at: string, value: unknown, max: number): void {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) {
        errors.push(`${at}: must be a list of one to ${max} skill names`);
    } else if (
        value.some((name) => typeof name !== "string" || name.length > MAX_SKILL_NAME || !SKILL_NAME_PATTERN.test(name))
    ) {
        errors.push(`${at}: every skill name is lowercase letters, digits and hyphens, such as pdf-tools`);
    }
}

/** The fields of a role that choose what a child reads: its skills, the skills it starts with, its project instructions and its thinking level. */
function checkRoleSelection(errors: string[], at: string, settings: Record<string, unknown>): void {
    checkActionMap(errors, `${at}.actions`, settings.actions, true);
    checkActionMap(errors, `${at}.ask`, settings.ask, false);
    if (settings.skills !== undefined && settings.skills !== "none") {
        checkSkillNames(errors, `${at}.skills`, settings.skills, MAX_SKILLS);
    }
    if (settings.preload !== undefined) checkSkillNames(errors, `${at}.preload`, settings.preload, MAX_PRELOAD);
    if (settings.context !== undefined && settings.context !== "project" && settings.context !== "none") {
        errors.push(`${at}.context: must be "project" or "none"`);
    }
    if (settings.thinking !== undefined) {
        if (typeof settings.thinking !== "string" || !THINKING_LEVELS.includes(settings.thinking)) {
            errors.push(`${at}.thinking: must be one of ${THINKING_LEVELS.join(", ")}`);
        }
    }
}

/** The errors in a raw `agents` section, each naming its key. An empty list means the section is valid. */
export function validateAgents(raw: unknown): string[] {
    if (!isObject(raw)) return ["agents: must be an object"];
    const errors = Object.keys(raw)
        .filter((name) => !FIELDS.has(name))
        .map((name) => `agents.${name}: unknown field`);

    if (raw.roles !== undefined) {
        if (!isObject(raw.roles)) {
            errors.push("agents.roles: must be an object from a role name to its settings");
        } else {
            for (const [role, settings] of Object.entries(raw.roles)) {
                const at = `agents.roles.${role}`;
                if (!NAME_PATTERN.test(role)) {
                    errors.push(`agents.roles: "${role.slice(0, 40)}" is not a role name (letters, digits, - and _)`);
                    continue;
                }
                if (!isObject(settings)) {
                    errors.push(`${at}: must be an object`);
                    continue;
                }
                for (const field of Object.keys(settings)) {
                    if (!ROLE_FIELDS.has(field)) {
                        const reason = Object.hasOwn(ROLE_FILE_ONLY, field) ? ROLE_FILE_ONLY[field] : undefined;
                        errors.push(`${at}.${field}: ${reason ?? "unknown field"}`);
                    }
                }
                checkRoleSelection(errors, at, settings);
                if (settings.model !== undefined) {
                    if (typeof settings.model !== "string" || parseModel(settings.model) === undefined) {
                        errors.push(`${at}.model: must be provider/id, with :thinking if wanted`);
                    }
                }
                checkApprovals(errors, `${at}.approvals`, settings.approvals);
                for (const name of LIMIT_FIELDS) checkLimit(errors, at, name, settings[name]);
            }
        }
    }
    if (raw.limits !== undefined) {
        if (!isObject(raw.limits)) {
            errors.push("agents.limits: must be an object");
        } else {
            for (const field of Object.keys(raw.limits)) {
                if (!LIMIT_FIELDS.has(field)) errors.push(`agents.limits.${field}: unknown field`);
            }
            for (const name of LIMIT_FIELDS) checkLimit(errors, "agents.limits", name, raw.limits[name]);
        }
    }
    checkApprovals(errors, "agents.approvals", raw.approvals);
    for (const name of COUNT_FIELDS) {
        const value = raw[name];
        const range = RANGES[name];
        if (value !== undefined && !inRange(value, range.min, range.max, true)) {
            errors.push(`agents.${name}: must be a whole number from ${range.min} to ${range.max}`);
        }
    }
    if (raw.folders !== undefined) {
        if (!Array.isArray(raw.folders)) {
            errors.push("agents.folders: must be a list of folders");
        } else {
            raw.folders.forEach((folder, index) => {
                if (typeof folder !== "string" || (!path.isAbsolute(folder) && !folder.startsWith("~/"))) {
                    errors.push(`agents.folders[${index}]: use an absolute path, or one that starts with ~/`);
                }
            });
        }
    }
    if (raw.env !== undefined) {
        if (!Array.isArray(raw.env) || raw.env.length > 100) {
            errors.push("agents.env: must be a list of at most 100 variable names");
        } else {
            raw.env.forEach((name, index) => {
                if (typeof name !== "string" || !VARIABLE_NAME.test(name)) {
                    errors.push(`agents.env[${index}]: must be a variable name such as MODEL_API_KEY`);
                }
            });
        }
    }
    if (raw.branch !== undefined) {
        const branch = raw.branch;
        if (
            typeof branch !== "string" ||
            !BRANCH_PATTERN.test(branch) ||
            branch.includes("..") ||
            branch.includes("//") ||
            branch.endsWith("/") ||
            branch.endsWith(".") ||
            branch.endsWith(".lock") ||
            !branch.includes("{name}")
        ) {
            errors.push("agents.branch: must be a branch name that holds {name}, such as agent/{name}");
        }
    }
    return errors;
}

function copyMap(map: ActionMap): ActionMap {
    return Object.fromEntries(Object.entries(map).map(([tool, actions]) => [tool, [...new Set(actions)]]));
}

const PLAIN_ROLE_FIELDS = ["model", "approvals", "maxTurns", "maxMinutes", "maxCost", "context", "thinking"] as const;

/** A role's settings as written, copied, with the fields it does not have left out. */
function roleSettingsFrom(given: RoleSettings): RoleSettings {
    const out: Record<string, unknown> = {};
    for (const field of PLAIN_ROLE_FIELDS) if (given[field] !== undefined) out[field] = given[field];
    if (given.actions !== undefined) out.actions = copyMap(given.actions);
    if (given.ask !== undefined) out.ask = copyMap(given.ask);
    if (given.skills !== undefined) out.skills = given.skills === "none" ? "none" : [...given.skills];
    if (given.preload !== undefined) out.preload = [...given.preload];
    return out as RoleSettings;
}

/** The section with defaults filled in. An absent or invalid section gives the defaults. */
export function settingsFrom(section: unknown, home: string = os.homedir()): AgentsSettings {
    const settings: AgentsSettings = {
        roles: {},
        limits: { ...DEFAULT_LIMITS },
        approvals: "forward",
        maxRunning: 4,
        maxStarted: 30,
        approvalWaitMinutes: 30,
        maxAsks: 10,
        folders: [],
        env: [],
        branch: DEFAULT_BRANCH,
    };
    if (!isObject(section) || validateAgents(section).length > 0) return settings;
    if (isObject(section.roles)) {
        for (const [role, raw] of Object.entries(section.roles))
            settings.roles[role] = roleSettingsFrom(raw as RoleSettings);
    }
    if (isObject(section.limits)) Object.assign(settings.limits, section.limits);
    if (section.approvals === "forward" || section.approvals === "deny") settings.approvals = section.approvals;
    for (const name of COUNT_FIELDS) {
        const value = section[name];
        if (typeof value === "number") settings[name] = value;
    }
    if (Array.isArray(section.folders)) {
        settings.folders = (section.folders as string[]).map((folder) =>
            folder.startsWith("~/") ? path.join(home, folder.slice(2)) : folder,
        );
    }
    if (Array.isArray(section.env)) settings.env = [...(section.env as string[])];
    if (typeof section.branch === "string") settings.branch = section.branch;
    return settings;
}

/** The limits one role runs under: its own settings, then `limits`. */
export function limitsFor(settings: AgentsSettings, role: string): Limits {
    const own = settings.roles[role] ?? {};
    return {
        maxTurns: own.maxTurns ?? settings.limits.maxTurns,
        maxMinutes: own.maxMinutes ?? settings.limits.maxMinutes,
        maxCost: own.maxCost ?? settings.limits.maxCost,
    };
}

/** Whether a role's questions are forwarded to the user. */
export function approvalsFor(settings: AgentsSettings, role: string): ApprovalMode {
    return settings.roles[role]?.approvals ?? settings.approvals;
}
