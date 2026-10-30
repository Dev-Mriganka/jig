// Runs one log query as a series of bounded requests and reports exactly what was and was not covered.
//
// The window is cut into buckets (see `planBuckets`) and searched one after the other. A bucket that times out or loses
// shards is halved and searched again, a few times over. What still cannot be searched becomes a gap in the result
// instead of silently missing: the answer says what it covers.
//
// Nothing here knows which kind of backend answers. The backend of the query's environment builds each request, reads
// each reply and says what an error means (see backends/); this file decides what to ask next.
import { backendOf } from "./backends/index.ts";
import type { LogBackend } from "./backends/index.ts";
import { failureFromError, failureFromStatus } from "./failure.ts";
import type { Failure, FailureReason } from "./failure.ts";
import type { LogQuery } from "./query.ts";
import type { Send } from "./request.ts";
import type { SearchPage, Source } from "./response.ts";
import { halve, iso, planBuckets } from "./time.ts";
import type { Bucket } from "./time.ts";

/** The most requests one call makes: searches and the check for data together. */
export const MAX_REQUESTS = 64;
/** One request is kept back, so that a search that finds nothing can always check whether the window holds any data. */
const SEARCH_REQUESTS = MAX_REQUESTS - 1;
/** No new request starts after this; the windows that are left are reported as missing. */
const TIME_BUDGET_MS = 150_000;

export type SearchStatus = "complete" | "partial" | "failed";

export interface WindowReport {
    from: string;
    to: string;
    /** searched: the whole window answered. partial: it answered but is known to be incomplete. missing: no answer. */
    state: "searched" | "partial" | "missing";
    total?: number;
    returned?: number;
    reason?: FailureReason;
}

export interface Availability {
    /** documents: the window has data, without your phrase or query. none: it has none. unknown: could not tell. */
    state: "documents" | "none" | "unknown";
    count?: number;
    reason?: FailureReason;
}

export interface SearchOutcome {
    status: SearchStatus;
    /** "gte" when the number is a lower bound: a window is missing, or the backend counted only up to a limit. */
    total: { value: number; relation: "eq" | "gte" };
    /** In time order, whichever end was searched first. */
    windows: WindowReport[];
    hits: Source[];
    /** How often a bucket was halved and searched again. */
    splits: number;
    /** Requests made, the check for data included. */
    requests: number;
    availability?: Availability;
}

export interface SearchEnvironment {
    send: Send;
    /** The backend that built the query's environment. Left out, it is found from the environment itself. */
    backend?: LogBackend;
    signal?: AbortSignal | undefined;
    now?: () => number;
    progress?: (text: string) => void;
}

type Answer = { ok: true; request: object; body: string } | { ok: false; failure: Failure };

function report(bucket: Bucket, state: WindowReport["state"], rest: Partial<WindowReport> = {}): WindowReport {
    return { from: iso(bucket.from), to: iso(bucket.to), state, ...rest };
}

export async function runSearch(query: LogQuery, environment: SearchEnvironment): Promise<SearchOutcome> {
    const { send, signal, progress } = environment;
    const backend = environment.backend ?? backendOf(query.target);
    const now = environment.now ?? Date.now;
    const deadline = now() + TIME_BUDGET_MS;
    const queue = planBuckets(query.range, backend.limits.maxWindowMs);
    // The hits wanted come from the end of the window that the order names, so that end is searched first.
    const newestFirst = query.order === "desc";
    if (newestFirst) queue.reverse();
    const windows: WindowReport[] = [];
    const hits: Source[] = [];
    let total = 0;
    let lowerBound = false;
    let requests = 0;
    let splits = 0;
    let halted: FailureReason | undefined;

    /** One request. A problem with its window comes back as a failure; anything else is thrown. */
    async function call(request: object): Promise<Answer> {
        requests += 1;
        progress?.(`searching ${query.environment} logs, request ${requests}`);
        try {
            const reply = await send(request);
            const failure = failureFromStatus(reply.status, reply.body, backend);
            return failure === undefined ? { ok: true, request, body: reply.body } : { ok: false, failure };
        } catch (error) {
            return { ok: false, failure: failureFromError(error) };
        }
    }

    while (queue.length > 0) {
        signal?.throwIfAborted();
        const bucket = queue.shift() as Bucket;
        const skip =
            halted ?? (requests >= SEARCH_REQUESTS ? "request_budget" : now() >= deadline ? "time_budget" : undefined);
        if (skip !== undefined) {
            windows.push(report(bucket, "missing", { reason: skip }));
            lowerBound = true;
            continue;
        }

        const wanted = Math.max(0, query.size - hits.length);
        const answer = await call(backend.search(query, bucket, wanted));
        let page: SearchPage | undefined;
        let failure: Failure | undefined;
        if (answer.ok) {
            page = backend.parse(answer.body, answer.request);
            if (page === undefined) failure = { reason: "invalid_response", split: false, fatal: false };
            else if (page.incomplete !== undefined) failure = { reason: page.incomplete, split: true, fatal: false };
        } else {
            failure = answer.failure;
        }

        if (failure?.split === true) {
            const halves = halve(bucket);
            if (halves !== undefined && requests < SEARCH_REQUESTS) {
                // The halves cover the same time and are counted again, so a partial answer is thrown away.
                queue.unshift(...(newestFirst ? [halves[1], halves[0]] : halves));
                splits += 1;
                continue;
            }
        }
        if (page !== undefined) {
            const taken = page.hits.slice(0, wanted);
            hits.push(...taken);
            total += page.total;
            if (page.relation === "gte" || failure !== undefined) lowerBound = true;
            windows.push(
                report(bucket, failure === undefined ? "searched" : "partial", {
                    total: page.total,
                    returned: taken.length,
                    ...(failure === undefined ? {} : { reason: failure.reason }),
                }),
            );
        } else if (failure !== undefined) {
            windows.push(report(bucket, "missing", { reason: failure.reason }));
            lowerBound = true;
            // A rejected query or a missing index fails every window alike.
            if (failure.fatal) halted = "not_run";
        }
    }

    // One request without the phrase or query, a count where the backend can count. It shows whether the window holds
    // data at all, and says nothing about how long logs are kept.
    async function probeAvailability(): Promise<Availability> {
        const answer = await call(backend.probe(query, query.range));
        if (!answer.ok) return { state: "unknown", reason: answer.failure.reason };
        const page = backend.parse(answer.body, answer.request);
        if (page === undefined) return { state: "unknown", reason: "invalid_response" };
        // A backend that cannot count says only that there is something, and then so does the result.
        if (page.total > 0) {
            return page.relation === "eq" ? { state: "documents", count: page.total } : { state: "documents" };
        }
        if (page.incomplete !== undefined) return { state: "unknown", reason: page.incomplete };
        return { state: "none", count: 0 };
    }

    // Reported in time order whichever end was searched first, so that neighbouring gaps still read as one.
    windows.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    const covered = windows.some((window) => window.state !== "missing");
    const gaps = windows.some((window) => window.state !== "searched");
    const outcome: SearchOutcome = {
        status: !covered ? "failed" : gaps ? "partial" : "complete",
        total: { value: total, relation: lowerBound || gaps ? "gte" : "eq" },
        windows,
        hits,
        splits,
        requests,
    };
    if (covered && hits.length === 0 && total === 0) {
        outcome.availability =
            requests >= MAX_REQUESTS
                ? { state: "unknown", reason: "request_budget" }
                : now() >= deadline
                  ? { state: "unknown", reason: "time_budget" }
                  : await probeAvailability();
        outcome.requests = requests;
    }
    return outcome;
}
