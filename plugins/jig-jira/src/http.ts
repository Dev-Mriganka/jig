// Talking to Jira: one HTTP request with the sign-in, a timeout, and errors that never hold a credential.
//
// A request ends in one of four ways, and the callers treat them differently:
//   an answer with a 2xx status      the data;
//   JiraError                        Jira answered with an error status. A 4xx turned the request down, so a write
//                                    that got one changed nothing;
//   NotSentError                     the request never left (no sign-in, a bad address): nothing was sent;
//   LostReplyError                   the request may have arrived, but no usable answer came back (a timeout, a dropped
//                                    connection, a reply that is not JSON). For a write, whether it happened is unknown.
//
// There is one request function for all four ways to sign in. jig-core sends the request (`jig().http.request`) and reads
// the credential for it, so no credential is ever in this plugin's hands: this file says where the credential comes from
// (a bearer token, Basic, a sign-in service) or that a transport carries the request, and what each failure means. The
// answer is read the same way whichever way it came.
import { jig } from "../../jig-core/src/client.ts";
import type { HttpAuth } from "../../jig-core/src/contract.ts";
import { isHttpError } from "../../jig-core/src/kit/http.ts";
import type { HttpError } from "../../jig-core/src/kit/http.ts";
import { httpsOnly } from "./config.ts";
import type { JiraSettings } from "./config.ts";
import { arr, errorMessage, obj } from "./values.ts";

export class JiraError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "JiraError";
        this.status = status;
    }

    /** True when Jira (or the gateway in front of it) turned the request down without acting on it. */
    get refused(): boolean {
        return this.status >= 300 && this.status < 500 && this.status !== 408;
    }
}

export class NotSentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NotSentError";
    }
}

export class LostReplyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LostReplyError";
    }
}

export interface JiraRequest {
    method: "GET" | "POST" | "PUT" | "DELETE";
    /** Below `/rest/api/2`, such as `/issue/PROJ-1`. */
    path: string;
    query?: Readonly<Record<string, string | number | undefined>>;
    body?: unknown;
    timeoutMs?: number;
}

export interface Timeouts {
    normal: number;
    search: number;
}

export interface Http {
    /** The answer's data, or undefined when it has no body. Throws JiraError, NotSentError or LostReplyError. */
    request(request: JiraRequest): Promise<unknown>;
    readonly timeouts: Timeouts;
}

export const TIMEOUTS: Timeouts = { normal: 30_000, search: 60_000 };

export interface HttpOptions {
    timeouts?: Timeouts;
    signal?: AbortSignal;
}

/** An answer larger than this is not read. A search asks for named fields only, so real answers are far smaller. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** What came back, however it travelled: the status, the headers with lower-case names, and the body as text. */
interface Answer {
    status: number;
    headers: Readonly<Record<string, string>>;
    text: string;
}

const HINTS: Readonly<Record<number, string>> = {
    401: "Jira did not accept the sign-in; the token may have expired or be wrong",
    403: "Jira denied access; the account may lack permission for this",
    404: "not found, or the account cannot see it",
    410: "Jira no longer offers this endpoint",
    429: "Jira is rate limiting; wait before trying again",
};

export function createHttp(settings: JiraSettings, options: HttpOptions = {}): Http {
    const timeouts = options.timeouts ?? TIMEOUTS;
    // One signal for every request of the call: jig-core reads the token once for it, and keeps it only that long. A
    // sign-in service is asked for every request, because it decides when its token has expired.
    const call = AbortSignal.any(options.signal === undefined ? [] : [options.signal]);

    /** Where the credential comes from. A transport needs none: the proxy holds the session. */
    function how(): { auth: HttpAuth } | { transport: string } {
        const { auth } = settings;
        switch (auth.kind) {
            case "transport":
                return { transport: auth.name };
            case "signIn":
                return { auth: { signIn: auth.name } };
            case "bearer":
                return { auth: { bearer: auth.token } };
            case "basic":
                return { auth: { basic: { user: auth.email, password: auth.token } } };
        }
    }

    return {
        timeouts,
        async request(request) {
            const url = new URL(`${settings.site}/rest/api/2${request.path}`);
            for (const [name, value] of Object.entries(request.query ?? {})) {
                if (value !== undefined) url.searchParams.set(name, String(value));
            }
            if (httpsOnly(url.href) === undefined) throw new NotSentError("the Jira address must be https");

            const body = request.body === undefined ? undefined : JSON.stringify(request.body);
            const timeoutMs = request.timeoutMs ?? timeouts.normal;

            let answer: Answer;
            try {
                const reply = await jig().http.request(
                    {
                        system: "jira",
                        url: url.href,
                        method: request.method,
                        headers: {
                            Accept: "application/json",
                            "User-Agent": "jig-jira",
                            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                        },
                        ...(body === undefined ? {} : { body }),
                        ...how(),
                        timeoutMs,
                        maxBytes: MAX_ANSWER_BYTES,
                    },
                    call,
                );
                if (reply.truncated) throw new LostReplyError(TOO_LARGE);
                answer = { status: reply.status, headers: reply.headers, text: reply.body };
            } catch (error) {
                throw failed(error, timeoutMs);
            }

            const data = parse(answer.text);
            if (answer.status >= 200 && answer.status < 300) {
                if (data === NOT_JSON) {
                    throw new LostReplyError("Jira answered with something that is not JSON, such as a sign-in page");
                }
                return data;
            }
            throw new JiraError(describeFailure(request, answer, data), answer.status);
        },
    };
}

