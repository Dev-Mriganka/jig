// An aggregation pipeline, walked in full before anything runs. Every reference to a field is checked against the access lists:
// the "$path" strings, `$getField`, the keys of `$match`, `$sort` and `$project`, what `$replaceRoot` takes as the new root, and
// the sub-pipelines of `$lookup`, `$unionWith` and `$facet`. A collection a stage reads or writes is checked too.
//
// With an allow list the pipeline is also reshaped: a projection of the allowed fields is put in front of the user's stages, so
// no stage can reach a field that is not listed, even one this walk missed. `$lookup` and `$unionWith` get the same projection
// on the collection they read.
import { nsName } from "./access.ts";
import type { Access, Ns } from "./access.ts";
import { projectionFor } from "./access.ts";
import { checkExpr, checkKey, checkName, markDerived, newCtx } from "./expr.ts";
import type { Ctx } from "./expr.ts";
import { checkFilter } from "./filter.ts";
import { InputError, isObject } from "./values.ts";
import type { Doc } from "./values.ts";

export const MAX_STAGES = 50;

export interface CheckedPipeline {
    /** The stages to run. With an allow list a projection of the allowed fields comes after the leading `$match` stages. */
    stages: Doc[];
    /** The last stage, when it writes to a collection. */
    output?: { stage: "$out" | "$merge"; target: Ns /** The stage as given, to run last. */; doc: Doc };
    /** The collections the pipeline reads: its own first. */
    reads: Ns[];
}

/** Stages that may appear in an update written as a pipeline. */
export const UPDATE_STAGES: ReadonlySet<string> = new Set([
    "$addFields",
    "$set",
    "$project",
    "$unset",
    "$replaceRoot",
    "$replaceWith",
]);

const OUTPUT_STAGES: ReadonlySet<string> = new Set(["$out", "$merge"]);

function stageParts(stage: unknown): [string, unknown] {
    const keys = isObject(stage) ? Object.keys(stage) : [];
    if (!isObject(stage) || keys.length !== 1 || !(keys[0] as string).startsWith("$")) {
        throw new InputError('each stage must be an object with one operator, such as {"$match": {...}}');
    }
    return [keys[0] as string, stage[keys[0] as string]];
}

/** `"orders"`, or `{ db, coll }`: the collection a stage names, with the database of the pipeline when it gives none. */
function namespaceOf(value: unknown, db: string, what: string): Ns {
    if (typeof value === "string") return { db, coll: value };
    if (isObject(value) && typeof value.coll === "string")
        return { db: typeof value.db === "string" ? value.db : db, coll: value.coll };
    throw new InputError(`${what} must name a collection`);
}

function positive(stage: string, value: unknown, least: number): void {
    if (typeof value !== "number" || !Number.isInteger(value) || value < least)
        throw new InputError(`${stage} takes a whole number of ${least} or more`);
}

/** Every collection that a list of stages reads, and the ones it names inside sub-pipelines, so the view covers them all. */
function reading(stages: readonly unknown[], db: string, found: Ns[]): void {
    for (const stage of stages) {
        if (!isObject(stage)) continue;
        const [name, body] = stageParts(stage);
        if (name === "$lookup" || name === "$graphLookup") {
            if (isObject(body) && body.from !== undefined) found.push(namespaceOf(body.from, db, `${name} from`));
            if (isObject(body) && Array.isArray(body.pipeline)) reading(body.pipeline, found.at(-1)?.db ?? db, found);
        } else if (name === "$unionWith") {
            const target = isObject(body)
                ? namespaceOf(body.coll, db, "$unionWith coll")
                : namespaceOf(body, db, "$unionWith");
            found.push(target);
            if (isObject(body) && Array.isArray(body.pipeline)) reading(body.pipeline, target.db, found);
        } else if (name === "$facet" && isObject(body)) {
            for (const branch of Object.values(body)) if (Array.isArray(branch)) reading(branch, db, found);
        }
    }
}

interface Walk {
    access: Access;
    /** One view over every collection read: with a deny list, a field denied for one is denied for all. */
    shared: Ctx;
    db: string;
}

/** The context for a collection read inside the pipeline: with an allow list its own list applies, otherwise the shared one. */
function contextFor(walk: Walk, ns: Ns, vars: Iterable<[string, "derived"]>): Ctx {
    if (walk.access.mode === "deny")
        return {
            ...walk.shared,
            derived: new Set(),
            rootDerived: false,
            vars: new Map([...walk.shared.vars, ...vars]),
        };
    return newCtx(walk.access.view([ns]), vars);
}

