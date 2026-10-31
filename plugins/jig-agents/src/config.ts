// The `agents` section of jig.json: limits, roles' models, counts and waits. jig-core checks the section with `validateAgents` when it
// loads, so the rest of the plugin reads a section that is valid, or absent. An unknown field is an error, as in jig-core.
import os from "node:os";
import path from "node:path";

export interface Limits {
    maxTurns: number;
    maxMinutes: number;
    maxCost: number;
}

export type ApprovalMode = "forward" | "deny";

export interface RoleSettings {
    /** `provider/id`, with `:thinking` if wanted. Absent: the parent's model. */
    model?: string;
    approvals?: ApprovalMode;
    maxTurns?: number;
    maxMinutes?: number;
    maxCost?: number;
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
const ROLE_FIELDS: ReadonlySet<string> = new Set(["model", "approvals", "maxTurns", "maxMinutes", "maxCost"]);
const LIMIT_FIELDS: ReadonlySet<string> = new Set(["maxTurns", "maxMinutes", "maxCost"]);
const COUNT_FIELDS = ["maxRunning", "maxStarted", "approvalWaitMinutes", "maxAsks"] as const;

export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** A role, child or branch word: letters, digits, `-` and `_`. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
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
                    if (!ROLE_FIELDS.has(field)) errors.push(`${at}.${field}: unknown field`);
                }
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
        for (const [role, raw] of Object.entries(section.roles)) {
            const given = raw as RoleSettings;
            settings.roles[role] = {
                ...(given.model === undefined ? {} : { model: given.model }),
                ...(given.approvals === undefined ? {} : { approvals: given.approvals }),
                ...(given.maxTurns === undefined ? {} : { maxTurns: given.maxTurns }),
                ...(given.maxMinutes === undefined ? {} : { maxMinutes: given.maxMinutes }),
                ...(given.maxCost === undefined ? {} : { maxCost: given.maxCost }),
            };
        }
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
