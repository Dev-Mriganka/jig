// The actions that write. A write is planned first with nothing sent (the call is checked), then `prepare` reads what the
// person needs to see: how many documents the filter matches right now. From that come the preview and its fingerprint. When
// the call runs, `prepare` runs again and the fingerprint is compared with the one that was approved: a count that changed in
// between is "changed since the preview", and nothing is sent. The write is sent once. If its reply is lost it is never sent
// again: `verify` reads once, so the model is told what the data looks like now.
import { createHash, randomBytes } from "node:crypto";
import type { Access, Ns } from "./access.ts";
import type { Backend, Req } from "./backend.ts";
import { MAX_LIMIT, WRITE_CAP } from "./params.ts";
import type { Call } from "./params.ts";
import type { CheckedPipeline } from "./pipeline.ts";
import { labelOf, nsOf } from "./reads.ts";
import { plural } from "./render.ts";
import {
    checkBulk,
    checkDocument,
    checkIndexKeys,
    checkIndexOptions,
    checkUpdateInput,
    checkWriteFilter,
} from "./write-check.ts";
import { InputError, stableJson } from "./values.ts";
import type { Doc } from "./values.ts";
import type { Facts, Preview } from "../../jig-core/src/contract.ts";

export interface Outcome {
    text: string;
    details: Doc;
    facts: Facts;
}

/** A write that was read for and is ready to be shown, compared and sent. */
export interface Prepared {
    preview: Preview;
    /** Covers the request and what was counted. */
    fingerprint: string;
    /** What was counted, for the message when it changed: "12 documents match". */
    counted: string;
    send(req: Req): Promise<Outcome>;
    /** One read, on a connection of its own (the first may be gone), to tell what a write whose reply was lost did. */
    verify(backend: Backend, req: Req): Promise<string>;
}

export interface WriteRun {
    label: string;
    /** Whether the write changes one document or one index at a time, so a server error means nothing changed. */
    atomic: boolean;
    prepare(backend: Backend, req: Req): Promise<Prepared>;
}

const SHOWN_DOCUMENTS = 10;
const SHOWN_CHARACTERS = 3000;

const capOf = (call: Call): number => call.limit ?? WRITE_CAP;

/** `12 documents`, or `more than 1000 documents` where the count stopped at the cap. */
function documents(count: number, cap: number): string {
    return count > cap ? `more than ${cap} documents` : plural(count, "document");
}

function fingerprintOf(parts: unknown): string {
    return createHash("sha256").update(stableJson(parts)).digest("hex");
}

function block(title: string, value: unknown): string {
    const text = JSON.stringify(value, null, 2) ?? "null";
    return `${title}:\n${text.length > SHOWN_CHARACTERS ? `${text.slice(0, SHOWN_CHARACTERS)}\n... (${text.length - SHOWN_CHARACTERS} more characters)` : text}`;
}

function previewOf(call: Call, summary: string, sections: readonly string[], fingerprint: string): Preview {
    const where = [call.database, call.collection].filter((part) => part !== undefined).join(".");
    return {
        summary,
        body: [`Environment: ${call.environment}`, `Collection: ${where}`, ...sections].join("\n\n"),
        format: "text",
        fingerprint,
    };
}

/** What a change can only be told apart by: how many documents the filter matches, counted up to the cap. */
async function matches(backend: Backend, ns: Ns, filter: Doc, cap: number, req: Req): Promise<number> {
    return backend.count({ ...ns, filter, limit: cap + 1 }, req);
}

/** Refuses a count that is nothing, or over the cap for a write of many. */
function requireInRange(label: string, count: number, many: boolean, cap: number): void {
    if (count === 0) throw new InputError(`${label}: no document matches the filter, so nothing would change`);
    if (many && count > cap) {
        const raise = cap < MAX_LIMIT ? `, or raise limit (up to ${MAX_LIMIT}) if you mean to change that many` : "";
        throw new InputError(`${label}: the filter matches more than ${cap} documents. Narrow the filter${raise}`);
    }
}

/** What to say about the data after a write whose reply was lost: the filter's matches now, against what was counted. */
async function recount(backend: Backend, ns: Ns, filter: Doc, cap: number, before: number, req: Req): Promise<string> {
    const now = await matches(backend, ns, filter, cap, req);
    return `Read once to check: the filter matches ${documents(now, cap)} now (${documents(before, cap)} when it was checked before sending).`;
}

/** `_id`s for documents that have none, made here so that a lost reply can be checked by id. */
function withIds(docs: readonly Doc[]): { docs: Doc[]; ids: unknown[] } {
    const ids: unknown[] = [];
    const out = docs.map((doc) => {
        const id = doc._id ?? { $oid: randomBytes(12).toString("hex") };
        ids.push(id);
        return doc._id === undefined ? { _id: id, ...doc } : doc;
    });
    return { docs: out, ids };
}