/** The inclusion projection that keeps only what an allow list allows, as a stage. */
function allowedProjection(access: Access, ns: Ns): Doc {
    return { $project: projectionFor(access, ns, undefined) as Doc };
}

function withProjection(access: Access, ns: Ns, stages: readonly Doc[]): Doc[] {
    if (access.mode === "deny") return [...stages];
    // The leading `$match` stages stay first: they are what an index can serve.
    let leading = 0;
    while (leading < stages.length && Object.hasOwn(stages[leading] as Doc, "$match")) leading++;
    return [...stages.slice(0, leading), allowedProjection(access, ns), ...stages.slice(leading)];
}

function checkSort(body: unknown, ctx: Ctx): void {
    if (!isObject(body) || Object.keys(body).length === 0)
        throw new InputError('$sort takes fields with 1 or -1, such as {"createdAt": -1}');
    for (const [key, direction] of Object.entries(body)) {
        if (direction !== 1 && direction !== -1 && !isObject(direction))
            throw new InputError(`$sort: ${JSON.stringify(key)} must be 1 or -1`);
        checkKey(ctx, key);
    }
}

function checkProject(body: unknown, ctx: Ctx): void {
    if (!isObject(body) || Object.keys(body).length === 0)
        throw new InputError("$project takes fields to keep or compute");
    const computed: string[] = [];
    for (const [key, value] of Object.entries(body)) {
        if (value === 0 || value === 1 || value === true || value === false) {
            checkKey(ctx, key, "shape");
        } else {
            checkName(ctx, key);
            checkExpr(value, ctx);
            computed.push(key);
        }
    }
    // Every expression of a stage reads the documents that came in, so the new names count only once all are checked.
    for (const key of computed) markDerived(ctx, key);
}

function checkFields(stage: string, body: unknown, ctx: Ctx): void {
    if (!isObject(body) || Object.keys(body).length === 0)
        throw new InputError(`${stage} takes fields to set, such as {"total": {"$sum": "$items.price"}}`);
    for (const [key, value] of Object.entries(body)) {
        checkName(ctx, key);
        checkExpr(value, ctx);
    }
    for (const key of Object.keys(body)) markDerived(ctx, key);
}

function checkAccumulators(stage: string, output: unknown, ctx: Ctx): void {
    if (output === undefined) return;
    if (!isObject(output)) throw new InputError(`${stage} output must be an object of accumulators`);
    for (const [key, value] of Object.entries(output)) {
        checkName(ctx, key);
        checkExpr(value, ctx);
    }
}

function checkUnwind(body: unknown, ctx: Ctx): void {
    const spec = isObject(body) ? body : { path: body };
    if (typeof spec.path !== "string" || !spec.path.startsWith("$"))
        throw new InputError('$unwind needs a path such as "$items"');
    checkKey(ctx, spec.path.slice(1), "shape");
    if (typeof spec.includeArrayIndex === "string") {
        checkName(ctx, spec.includeArrayIndex);
        markDerived(ctx, spec.includeArrayIndex);
    }
}

/** Where the documents of a sub-pipeline start, with the variables the stage hands it. */
function subPipeline(walk: Walk, stages: unknown, ns: Ns, vars: Iterable<[string, "derived"]>, what: string): Doc[] {
    if (!Array.isArray(stages) || stages.length > MAX_STAGES)
        throw new InputError(`${what} pipeline must be a list of at most ${MAX_STAGES} stages`);
    const ctx = contextFor(walk, ns, vars);
    const checked = stages.map((stage) => stageOf(walk, ctx, stage, ns, false));
    return withProjection(walk.access, ns, checked);
}

