// Reading what Jira sends back. Jira's answers differ by version and by edition, so every reader here accepts a missing
// or oddly shaped value and gives an empty one, and only the code that needs a field decides that its absence is an error.

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);
export const obj = (value: unknown): Obj => (isObject(value) ? value : {});
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const int = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0);

/**
 * A mistake in a call's input. jig-core takes a `TypeError` from a preview to mean "invalid input" and blocks the call
 * without asking, so every such finding is an InputError, which is a TypeError. A TypeError from a bug in this plugin is
 * not an InputError, and tool.ts keeps it from being mistaken for one.
 */
export class InputError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "InputError";
    }
}

/** A message from anything that was thrown. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The name Jira shows for an option, a status, a priority or a user: `name`, else `value`, else `displayName`. */
export function nameOf(value: unknown): string {
    const found = obj(value);
    return str(found.name) || str(found.value) || str(found.displayName) || str(value);
}

/** A person as Jira describes one. Jira Cloud identifies people by `accountId`; Data Center by `name` and `key`. */
export interface User {
    accountId: string;
    username: string;
    key: string;
    displayName: string;
    active: boolean;
}

export function userOf(value: unknown): User {
    const user = obj(value);
    return {
        accountId: str(user.accountId),
        username: str(user.name),
        key: str(user.key),
        displayName: str(user.displayName) || str(user.name) || str(user.accountId),
        active: user.active !== false,
    };
}

/** The identifier to give back to Jira for this person: an account id on Cloud, the user name on Data Center. */
export function userId(user: User): string {
    return user.accountId || user.username || user.key;
}

/** True when two descriptions are of the same person, by any identifier they share. */
export function sameUser(a: User, b: User): boolean {
    const ids = (user: User): string[] => [user.accountId, user.username, user.key].filter((id) => id !== "");
    const mine = ids(a);
    return ids(b).some((id) => mine.includes(id));
}

/** `2026-10-12T14:03:22.123+0000` as `2026-10-12`. */
export const day = (stamp: unknown): string => str(stamp).slice(0, 10);

/** `2026-10-12T14:03:22.123+0000` as `2026-10-12 14:03`. */
export const minute = (stamp: unknown): string => str(stamp).slice(0, 16).replace("T", " ");

export function oneLine(text: string, max = 200): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One value of any field on one line: the names of objects, lists joined, long text cut. */
export function describeValue(value: unknown): string {
    if (value === null || value === undefined || value === "") return "(empty)";
    if (typeof value === "string") return oneLine(value, 120);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.length === 0 ? "(empty)" : oneLine(value.map(describeValue).join(", "), 200);
    const found = obj(value);
    for (const key of ["name", "value", "displayName", "key"]) {
        if (str(found[key]) !== "") return oneLine(str(found[key]), 120);
    }
    return oneLine(JSON.stringify(value), 200);
}

/**
 * A field value in a form that compares equal whether Jira sent a whole object (`{ "id": "2", "name": "High" }`) or the
 * call gave only its name (`{ "name": "High" }`): an object counts as its name, value, account id, key or id.
 */
export function comparable(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.replace(/\r\n/g, "\n").trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return JSON.stringify(value.map(comparable).sort());
    const found = obj(value);
    for (const key of ["name", "value", "accountId", "key", "id"]) {
        if (found[key] !== undefined && found[key] !== null) return comparable(found[key]);
    }
    return JSON.stringify(value);
}

/**
 * The items joined, cut after about `max` characters with a count of the rest. jig-core shows a blocked call's reason to
 * the model cut at 200 characters, so a message that lists choices lists only the first few.
 */
export function shortList(items: readonly string[], separator = ", ", max = 100): string {
    let text = "";
    for (const [index, item] of items.entries()) {
        const next = text === "" ? item : `${text}${separator}${item}`;
        if (text !== "" && next.length > max) return `${text} (and ${items.length - index} more)`;
        text = next;
    }
    return text;
}
