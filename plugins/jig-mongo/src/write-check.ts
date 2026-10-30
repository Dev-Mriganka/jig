// The inputs of the actions that write: documents, updates, the operations of a bulk write, and indexes. The same rule holds as
// for reads: a write that names a field that may not be seen is refused, because what a write reports (how many documents it
// matched or changed) would otherwise let the agent probe the value of that field.
import { fieldPath } from "./access.ts";
import type { Access, Ns, View } from "./access.ts";
import { isWrapper } from "./ejson.ts";
import { newCtx } from "./expr.ts";
import { checkFilter } from "./filter.ts";
import { checkUpdatePipeline } from "./pipeline.ts";
import { InputError, isObject } from "./values.ts";
import type { Doc } from "./values.ts";

const MAX_DEPTH = 32;

const UPDATE_OPERATORS: ReadonlySet<string> = new Set([
    "$set",
    "$unset",
    "$inc",
    "$mul",
    "$min",
    "$max",
    "$rename",
    "$currentDate",
    "$push",
    "$addToSet",
    "$pop",
    "$pull",
    "$pullAll",
    "$bit",
    "$setOnInsert",
]);

/** A value that is written: every field name in it must be one that may be written. */
export function checkWritten(value: unknown, path: readonly string[], view: View, depth = 0): void {
    if (depth > MAX_DEPTH) throw new InputError(`a document nests more than ${MAX_DEPTH} levels deep`);
    if (Array.isArray(value)) {
        for (const item of value) checkWritten(item, path, view, depth + 1);
        return;
    }
    if (!isObject(value) || isWrapper(value)) return;
    for (const [key, inner] of Object.entries(value)) {
        // `$each`, `$sort` and the like only shape what is written to the same field.
        if (key.startsWith("$")) {
            checkWritten(inner, path, view, depth + 1);
            continue;
        }
        const next = [...path, ...fieldPath(key)];
        const status = view.visibility(next);
        if (status === "no") throw new InputError(view.reason(next));
        // A value at a field that is only partly visible would overwrite the part that is not.
        const nested = isObject(inner) || (Array.isArray(inner) && inner.some(isObject));
        if (status === "partial" && !nested) throw new InputError(view.reason(next));
        checkWritten(inner, next, view, depth + 1);
    }
}

/** A filter that picks the documents of an update, a replacement or a delete. An empty one would pick them all. */
export function checkWriteFilter(filter: Doc | undefined, ns: Ns, access: Access): Doc {
    if (filter === undefined || Object.keys(filter).length === 0) {
        throw new InputError(
            "the filter is empty, so it would change every document: say which documents with a filter",
        );
    }
    checkFilter(filter, newCtx(access.view([ns])));
    return filter;
}

/** The documents of an insert, or a replacement: whole documents, with no operators. */
export function checkDocument(doc: unknown, ns: Ns, access: Access, what: string): Doc {
    if (!isObject(doc) || Object.keys(doc).length === 0)
        throw new InputError(`${what} must be a document with at least one field`);
    if (Object.keys(doc).some((key) => key.startsWith("$")))
        throw new InputError(
            `${what} cannot hold operators such as ${Object.keys(doc).find((key) => key.startsWith("$"))}; use update for those`,
        );
    checkWritten(doc, [], access.view([ns]));
    return doc;
}

/** An update in the operator form, `{"$set": {...}}`. */
export function checkUpdate(update: Doc, ns: Ns, access: Access): void {
    const view = access.view([ns]);
    const ctx = newCtx(view);
    if (Object.keys(update).length === 0)
        throw new InputError('update is empty: give an operator such as {"$set": {"status": "shipped"}}');
    for (const [operator, spec] of Object.entries(update)) {
        if (!operator.startsWith("$"))
            throw new InputError("an update takes operators such as $set; use replace to replace a whole document");
        if (!UPDATE_OPERATORS.has(operator)) throw new InputError(`the update operator ${operator} is not supported`);
        if (!isObject(spec) || Object.keys(spec).length === 0)
            throw new InputError(`${operator} takes fields, such as {"status": "shipped"}`);
        for (const [field, value] of Object.entries(spec)) {
            const path = fieldPath(field);
            const status = view.visibility(path);
            if (status === "no" || (status === "partial" && !isObject(value))) throw new InputError(view.reason(path));
            if (operator === "$rename") {
                if (typeof value !== "string") throw new InputError("$rename takes the new name as text");
                const target = fieldPath(value);
                if (view.visibility(target) !== "yes" || status !== "yes")
                    throw new InputError(view.reason(view.visibility(target) !== "yes" ? target : path));
            } else if (operator === "$pull" && isObject(value) && !isWrapper(value)) {
                // The condition is a filter on the array's elements.
                checkFilter(value, ctx, path);
            } else {
                checkWritten(value, path, view);
            }
        }
    }
}

/** The update of an `update` call: operators, or stages. */
export function checkUpdateInput(
    update: Doc | undefined,
    pipeline: Doc[] | undefined,
    ns: Ns,
    access: Access,
): Doc | Doc[] {
    if (update !== undefined) {
        checkUpdate(update, ns, access);
        return update;
    }
    checkUpdatePipeline(pipeline, ns, access);
    return pipeline as Doc[];
}

