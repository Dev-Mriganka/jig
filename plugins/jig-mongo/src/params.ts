// The parameters of the `mongo` tool. One flat object, because several model providers reject a top-level union. ACTIONS says
// which parameters each action takes; the schema's action list, the usage lines in errors and the checks in parseCall all come
// from it, so they cannot drift apart.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { COLLECTION_NAME, DATABASE_NAME } from "./access.ts";
import { checkExtended } from "./ejson.ts";
import { InputError, isObject, shown } from "./values.ts";
import type { Doc } from "./values.ts";

export type Param =
    | "environment"
    | "cluster"
    | "database"
    | "collection"
    | "filter"
    | "projection"
    | "sort"
    | "limit"
    | "maxTimeMS"
    | "field"
    | "pipeline"
    | "which"
    | "documents"
    | "update"
    | "replacement"
    | "operations"
    | "keys"
    | "options"
    | "name"
    | "verbosity";

interface ActionSpec {
    required: readonly Param[];
    optional: readonly Param[];
    /** What the action does to the database. */
    effect: "read" | "write";
}

const TARGET = ["environment", "database", "collection"] as const;

export const ACTIONS = {
    databases: { required: ["environment"], optional: ["maxTimeMS"], effect: "read" },
    collections: { required: ["environment", "database"], optional: ["maxTimeMS"], effect: "read" },
    schema: { required: TARGET, optional: ["filter", "limit", "maxTimeMS"], effect: "read" },
    stats: { required: ["environment", "database"], optional: ["collection", "maxTimeMS"], effect: "read" },
    indexes: { required: TARGET, optional: ["maxTimeMS"], effect: "read" },
    "index-stats": { required: TARGET, optional: ["maxTimeMS"], effect: "read" },
    explain: {
        required: TARGET,
        optional: ["filter", "projection", "sort", "limit", "pipeline", "verbosity", "maxTimeMS"],
        effect: "read",
    },
    count: { required: TARGET, optional: ["filter", "maxTimeMS"], effect: "read" },
    find: { required: TARGET, optional: ["filter", "projection", "sort", "limit", "maxTimeMS"], effect: "read" },
    distinct: { required: [...TARGET, "field"], optional: ["filter", "limit", "maxTimeMS"], effect: "read" },
    sample: { required: TARGET, optional: ["filter", "projection", "limit", "maxTimeMS"], effect: "read" },
    aggregate: { required: [...TARGET, "pipeline"], optional: ["limit", "maxTimeMS"], effect: "read" },
    insert: { required: [...TARGET, "documents"], optional: ["limit", "maxTimeMS"], effect: "write" },
    update: {
        required: [...TARGET, "filter", "which"],
        optional: ["update", "pipeline", "limit", "maxTimeMS"],
        effect: "write",
    },
    replace: { required: [...TARGET, "filter", "replacement"], optional: ["maxTimeMS"], effect: "write" },
    delete: { required: [...TARGET, "filter", "which"], optional: ["limit", "maxTimeMS"], effect: "write" },
    bulk: { required: [...TARGET, "operations"], optional: ["limit", "maxTimeMS"], effect: "write" },
    "create-index": { required: [...TARGET, "keys"], optional: ["options", "maxTimeMS"], effect: "write" },
    "drop-index": { required: [...TARGET, "name"], optional: ["maxTimeMS"], effect: "write" },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 2000;
export const DEFAULT_MAX_TIME_MS = 10_000;
export const MAX_MAX_TIME_MS = 60_000;
/** The most documents a `many` write may touch, unless `limit` raises it. */
export const WRITE_CAP = 1000;
const MAX_REQUEST_CHARACTERS = 256 * 1024;

/** Where a call acts, as a message says it: the environment, and the connection's name when the environment has several. */
export function placeOf(call: { environment: string; cluster?: string }): string {
    return call.cluster === undefined ? call.environment : `${call.environment}/${call.cluster}`;
}

export function isAction(value: unknown): value is ActionName {
    return typeof value === "string" && Object.hasOwn(ACTIONS, value);
}

/** `Usage: mongo find {environment, database, collection, filter?, ...}`; a parameter with `?` is optional. */
export function usage(action: ActionName): string {
    const { required, optional }: ActionSpec = ACTIONS[action];
    return `Usage: mongo ${action} {${[...required, ...optional.map((name) => `${name}?`)].join(", ")}}`;
}

function describeActions(): string {
    return ACTION_NAMES.map(
        (name) => `${name}(${ACTIONS[name].required.filter((item) => item !== "environment").join(",")})`,
    ).join(" ");
}

const json = (description: string) =>
    Type.Unsafe<Record<string, unknown>>({ type: "object", additionalProperties: true, description });

export const parameters = Type.Object({
    action: StringEnum(ACTION_NAMES, {
        description: `What to do. Needs: ${describeActions()}. All also need environment`,
    }),
    environment: Type.Optional(Type.String({ description: "The connection's environment name, such as staging" })),
    cluster: Type.Optional(
        Type.String({
            description:
                "Which connection, for an environment that has several, such as orders. Refused where there is one",
        }),
    ),
    database: Type.Optional(Type.String({ description: "The database, such as orders" })),
    collection: Type.Optional(Type.String({ description: "The collection, such as orders" })),
    filter: Type.Optional(
        json(
            'Extended JSON filter: {"status": "open", "_id": {"$oid": "..."}, "createdAt": {"$gt": {"$date": "2026-01-01T00:00:00Z"}}}',
        ),
    ),
    projection: Type.Optional(
        json('Fields to return: {"status": 1, "items": 1}. With an allow list only the allowed fields are returned'),
    ),
    sort: Type.Optional(json('Sort order: {"createdAt": -1}')),
    limit: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: MAX_LIMIT,
            description: `Documents to return, or to sample (default ${DEFAULT_LIMIT}). For a write that changes many, the most it may touch (default ${WRITE_CAP}; raise on purpose)`,
        }),
    ),
    maxTimeMS: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: MAX_MAX_TIME_MS,
            description: `Server time limit in milliseconds (default ${DEFAULT_MAX_TIME_MS})`,
        }),
    ),
    field: Type.Optional(Type.String({ description: "distinct: the field whose values to list" })),
    pipeline: Type.Optional(
        Type.Array(json("One stage"), {
            description:
                "aggregate: the stages. explain: the pipeline to explain. update: an update written as stages ($set, $unset, ...)",
        }),
    ),
    which: Type.Optional(
        StringEnum(["one", "many"], { description: "update, delete: change one document or every match" }),
    ),
    documents: Type.Optional(
        Type.Array(json("One document"), { description: "insert: the documents, in Extended JSON" }),
    ),
    update: Type.Optional(json('update: the change, such as {"$set": {"status": "shipped"}}')),
    replacement: Type.Optional(json("replace: the whole new document")),
    operations: Type.Optional(
        Type.Array(json("One operation"), {
            description:
                'bulk: operations such as {"updateOne": {"filter": {...}, "update": {...}}}, insertOne, updateMany, replaceOne, deleteOne, deleteMany',
        }),
    ),
    keys: Type.Optional(json('create-index: the fields, such as {"status": 1, "createdAt": -1}')),
    options: Type.Optional(
        json("create-index: name, unique, sparse, expireAfterSeconds, partialFilterExpression, hidden"),
    ),
    name: Type.Optional(Type.String({ description: "drop-index: the index name, from indexes" })),
    verbosity: Type.Optional(
        StringEnum(["queryPlanner", "executionStats"], {
            description: "explain: executionStats (default) also runs the query",
        }),
    ),
});

