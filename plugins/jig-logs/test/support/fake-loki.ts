// A fake Loki. It runs on the same server and transport as the fake search (see fake-search.ts), and answers
// `query_range` from streams of lines: it applies the selector, the time range, the line filters, the direction and the
// limit of the request, and it can refuse what a real Loki refuses (a range that is too long, too many lines, a selector
// that matches everything). It does not run parser stages: a pipeline after the filters passes the lines through.
import { PUBLIC_URL } from "./fake-search.ts";
import type { Answer, Json, Recorded, Responder } from "./fake-search.ts";
import { parseLogql } from "./logql.ts";
import type { Matcher } from "./logql.ts";
import { NOW } from "./world.ts";

export const SELECTOR = '{app="orders-api", env="staging"}';

/** One stream of Loki: its labels, and its lines as [nanoseconds since the epoch, text]. */
export interface Stream {
    labels: Record<string, string>;
    lines: Array<[string, string]>;
}

export const nanos = (ms: number, extraNanos = 0n): string => (BigInt(ms) * 1_000_000n + extraNanos).toString();

/** The `logs` section for Loki, with the parts a test changes replaced. `via` says how requests travel. */
export function lokiSection(over: { backend?: Json; environments?: Json; via?: "transport" } = {}): Json {
    const how = over.via === "transport" ? { transport: "corp" } : { auth: { token: "env:LOGS_TOKEN" } };
    return {
        backend: { type: "loki", url: PUBLIC_URL, ...how, ...over.backend },
        environments: over.environments ?? {
            staging: { selector: SELECTOR },
            prod: { selector: '{app="orders-api", env="production"}', jigEnvironment: "production" },
        },
    };
}

/**
 * `count` lines of one stream, `stepMs` apart, the first at `start` (25 minutes before NOW unless said). `text` makes the
 * text of line n.
 */
export function stream(
    labels: Record<string, string>,
    count: number,
    options: { start?: number; stepMs?: number; text?: (n: number) => string } = {},
): Stream {
    const start = options.start ?? NOW - 25 * 60_000;
    const stepMs = options.stepMs ?? 30_000;
    return {
        labels,
        lines: Array.from({ length: count }, (_, n): [string, string] => [
            nanos(start + n * stepMs),
            options.text?.(n) ?? `message ${n}`,
        ]),
    };
}

/** The query parameters of a request that reached the fake server. */
export function paramsOf(request: Recorded): Record<string, string> {
    return Object.fromEntries(new URL(request.path, "http://loki.test").searchParams);
}

/** A successful `query_range` reply for streams of lines. */
export function lokiReply(streams: readonly Stream[]): Answer {
    return {
        json: {
            status: "success",
            data: {
                resultType: "streams",
                result: streams.map(({ labels, lines }) => ({ stream: labels, values: lines })),
                stats: { summary: { totalLinesProcessed: 0 } },
            },
        },
    };
}

/** An error reply as Loki sends one: plain text. */
export const lokiError = (status: number, message: string): Answer => ({ status, text: message });

export interface FakeLokiOptions {
    /** `max_entries_limit_per_query`: a larger `limit` is refused. */
    maxEntries?: number;
    /** `max_query_length`: a longer range is refused. */
    maxRangeMs?: number;
}

function matches(matcher: Matcher, labels: Record<string, string>): boolean {
    const actual = labels[matcher.label] ?? "";
    const regex = () => new RegExp(`^(?:${matcher.value})$`).test(actual);
    switch (matcher.op) {
        case "=":
            return actual === matcher.value;
        case "!=":
            return actual !== matcher.value;
        case "=~":
            return regex();
        case "!~":
            return !regex();
    }
}

/** A line filter's regular expression: `(?i)` at the start means ignoring case, as in Loki. */
function pattern(value: string): RegExp {
    return value.startsWith("(?i)") ? new RegExp(value.slice(4), "i") : new RegExp(value);
}

/** Answers `query_range` from `streams`, as a Loki holding them would. */
export function fixtureResponder(streams: readonly Stream[], options: FakeLokiOptions = {}): Responder {
    return (request) => {
        const params = paramsOf(request);
        const bad = (message: string) => lokiError(400, message);
        if (request.method !== "GET" || !request.path.startsWith("/loki/api/v1/query_range?")) {
            return lokiError(404, "404 page not found");
        }
        const parsed = parseLogql(params.query ?? "");
        if (parsed === undefined) return bad("parse error at line 1, col 1: syntax error: unexpected end of input");
        const positive = parsed.matchers.some((m) => (m.op === "=" || m.op === "=~") && m.value !== "");
        if (!positive) return bad("parse error : queries require at least one regexp or equality matcher");
        const { start, end, limit, direction } = params;
        if (!/^\d+$/.test(start ?? "") || !/^\d+$/.test(end ?? "")) return bad("invalid start or end");
        if (!/^[1-9]\d*$/.test(limit ?? "")) return bad("limit must be a positive value");
        if (direction !== "forward" && direction !== "backward") return bad("invalid direction");
        const [from, to, max] = [BigInt(start as string), BigInt(end as string), Number(limit)];
        if (options.maxRangeMs !== undefined && Number(to - from) / 1e6 > options.maxRangeMs) {
            const hours = (ms: number) => `${ms / 3_600_000}h0m0s`;
            const length = hours(Number(to - from) / 1e6);
            return bad(
                `the query time range exceeds the limit (query length: ${length}, limit: ${hours(options.maxRangeMs)})`,
            );
        }
        if (options.maxEntries !== undefined && max > options.maxEntries) {
            return bad(
                `max entries limit per query exceeded, limit > max_entries_limit (${max} > ${options.maxEntries})`,
            );
        }

        const found: Array<{ stream: number; ns: bigint; text: string }> = [];
        streams.forEach((candidate, index) => {
            if (!parsed.matchers.every((matcher) => matches(matcher, candidate.labels))) return;
            for (const [stamp, text] of candidate.lines) {
                const ns = BigInt(stamp);
                if (ns < from || ns >= to) continue;
                const kept = parsed.filters.every((filter) => {
                    switch (filter.op) {
                        case "|=":
                            return text.includes(filter.value);
                        case "!=":
                            return !text.includes(filter.value);
                        case "|~":
                            return pattern(filter.value).test(text);
                        case "!~":
                            return !pattern(filter.value).test(text);
                    }
                });
                if (kept) found.push({ stream: index, ns, text });
            }
        });
        const sign = direction === "backward" ? -1 : 1;
        found.sort((a, b) => sign * (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
        const taken = found.slice(0, max);
        const grouped = streams
            .map((candidate, index) => ({
                labels: candidate.labels,
                lines: taken
                    .filter((line) => line.stream === index)
                    .map((line): [string, string] => [line.ns.toString(), line.text]),
            }))
            .filter((group) => group.lines.length > 0);
        return lokiReply(grouped);
    };
}
