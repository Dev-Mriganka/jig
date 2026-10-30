// Grafana Loki: `GET <url>/loki/api/v1/query_range`, with the LogQL query, the time range, a limit and a direction in
// the address. The facts this file relies on, and where they were read, are in docs/not-verified.md.
//
// A search is the stream selector from the configuration, then line filters, then perhaps the model's own pipeline:
//
//   {app="orders-api", env="staging"} |~ "(?i)req-7f3a9c" |~ "(?i)timeout" !~ "(?i)Heartbeat"
//
// The model's text lands in one of two places. A phrase, a `match` and an `exclude` become line filters that ignore case:
// the text matched literally (every regular-expression character escaped), in a quoted string escaped so that nothing
// in it can close the string. A `query` is a pipeline that is checked first, so it
// cannot open another stream selector (see logql.ts). The selector is never the model's.
//
// Loki answers a log query with the lines of the streams it found, and has no count to give with them. The total of a
// bucket is therefore the number of lines returned, and a lower bound when the bucket filled its limit.
import type { LokiTarget, Target } from "../config.ts";
import { final, transient } from "../failure.ts";
import type { LogQuery } from "../query.ts";
import { parseBody } from "../response.ts";
import type { Source } from "../response.ts";
import { HOUR_MS } from "../time.ts";
import { isObject } from "../values.ts";
import type { LogBackend } from "./backend.ts";
import { checkPipeline, literalPattern, quote, selectorProblem } from "./logql.ts";

/** Loki's default `max_entries_limit_per_query`, the most lines one query returns. An operator may set it lower. */
const MAX_ENTRIES = 5000;
/** Loki's default `max_query_length`, 721 hours: the longest time range one query covers. */
const MAX_RANGE_MS = 721 * HOUR_MS;

/** A hit keeps its time and its line under these names, and the labels of its stream beside them. */
const TIME_FIELD = "@timestamp";
const MESSAGE_FIELD = "message";

/** A tenant id goes into a header: visible characters, no spaces. Loki also reads `a|b` as two tenants. */
const TENANT = /^[\x21-\x7e]{1,300}$/;

/** The environment as this backend made it. Only environments this backend made reach its functions. */
function lokiTarget(target: Target): LokiTarget {
    if (target.type !== "loki") throw new Error("a Loki search was given an Elasticsearch environment");
    return target;
}

/** Nanoseconds since the epoch, as Loki takes them. That is too many digits for a number, so it is written as text. */
function nanos(ms: number): string {
    return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** How many lines to ask for: those still wanted, but at least one (Loki wants a positive limit) and at most Loki's. */
function limitFor(size: number): number {
    return Math.min(Math.max(size, 1), MAX_ENTRIES);
}

/** The selector, then the line filters that every backend understands, then the model's pipeline, if it wrote one. */
function logql(query: LogQuery): string {
    const stages: string[] = [];
    // Case is ignored, as the tool promises for every backend: Loki's `|=` and `!=` match case, so the filters are
    // `|~` and `!~` with `(?i)` and the text matched literally.
    const ignoringCase = (text: string) => quote(`(?i)${literalPattern(text)}`);
    if (query.kind === "phrase") stages.push(`|~ ${ignoringCase(query.text)}`);
    for (const text of query.match ?? []) stages.push(`|~ ${ignoringCase(text)}`);
    for (const text of query.exclude ?? []) stages.push(`!~ ${ignoringCase(text)}`);
    // Checked again here, so that a request is never built from a pipeline nobody looked at.
    if (query.kind === "query") stages.push(checkPipeline(query.text));
    return [lokiTarget(query.target).selector, ...stages].join(" ");
}

// ---- reading a reply ---------------------------------------------------------------------------------------------

interface Entry {
    ns: bigint;
    line: string;
    labels: Record<string, string>;
}

/** A time in nanoseconds since the epoch as an ISO instant, with the digits after the second it needs: 3, 6 or 9. */
function isoOfNanos(ns: bigint): string {
    const seconds = new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 19);
    const fraction = (ns % 1_000_000_000n).toString().padStart(9, "0");
    const digits = fraction.endsWith("000000") ? 3 : fraction.endsWith("000") ? 6 : 9;
    return `${seconds}.${fraction.slice(0, digits)}Z`;
}

function labelsOf(value: unknown): Record<string, string> {
    const labels: Record<string, string> = {};
    if (isObject(value)) {
        for (const [name, text] of Object.entries(value)) if (typeof text === "string") labels[name] = text;
    }
    return labels;
}

/** One `[nanoseconds, line]` of a stream. Newer Loki may add a third part, structured metadata, which is not read. */
function entryOf(value: unknown, labels: Record<string, string>): Entry | undefined {
    if (!Array.isArray(value)) return undefined;
    const [stamp, line] = value;
    if (typeof stamp !== "string" || !/^\d{1,20}$/.test(stamp) || typeof line !== "string") return undefined;
    return { ns: BigInt(stamp), line, labels };
}

