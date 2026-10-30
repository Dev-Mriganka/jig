// Reading the backend's replies. Nothing here trusts the shape of what came back.
import { isObject } from "./values.ts";

/** The fields of one hit that were asked for: its `_source`. */
export type Source = Record<string, unknown>;

export interface SearchPage {
    total: number;
    /** "gte" when the backend only knows a lower bound. */
    relation: "eq" | "gte";
    hits: Source[];
    /** Set when this reply is known to be missing data. */
    incomplete?: "search_timeout" | "failed_shards";
}

/** The reply's JSON object, or undefined when the text is anything else. */
export function parseBody(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function failedShards(body: Record<string, unknown>): number {
    const shards = body._shards;
    return isObject(shards) && typeof shards.failed === "number" ? shards.failed : 0;
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseSearch(text: string): SearchPage | undefined {
    const body = parseBody(text);
    const hits = body?.hits;
    if (body === undefined || !isObject(hits) || !Array.isArray(hits.hits)) return undefined;
    // Version 7 and later report { value, relation }; a bare number is the older form.
    const total = isObject(hits.total) ? hits.total.value : hits.total;
    if (!isCount(total)) return undefined;
    const relation = isObject(hits.total) && hits.total.relation === "gte" ? "gte" : "eq";
    const sources: Source[] = [];
    for (const row of hits.hits) {
        if (!isObject(row)) return undefined;
        sources.push(isObject(row._source) ? row._source : {});
    }
    const incomplete =
        body.timed_out === true ? "search_timeout" : failedShards(body) > 0 ? "failed_shards" : undefined;
    return { total, relation, hits: sources, ...(incomplete === undefined ? {} : { incomplete }) };
}

/**
 * The class name of the backend's error, such as `index_not_found_exception` or `query_shard_exception`, when the
 * reply carries one. It names the kind of failure, not the data, so it is safe to show; the error's text is not
 * kept, because a rejected query's text repeats the query.
 */
export function errorType(text: string): string | undefined {
    const error = parseBody(text)?.error;
    if (!isObject(error)) return undefined;
    const causes = error.root_cause;
    const cause: unknown = Array.isArray(causes) ? causes[0] : undefined;
    const type = isObject(cause) && typeof cause.type === "string" ? cause.type : error.type;
    return typeof type === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(type) ? type : undefined;
}