// ---- insert ------------------------------------------------------------------------------------------------------------

function planInsert(call: Call, access: Access): WriteRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const cap = capOf(call);
    const given = call.documents as Doc[];
    if (given.length > cap)
        throw new InputError(
            `insert takes at most ${cap} documents; raise limit (up to ${MAX_LIMIT}) on purpose to insert more`,
        );
    given.forEach((doc, index) => checkDocument(doc, ns, access, `document ${index + 1}`));
    const label = labelOf(call);
    return {
        label,
        atomic: given.length === 1,
        async prepare(backend) {
            const fingerprint = fingerprintOf({
                action: "insert",
                environment: call.environment,
                ns,
                documents: given,
            });
            const shown = given.slice(0, SHOWN_DOCUMENTS);
            const more = given.length > shown.length ? [`... and ${given.length - shown.length} more documents`] : [];
            const { docs, ids } = withIds(given);
            return {
                fingerprint,
                counted: plural(given.length, "document"),
                preview: previewOf(
                    call,
                    `insert ${plural(given.length, "document")} into ${call.database}.${call.collection} in ${call.environment}`,
                    [block("Documents", shown), ...more],
                    fingerprint,
                ),
                async send(req) {
                    const result = await backend.insert({ ...ns, documents: docs }, req);
                    return {
                        text: `${label}: inserted ${plural(result.inserted, "document")}`,
                        details: { inserted: result.inserted },
                        facts: { inserted: result.inserted },
                    };
                },
                async verify(fresh, verifyReq) {
                    const present = await fresh.count({ ...ns, filter: { _id: { $in: ids } } }, verifyReq);
                    return `Read once to check: ${present} of the ${given.length} inserted documents are present (found by _id).`;
                },
            };
        },
    };
}

// ---- update, replace, delete --------------------------------------------------------------------------------------------

/** The three writes that change what a filter matches share the count, the cap and the verification. */
function planFiltered(call: Call, access: Access, kind: "update" | "replace" | "delete"): WriteRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const filter = checkWriteFilter(call.filter, ns, access);
    const many = call.which === "many";
    if (call.limit !== undefined && !many)
        throw new InputError("limit raises the cap of a write of many; with which one it does nothing");
    const cap = many ? capOf(call) : WRITE_CAP;
    const label = labelOf(call);
    const update = kind === "update" ? checkUpdateInput(call.update, call.pipeline, ns, access) : undefined;
    const replacement = kind === "replace" ? checkDocument(call.replacement, ns, access, "replacement") : undefined;
    const scope = kind === "replace" ? "one" : (call.which as string);
    return {
        label,
        atomic: !many,
        async prepare(backend, req) {
            const count = await matches(backend, ns, filter, cap, req);
            requireInRange(label, count, many, cap);
            const fingerprint = fingerprintOf({
                action: kind,
                environment: call.environment,
                ns,
                which: scope,
                filter,
                update,
                replacement,
                count,
            });
            const effect = many
                ? `all ${documents(count, cap)}`
                : count > 1
                  ? `the first of ${documents(count, cap)}`
                  : "1 document";
            const sections = [
                block("Filter", filter),
                ...(update === undefined ? [] : [block("Update", update)]),
                ...(replacement === undefined ? [] : [block("Replacement", replacement)]),
                `Matches now: ${documents(count, cap)} (counted just before this preview).\n` +
                    `This ${kind} changes ${effect}.${many ? `\nCap: at most ${cap} documents.` : ""}`,
            ];
            return {
                fingerprint,
                counted: `${documents(count, cap)} match`,
                preview: previewOf(
                    call,
                    `${kind} ${scope} in ${call.database}.${call.collection} (${call.environment}): ${documents(count, cap)} match`,
                    sections,
                    fingerprint,
                ),
                async send(sendReq): Promise<Outcome> {
                    if (kind === "delete") {
                        const result = await backend.remove({ ...ns, filter, many }, sendReq);
                        return {
                            text: `${label}: deleted ${plural(result.deleted, "document")}`,
                            details: { deleted: result.deleted },
                            facts: { deleted: result.deleted },
                        };
                    }
                    const result =
                        kind === "update"
                            ? await backend.update({ ...ns, filter, update: update as Doc, many }, sendReq)
                            : await backend.replace({ ...ns, filter, replacement: replacement as Doc }, sendReq);
                    return {
                        text: `${label}: matched ${plural(result.matched, "document")}, modified ${result.modified}`,
                        details: { matched: result.matched, modified: result.modified },
                        facts: { matched: result.matched, modified: result.modified },
                    };
                },
                verify: (fresh, verifyReq) => recount(fresh, ns, filter, cap, count, verifyReq),
            };
        },
    };
}

