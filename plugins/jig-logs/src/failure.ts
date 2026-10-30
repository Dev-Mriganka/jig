// Why one request did not give a usable answer, and what to do about it.
//
// A problem with one window becomes a gap in the result, and the rest of the search goes on. A problem that every
// window would have, such as a refused credential or an address nobody answers, is thrown, because a result made of
// nothing but gaps would only hide it.
import { errorType } from "./response.ts";

export type FailureReason =
    | "timeout"
    | "search_timeout"
    | "failed_shards"
    | "upstream_unavailable"
    | "rate_limited"
    | "response_too_large"
    | "invalid_response"
    | "query_rejected"
    | "index_not_found"
    | "request_budget"
    | "time_budget"
    | "not_run";

export interface Failure {
    reason: FailureReason;
    /** Halving the window can help (a slow or flaky backend), unlike a rejected query. */
    split: boolean;
    /** Every other window would fail the same way, so the search stops. */
    fatal: boolean;
}

/** A request that failed in a way that concerns only its own window. `request.ts` throws it. */
export class RequestError extends Error {
    readonly reason: "timeout" | "connection_lost" | "response_too_large";

    constructor(reason: RequestError["reason"]) {
        super(`the request failed: ${reason}`);
        this.name = "RequestError";
        this.reason = reason;
    }
}

function transient(reason: FailureReason): Failure {
    return { reason, split: true, fatal: false };
}

function final(reason: FailureReason, fatal = false): Failure {
    return { reason, split: false, fatal };
}

const NOT_ACCEPTED = "The backend did not accept the sign-in";

/**
 * The failure a reply's status stands for, or undefined for a success. Throws when the problem is the sign-in or the
 * address: neither is about one window. The messages never hold a credential, and never the reply's body.
 */
export function failureFromStatus(status: number, body: string): Failure | undefined {
    if (status >= 200 && status < 300) return undefined;
    if (status === 401) {
        throw new Error(
            `${NOT_ACCEPTED} (HTTP 401): sign in again, or check backend.auth in the logs section of jig.json`,
        );
    }
    if (status === 403) {
        throw new Error(
            "The backend denied this sign-in access to the index (HTTP 403): signing in again will not help, " +
                "so ask for access to it",
        );
    }
    if (status >= 300 && status < 400) {
        throw new Error(
            `The backend answered with a redirect (HTTP ${status}): set backend.url to the address it redirects to`,
        );
    }
    if (status === 404 || errorType(body) === "index_not_found_exception") return final("index_not_found", true);
    if (status === 408 || status === 504) return transient("timeout");
    if (status === 429) return final("rate_limited");
    if (status >= 500) return transient("upstream_unavailable");
    return final("query_rejected", true);
}

/**
 * The failure a request error stands for. Anything else, such as a stop by the user or an address that cannot be
 * reached, is not about one window and is thrown again.
 */
export function failureFromError(error: unknown): Failure {
    if (error instanceof RequestError) {
        switch (error.reason) {
            case "timeout":
                return transient("timeout");
            case "connection_lost":
                return transient("upstream_unavailable");
            case "response_too_large":
                return final("response_too_large");
        }
    }
    throw error;
}

/** One line per reason for the model: what to change before searching again. */
export function nextStep(reason: FailureReason): string {
    switch (reason) {
        case "timeout":
        case "search_timeout":
            return "Narrow the window or search for a more exact phrase, then retry.";
        case "failed_shards":
            return "Some shards failed, so counts are a lower bound; retry later or narrow the window.";
        case "upstream_unavailable":
        case "rate_limited":
            return "The backend was unavailable or busy; retry once, then report the gap instead of guessing.";
        case "response_too_large":
            return "Lower size or narrow the window.";
        case "invalid_response":
            return "The backend sent a reply that is not a search result; retry once, then report the gap.";
        case "query_rejected":
            return (
                "The backend rejected the query; for query check the Lucene syntax " +
                "(AND, OR and NOT in capitals, quotes around phrases), otherwise use phrase."
            );
        case "index_not_found":
            return "The index was not found: the environment's index in the logs section of jig.json may be wrong.";
        case "request_budget":
        case "time_budget":
            return "Too much for one call; narrow the window, or search the missing windows separately.";
        case "not_run":
            return "Skipped after an earlier rejection; fix that first.";
    }
}