/** A call whose shape was checked: what it needs is present, and each value has its type. What names refer to is checked later. */
export interface Call {
    action: ActionName;
    environment: string;
    /** Which of the environment's connections, when it has several. */
    cluster?: string;
    database?: string;
    collection?: string;
    filter?: Doc;
    projection?: Doc;
    sort?: Doc;
    /** As given, or absent. */
    limit?: number;
    maxTimeMS: number;
    field?: string;
    pipeline?: Doc[];
    which?: "one" | "many";
    documents?: Doc[];
    update?: Doc;
    replacement?: Doc;
    operations?: Doc[];
    keys?: Doc;
    options?: Doc;
    name?: string;
    verbosity?: "queryPlanner" | "executionStats";
}

const TEXT_PARAMS: readonly Param[] = ["environment", "cluster", "database", "collection", "field", "name"];
const OBJECT_PARAMS: readonly Param[] = ["filter", "projection", "sort", "update", "replacement", "keys", "options"];
const LIST_PARAMS: readonly Param[] = ["pipeline", "documents", "operations"];
const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Checks the shape of a call and returns it typed. Every problem is an InputError, a `TypeError` that says what to change, with
 * the usage line when the shape is wrong, so the model can correct the call at once.
 */
export function parseCall(input: Readonly<Record<string, unknown>>): Call {
    const action = input.action;
    if (!isAction(action))
        throw new InputError(`mongo: unknown action ${shown(action, 30)}; use one of ${ACTION_NAMES.join(", ")}`);
    const spec: ActionSpec = ACTIONS[action];
    // `cluster` goes with `environment` in every action; whether the environment takes it is for the configuration to say.
    const accepted = new Set<string>(["action", "cluster", ...spec.required, ...spec.optional]);
    const extra = Object.keys(input).filter((name) => present(input[name]) && !accepted.has(name));
    if (extra.length > 0) throw new InputError(`mongo ${action} does not use ${extra.join(", ")}. ${usage(action)}`);
    const missing = spec.required.filter((name) => !present(input[name]));
    if (missing.length > 0) throw new InputError(`mongo ${action} needs ${missing.join(", ")}. ${usage(action)}`);
    if (JSON.stringify(input).length > MAX_REQUEST_CHARACTERS)
        throw new InputError("the request is longer than 256 KiB; shorten the filter, the documents or the pipeline");

    for (const name of TEXT_PARAMS) {
        if (present(input[name]) && typeof input[name] !== "string")
            throw new InputError(`mongo ${action}: ${name} must be text (got ${shown(input[name], 30)})`);
    }
    for (const name of OBJECT_PARAMS) {
        if (present(input[name]) && !isObject(input[name]))
            throw new InputError(`mongo ${action}: ${name} must be an object (got ${shown(input[name], 30)})`);
    }
    for (const name of LIST_PARAMS) {
        const value = input[name];
        if (present(value) && (!Array.isArray(value) || value.length === 0 || !value.every(isObject))) {
            throw new InputError(`mongo ${action}: ${name} must be a list of objects`);
        }
    }
    if (present(input.database) && !DATABASE_NAME.test(input.database as string))
        throw new InputError("database must be a plain database name (letters, digits, _ and -)");
    if (present(input.collection) && !COLLECTION_NAME.test(input.collection as string))
        throw new InputError("collection must be a plain collection name (letters, digits, _ . and -)");

    const limit = input.limit;
    if (present(limit) && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
        throw new InputError(`mongo ${action}: limit must be a whole number from 1 to ${MAX_LIMIT}`);
    }
    const maxTimeMS = input.maxTimeMS;
    if (
        present(maxTimeMS) &&
        (typeof maxTimeMS !== "number" || !Number.isInteger(maxTimeMS) || maxTimeMS < 1 || maxTimeMS > MAX_MAX_TIME_MS)
    ) {
        throw new InputError(`mongo ${action}: maxTimeMS must be a whole number from 1 to ${MAX_MAX_TIME_MS}`);
    }
    if (present(input.which) && input.which !== "one" && input.which !== "many")
        throw new InputError('which must be "one" or "many"');
    if (present(input.verbosity) && input.verbosity !== "queryPlanner" && input.verbosity !== "executionStats") {
        throw new InputError('verbosity must be "queryPlanner" or "executionStats"');
    }
    if (action === "distinct" && !/^[^$.\s][^\s]{0,255}$/.test(String(input.field)))
        throw new InputError('distinct needs a field such as "status"');
    if (action === "update" && present(input.update) === present(input.pipeline)) {
        throw new InputError(
            `mongo update needs update (operators such as {"$set": {...}}) or pipeline (stages), and not both. ${usage("update")}`,
        );
    }
    if (action === "explain" && present(input.pipeline) && (present(input.projection) || present(input.sort))) {
        throw new InputError(
            "mongo explain: give filter, projection, sort and limit for a find, or a pipeline, not both",
        );
    }

    const call: Record<string, unknown> = { action, maxTimeMS: present(maxTimeMS) ? maxTimeMS : DEFAULT_MAX_TIME_MS };
    for (const name of accepted)
        if (name !== "action" && name !== "maxTimeMS" && present(input[name])) call[name] = input[name];
    for (const name of [...OBJECT_PARAMS, ...LIST_PARAMS]) checkExtended(call[name]);
    return call as unknown as Call;
}

/** The names `scanJavaScript` refuses: they run code on the server. */
const JAVASCRIPT_KEYS: ReadonlySet<string> = new Set(["$where", "$function", "$accumulator", "$code", "$scope"]);

/** Refuses server-side JavaScript anywhere in a request, unless the environment allows it. */
export function scanJavaScript(value: unknown, allowed: boolean, depth = 0): void {
    if (allowed) return;
    if (depth > 64) throw new InputError("a request nests more than 64 levels deep");
    if (Array.isArray(value)) {
        for (const item of value) scanJavaScript(item, allowed, depth + 1);
    } else if (isObject(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (JAVASCRIPT_KEYS.has(key)) {
                throw new InputError(
                    `${key} runs JavaScript on the server, which is not allowed here (it is never allowed in production)`,
                );
            }
            scanJavaScript(item, allowed, depth + 1);
        }
    }
}
