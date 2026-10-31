// The index check of a read. Where the environment requires it (production by default), the server's planner is asked how a read
// would run, with `explain` at queryPlanner (the planner only: nothing is executed), and a read whose plan scans the whole
// collection is refused. A scan of a big collection is slow for everyone who uses the database, and a broad scan is how too much
// data gets read. The refusal names the fields that lead an index of the collection, so the agent can rewrite the query.
//
// Three more things hold:
// - a check that cannot be made is a refusal, never a pass: a failed explain, or a plan with no stage in it that can be read;
// - a collection the allow list marks `reference: true` is small, and is read whole;
// - the planner does not report the foreign side of a `$lookup`, so a `$lookup` that matches on a field is checked against the
//   index list of the collection it joins.
import { fieldPath } from "./access.ts";
import type { Access, Ns } from "./access.ts";
import type { Backend, ExplainQuery, Req } from "./backend.ts";
import { toExtended } from "./bson.ts";
import { describeFailure, isAbort } from "./errors.ts";
import { InputError, isObject } from "./values.ts";
import type { Doc } from "./values.ts";

/** How a read is planned. Absent, or without `requireIndex`, no read is checked. */
export interface PlanOptions {
    /** Refuse a read whose plan scans the collection. The tool sets it from the connection: on for production unless it says off. */
    requireIndex?: boolean;
}

export interface IndexCheck {
    ns: Ns;
    /** `mongo find production orders.orders`: the start of every line this call prints. */
    label: string;
    /** The environment's name, for the sentence that says why. */
    environment: string;
    maxTimeMS: number;
    /** The read as it would run: a find (filter, projection, sort, limit) or a pipeline. */
    query: Omit<ExplainQuery, "verbosity">;
    /** The read has no filter, so it touches every document whatever the plan is: refused without asking the planner. */
    everything?: boolean;
    /** Another way to the answer, said after a refusal. */
    advice?: string;
}

/** The check for a read, or undefined when none is needed: the environment does not require it, or the collection is reference data. */
export function indexCheckFor(
    options: PlanOptions | undefined,
    access: Access,
    check: IndexCheck,
): IndexCheck | undefined {
    if (options?.requireIndex !== true) return undefined;
    return access.isReference(check.ns.db, check.ns.coll) ? undefined : check;
}

// ---- the plan ----------------------------------------------------------------------------------------------------------

/** A stage of a plan that reads a whole collection: a collection scan, or a join that reads the joined collection whole. */
export type Scan = { stage: "COLLSCAN" } | { stage: "EQ_LOOKUP"; strategy: string; ns?: Ns; field?: string };

/** What the planner's answer holds: how many stages it names, and which of them read a collection whole. */
interface PlanFacts {
    stages: number;
    scans: Scan[];
}

const MAX_DEPTH = 60;
const MAX_NODES = 50_000;

/** The strategies of the slot-based `$lookup` that read the joined collection whole (an indexed join reads by index). */
const LOOKUP_SCANS: ReadonlySet<string> = new Set(["HashJoin", "NestedLoopJoin"]);

/** `orders.customers`, as a join names the collection it reads: the database ends at the first dot. */
function nsFrom(text: unknown): Ns | undefined {
    if (typeof text !== "string") return undefined;
    const dot = text.indexOf(".");
    return dot < 1 || dot === text.length - 1 ? undefined : { db: text.slice(0, dot), coll: text.slice(dot + 1) };
}

/**
 * Reads the stages of every winning plan in an explain, wherever the server put them: a find has one under
 * `queryPlanner`, an aggregation has one in the `$cursor` stage, a `$unionWith` has another inside it, and a sharded query has
 * one per shard. The plans the planner rejected are not what runs, so they are left out.
 */
export function readPlan(explain: unknown): PlanFacts {
    const facts: PlanFacts = { stages: 0, scans: [] };
    let nodes = 0;
    const walk = (node: unknown, depth: number): void => {
        if (depth > MAX_DEPTH || nodes++ > MAX_NODES) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
        } else if (isObject(node)) {
            if (typeof node.stage === "string") {
                facts.stages++;
                if (node.stage === "COLLSCAN") facts.scans.push({ stage: "COLLSCAN" });
                else if (node.stage === "EQ_LOOKUP" && LOOKUP_SCANS.has(String(node.strategy))) {
                    const ns = nsFrom(node.foreignCollection);
                    facts.scans.push({
                        stage: "EQ_LOOKUP",
                        strategy: String(node.strategy),
                        ...(ns === undefined ? {} : { ns }),
                        ...(typeof node.foreignField === "string" ? { field: node.foreignField } : {}),
                    });
                }
            }
            for (const [key, value] of Object.entries(node)) if (key !== "rejectedPlans") walk(value, depth + 1);
        }
    };
    walk(explain, 0);
    return facts;
}

// ---- the joins ---------------------------------------------------------------------------------------------------------

interface Join {
    ns: Ns;
    /** The field of the joined collection that the `$lookup` matches on. */
    field: string;
}

