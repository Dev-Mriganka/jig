// The actions that only read. Each is planned first, with nothing sent: the call is checked against the access lists and the
// request to the backend is built. `run` then sends that request, and shapes the answer: denied fields are taken out of it,
// and what is left is written as lines for the model.
import { fieldPath, projectionFor, stripCredentials } from "./access.ts";
import type { Access, Ns } from "./access.ts";
import type { Backend } from "./backend.ts";
import { isLeaf, toExtended, typeName } from "./bson.ts";
import { checkKey, newCtx } from "./expr.ts";
import type { Ctx } from "./expr.ts";
import { summarizeExplain } from "./explain.ts";
import { checkFilter } from "./filter.ts";
import { DEFAULT_LIMIT } from "./params.ts";
import type { Call } from "./params.ts";
import { checkPipeline } from "./pipeline.ts";
import type { CheckedPipeline } from "./pipeline.ts";
import { line, plural, renderDocs } from "./render.ts";
import { InputError, isObject } from "./values.ts";
import type { Doc } from "./values.ts";
import type { Facts } from "../../jig-core/src/contract.ts";

/** What a read hands back: the text for the model, a few details for the result, and the numbers for the record. */
export interface Rendered {
    text: string;
    details: Doc;
    facts: Facts;
}

export interface ReadRun {
    /** `mongo find staging orders.orders`: the start of every line this call prints. */
    label: string;
    run(backend: Backend, signal: AbortSignal): Promise<Rendered>;
}

/** The environment's name and what a call acts on, as the lines of a result start. */
export function labelOf(call: Call): string {
    const target = [call.database, call.collection].filter((part) => part !== undefined).join(".");
    return `mongo ${call.action} ${call.environment}${target === "" ? "" : ` ${target}`}`;
}

export const nsOf = (call: Call): Ns => ({ db: call.database as string, coll: call.collection as string });

/** The `limit` of a read: the one given, or the default. */
export const limitOf = (call: Call): number => call.limit ?? DEFAULT_LIMIT;

function checkSort(sort: Doc | undefined, ctx: Ctx): Doc | undefined {
    if (sort === undefined) return undefined;
    const entries = Object.entries(sort);
    if (entries.length === 0 || entries.length > 8)
        throw new InputError('sort takes 1 to 8 fields, such as {"createdAt": -1}');
    for (const [key, direction] of entries) {
        if (direction !== 1 && direction !== -1) throw new InputError(`sort: ${JSON.stringify(key)} must be 1 or -1`);
        checkKey(ctx, key);
    }
    return sort;
}

/** A projection of fields to keep or drop. A computed field is for `aggregate`. */
function checkProjection(projection: Doc | undefined, ctx: Ctx): void {
    if (projection === undefined) return;
    for (const [key, flag] of Object.entries(projection)) {
        if (flag !== 0 && flag !== 1 && flag !== true && flag !== false)
            throw new InputError(`projection: ${JSON.stringify(key)} must be 1 or 0; computed fields need aggregate`);
        checkKey(ctx, key);
    }
}

const emptyFilter = (call: Call): Doc => call.filter ?? {};

// ---- exploring ---------------------------------------------------------------------------------------------------------

function planDatabases(call: Call, access: Access): ReadRun {
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const names = (await backend.databases({ maxTimeMS: call.maxTimeMS, signal }))
                .filter((name) => access.namespaceVisible(name))
                .sort();
            return {
                text: [`${label}: ${plural(names.length, "database")}`, ...names].join("\n"),
                details: { count: names.length },
                facts: { returned: names.length },
            };
        },
    };
}

function planCollections(call: Call, access: Access): ReadRun {
    const db = call.database as string;
    access.namespace(db);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const found = await backend.collections(db, { maxTimeMS: call.maxTimeMS, signal });
            const names = found
                .filter((item) => access.namespaceVisible(db, item.name))
                .sort((a, b) => a.name.localeCompare(b.name));
            return {
                text: [
                    `${label}: ${plural(names.length, "collection")}`,
                    ...names.map((item) => (item.type === "collection" ? item.name : `${item.name} (${item.type})`)),
                ].join("\n"),
                details: { count: names.length },
                facts: { returned: names.length },
            };
        },
    };
}

