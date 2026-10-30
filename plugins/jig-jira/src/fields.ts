// Field names and values. A call names a field in one of three ways: a name the tool knows how to build (`labels`), a
// friendly name from the configuration (`Story Points`), or a field id (`customfield_10016`). The tool builds the value
// Jira expects for the first kind, from plain input; any other field takes its value as Jira's REST API does.
import { InputError } from "./values.ts";

/** Jira rejects longer text in a comment, a description or a text field. */
export const MAX_TEXT = 32767;

/** Fields whose value the tool builds from plain input: `priority: "High"` becomes `{ "name": "High" }`. `assignee` is
 *  built from a user the tool looked up (see plan-fields.ts). */
export const BUILT_IN_FIELDS = [
    "summary", "description", "labels", "priority", "assignee", "components", "fixVersions", "parent",
] as const;

/** Fields whose text is Jira wiki markup, so the preview page renders them. */
const WIKI_FIELDS: ReadonlySet<string> = new Set(["description", "environment"]);

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isFieldId(value: string): boolean {
    return FIELD_ID.test(value);
}

/** The built-in field a name means (case does not matter), or undefined. */
export function builtInField(name: string): string | undefined {
    const lower = name.trim().toLowerCase();
    return BUILT_IN_FIELDS.find((field) => field.toLowerCase() === lower);
}

/** The friendly name, as configured, that `name` means (case does not matter), or undefined. */
function friendlyName(name: string, friendly: Readonly<Record<string, string>>): string | undefined {
    const lower = name.trim().toLowerCase();
    return Object.keys(friendly).find((candidate) => candidate.toLowerCase() === lower);
}

/** The id of a field the tool knows by name: a built-in field or a configured friendly name (case does not matter). */
export function knownFieldId(name: string, friendly: Readonly<Record<string, string>>): string | undefined {
    const built = builtInField(name);
    if (built !== undefined) return built;
    const configured = friendlyName(name, friendly);
    return configured === undefined ? undefined : friendly[configured];
}

/** The id of the field a name means: a known name, else a field id as it is. */
export function fieldIdOf(name: string, friendly: Readonly<Record<string, string>>): string | undefined {
    return knownFieldId(name, friendly) ?? (isFieldId(name.trim()) ? name.trim() : undefined);
}

export function isFieldReference(name: string, friendly: Readonly<Record<string, string>>): boolean {
    return fieldIdOf(name, friendly) !== undefined;
}

export function isWikiField(id: string): boolean {
    return WIKI_FIELDS.has(id);
}

/** A value ready to send, how the preview shows it, and the strings in it that go to readers. */
export interface Converted {
    send: unknown;
    shown: string;
}

const MAX_DEPTH = 6;
const MAX_NODES = 500;

/** Throws unless `value` is plain JSON of a sensible size: a field value is sent as it is, so it is bounded here. */
function checkJson(id: string, value: unknown): void {
    let nodes = 0;
    const visit = (node: unknown, depth: number): void => {
        if (depth > MAX_DEPTH || ++nodes > MAX_NODES) {
            throw new InputError(`${id}: the value is too large or nested too deeply`);
        }
        if (typeof node === "string") {
            if (node.length > MAX_TEXT) throw new InputError(`${id}: text over ${MAX_TEXT} characters; Jira refuses it`);
        } else if (typeof node === "number") {
            if (!Number.isFinite(node)) throw new InputError(`${id}: numbers must be finite`);
        } else if (node === null || typeof node === "boolean") {
            return;
        } else if (Array.isArray(node)) {
            for (const item of node) visit(item, depth + 1);
        } else if (typeof node === "object") {
            for (const [key, item] of Object.entries(node)) {
                if (key === "__proto__") throw new InputError(`${id}: the value has a key that is not allowed`);
                visit(item, depth + 1);
            }
        } else {
            throw new InputError(`${id}: the value must be plain JSON`);
        }
    };
    visit(value, 0);
}

function text(id: string, raw: unknown): string {
    if (typeof raw !== "string") throw new InputError(`${id}: must be text`);
    if (raw.length > MAX_TEXT) throw new InputError(`${id}: ${raw.length} characters; Jira refuses text over ${MAX_TEXT}`);
    return raw;
}

function names(id: string, raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length > 50 || list.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 255)) {
        throw new InputError(`${id}: must be a list of at most 50 names`);
    }
    return list.map((item) => String(item).trim());
}

/**
 * The value Jira expects for a field, from what the call gave. `assignee` is not here: it needs a user that was looked
 * up. Any field the tool does not build is sent as given, and Jira has the last word on it.
 */
export function convertField(id: string, raw: unknown): Converted {
    switch (id) {
        case "summary": {
            const summary = typeof raw === "string" ? raw.trim() : "";
            if (summary === "" || summary.length > 255 || /[\r\n]/.test(summary)) {
                throw new InputError("summary: must be one line of 1 to 255 characters");
            }
            return { send: summary, shown: summary };
        }
        case "description":
            return raw === null ? { send: null, shown: "(cleared)" } : { send: text(id, raw), shown: text(id, raw) };
        case "labels": {
            const labels = raw === null ? [] : names(id, raw);
            if (labels.some((label) => /\s/.test(label))) throw new InputError("labels: a label cannot contain a space");
            return { send: labels, shown: labels.length === 0 ? "(none)" : labels.join(", ") };
        }
        case "priority": {
            const name = typeof raw === "string" ? raw.trim() : "";
            if (name === "") throw new InputError("priority: must be a priority name, such as High");
            return { send: { name }, shown: name };
        }
        case "components":
        case "fixVersions": {
            // A value that is already in Jira's own form (an object, or a list of them) is sent as it is.
            const ofObjects = Array.isArray(raw) && raw.some((item) => typeof item === "object" && item !== null);
            if ((raw !== null && typeof raw === "object" && !Array.isArray(raw)) || ofObjects) return passThrough(id, raw);
            const list = raw === null ? [] : names(id, raw);
            return { send: list.map((name) => ({ name })), shown: list.length === 0 ? "(none)" : list.join(", ") };
        }
        case "parent": {
            const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
            if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key)) {
                throw new InputError("parent: must be an issue key, such as PROJ-12");
            }
            return { send: { key }, shown: key };
        }
        default:
            return passThrough(id, raw);
    }
}

function passThrough(id: string, raw: unknown): Converted {
    checkJson(id, raw);
    const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
    return { send: raw, shown: shown.length > 300 ? `${shown.slice(0, 299)}…` : shown };
}
