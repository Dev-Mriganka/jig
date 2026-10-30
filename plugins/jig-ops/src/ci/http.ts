// Reading a CI server's reply: what a status means to the person who has to fix it, and the JSON of a good one. The
// messages say which server and which request failed, and hint at the usual cause. They never hold what was sent.
import { clean, oneLine } from "../values.ts";
import type { Reply } from "./request.ts";

/** The `message` or `error` of a JSON error body, cleaned and short, or "" when the body says nothing usable. */
function reason(body: string): string {
    try {
        const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
        const found = parsed.message ?? parsed.error;
        if (typeof found === "string") return oneLine(clean(found), 160);
        if (found !== undefined && found !== null) return oneLine(clean(JSON.stringify(found)), 160);
    } catch {
        // An HTML error page or plain text says nothing we can quote safely.
    }
    return "";
}

/** What a status usually means, as the hint after it. */
function hint(status: number, reply: Reply): string {
    if (status === 401) return "the server did not accept the sign-in: sign in again yourself";
    if (status === 403) return "the account may not do this, or the sign-in is missing or has expired";
    if (status === 404) return "not found: check the project or job in the catalog, and that the account can see it";
    if (status === 409) return "the server is busy with the same thing; wait, then look again";
    if (status === 429) {
        const wait = Number(reply.headers["retry-after"]);
        return Number.isFinite(wait) && wait > 0
            ? `rate limited: try again in ${wait} s`
            : "rate limited: try again later";
    }
    if (status >= 300 && status < 400) {
        return "the server redirected the request, which is never followed; check the url in the catalog";
    }
    if (status >= 500) return "the server failed; it may be down or restarting";
    return "";
}

/** An error for a reply that is not the one wanted: `GitLab GET /pipelines failed: HTTP 404 (not found: ...)`. */
export function httpFailure(who: string, what: string, reply: Reply): Error {
    const said = reason(reply.body);
    const why = [hint(reply.status, reply), said].filter(Boolean).join("; ");
    return new Error(`${who} ${what} failed: HTTP ${reply.status}${why === "" ? "" : ` (${why})`}`);
}

/** The JSON of a reply that has a status from 200 to 299. Any other reply is an error naming the request. */
export function jsonOf<T>(who: string, what: string, reply: Reply): T {
    if (reply.status < 200 || reply.status > 299) throw httpFailure(who, what, reply);
    try {
        return JSON.parse(reply.body) as T;
    } catch {
        throw new Error(`${who} ${what} returned something that is not JSON`);
    }
}
