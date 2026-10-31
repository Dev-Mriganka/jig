// What a role gives its child agent to obey: whether it may write, the only actions some tools may run, and the actions that must ask.
// jig-agents writes it into one environment variable when it starts a child, and reads it again in the child, where a gate enforces it.
// jig-sandbox reads the same variable to lock the folders of a child that may not write. One parser serves all three, so they cannot
// disagree about what a policy says, and a policy that cannot be read is the same problem for each of them.
//
// The variable is a snapshot: the process that holds it cannot be given another by anything the model runs, because a command changes
// only the environment of its own child process. Stateless; nothing here talks to Pi.
import { isObject } from "./values.ts";

/** The environment variable that carries the policy to a child agent. */
export const ROLE_POLICY_VARIABLE = "JIG_ROLE_POLICY";

/** Tools by name, each with the actions that apply to it. */
export type ActionMap = Record<string, string[]>;

export interface RolePolicy {
    /** The role's name, for the words of a refusal. */
    role: string;
    /** False: the child may not write. Every call classified as a write is refused, except `bash` in the sandbox. */
    writes: boolean;
    /** For each tool named here, the only actions that run; any other action of that tool is refused. An empty list refuses them all. */
    actions: ActionMap;
    /** For each tool named here, the actions that ask even if the rules allow. Only ever stricter. */
    ask: ActionMap;
}

/** What reading the variable found. */
export type PolicyReading =
    | { kind: "absent" }
    | { kind: "policy"; policy: RolePolicy }
    /** The variable is there and cannot be used. Whoever reads it must refuse, never carry on as if it were absent. */
    | { kind: "unreadable"; problem: string };

/** A tool name, as Pi registers it. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** An action name of a tool. */
export const ACTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_TOOLS = 40;
const MAX_ACTIONS = 60;
/** A policy is a few lines. A much longer value is not one. */
const MAX_TEXT_CHARS = 32 * 1024;
const VERSION = 1;

/** The policy as the text of the variable. */
export function writeRolePolicy(policy: RolePolicy): string {
    return JSON.stringify({
        v: VERSION,
        role: policy.role,
        writes: policy.writes,
        actions: policy.actions,
        ask: policy.ask,
    });
}

function actionMap(raw: unknown, field: string): ActionMap | string {
    if (raw === undefined) return {};
    if (!isObject(raw)) return `${field} must be an object from a tool to its actions`;
    const tools = Object.keys(raw);
    if (tools.length > MAX_TOOLS) return `${field} names more than ${MAX_TOOLS} tools`;
    const map: ActionMap = {};
    for (const tool of tools) {
        const list = raw[tool];
        if (!TOOL_NAME_PATTERN.test(tool)) return `${field} has "${tool.slice(0, 40)}", which is not a tool name`;
        if (!Array.isArray(list) || list.length > MAX_ACTIONS) return `${field}.${tool} must be a list of actions`;
        for (const action of list) {
            if (typeof action !== "string" || !ACTION_NAME_PATTERN.test(action)) {
                return `${field}.${tool} has an action that is not a name`;
            }
        }
        map[tool] = [...new Set(list as string[])];
    }
    return map;
}

/** A policy from parsed JSON, or the problem with it. */
export function checkRolePolicy(raw: unknown): RolePolicy | string {
    if (!isObject(raw)) return "the policy must be a JSON object";
    if (raw.v !== VERSION)
        return `the policy is version ${JSON.stringify(raw.v)}, and only version ${VERSION} is known`;
    for (const key of Object.keys(raw)) {
        if (!["v", "role", "writes", "actions", "ask"].includes(key))
            return `the policy has an unknown field "${key.slice(0, 40)}"`;
    }
    if (typeof raw.role !== "string" || !ROLE_NAME_PATTERN.test(raw.role)) return "the policy needs the role's name";
    if (typeof raw.writes !== "boolean") return "writes must be true or false";
    const actions = actionMap(raw.actions, "actions");
    if (typeof actions === "string") return actions;
    const ask = actionMap(raw.ask, "ask");
    if (typeof ask === "string") return ask;
    return { role: raw.role, writes: raw.writes, actions, ask };
}

/** Reads the policy out of an environment. Absent when the variable is not set; unreadable when it is set to anything that is not a policy. */
export function readRolePolicy(env: Readonly<Record<string, string | undefined>>): PolicyReading {
    const text = env[ROLE_POLICY_VARIABLE];
    if (text === undefined) return { kind: "absent" };
    if (text.length > MAX_TEXT_CHARS) return { kind: "unreadable", problem: "the policy is longer than 32 KiB" };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { kind: "unreadable", problem: "the policy is not JSON" };
    }
    const checked = checkRolePolicy(raw);
    return typeof checked === "string" ? { kind: "unreadable", problem: checked } : { kind: "policy", policy: checked };
}
