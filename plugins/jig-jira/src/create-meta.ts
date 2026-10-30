// What Jira's create screen says about one issue type, and checking a value against it. The screen is the authority:
// the fields an issue needs and the values a field allows come from it, never from this code. It is read with the two
// paged endpoints of Jira Cloud and Data Center 9 (`createmeta/{project}/issuetypes`, then one issue type's fields).
import { notFoundAsInvalid } from "./api.ts";
import type { Env } from "./api.ts";
import type { Converted } from "./fields.ts";
import { JiraError } from "./http.ts";
import { arr, InputError, int, isObject, obj, shortList, str } from "./values.ts";
import type { Obj } from "./values.ts";

export interface IssueType {
    id: string;
    name: string;
    subtask: boolean;
}

export interface ScreenField {
    id: string;
    name: string;
    required: boolean;
    hasDefault: boolean;
    /** The schema type (`string`, `array`, `option`, `user`, ...) and, for an array, the type of its items. */
    type: string;
    items: string;
    allowed: Obj[];
}

export interface Screen {
    type: IssueType;
    fields: Map<string, ScreenField>;
}

const PAGE_TYPES = 50;
const PAGE_FIELDS = 100;
const MAX_PAGES = 5;

/** Every row of a paged answer. Cloud names the rows `issueTypes` or `fields`, Data Center names both `values`. */
async function pages(env: Env, path: string, size: number, names: readonly string[]): Promise<Obj[]> {
    const rows: Obj[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const query = { startAt: rows.length, maxResults: size };
        const answer = obj(await env.http.request({ method: "GET", path, query }));
        const batch = names.map((name) => answer[name]).find(Array.isArray) ?? [];
        rows.push(...arr(batch).map(obj));
        const total = int(answer.total);
        // Done when a page is empty, Jira says it was the last, the count is reached, or (with no count) it was not full.
        const counted = total > 0 && rows.length >= total;
        const notFull = answer.isLast === undefined && total === 0 && batch.length < size;
        if (batch.length === 0 || answer.isLast === true || counted || notFull) break;
    }
    return rows;
}

function fieldOf(row: Obj): ScreenField | undefined {
    const id = str(row.fieldId) || str(row.key);
    if (id === "") return undefined;
    const schema = obj(row.schema);
    return {
        id,
        name: str(row.name) || id,
        required: row.required === true,
        hasDefault: row.hasDefaultValue === true,
        type: str(schema.type),
        items: str(schema.items),
        allowed: arr(row.allowedValues).filter(isObject),
    };
}

/**
 * The create screen of an issue type, by name. Undefined when this Jira has no such endpoints, so the caller can go on
 * without it. An unknown project or issue type is a mistake in the call and throws an InputError that lists the choices.
 */
export async function readScreen(env: Env, project: string, typeName: string): Promise<Screen | undefined> {
    let types: IssueType[];
    try {
        const path = `/issue/createmeta/${project}/issuetypes`;
        const rows = await pages(env, path, PAGE_TYPES, ["values", "issueTypes", "createMetaIssueType"]);
        types = rows
            .map((row) => ({ id: str(row.id), name: str(row.name), subtask: row.subtask === true }))
            .filter((type) => type.id !== "" && type.name !== "");
    } catch (error) {
        if (!(error instanceof JiraError) || (error.status !== 404 && error.status !== 405)) throw error;
        // Either the project does not exist, or this Jira is too old to have the endpoint. The project says which.
        try {
            await env.http.request({ method: "GET", path: `/project/${project}` });
        } catch (projectError) {
            throw notFoundAsInvalid(projectError, `project ${project}`);
        }
        return undefined;
    }
    const wanted = typeName.trim().toLowerCase();
    const type = types.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (type === undefined) {
        const names = shortList(types.map((candidate) => candidate.name)) || "none";
        throw new InputError(`jira create: ${project} has no issue type "${typeName}"; its types: ${names}`);
    }
    const screenPath = `/issue/createmeta/${project}/issuetypes/${type.id}`;
    const rows = await pages(env, screenPath, PAGE_FIELDS, ["values", "fields", "results"]);
    const fields = new Map<string, ScreenField>();
    for (const row of rows) {
        const field = fieldOf(row);
        if (field !== undefined) fields.set(field.id, field);
    }
    return { type, fields };
}