/** The numbers of a statistics document that are worth reading, and no others. */
function pick(source: unknown, names: readonly string[]): Doc {
    const out: Doc = {};
    if (!isObject(source)) return out;
    for (const name of names) {
        if (source[name] !== undefined) out[name] = toExtended(source[name]);
    }
    return out;
}

function planStats(call: Call, access: Access): ReadRun {
    const db = call.database as string;
    access.namespace(db, call.collection);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const req = { maxTimeMS: call.maxTimeMS, signal };
            let numbers: Doc;
            if (call.collection === undefined) {
                numbers = pick(await backend.dbStats(db, req), [
                    "collections",
                    "views",
                    "objects",
                    "avgObjSize",
                    "dataSize",
                    "storageSize",
                    "indexes",
                    "indexSize",
                    "totalSize",
                ]);
            } else {
                const stats = await backend.collStats(nsOf(call), req);
                const storage = isObject(stats.storageStats) ? stats.storageStats : stats;
                numbers = pick(storage, [
                    "count",
                    "size",
                    "avgObjSize",
                    "storageSize",
                    "nindexes",
                    "totalIndexSize",
                    "capped",
                ]);
            }
            return { text: `${label}\n${line(numbers)}`, details: { action: "stats" }, facts: {} };
        },
    };
}

const INDEX_OPTIONS = ["unique", "sparse", "expireAfterSeconds", "hidden"] as const;

/** An index's keys as `{status: 1}`, or undefined when one of its fields may not be seen. */
function shownIndex(index: Doc, access: Access, ns: Ns): Doc | undefined {
    const key = isObject(index.key) ? index.key : {};
    const view = access.view([ns]);
    if (Object.keys(key).some((field) => view.visibility(fieldPath(field)) === "no")) return undefined;
    const out: Doc = { name: index.name, key };
    for (const option of INDEX_OPTIONS) if (index[option] !== undefined) out[option] = index[option];
    // The condition of a partial index names fields, so only the fact that there is one is shown.
    if (index.partialFilterExpression !== undefined) out.partial = true;
    return out;
}

function planIndexes(call: Call, access: Access, usage: boolean): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const req = { maxTimeMS: call.maxTimeMS, signal };
            const raw = usage ? await backend.indexStats(ns, req) : await backend.indexes(ns, req);
            const shown: Doc[] = [];
            for (const index of raw) {
                const item = shownIndex(index, access, ns);
                if (item === undefined) continue;
                if (usage && isObject(index.accesses))
                    item.accesses = { ops: index.accesses.ops, since: index.accesses.since };
                shown.push(item);
            }
            const hidden = raw.length - shown.length;
            const note =
                hidden > 0 ? `; ${plural(hidden, "index", "indexes")} on fields that may not be seen not shown` : "";
            return {
                text: [`${label}: ${plural(shown.length, "index", "indexes")}${note}`, ...shown.map(line)].join("\n"),
                details: { count: shown.length },
                facts: { returned: shown.length },
            };
        },
    };
}

// ---- query plans -------------------------------------------------------------------------------------------------------

function planExplain(call: Call, access: Access): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const ctx = newCtx(access.view([ns]));
    const verbosity = call.verbosity ?? "executionStats";
    const label = labelOf(call);
    let query: Parameters<Backend["explain"]>[0];
    if (call.pipeline !== undefined) {
        const checked = checkPipeline(call.pipeline, ns, access);
        if (checked.output !== undefined)
            throw new InputError(`explain a pipeline without its ${checked.output.stage} stage`);
        query = { ...ns, verbosity, pipeline: checked.stages };
    } else {
        checkFilter(emptyFilter(call), ctx);
        checkProjection(call.projection, ctx);
        const projection = projectionFor(access, ns, call.projection);
        const sort = checkSort(call.sort, ctx);
        query = {
            ...ns,
            verbosity,
            filter: emptyFilter(call),
            limit: limitOf(call),
            ...(projection === undefined ? {} : { projection }),
            ...(sort === undefined ? {} : { sort }),
        };
    }
    return {
        label,
        async run(backend, signal) {
            const explained = await backend.explain(query, { maxTimeMS: call.maxTimeMS, signal });
            const lines = summarizeExplain(toExtended(explained) as Doc);
            return {
                text: [`${label} (${verbosity})`, ...lines].join("\n"),
                details: { action: "explain", verbosity },
                facts: {},
            };
        },
    };
}

