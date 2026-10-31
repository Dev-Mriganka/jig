// The parameters of the `jira` tool. One flat object, because several model providers reject a top-level union. ACTIONS
// says which parameters each action takes. The schema's action list, the usage lines in errors and the checks in
// parseCall all come from it, so they cannot drift apart.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PROJECT_KEY } from "./config.ts";
import { convertField, MAX_TEXT } from "./fields.ts";
import { InputError, shortList } from "./values.ts";

export type Param =
    | "key"
    | "jql"
    | "page"
    | "limit"
    | "include"
    | "full"
    | "query"
    | "commentId"
    | "text"
    | "transition"
    | "project"
    | "type"
    | "summary"
    | "description"
    | "fields"
    | "to"
    | "linkType";

interface ActionSpec {
    kind: "read" | "write";
    required: readonly Param[];
    optional: readonly Param[];
}

export const ACTIONS = {
    get: { kind: "read", required: ["key"], optional: ["include", "full"] },
    search: { kind: "read", required: ["jql"], optional: ["limit", "page", "include"] },
    comments: { kind: "read", required: ["key"], optional: ["limit", "full"] },
    transitions: { kind: "read", required: ["key"], optional: [] },
    changelog: { kind: "read", required: ["key"], optional: ["limit"] },
    attachments: { kind: "read", required: ["key"], optional: [] },
    assignable: { kind: "read", required: ["key"], optional: ["query", "limit"] },
    find_field: { kind: "read", required: ["query"], optional: [] },
    link_types: { kind: "read", required: [], optional: [] },
    create: { kind: "write", required: ["project", "type", "summary"], optional: ["description", "fields"] },
    comment: { kind: "write", required: ["key", "text"], optional: [] },
    edit_comment: { kind: "write", required: ["key", "commentId", "text"], optional: [] },
    delete_comment: { kind: "write", required: ["key", "commentId"], optional: [] },
    transition: { kind: "write", required: ["key", "transition"], optional: [] },
    update: { kind: "write", required: ["key", "fields"], optional: [] },
    link: { kind: "write", required: ["key", "to", "linkType"], optional: [] },
    unlink: { kind: "write", required: ["key", "to"], optional: ["linkType"] },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];

export function isAction(value: unknown): value is ActionName {
    return typeof value === "string" && Object.hasOwn(ACTIONS, value);
}

/** `Usage: jira comment {key, text}`; a parameter with `?` is optional. */
export function usage(action: ActionName): string {
    const { required, optional }: ActionSpec = ACTIONS[action];
    return `Usage: jira ${action} {${[...required, ...optional.map((name) => `${name}?`)].join(", ")}}`;
}

/** The actions with the parameters each needs, for the schema: `get(key) search(jql) ...`. */
function describeActions(): string {
    return ACTION_NAMES.map((name) => `${name}(${ACTIONS[name].required.join(",")})`).join(" ");
}

export const parameters = Type.Object({
    action: StringEnum(ACTION_NAMES, { description: `What to do. Needs: ${describeActions()}` }),
    key: Type.Optional(Type.String({ description: "Issue key, such as PROJ-123" })),
    jql: Type.Optional(
        Type.String({
            description:
                "JQL query. A search may leave it out only when the user has listed projects in jig.json, and then looks in them",
        }),
    ),
    page: Type.Optional(Type.String({ description: "Search: the page value the previous result gave" })),
    limit: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "How many to return (search and assignable: up to 50)",
        }),
    ),
    include: Type.Optional(
        Type.Array(Type.String(), { description: "Extra fields to show, by name or id (up to 10)" }),
    ),
    full: Type.Optional(Type.Boolean({ description: "Do not cut long text. Use it before rewriting a description" })),
    query: Type.Optional(Type.String({ description: "Text to match: part of a user's name, or of a field's name" })),
    commentId: Type.Optional(Type.String({ description: "Comment id, from comments" })),
    text: Type.Optional(Type.String({ description: "Comment text, in Jira wiki markup" })),
    transition: Type.Optional(Type.String({ description: "Transition name (or id), from transitions" })),
    project: Type.Optional(Type.String({ description: "Project key, such as PROJ" })),
    type: Type.Optional(Type.String({ description: "Issue type name, such as Bug" })),
    summary: Type.Optional(Type.String({ description: "One-line title" })),
    description: Type.Optional(Type.String({ description: "Description, in Jira wiki markup" })),
    to: Type.Optional(Type.String({ description: "The other issue's key, for link and unlink" })),
    linkType: Type.Optional(
        Type.String({
            description: 'Link type: a name or phrase from link_types, such as "Blocks" or "is blocked by"',
        }),
    ),
    fields: Type.Optional(
        Type.Unsafe<Record<string, unknown>>({
            type: "object",
            additionalProperties: true,
            description: 'Fields to set, by name or id: {"labels": ["a"], "priority": "High", "assignee": "<id>"}',
        }),
    ),
});