function stageOf(walk: Walk, ctx: Ctx, stage: unknown, ns: Ns, main: boolean): Doc {
    const [name, body] = stageParts(stage);
    const { access } = walk;
    switch (name) {
        case "$match":
            checkFilter(body, ctx);
            break;
        case "$sort":
            checkSort(body, ctx);
            break;
        case "$project":
            checkProject(body, ctx);
            break;
        case "$addFields":
        case "$set":
            checkFields(name, body, ctx);
            break;
        case "$unset":
            for (const item of Array.isArray(body) ? body : [body]) {
                if (typeof item !== "string") throw new InputError("$unset takes a field name or a list of them");
                checkKey(ctx, item, "shape");
            }
            break;
        case "$unwind":
            checkUnwind(body, ctx);
            break;
        case "$limit":
            positive(name, body, 1);
            break;
        case "$skip":
            positive(name, body, 0);
            break;
        case "$sample":
            if (!isObject(body)) throw new InputError("$sample takes {size: n}");
            positive("$sample size", body.size, 1);
            break;
        case "$count":
            if (typeof body !== "string" || body === "" || body.startsWith("$") || body.includes("."))
                throw new InputError("$count takes a field name");
            checkName(ctx, body);
            ctx.rootDerived = true;
            break;
        case "$group": {
            if (!isObject(body) || !("_id" in body)) throw new InputError("$group needs an _id, which may be null");
            const { _id, ...fields } = body;
            checkExpr(_id, ctx);
            checkAccumulators(name, fields, ctx);
            ctx.rootDerived = true;
            break;
        }
        case "$bucket":
        case "$bucketAuto":
            if (!isObject(body)) throw new InputError(`${name} takes an object`);
            checkExpr(body.groupBy, ctx);
            checkAccumulators(name, body.output, ctx);
            ctx.rootDerived = true;
            break;
        case "$sortByCount":
            checkExpr(body, ctx);
            ctx.rootDerived = true;
            break;
        case "$replaceRoot":
            if (!isObject(body) || body.newRoot === undefined)
                throw new InputError("$replaceRoot takes {newRoot: <expression>}");
            checkExpr(body.newRoot, ctx);
            ctx.rootDerived = true;
            break;
        case "$replaceWith":
            checkExpr(body, ctx);
            ctx.rootDerived = true;
            break;
        case "$redact":
            checkExpr(body, ctx);
            break;
        case "$setWindowFields": {
            if (!isObject(body)) throw new InputError("$setWindowFields takes an object");
            checkExpr(body.partitionBy, ctx);
            if (isObject(body.sortBy)) for (const key of Object.keys(body.sortBy)) checkKey(ctx, key);
            checkAccumulators(name, body.output, ctx);
            for (const key of Object.keys(isObject(body.output) ? body.output : {})) markDerived(ctx, key);
            break;
        }
        case "$facet": {
            if (!isObject(body) || Object.keys(body).length === 0) throw new InputError("$facet takes named pipelines");
            const rebuilt: Doc = {};
            for (const [key, branch] of Object.entries(body)) {
                checkName(ctx, key);
                if (!Array.isArray(branch) || branch.length > MAX_STAGES)
                    throw new InputError(
                        `$facet ${JSON.stringify(key)} must be a list of at most ${MAX_STAGES} stages`,
                    );
                const inner: Ctx = { ...ctx, derived: new Set(ctx.derived) };
                rebuilt[key] = branch.map((item) => stageOf(walk, inner, item, ns, false));
            }
            ctx.rootDerived = true;
            return { $facet: rebuilt };
        }
        case "$lookup": {
            if (!isObject(body)) throw new InputError("$lookup takes an object");
            const from = namespaceOf(body.from, ns.db, "$lookup from");
            access.namespace(from.db, from.coll);
            if (typeof body.as !== "string" || body.as === "") throw new InputError("$lookup needs as");
            if (typeof body.localField === "string") checkKey(ctx, body.localField);
            const vars: [string, "derived"][] = [];
            for (const [variable, expression] of Object.entries(isObject(body.let) ? body.let : {})) {
                checkExpr(expression, ctx);
                vars.push([variable, "derived"]);
            }
            // A pipeline-less lookup in an allow list gets one, for the projection. It needs MongoDB 5.0 or later to be told
            // apart from the pipeline form, and says so if the server is older.
            const given = body.pipeline ?? (access.mode === "allow" ? [] : undefined);
            const pipeline = given === undefined ? undefined : subPipeline(walk, given, from, vars, "$lookup");
            if (typeof body.foreignField === "string") checkKey(contextFor(walk, from, []), body.foreignField);
            checkName(ctx, body.as);
            markDerived(ctx, body.as);
            return { $lookup: { ...body, ...(pipeline === undefined ? {} : { pipeline }) } };
        }
        case "$graphLookup": {
            if (access.mode === "allow")
                throw new InputError(
                    "$graphLookup is not available with an allow list: it cannot be limited to the listed fields",
                );
            if (!isObject(body)) throw new InputError("$graphLookup takes an object");
            const from = namespaceOf(body.from, ns.db, "$graphLookup from");
            access.namespace(from.db, from.coll);
            checkExpr(body.startWith, ctx);
            for (const key of ["connectFromField", "connectToField"] as const) {
                if (typeof body[key] === "string") checkKey(ctx, body[key]);
            }
            if (body.restrictSearchWithMatch !== undefined) checkFilter(body.restrictSearchWithMatch, ctx);
            if (typeof body.as !== "string") throw new InputError("$graphLookup needs as");
            checkName(ctx, body.as);
            if (typeof body.depthField === "string") checkName(ctx, body.depthField);
            break;
        }
        case "$unionWith": {
            const spec = isObject(body) ? body : { coll: body };
            const target = namespaceOf(spec.coll, ns.db, "$unionWith");
            if (target.db !== ns.db) throw new InputError("$unionWith can only read a collection of the same database");
            access.namespace(target.db, target.coll);
            const pipeline =
                spec.pipeline === undefined && access.mode === "deny"
                    ? undefined
                    : subPipeline(walk, spec.pipeline ?? [], target, [], "$unionWith");
            ctx.rootDerived = true;
            return { $unionWith: { coll: target.coll, ...(pipeline === undefined ? {} : { pipeline }) } };
        }
        case "$out":
        case "$merge":
            throw new InputError(
                `${name} must be the last stage of the pipeline${main ? "" : " and cannot be inside a sub-pipeline"}`,
            );
        default:
            throw new InputError(
                `the stage ${name} is not supported${name === "$indexStats" || name === "$collStats" ? "; use the index-stats or stats action" : ""}`,
            );
    }
    return stage as Doc;
}