/** What a failure of jig-core's request means for a caller: nothing was sent, or no usable answer came back. */
function failed(error: unknown, timeoutMs: number): unknown {
    if (error instanceof NotSentError || error instanceof LostReplyError) return error;
    if (!isHttpError(error)) return new LostReplyError(`no answer from Jira (${whyLost(error, timeoutMs)})`);
    // jig-core could not read the credential (a secret that is missing or locked, a sign-in service that failed).
    if (error.code === "auth_failed") return new NotSentError(`could not sign in to Jira: ${error.message}`);
    // No transport has this name, or the request itself was wrong: nothing was sent.
    if (error.code === "no_transport" || error.code === "invalid_request") return new NotSentError(error.message);
    return new LostReplyError(`no answer from Jira (${whyLost(error, timeoutMs)})`);
}

const NOT_JSON = Symbol("not json");
const TOO_LARGE = "Jira's answer is larger than 8 MiB, so it was not read";

function parse(text: string): unknown {
    if (text.trim() === "") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return NOT_JSON;
    }
}

/** Why a request got no answer, in words that hold no address and no credential. */
function whyLost(error: unknown, timeoutMs: number): string {
    if (isHttpError(error)) return whyHttp(error, timeoutMs);
    return errorMessage(error).replace(/\s+/g, " ").slice(0, 160);
}

function whyHttp(error: HttpError, timeoutMs: number): string {
    if (error.code === "timeout") {
        return `timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
    }
    if (error.code === "aborted") return "cancelled";
    // A system code is the whole explanation. Without one, the words of the original error, on one line.
    if (/^[A-Z][A-Z0-9_]+$/.test(error.code)) return error.code;
    if (error.code === "network_error")
        return errorMessage(error.cause ?? error)
            .replace(/\s+/g, " ")
            .slice(0, 160);
    return error.message;
}

function hostOf(location: string | undefined): string {
    try {
        return location === undefined ? "" : new URL(location).host;
    } catch {
        return "";
    }
}

/** Jira's error bodies: `{ "errorMessages": [...], "errors": { "field": "message" } }`. */
export function problemOf(data: unknown): string {
    const body = obj(data);
    const parts = arr(body.errorMessages).filter((message): message is string => typeof message === "string");
    for (const [field, message] of Object.entries(obj(body.errors))) {
        if (typeof message === "string") parts.push(`${field}: ${message}`);
    }
    if (parts.length === 0 && typeof body.message === "string") parts.push(body.message);
    return parts.join("; ").replace(/\s+/g, " ").trim().slice(0, 400);
}

function describeFailure(request: JiraRequest, answer: Answer, data: unknown): string {
    const { status } = answer;
    let problem = problemOf(data);
    if (problem === "" && data === NOT_JSON) {
        problem = answer.text
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
    }
    let hint = HINTS[status] ?? "";
    if (status >= 300 && status < 400) {
        // Only the host is named: a sign-in redirect can carry state in its query.
        const host = hostOf(answer.headers.location);
        hint =
            `Jira redirected the request${host === "" ? "" : ` to ${host}`}; it was not followed. ` +
            "The sign-in may have expired, or the site address is wrong";
    }
    if (status === 429) {
        const wait = answer.headers["retry-after"];
        if (wait !== undefined && /^\d{1,5}$/.test(wait)) hint = `${hint} (retry after ${wait} s)`;
    }
    const detail = [problem, hint].filter((part) => part !== "").join(" - ");
    return `Jira said ${status} to ${request.method} ${request.path}: ${detail === "" ? "no details" : detail}`;
}