// ---- bulk --------------------------------------------------------------------------------------------------------------

function planBulk(call: Call, access: Access): WriteRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const cap = capOf(call);
    const items = checkBulk(call.operations as Doc[], ns, access);
    const label = labelOf(call);
    return {
        label,
        atomic: false,
        async prepare(backend, req) {
            const counts: number[] = [];
            for (const item of items)
                counts.push(item.filter === undefined ? 1 : await matches(backend, ns, item.filter, cap, req));
            // An operation of one changes at most one document; an insert adds one.
            const touched = items.reduce(
                (sum, item, index) =>
                    sum + (item.many ? (counts[index] as number) : Math.min(counts[index] as number, 1)),
                0,
            );
            if (touched > cap) {
                throw new InputError(
                    `${label}: the operations touch more than ${cap} documents in all. Narrow them, or raise limit (up to ${MAX_LIMIT}) if you mean it`,
                );
            }
            const fingerprint = fingerprintOf({
                action: "bulk",
                environment: call.environment,
                ns,
                operations: call.operations,
                counts,
            });
            const lines = items.map((item, index) => {
                const count = counts[index] as number;
                return `${index + 1}. ${item.kind}${item.filter === undefined ? "" : `: ${documents(count, cap)} match`}`;
            });
            const prepared = items.map((item) =>
                item.kind === "insertOne"
                    ? { insertOne: { document: withIds([(item.op.insertOne as Doc).document as Doc]).docs[0] } }
                    : item.op,
            );
            return {
                fingerprint,
                counted: `${counts.join(", ")} documents match`,
                preview: previewOf(
                    call,
                    `bulk write of ${plural(items.length, "operation")} in ${call.database}.${call.collection} (${call.environment}): up to ${plural(touched, "document")}`,
                    [block("Operations", call.operations), `Matches now, per operation:\n${lines.join("\n")}`],
                    fingerprint,
                ),
                async send(sendReq) {
                    const result = await backend.bulk({ ...ns, operations: prepared }, sendReq);
                    return {
                        text: `${label}: inserted ${result.inserted}, matched ${result.matched}, modified ${result.modified}, deleted ${result.deleted}`,
                        details: { ...result },
                        facts: { ...result },
                    };
                },
                async verify(fresh, verifyReq) {
                    const checks: string[] = [];
                    for (const [index, item] of items.entries()) {
                        if (item.filter === undefined || checks.length >= 10) continue;
                        const now = await matches(fresh, ns, item.filter as Doc, cap, verifyReq);
                        checks.push(
                            `operation ${index + 1}: ${documents(now, cap)} match now (${documents(counts[index] as number, cap)} before)`,
                        );
                    }
                    const found =
                    checks.length === 0
                        ? "the operations were inserts only; read the documents to see them"
                        : checks.join("; ");
                return `Read once per operation to check: ${found}.`;
                },
            };
        },
    };
}

// ---- indexes -----------------------------------------------------------------------------------------------------------

function planCreateIndex(call: Call, access: Access): WriteRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const keys = call.keys as Doc;
    checkIndexKeys(keys, ns, access);
    const options = checkIndexOptions(call.options, ns, access);
    const label = labelOf(call);
    return {
        label,
        atomic: true,
        async prepare(backend, req) {
            const existing = (await backend.indexes(ns, req)).map((index) => String(index.name));
            const fingerprint = fingerprintOf({
                action: "create-index",
                environment: call.environment,
                ns,
                keys,
                options,
                existing,
            });
            return {
                fingerprint,
                counted: `${plural(existing.length, "index", "indexes")} exist`,
                preview: previewOf(
                    call,
                    `create an index on ${call.database}.${call.collection} (${call.environment})`,
                    [
                        block("Keys", keys),
                        ...(Object.keys(options).length === 0 ? [] : [block("Options", options)]),
                        `Existing indexes: ${existing.join(", ") || "none"}.`,
                    ],
                    fingerprint,
                ),
                async send(sendReq) {
                    const name = await backend.createIndex({ ...ns, keys, options }, sendReq);
                    return { text: `${label}: created the index ${name}`, details: { index: name }, facts: {} };
                },
                async verify(fresh, verifyReq) {
                    const now = (await fresh.indexes(ns, verifyReq)).map((index) => String(index.name));
                    return `Read once to check: the indexes are now ${now.join(", ") || "none"}.`;
                },
            };
        },
    };
}