// ---- documents ---------------------------------------------------------------------------------------------------------

function planCount(call: Call, access: Access): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const filter = emptyFilter(call);
    checkFilter(filter, newCtx(access.view([ns])));
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const count = await backend.count({ ...ns, filter }, { maxTimeMS: call.maxTimeMS, signal });
            return {
                text: `${label}: ${plural(count, "document")} match (exact)`,
                details: { count },
                facts: { matched: count },
            };
        },
    };
}

function planFind(call: Call, access: Access): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const view = access.view([ns]);
    const ctx = newCtx(view);
    const filter = emptyFilter(call);
    checkFilter(filter, ctx);
    checkProjection(call.projection, ctx);
    const sort = checkSort(call.sort, ctx);
    // With an allow list this is a projection of allowed fields only, whatever was asked.
    const projection = projectionFor(access, ns, call.projection);
    const limit = limitOf(call);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const docs = await backend.find(
                {
                    ...ns,
                    filter,
                    limit,
                    ...(projection === undefined ? {} : { projection }),
                    ...(sort === undefined ? {} : { sort }),
                },
                { maxTimeMS: call.maxTimeMS, signal },
            );
            const kept = docs.map((doc) => view.strip(doc));
            return {
                text: renderDocs(label, ["document", "documents"], kept, { limit }),
                details: { count: kept.length, partial: kept.length >= limit },
                facts: { returned: kept.length },
            };
        },
    };
}

function planDistinct(call: Call, access: Access): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const view = access.view([ns]);
    const ctx = newCtx(view);
    const filter = emptyFilter(call);
    checkFilter(filter, ctx);
    const field = call.field as string;
    checkKey(ctx, field);
    const path = fieldPath(field);
    if (view.visibility(path) === "partial") throw new InputError(view.reason(path));
    const limit = limitOf(call);
    // An array field is unwound first, so each element counts, as `distinct` does.
    const pipeline: Doc[] = [
        { $match: filter },
        { $unwind: `$${field}` },
        { $group: { _id: `$${field}` } },
        { $sort: { _id: 1 } },
        { $limit: limit },
    ];
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const rows = await backend.aggregate({ ...ns, pipeline }, { maxTimeMS: call.maxTimeMS, signal });
            const values = rows.map((row) => view.strip(isObject(row) ? row._id : row, path));
            return {
                text: renderDocs(`${label}.${field}`, ["value", "values"], values, { limit }),
                details: { count: values.length, partial: values.length >= limit },
                facts: { returned: values.length },
            };
        },
    };
}

/** `$match`, then a random sample, then the projection. */
function samplePipeline(filter: Doc, projection: Doc | undefined, size: number): Doc[] {
    return [
        ...(Object.keys(filter).length === 0 ? [] : [{ $match: filter }]),
        { $sample: { size } },
        ...(projection === undefined ? [] : [{ $project: projection }]),
    ];
}

function planSample(call: Call, access: Access): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const view = access.view([ns]);
    const ctx = newCtx(view);
    const filter = emptyFilter(call);
    checkFilter(filter, ctx);
    checkProjection(call.projection, ctx);
    const projection = projectionFor(access, ns, call.projection);
    const size = limitOf(call);
    const pipeline = samplePipeline(filter, projection, size);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const docs = (await backend.aggregate({ ...ns, pipeline }, { maxTimeMS: call.maxTimeMS, signal })).map(
                (doc) => view.strip(doc),
            );
            return {
                text: renderDocs(label, ["document sampled", "documents sampled"], docs),
                details: { count: docs.length },
                facts: { returned: docs.length },
            };
        },
    };
}

// ---- schema ------------------------------------------------------------------------------------------------------------

const MAX_SCHEMA_PATHS = 300;