// ---- parsed calls -----------------------------------------------------------------------------------------------------

type Fields = Record<string, unknown>;

export type Call =
    | { action: "get"; key: string; include: string[]; full: boolean }
    | { action: "search"; jql: string; limit: number; page: string | undefined; include: string[] }
    | { action: "comments"; key: string; limit: number; full: boolean }
    | { action: "transitions"; key: string }
    | { action: "changelog"; key: string; limit: number }
    | { action: "attachments"; key: string }
    | { action: "assignable"; key: string; query: string | undefined; limit: number }
    | { action: "find_field"; query: string }
    | {
          action: "create";
          project: string;
          type: string;
          summary: string;
          description: string | undefined;
          fields: Fields;
      }
    | { action: "comment"; key: string; text: string }
    | { action: "edit_comment"; key: string; commentId: string; text: string }
    | { action: "delete_comment"; key: string; commentId: string }
    | { action: "transition"; key: string; transition: string }
    | { action: "update"; key: string; fields: Fields }
    | { action: "link_types" }
    | { action: "link"; key: string; to: string; linkType: string }
    | { action: "unlink"; key: string; to: string; linkType: string | undefined };

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]{0,9}$/;
const COMMENT_ID = /^[0-9]{1,20}$/;
const MAX_FIELDS = 30;

/** Per action: the default and the largest `limit`. */
const LIMITS: Partial<Record<ActionName, readonly [fallback: number, max: number]>> = {
    search: [20, 50],
    comments: [20, 100],
    changelog: [30, 100],
    assignable: [20, 50],
};