export const loki: LogBackend = {
    type: "loki",

    config: {
        backendFields: ["tenant"],
        environmentFields: ["selector"],
        needs: "a selector",
        exampleUrl: "https://logs.example.com:3100",
    },

    checkBackendFields(raw, key, errors) {
        if (raw.tenant !== undefined && (typeof raw.tenant !== "string" || !TENANT.test(raw.tenant))) {
            errors.push(`${key}.tenant must be the tenant id: visible characters without spaces, such as orders`);
        }
    },

    checkEnvironmentFields(raw, key, errors) {
        const problem = selectorProblem(raw.selector);
        if (problem === "form") {
            errors.push(`${key}.selector must be a stream selector, such as {app="orders-api", env="staging"}`);
        } else if (problem === "positive") {
            const why = "Loki refuses a selector that can match every stream";
            errors.push(`${key}.selector needs a label that equals a value (= or =~): ${why}`);
        }
    },

    environment(name, raw) {
        return {
            type: "loki",
            selector: (raw.selector as string).trim(),
            timeField: TIME_FIELD,
            messageField: MESSAGE_FIELD,
            jigEnvironment: (raw.jigEnvironment as string | undefined) ?? name,
        };
    },

    limits: { maxHits: MAX_ENTRIES, maxWindowMs: MAX_RANGE_MS },

    checkQuery(text) {
        checkPipeline(text);
    },

    // A bucket is from `from` up to, not including, `to`, and so is Loki's range. Every request is a log query, which
    // Loki limits by lines and cannot count, so a bucket that only counts asks for one line.
    search(query, bucket, size) {
        return {
            query: logql(query),
            start: nanos(bucket.from),
            end: nanos(bucket.to),
            limit: String(limitFor(size)),
            direction: query.order === "desc" ? "backward" : "forward",
        };
    },

    // Only the selector, so it asks about the streams of the environment and about nothing the model wrote.
    probe(query, range) {
        const { selector } = lokiTarget(query.target);
        return { query: selector, start: nanos(range.from), end: nanos(range.to), limit: "1", direction: "forward" };
    },

    wire(_target, connection) {
        return (request) => {
            const parameters = new URLSearchParams();
            for (const [name, value] of Object.entries(request)) parameters.set(name, String(value));
            return {
                method: "GET",
                path: `/loki/api/v1/query_range?${parameters}`,
                ...(connection.tenant === undefined ? {} : { headers: { "X-Scope-OrgID": connection.tenant } }),
            };
        };
    },

    parse(reply, request) {
        const body = parseBody(reply);
        const data = body?.data;
        if (body?.status !== "success" || !isObject(data) || data.resultType !== "streams") return undefined;
        if (!Array.isArray(data.result)) return undefined;
        const entries: Entry[] = [];
        for (const stream of data.result) {
            if (!isObject(stream) || !Array.isArray(stream.values)) return undefined;
            const labels = labelsOf(stream.stream);
            for (const value of stream.values) {
                const entry = entryOf(value, labels);
                if (entry === undefined) return undefined;
                entries.push(entry);
            }
        }
        // Loki sorts the lines of each stream, not the streams among each other.
        const { direction, limit } = request as { direction?: unknown; limit?: unknown };
        const sign = direction === "backward" ? -1 : 1;
        entries.sort((a, b) => sign * (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
        return {
            total: entries.length,
            // A reply that filled its limit may have left lines behind.
            relation: entries.length >= Number(limit) ? "gte" : "eq",
            hits: entries.map(({ ns, line, labels }): Source => ({
                ...labels,
                [TIME_FIELD]: isoOfNanos(ns),
                [MESSAGE_FIELD]: line,
            })),
        };
    },

    // Loki words its limits in plain text, with a 400. The phrases are the ones its troubleshooting page quotes, and
    // they are matched loosely because the rest of a message differs between versions.
    classify(status, reply) {
        if (status === 413) return final("response_too_large");
        if (status !== 400) return undefined;
        // A shorter bucket gets past the longest range, so it is halved. Halving does not lower the number of lines a
        // request asks for, and the next bucket asks for as many, so that error stops the search.
        if (/time range exceeds the limit|max(?:imum)? query length/i.test(reply)) return transient("window_too_long");
        if (/max entries limit/i.test(reply)) return final("response_too_large", true);
        return undefined;
    },

    words: {
        resource: "the logs",
        signIn: "backend.auth and backend.tenant",
        queryRejected:
            'The backend rejected the query; for query check the LogQL syntax (it starts with |, as in |= "text" ' +
            'or | json | level="error"), otherwise use phrase.',
        notFound:
            "The backend answered 404: backend.url in the logs section of jig.json may be wrong, " +
            "as Loki serves /loki/api/v1/query_range.",
    },
};