// ---- bulk --------------------------------------------------------------------------------------------------------------

export const BULK_MAX = 100;

export interface BulkItem {
    kind: "insertOne" | "updateOne" | "updateMany" | "replaceOne" | "deleteOne" | "deleteMany";
    /** The operation as it is sent. */
    op: Doc;
    /** The filter whose matches are counted, when the operation has one. */
    filter?: Doc;
    /** Whether the operation can change more than one document. */
    many: boolean;
}

const BULK_FIELDS: Readonly<Record<BulkItem["kind"], readonly string[]>> = {
    insertOne: ["document"],
    updateOne: ["filter", "update"],
    updateMany: ["filter", "update"],
    replaceOne: ["filter", "replacement"],
    deleteOne: ["filter"],
    deleteMany: ["filter"],
};

/** Checks each operation of a bulk write like its single form, and returns what the preview and the count need to know. */
export function checkBulk(operations: readonly Doc[], ns: Ns, access: Access): BulkItem[] {
    if (operations.length === 0 || operations.length > BULK_MAX)
        throw new InputError(`bulk takes 1 to ${BULK_MAX} operations`);
    return operations.map((operation, index) => {
        const where = `bulk operation ${index + 1}`;
        const kinds = Object.keys(operation);
        const kind = kinds[0] as BulkItem["kind"];
        if (kinds.length !== 1 || !Object.hasOwn(BULK_FIELDS, kind)) {
            throw new InputError(`${where} must be one of ${Object.keys(BULK_FIELDS).join(", ")}`);
        }
        const spec = operation[kind];
        if (!isObject(spec)) throw new InputError(`${where}: ${kind} takes an object`);
        const allowed = BULK_FIELDS[kind];
        const unknown = Object.keys(spec).find((key) => !allowed.includes(key));
        if (unknown !== undefined)
            throw new InputError(`${where}: ${kind} does not take ${unknown} (it takes ${allowed.join(", ")})`);
        for (const need of allowed)
            if (spec[need] === undefined) throw new InputError(`${where}: ${kind} needs ${need}`);
        if (kind === "insertOne") {
            checkDocument(spec.document, ns, access, `${where} document`);
            return { kind, op: operation, many: false };
        }
        const filter = checkWriteFilter(spec.filter as Doc, ns, access);
        if (kind === "replaceOne") checkDocument(spec.replacement, ns, access, `${where} replacement`);
        if (kind === "updateOne" || kind === "updateMany") {
            if (Array.isArray(spec.update)) checkUpdatePipeline(spec.update, ns, access);
            else if (isObject(spec.update)) checkUpdate(spec.update, ns, access);
            else throw new InputError(`${where}: update must be operators or a list of stages`);
        }
        return { kind, op: operation, filter, many: kind === "updateMany" || kind === "deleteMany" };
    });
}

// ---- indexes -----------------------------------------------------------------------------------------------------------

const INDEX_TYPES: ReadonlySet<unknown> = new Set([1, -1, "text", "hashed", "2dsphere", "2d"]);
const INDEX_NAME = /^[A-Za-z0-9_.$-]{1,127}$/;
const INDEX_OPTIONS: ReadonlySet<string> = new Set([
    "name",
    "unique",
    "sparse",
    "expireAfterSeconds",
    "partialFilterExpression",
    "hidden",
    "background",
]);

export function checkIndexKeys(keys: Doc, ns: Ns, access: Access): void {
    const entries = Object.entries(keys);
    if (entries.length === 0 || entries.length > 32)
        throw new InputError('keys takes 1 to 32 fields, such as {"status": 1, "createdAt": -1}');
    const view = access.view([ns]);
    for (const [field, type] of entries) {
        if (!INDEX_TYPES.has(type))
            throw new InputError(`keys: ${JSON.stringify(field)} must be 1, -1, "text", "hashed", "2dsphere" or "2d"`);
        const path = fieldPath(field);
        if (view.visibility(path) === "no") throw new InputError(view.reason(path));
    }
}

export function checkIndexOptions(options: Doc | undefined, ns: Ns, access: Access): Doc {
    const given = options ?? {};
    for (const [name, value] of Object.entries(given)) {
        if (!INDEX_OPTIONS.has(name))
            throw new InputError(
                `options: ${JSON.stringify(name)} is not supported (use ${[...INDEX_OPTIONS].join(", ")})`,
            );
        const boolean = name === "unique" || name === "sparse" || name === "hidden" || name === "background";
        if (boolean && typeof value !== "boolean") throw new InputError(`options.${name} must be true or false`);
        if (name === "name" && (typeof value !== "string" || !INDEX_NAME.test(value)))
            throw new InputError("options.name must be a plain index name");
        if (name === "expireAfterSeconds" && (typeof value !== "number" || !Number.isInteger(value) || value < 0))
            throw new InputError("options.expireAfterSeconds must be a whole number of seconds");
        if (name === "partialFilterExpression") checkFilter(value, newCtx(access.view([ns])));
    }
    return given;
}