/** The field a name means on this screen: by id, or by display name without regard to case. */
export function screenField(screen: Screen, name: string): ScreenField | undefined {
    const byId = screen.fields.get(name.trim());
    if (byId !== undefined) return byId;
    const lower = name.trim().toLowerCase();
    const named = [...screen.fields.values()].filter((field) => field.name.toLowerCase() === lower);
    return named.length === 1 ? named[0] : undefined;
}

/** The name Jira shows for an allowed value: `value` on options, `name` on priorities, components and versions. */
const labelOf = (allowed: Obj): string => str(allowed.value) || str(allowed.name) || str(allowed.id);

function listAllowed(field: ScreenField): string {
    return shortList(field.allowed.map(labelOf).filter((label) => label !== ""), ", ", 80);
}

/** What a field takes, for an error that asks for a missing one. */
export function expectation(field: ScreenField): string {
    if (field.allowed.length > 0) return `one of ${listAllowed(field)}`;
    switch (field.type === "array" ? field.items : field.type) {
        case "date": return "a date as YYYY-MM-DD";
        case "number": return "a number";
        case "user": return "a user id from assignable";
        default: return "text";
    }
}

/** The names a converted value asks for (`High`, or `Web` and `Billing`), or undefined when it is not made of names. */
function wantedLabels(send: unknown): string[] | undefined {
    const labelFor = (item: unknown): string | undefined => {
        if (typeof item === "string") return item;
        if (isObject(item)) return str(item.name) || str(item.value) || undefined;
        return undefined;
    };
    const labels = (Array.isArray(send) ? send : [send]).map(labelFor);
    return labels.every((label): label is string => label !== undefined) ? labels : undefined;
}

/** An allowed value as Jira takes it back: by id when it has one, else by its value or its name. */
function exact(entry: Obj): Obj {
    if (str(entry.id) !== "") return { id: str(entry.id) };
    return str(entry.value) !== "" ? { value: str(entry.value) } : { name: str(entry.name) };
}

/**
 * Checks a value against the values the screen allows for its field and rewrites it as the exact option, by id, so that
 * `high` becomes Jira's `High`. A field with no list of allowed values, or a value this does not understand, is left
 * as it is.
 */
export function checkAllowed(field: ScreenField, converted: Converted): Converted {
    const wanted = field.allowed.length === 0 ? undefined : wantedLabels(converted.send);
    if (wanted === undefined) return converted;
    const chosen = wanted.map((label) => {
        const same = field.allowed.filter((entry) => labelOf(entry) === label || str(entry.id) === label);
        const loose = field.allowed.filter((entry) => labelOf(entry).toLowerCase() === label.toLowerCase());
        const matches = same.length > 0 ? same : loose;
        const [only] = matches;
        if (matches.length === 1 && only !== undefined) return only;
        throw new InputError(
            matches.length > 1
                ? `${field.name}: "${label}" matches several allowed values; use the exact one: ${listAllowed(field)}`
                : `${field.name}: "${label}" is not allowed; allowed: ${listAllowed(field)}`,
        );
    });
    const send = chosen.map(exact);
    return { send: Array.isArray(converted.send) ? send : send[0], shown: chosen.map(labelOf).join(", ") };
}

/** The fields the screen requires that the call did not give. `reporter` is left out: Jira fills in the signed-in user. */
export function missingRequired(screen: Screen, given: ReadonlySet<string>): ScreenField[] {
    const fixed = ["project", "issuetype", "reporter"];
    return [...screen.fields.values()].filter(
        (field) => field.required && !field.hasDefault && !given.has(field.id) && !fixed.includes(field.id),
    );
}
