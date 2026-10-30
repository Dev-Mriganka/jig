// The plan of a query, in a few lines: which index, how many documents were examined, how long it took. The raw explain of a
// server is long and repeats the filter, so only the parts that answer "did it use an index" are kept.
import { isObject } from "./values.ts";
import type { Doc } from "./values.ts";
import { plural } from "./render.ts";

/** The first value under `key`, anywhere in the explain: its place differs for a find, an aggregation and a sharded query. */
function find(node: unknown, key: string, depth = 0): unknown {
    if (depth > 12) return undefined;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = find(item, key, depth + 1);
            if (found !== undefined) return found;
        }
    } else if (isObject(node)) {
        if (key in node) return node[key];
        for (const [name, value] of Object.entries(node)) {
            if (name === "rejectedPlans") continue;
            const found = find(value, key, depth + 1);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

/** `FETCH > IXSCAN(status_1)`, or `OR[IXSCAN(a), IXSCAN(b)]` where a stage has several inputs. */
function chain(plan: unknown, depth = 0): { text: string; stages: string[] } {
    if (!isObject(plan) || depth > 20) return { text: "?", stages: [] };
    const node = isObject(plan.queryPlan) ? plan.queryPlan : plan;
    const stage = typeof node.stage === "string" ? node.stage : "?";
    const label = typeof node.indexName === "string" ? `${stage}(${node.indexName})` : stage;
    const inputs = isObject(node.inputStage)
        ? [node.inputStage]
        : Array.isArray(node.inputStages)
          ? node.inputStages
          : [];
    if (inputs.length === 0) return { text: label, stages: [stage] };
    const inner = inputs.map((input) => chain(input, depth + 1));
    const stages = [stage, ...inner.flatMap((item) => item.stages)];
    if (inner.length === 1) return { text: `${label} > ${(inner[0] as { text: string }).text}`, stages };
    return { text: `${label}[${inner.map((item) => item.text).join(", ")}]`, stages };
}

const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** Lines for the model: the plan's shape, a warning for a scan of the whole collection, and the numbers of an executed query. */
export function summarizeExplain(explain: Doc): string[] {
    const planner = find(explain, "queryPlanner");
    const winning = isObject(planner) ? planner.winningPlan : find(explain, "winningPlan");
    const { text, stages } = chain(winning);
    const lines = [`plan: ${text}`];
    if (stages.includes("COLLSCAN")) {
        lines.push(
            "warning: COLLSCAN reads the whole collection. Filter on an indexed field, or add an index (indexes lists them)",
        );
    } else if (
        !stages.some(
            (stage) =>
                stage.includes("IXSCAN") || stage === "IDHACK" || stage === "COUNT_SCAN" || stage === "DISTINCT_SCAN",
        )
    ) {
        lines.push("note: no index scan in this plan");
    }
    const rejected = isObject(planner) && Array.isArray(planner.rejectedPlans) ? planner.rejectedPlans.length : 0;
    if (rejected > 0) lines.push(`rejected plans: ${rejected}`);
    const stats = find(explain, "executionStats");
    if (isObject(stats)) {
        const parts = [
            number(stats.nReturned) === undefined
                ? undefined
                : `returned ${plural(number(stats.nReturned) as number, "document")}`,
            number(stats.totalKeysExamined) === undefined
                ? undefined
                : `${plural(number(stats.totalKeysExamined) as number, "index key")} examined`,
            number(stats.totalDocsExamined) === undefined
                ? undefined
                : `${plural(number(stats.totalDocsExamined) as number, "document")} examined`,
            number(stats.executionTimeMillis) === undefined ? undefined : `${number(stats.executionTimeMillis)} ms`,
        ].filter((part) => part !== undefined);
        if (parts.length > 0) lines.push(`executed: ${parts.join(", ")}`);
    }
    return lines;
}