function planDropIndex(call: Call, access: Access): WriteRun {
    const ns = nsOf(call);
    access.namespace(ns.db, ns.coll);
    const name = call.name as string;
    if (name === "_id_") throw new InputError("the _id index cannot be dropped");
    if (name === "*") throw new InputError("drop-index takes the name of one index");
    const label = labelOf(call);
    return {
        label,
        atomic: true,
        async prepare(backend, req) {
            const found = (await backend.indexes(ns, req)).find((index) => index.name === name);
            if (found === undefined)
                throw new InputError(`${label}: there is no index named ${name} (indexes lists them)`);
            const fingerprint = fingerprintOf({
                action: "drop-index",
                environment: call.environment,
                ns,
                name,
                key: found.key,
            });
            return {
                fingerprint,
                counted: `the index ${name} exists`,
                preview: previewOf(
                    call,
                    `drop the index ${name} of ${call.database}.${call.collection} (${call.environment})`,
                    [block("Index", { name, key: found.key })],
                    fingerprint,
                ),
                async send(sendReq) {
                    await backend.dropIndex({ ...ns, name }, sendReq);
                    return { text: `${label}: dropped the index ${name}`, details: { index: name }, facts: {} };
                },
                async verify(fresh, verifyReq) {
                    const now = (await fresh.indexes(ns, verifyReq)).some((index) => index.name === name);
                    return `Read once to check: the index ${name} ${now ? "still exists" : "is gone"}.`;
                },
            };
        },
    };
}

// ---- aggregation that writes -------------------------------------------------------------------------------------------

/** A pipeline whose last stage is `$out` or `$merge`. The documents that reach that stage are counted first. */
export function planAggregateWrite(call: Call, ns: Ns, checked: CheckedPipeline, access: Access): WriteRun {
    const output = checked.output as NonNullable<CheckedPipeline["output"]>;
    access.namespace(output.target.db, output.target.coll);
    const cap = capOf(call);
    const label = labelOf(call);
    const target = `${output.target.db}.${output.target.coll}`;
    return {
        label,
        atomic: false,
        async prepare(backend, req) {
            const rows = await backend.aggregate({ ...ns, pipeline: [...checked.stages, { $count: "n" }] }, req);
            const first = rows[0] as { n?: unknown } | undefined;
            const count = typeof first?.n === "number" ? first.n : 0;
            if (count > cap)
                throw new InputError(
                    `${label}: the pipeline would write ${count} documents, over the cap of ${cap}. Narrow it, or raise limit (up to ${MAX_LIMIT}) if you mean it`,
                );
            const targetCount = await backend.count({ ...output.target, filter: {}, limit: cap + 1 }, req);
            const fingerprint = fingerprintOf({
                action: "aggregate",
                environment: call.environment,
                ns,
                pipeline: call.pipeline,
                count,
                targetCount,
            });
            const replaces =
                output.stage === "$out"
                    ? `$out replaces ${target}, which has ${documents(targetCount, cap)} now.`
                    : `$merge adds to ${target}, which has ${documents(targetCount, cap)} now.`;
            return {
                fingerprint,
                counted: `${plural(count, "document")} reach ${output.stage}`,
                preview: previewOf(
                    call,
                    `${output.stage} into ${target} (${call.environment}): ${plural(count, "document")}`,
                    [
                        block("Pipeline", call.pipeline),
                        `${plural(count, "document")} reach the ${output.stage} stage (counted just before this preview).\n${replaces}`,
                    ],
                    fingerprint,
                ),
                async send(sendReq) {
                    await backend.aggregate({ ...ns, pipeline: [...checked.stages, output.doc] }, sendReq);
                    const facts: Facts = output.stage === "$out" ? { inserted: count } : { matched: count };
                    return {
                        text: `${label}: ${output.stage} wrote ${plural(count, "document")} to ${target}`,
                        details: { documents: count, target },
                        facts,
                    };
                },
                async verify(fresh, verifyReq) {
                    const now = await fresh.count({ ...output.target, filter: {}, limit: cap + 1 }, verifyReq);
                    return `Read once to check: ${target} has ${documents(now, cap)} now (${documents(targetCount, cap)} before).`;
                },
            };
        },
    };
}

/** Plans a call that writes, other than an aggregation. */
export function planWrite(call: Call, access: Access): WriteRun {
    switch (call.action) {
        case "insert":
            return planInsert(call, access);
        case "update":
            return planFiltered(call, access, "update");
        case "replace":
            return planFiltered(call, access, "replace");
        case "delete":
            return planFiltered(call, access, "delete");
        case "bulk":
            return planBulk(call, access);
        case "create-index":
            return planCreateIndex(call, access);
        case "drop-index":
            return planDropIndex(call, access);
        default:
            throw new InputError(`mongo ${call.action} is not a write`);
    }
}