interface Seen {
    types: Map<string, number>;
    documents: number;
}

/** Records the types of every field of a document, under dotted paths with `[]` for array elements. */
function collect(value: unknown, path: string, into: Map<string, Seen>, inDocument: Set<string>, depth = 0): void {
    if (depth > 20) return;
    if (path !== "") {
        const seen = into.get(path) ?? { types: new Map(), documents: 0 };
        const type = typeName(value);
        seen.types.set(type, (seen.types.get(type) ?? 0) + 1);
        if (!inDocument.has(path)) {
            inDocument.add(path);
            seen.documents++;
        }
        into.set(path, seen);
    }
    if (Array.isArray(value)) {
        for (const item of value) collect(item, `${path}[]`, into, inDocument, depth + 1);
    } else if (!isLeaf(value) && isObject(value)) {
        for (const [key, item] of Object.entries(value))
            collect(item, path === "" ? key : `${path}.${key}`, into, inDocument, depth + 1);
    }
}

function planSchema(call: Call, access: Access): ReadRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const view = access.view([ns]);
    const filter = emptyFilter(call);
    checkFilter(filter, newCtx(view));
    const size = limitOf(call);
    const pipeline = samplePipeline(filter, projectionFor(access, ns, undefined), size);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const docs = (
                await backend.aggregate({ ...ns, pipeline, typed: true }, { maxTimeMS: call.maxTimeMS, signal })
            ).map((doc) => view.strip(doc));
            const seen = new Map<string, Seen>();
            for (const doc of docs) collect(doc, "", seen, new Set());
            const paths = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
            const rows = paths.slice(0, MAX_SCHEMA_PATHS).map(([path, item]) => {
                const types = [...item.types.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([type]) => type)
                    .join("|");
                return `${path}: ${types} (in ${item.documents} of ${docs.length})`;
            });
            const more = paths.length > rows.length ? [`...and ${paths.length - rows.length} more fields`] : [];
            return {
                text: [
                    `${label}: ${plural(paths.length, "field")} in a sample of ${plural(docs.length, "document")}`,
                    ...rows,
                    ...more,
                ].join("\n"),
                details: { fields: paths.length, sampled: docs.length },
                facts: { returned: docs.length },
            };
        },
    };
}

// ---- aggregation -------------------------------------------------------------------------------------------------------

/** A pipeline that reads. The limit is a stage of its own at the end, so the result can say when it was reached. */
export function planAggregateRead(call: Call, ns: Ns, checked: CheckedPipeline, access: Access): ReadRun {
    const limit = limitOf(call);
    const pipeline: Doc[] = [...checked.stages, { $limit: limit }];
    const view = access.view(access.mode === "deny" ? checked.reads : [ns]);
    const label = labelOf(call);
    return {
        label,
        async run(backend, signal) {
            const rows = await backend.aggregate({ ...ns, pipeline }, { maxTimeMS: call.maxTimeMS, signal });
            // With an allow list the stages were limited to listed fields, and the output has the names the pipeline gave it.
            const docs = access.mode === "deny" ? rows.map((row) => view.strip(row)) : rows.map(stripCredentials);
            return {
                text: renderDocs(label, ["document", "documents"], docs, { limit }),
                details: { count: docs.length, partial: docs.length >= limit },
                facts: { returned: docs.length },
            };
        },
    };
}

/** Plans a call that only reads, other than an aggregation. */
export function planRead(call: Call, access: Access): ReadRun {
    switch (call.action) {
        case "databases":
            return planDatabases(call, access);
        case "collections":
            return planCollections(call, access);
        case "schema":
            return planSchema(call, access);
        case "stats":
            return planStats(call, access);
        case "indexes":
            return planIndexes(call, access, false);
        case "index-stats":
            return planIndexes(call, access, true);
        case "explain":
            return planExplain(call, access);
        case "count":
            return planCount(call, access);
        case "find":
            return planFind(call, access);
        case "distinct":
            return planDistinct(call, access);
        case "sample":
            return planSample(call, access);
        default:
            throw new InputError(`mongo ${call.action} is not a read`);
    }
}
