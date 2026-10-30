// The request bodies sent to the backend. Every one is built here, in one place, from a narrow grammar:
//
//   { size, timeout, track_total_hits, query: { bool: { filter: [...], must: [...] } }, sort, _source }
//
// The model's text only ever lands in one value: the phrase of a `match_phrase`, or the string of a `query_string`. It
// never becomes a key, a field name or a clause of its own, so a call cannot ask the backend for anything else: no
// scripts, aggregations or other indexes. Field names, the index and the environment filter come from configuration.
import type { Target } from "./config.ts";
import { iso } from "./time.ts";
import type { Range } from "./time.ts";

/** What `text` is: an exact phrase, or a Lucene query. */
export type SearchKind = "phrase" | "query";

/** Which end of the window the hits come from; the sort inside each request follows it. */
export type Order = "asc" | "desc";

/** What one `logs` call asks for, after its parameters were checked and the defaults applied. */
export interface LogQuery {
    /** The environment as the tool names it. */
    environment: string;
    target: Target;
    kind: SearchKind;
    text: string;
    /** How many hits to fetch in all. */
    size: number;
    /** asc: the oldest hits of the window. desc: the newest. */
    order: Order;
    range: Range;
}

export type Clause = Record<string, unknown>;
export type SearchBody = Record<string, unknown>;

/**
 * The backend gives up on a shard search after this and answers with what it has, marked `timed_out`; the bucket is
 * then halved and tried again. It is shorter than the 30 seconds one request may take, so the backend's answer comes
 * before our own timeout cuts the connection.
 */
export const SEARCH_TIMEOUT = "25s";

/** The time range and the environment's own filter. Every request carries both. */
function scope(query: LogQuery, range: Range): Clause[] {
    const { timeField, filter } = query.target;
    return [
        // `format` makes the bounds mean ISO instants whatever date format the field was mapped with.
        { range: { [timeField]: { gte: iso(range.from), lt: iso(range.to), format: "strict_date_optional_time" } } },
        ...Object.entries(filter).map(([field, value]): Clause => ({ term: { [field]: value } })),
    ];
}

function messageClause(query: LogQuery): Clause {
    const field = query.target.messageField;
    // `analyze_wildcard` lets `Timeout*` find the lower-cased terms a text field stores, as Kibana's own search does.
    return query.kind === "query"
        ? { query_string: { query: query.text, default_field: field, analyze_wildcard: true } }
        : { match_phrase: { [field]: query.text } };
}

/**
 * One bucket search. `size` is how many hits are still wanted: once enough are collected, the buckets that remain ask
 * for 0 and only add their exact total.
 */
export function searchBody(query: LogQuery, bucket: Range, size: number): SearchBody {
    const { timeField, messageField } = query.target;
    const body: SearchBody = {
        size,
        timeout: SEARCH_TIMEOUT,
        track_total_hits: true,
        query: { bool: { filter: scope(query, bucket), must: [messageClause(query)] } },
    };
    if (size > 0) {
        body.sort = [{ [timeField]: { order: query.order, unmapped_type: "date" } }];
        body._source = [timeField, messageField];
    }
    return body;
}

/**
 * How many documents the environment has in the range, whatever they say: the time range and the environment's filter
 * and nothing else. A search that finds nothing uses it to tell "nothing matches" from "nothing is there".
 */
export function probeBody(query: LogQuery, range: Range): SearchBody {
    return {
        size: 0,
        timeout: SEARCH_TIMEOUT,
        track_total_hits: true,
        query: { bool: { filter: scope(query, range) } },
    };
}