function shown(value: unknown): string {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

export interface ParseOptions {
    /** The user's project keys (`jira.projects`). With any, a `search` needs no JQL: it looks in these projects. */
    projects?: readonly string[];
}

/** What `search` looks for when the call has no JQL: the newest issues of the user's projects. */
export function projectsQuery(projects: readonly string[]): string {
    return `project in (${projects.map((key) => `"${key}"`).join(", ")}) ORDER BY updated DESC`;
}

/**
 * Checks a call against its action's table and returns it in a typed form. Every problem is an InputError, a
 * `TypeError` that says what to change, with the action's usage line when the shape is wrong, so the model can correct
 * the call at once.
 */
export function parseCall(input: Readonly<Record<string, unknown>>, options: ParseOptions = {}): Call {
    const action = input.action;
    if (!isAction(action)) {
        // The schema lists every action and Pi checks against it first, so this reaches the model rarely and stays short.
        throw new InputError(
            `jira: action must be one of ${shortList(ACTION_NAMES, ", ", 100)} (got ${shown(action)})`,
        );
    }
    const { required: listed, optional }: ActionSpec = ACTIONS[action];
    const projects = options.projects ?? [];
    // A search with no JQL is for the user's projects, so with some listed `jql` is optional.
    const required: readonly Param[] = action === "search" && projects.length > 0 ? [] : listed;
    const known: readonly string[] = ["action", ...listed, ...optional];

    const extra = Object.keys(input).filter((name) => present(input[name]) && !known.includes(name));
    if (extra.length > 0) throw new InputError(`jira ${action} does not use ${extra.join(", ")}. ${usage(action)}`);
    const missing = required.filter((name) => !present(input[name]));
    if (missing.length > 0) throw new InputError(`jira ${action} needs ${missing.join(", ")}. ${usage(action)}`);

    const fail = (message: string): never => {
        throw new InputError(`jira ${action}: ${message}`);
    };
    const issueKey = (name: "key" | "to" = "key"): string => {
        const value = typeof input[name] === "string" ? input[name].trim().toUpperCase() : "";
        return ISSUE_KEY.test(value)
            ? value
            : fail(`${name} must be an issue key such as PROJ-123 (got ${shown(input[name])})`);
    };
    /** The two issues of a link: different ones. */
    const pair = (): { key: string; to: string } => {
        const [key, to] = [issueKey("key"), issueKey("to")];
        return key === to ? fail(`key and to must be two different issues (both are ${key})`) : { key, to };
    };
    const commentId = (): string => {
        const { commentId: given } = input;
        const value = typeof given === "string" || typeof given === "number" ? String(given).trim() : "";
        const problem = `commentId must be the numeric id that comments shows (got ${shown(given)})`;
        return COMMENT_ID.test(value) ? value : fail(problem);
    };
    const words = (name: Param, max: number): string => {
        const value = typeof input[name] === "string" ? (input[name] as string).trim() : "";
        return value !== "" && value.length <= max ? value : fail(`${name} must be text of 1 to ${max} characters`);
    };
    const longText = (name: Param): string => {
        const value = input[name];
        if (typeof value !== "string" || value.trim() === "") return fail(`${name} must be non-empty text`);
        if (value.length > MAX_TEXT) {
            return fail(`${name} is ${value.length} characters; Jira refuses text over ${MAX_TEXT}`);
        }
        return value.includes("\u0000") ? fail(`${name} must not contain a NUL character`) : value;
    };
    const limit = (): number => {
        const [fallback, max] = LIMITS[action] ?? [20, 50];
        const value = input.limit;
        if (!present(value)) return fallback;
        return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
            ? value
            : fail(`limit must be a whole number from 1 to ${max} (got ${shown(value)})`);
    };
    const include = (): string[] => {
        const value = input.include;
        if (!present(value)) return [];
        const usable = (item: unknown): boolean => typeof item === "string" && item.trim() !== "" && item.length <= 60;
        if (!Array.isArray(value) || value.length > 10 || !value.every(usable)) {
            return fail("include must be a list of at most 10 field names or ids");
        }
        return value.map((item) => String(item).trim());
    };
    const flag = (name: Param): boolean => {
        const value = input[name];
        if (!present(value)) return false;
        return typeof value === "boolean" ? value : fail(`${name} must be true or false`);
    };
    const fieldValues = (): Fields => {
        const value = input.fields;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return fail('fields must be an object such as {"labels": ["a"]}');
        }
        const entries = Object.entries(value);
        if (entries.length === 0 || entries.length > MAX_FIELDS)
            return fail(`fields must name 1 to ${MAX_FIELDS} fields`);
        return Object.fromEntries(entries);
    };

    switch (action) {
        case "get":
            return { action, key: issueKey(), include: include(), full: flag("full") };
        case "search": {
            const jql = present(input.jql) ? words("jql", 8000).replace(/\s+/g, " ") : projectsQuery(projects);
            const page = present(input.page) ? words("page", 2000) : undefined;
            return { action, jql, limit: limit(), page, include: include() };
        }
        case "comments":
            return { action, key: issueKey(), limit: limit(), full: flag("full") };
        case "transitions":
        case "attachments":
            return { action, key: issueKey() };
        case "changelog":
            return { action, key: issueKey(), limit: limit() };
        case "assignable": {
            const query = present(input.query) ? words("query", 100) : undefined;
            return { action, key: issueKey(), query, limit: limit() };
        }
        case "find_field": {
            const query = words("query", 60);
            return query.length >= 2 ? { action, query } : fail("query must be at least 2 characters");
        }
        case "create": {
            const project = typeof input.project === "string" ? input.project.trim().toUpperCase() : "";
            if (!PROJECT_KEY.test(project)) {
                return fail(`project must be a project key such as PROJ (got ${shown(input.project)})`);
            }
            const description = present(input.description) ? longText("description") : undefined;
            const fields = present(input.fields) ? fieldValues() : {};
            return { action, project, type: words("type", 60), summary: summaryOf(input.summary), description, fields };
        }
        case "comment":
            return { action, key: issueKey(), text: longText("text") };
        case "edit_comment":
            return { action, key: issueKey(), commentId: commentId(), text: longText("text") };
        case "delete_comment":
            return { action, key: issueKey(), commentId: commentId() };
        case "transition":
            return { action, key: issueKey(), transition: words("transition", 100) };
        case "update":
            return { action, key: issueKey(), fields: fieldValues() };
        case "link_types":
            return { action };
        case "link":
            return { action, ...pair(), linkType: words("linkType", 100) };
        case "unlink":
            return { action, ...pair(), linkType: present(input.linkType) ? words("linkType", 100) : undefined };
    }
}

function summaryOf(value: unknown): string {
    try {
        return String(convertField("summary", value).send);
    } catch (error) {
        throw new InputError(`jira create: ${error instanceof Error ? error.message : String(error)}`);
    }
}