/** The `$lookup` stages that match on a field of the joined collection, anywhere in a pipeline (a `$facet` branch holds some). */
function joinsOf(node: unknown, db: string, found: Join[] = [], depth = 0): Join[] {
    if (depth > MAX_DEPTH) return found;
    if (Array.isArray(node)) {
        for (const item of node) joinsOf(item, db, found, depth + 1);
    } else if (isObject(node)) {
        for (const [key, value] of Object.entries(node)) {
            if (key === "$lookup" && isObject(value) && typeof value.foreignField === "string") {
                const from = value.from;
                if (typeof from === "string") found.push({ ns: { db, coll: from }, field: value.foreignField });
                else if (isObject(from) && typeof from.db === "string" && typeof from.coll === "string")
                    found.push({ ns: { db: from.db, coll: from.coll }, field: value.foreignField });
            }
            joinsOf(value, db, found, depth + 1);
        }
    }
    return found;
}

// ---- the indexes -------------------------------------------------------------------------------------------------------

/** The field each index of a collection starts with, once each, in the order the indexes are listed. Text and wildcard indexes lead with no field. */
async function leadingFields(backend: Backend, ns: Ns, req: Req): Promise<string[]> {
    const fields: string[] = [];
    for (const index of await backend.indexes(ns, req)) {
        const first = isObject(index.key) ? Object.keys(index.key)[0] : undefined;
        if (first !== undefined && !first.startsWith("_fts") && !first.includes("$") && !fields.includes(first))
            fields.push(first);
    }
    return fields;
}

const SHOWN_FIELDS = 5;

/** The sentence that names the fields an index leads with. It names only fields that may be seen, and says how many it left out. */
async function fieldsSentence(backend: Backend, access: Access, ns: Ns, req: Req): Promise<string> {
    let fields: string[];
    try {
        fields = await leadingFields(backend, ns, req);
    } catch {
        return "`mongo indexes` lists the indexes.";
    }
    const view = access.view([ns]);
    const visible = fields.filter((field) => view.visibility(fieldPath(field)) !== "no");
    if (visible.length === 0) return "No index leads with a field you may see; `mongo indexes` lists the indexes.";
    const named = visible.slice(0, SHOWN_FIELDS).join(", ");
    const more = visible.length - SHOWN_FIELDS;
    return `Filter on a field an index leads with: ${named}${more > 0 ? ` (+${more} more; \`mongo indexes\` lists all)` : ""}.`;
}

// ---- the check ---------------------------------------------------------------------------------------------------------

async function refusal(
    backend: Backend,
    access: Access,
    check: IndexCheck,
    ns: Ns,
    why: string,
    req: Req,
): Promise<InputError> {
    const fields = await fieldsSentence(backend, access, ns, req);
    const advice = check.advice === undefined ? "" : ` ${check.advice}`;
    return new InputError(
        `${check.label}: refused, ${why}, and reads in ${check.environment} must use an index. ${fields}${advice}`,
    );
}

/** A check that could not be made. Nothing was read, and the read is not sent without it. */
function unchecked(check: IndexCheck, what: string): InputError {
    return new InputError(
        `${check.label}: refused, the index check could not be made (${what}), and a read here is not sent without it. Nothing was read.`,
    );
}

/**
 * Asks the planner how the read would run, and refuses it when it scans the collection. Throws an InputError for a refusal. A call
 * that is cancelled or runs out of time throws what it threw, for the tool to word as it does for any call.
 */
export async function enforceIndex(
    backend: Backend,
    access: Access,
    check: IndexCheck,
    signal: AbortSignal,
): Promise<void> {
    const req: Req = { maxTimeMS: check.maxTimeMS, signal };
    const failure = (error: unknown): unknown => {
        if (signal.aborted || isAbort(error)) return error;
        const context = {
            environment: check.environment,
            production: true,
            maxTimeMS: check.maxTimeMS,
            aborted: false,
        };
        return unchecked(check, describeFailure(error, context).message);
    };
    try {
        if (check.everything === true) {
            throw await refusal(backend, access, check, check.ns, "with no filter it reads every document", req);
        }
        const explained = await backend.explain({ ...check.query, verbosity: "queryPlanner" }, req);
        const plan = readPlan(toExtended(explained) as Doc);
        if (plan.stages === 0) throw unchecked(check, "the planner's answer holds no plan that can be read");
        // A scan of the collection that is read comes first; a join that reads another collection whole comes after it.
        const scan = plan.scans.find((item) => item.stage === "COLLSCAN") ?? plan.scans[0];
        if (scan?.stage === "COLLSCAN") {
            throw await refusal(
                backend,
                access,
                check,
                check.ns,
                "the plan scans the whole collection (COLLSCAN)",
                req,
            );
        }
        if (scan?.stage === "EQ_LOOKUP") {
            const ns = scan.ns ?? check.ns;
            const on = scan.field === undefined ? "" : `, since no index of it leads with ${scan.field}`;
            const why = `the plan joins by reading all of ${ns.coll} (the $lookup uses a ${scan.strategy})${on}`;
            throw await refusal(backend, access, check, ns, why, req);
        }
        for (const join of joinsOf(check.query.pipeline, check.ns.db)) {
            if (join.field === "_id" || access.isReference(join.ns.db, join.ns.coll)) continue;
            if ((await leadingFields(backend, join.ns, req)).includes(join.field)) continue;
            const why = `the $lookup into ${join.ns.coll} matches on ${join.field}, which no index of it leads with, so it would scan ${join.ns.coll} for each document`;
            throw await refusal(backend, access, check, join.ns, why, req);
        }
    } catch (error) {
        if (error instanceof InputError) throw error;
        throw failure(error);
    }
}