/** What `$out` or `$merge` writes to. A `$merge` condition that is a pipeline is walked like an update pipeline. */
function checkOutput(walk: Walk, ctx: Ctx, name: "$out" | "$merge", body: unknown, ns: Ns): Ns {
    const target =
        name === "$out"
            ? namespaceOf(body, ns.db, "$out")
            : namespaceOf(isObject(body) ? body.into : undefined, ns.db, "$merge into");
    walk.access.namespace(target.db, target.coll);
    if (name === "$merge" && isObject(body)) {
        const on = typeof body.on === "string" ? [body.on] : Array.isArray(body.on) ? body.on : [];
        for (const field of on) if (typeof field === "string") checkKey(ctx, field);
        if (Array.isArray(body.whenMatched)) {
            const inner: Ctx = { ...ctx, vars: new Map([...ctx.vars, ["new", "derived"]]) };
            for (const stage of body.whenMatched) {
                const [stageName] = stageParts(stage);
                if (!UPDATE_STAGES.has(stageName))
                    throw new InputError(
                        `$merge whenMatched can use ${[...UPDATE_STAGES].join(", ")}, not ${stageName}`,
                    );
                stageOf(walk, inner, stage, ns, false);
            }
        }
    }
    return target;
}

/**
 * Checks a pipeline over `ns` and returns what to run. Throws an InputError that names the first problem: a field or a
 * collection that may not be used, a stage that is not supported, or `$out` or `$merge` anywhere but last.
 */
export function checkPipeline(raw: unknown, ns: Ns, access: Access): CheckedPipeline {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STAGES) {
        throw new InputError(`a pipeline is a list of 1 to ${MAX_STAGES} stages`);
    }
    for (const stage of raw) stageParts(stage);
    const last = stageParts(raw[raw.length - 1]);
    const writes = OUTPUT_STAGES.has(last[0]);
    const body = writes ? raw.slice(0, -1) : raw;

    const reads: Ns[] = [ns];
    reading(body, ns.db, reads);
    for (const read of reads) access.namespace(read.db, read.coll);
    const unique = reads.filter((read, index) => reads.findIndex((other) => nsName(other) === nsName(read)) === index);

    const shared = newCtx(access.view(access.mode === "deny" ? unique : [ns]));
    const walk: Walk = { access, shared, db: ns.db };
    const ctx = contextFor(walk, ns, []);
    const stages = body.map((stage) => stageOf(walk, ctx, stage, ns, true));
    const result: CheckedPipeline = { stages: withProjection(access, ns, stages), reads: unique };
    if (writes) {
        const name = last[0] as "$out" | "$merge";
        result.output = {
            stage: name,
            target: checkOutput(walk, ctx, name, last[1], ns),
            doc: raw[raw.length - 1] as Doc,
        };
    }
    return result;
}

/** Checks the stages of an update written as a pipeline. */
export function checkUpdatePipeline(raw: unknown, ns: Ns, access: Access): void {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STAGES)
        throw new InputError(`an update pipeline is a list of 1 to ${MAX_STAGES} stages`);
    const view = access.view([ns]);
    const walk: Walk = { access, shared: newCtx(view), db: ns.db };
    const ctx = newCtx(view);
    for (const stage of raw) {
        const [name] = stageParts(stage);
        if (!UPDATE_STAGES.has(name))
            throw new InputError(`an update pipeline can use ${[...UPDATE_STAGES].join(", ")}, not ${name}`);
        stageOf(walk, ctx, stage, ns, false);
    }
}
