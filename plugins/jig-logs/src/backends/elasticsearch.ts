// Elasticsearch and OpenSearch: `POST <url>/<index>/_search` with a JSON body.
//
// Every body is built here, in one place, from a narrow grammar:
//
//   { size, timeout, track_total_hits, query: { bool: { filter: [...], must: [...] } }, sort, _source }
//
// The model's text only ever lands in one value: the phrase of a `match_phrase`, or the string of a `query_string`. It
// never becomes a key, a field name or a clause of its own, so a call cannot ask the backend for anything else: no
// scripts, aggregations or other indexes. Field names, the index and the environment filter come from configuration.
import type { ElasticTarget, FilterSetting, Target } from "../config.ts";
import { final } from "../failure.ts";
import { checkFilter, isList } from "../filter.ts";
import type { LogQuery } from "../query.ts";
import { parseBody } from "../response.ts";
import type { SearchPage, Source } from "../response.ts";
import { iso } from "../time.ts";
import type { Range } from "../time.ts";
import { isObject } from "../values.ts";
import type { LogBackend } from "./backend.ts";

export const DEFAULT_TIME_FIELD = "@timestamp";
export const DEFAULT_MESSAGE_FIELD = "message";

export type Clause = Record<string, unknown>;
export type SearchBody = Record<string, unknown>;

/**
 * The backend gives up on a shard search after this and answers with what it has, marked `timed_out`; the bucket is
 * then halved and tried again. It is shorter than the 30 seconds one request may take, so the backend's answer comes
 * before our own timeout cuts the connection.
 */
export const SEARCH_TIMEOUT = "25s";

/** The environment as this backend made it. Only environments this backend made reach its functions. */
function elastic(target: Target): ElasticTarget {
    if (target.type === "loki") throw new Error("an Elasticsearch search was given a Loki environment");
    return target;
}

/** The time range and the environment's own filter. Every request carries both. */
function scope(query: LogQuery, range: Range): Clause[] {
    const { timeField, filter } = elastic(query.target);
    return [
        // `format` makes the bounds mean ISO instants whatever date format the field was mapped with.
        { range: { [timeField]: { gte: iso(range.from), lt: iso(range.to), format: "strict_date_optional_time" } } },
        // One value is a `term`; a list is a `terms`, which a document matches when its field equals any of them.
        ...Object.entries(filter).map(
            ([field, value]): Clause => (isList(value) ? { terms: { [field]: value } } : { term: { [field]: value } }),
        ),
    ];
}

function messageClause(query: LogQuery): Clause {
    const field = elastic(query.target).messageField;
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
    const { timeField, messageField } = elastic(query.target);
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

// ---- reading a reply ---------------------------------------------------------------------------------------------

function failedShards(body: Record<string, unknown>): number {
    const shards = body._shards;
    return isObject(shards) && typeof shards.failed === "number" ? shards.failed : 0;
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseSearch(text: string): SearchPage | undefined {
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
function errorType(text: string): string | undefined {
    const error = parseBody(text)?.error;
    if (!isObject(error)) return undefined;
    const causes = error.root_cause;
    const cause: unknown = Array.isArray(causes) ? causes[0] : undefined;
    const type = isObject(cause) && typeof cause.type === "string" ? cause.type : error.type;
    return typeof type === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(type) ? type : undefined;
}

// ---- the settings of an environment ------------------------------------------------------------------------------

/** An index name or pattern: letters, digits and `_ . * : , -`, so it can be put in a request path as it is. */
const INDEX = /^[A-Za-z0-9_.*:,-]{1,255}$/;
const FIELD = /^[A-Za-z0-9_.@-]{1,128}$/;

export const elasticsearch: LogBackend = {
    type: "elasticsearch",

    config: {
        backendFields: [],
        environmentFields: ["index", "timeField", "messageField", "filter"],
        needs: "an index",
        exampleUrl: "https://logs.example.com:9200",
    },

    checkEnvironmentFields(raw, key, errors) {
        const index = raw.index;
        const parts = typeof index === "string" ? index.split(",") : [];
        // `.` and `..` would be read as part of the path when the index is put in the request address.
        if (
            typeof index !== "string" ||
            !INDEX.test(index) ||
            parts.some((part) => part === "" || part === "." || part === "..")
        ) {
            errors.push(`${key}.index must be an index name or pattern, such as app-logs-*`);
        }
        for (const field of ["timeField", "messageField"] as const) {
            if (raw[field] !== undefined && (typeof raw[field] !== "string" || !FIELD.test(raw[field]))) {
                errors.push(`${key}.${field} must be a field name`);
            }
        }
        if (raw.filter !== undefined)
            checkFilter(raw.filter, `${key}.filter`, { pattern: FIELD, noun: "field" }, errors);
    },

    environment(name, raw) {
        return {
            index: raw.index as string,
            timeField: (raw.timeField as string | undefined) ?? DEFAULT_TIME_FIELD,
            messageField: (raw.messageField as string | undefined) ?? DEFAULT_MESSAGE_FIELD,
            filter: (raw.filter as Record<string, FilterSetting> | undefined) ?? {},
            jigEnvironment: (raw.jigEnvironment as string | undefined) ?? name,
        };
    },

    // Elasticsearch has no limit on the time a search covers, and 10 000 hits is the default `index.max_result_window`.
    limits: { maxHits: 10_000, maxWindowMs: Number.POSITIVE_INFINITY },

    search: searchBody,
    probe: probeBody,

    wire(target) {
        return (request) => ({
            method: "POST",
            path: `/${elastic(target).index}/_search`,
            body: JSON.stringify(request),
        });
    },

    parse: (reply) => parseSearch(reply),

    // A missing index comes with 404 or, for a pattern, 400: the class name of the error decides.
    classify: (_status, reply) =>
        errorType(reply) === "index_not_found_exception" ? final("index_not_found", true) : undefined,

    words: {
        resource: "the index",
        signIn: "backend.auth",
        queryRejected:
            "The backend rejected the query; for query check the Lucene syntax " +
            "(AND, OR and NOT in capitals, quotes around phrases), otherwise use phrase.",
        notFound: "The index was not found: the environment's index in the logs section of jig.json may be wrong.",
    },
};
