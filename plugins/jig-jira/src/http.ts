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
// There is one request function for all four ways to sign in. They differ only in how the request travels: with `fetch`
// and a header that carries a token or the sign-in service's headers, or, for a transport, through the company's local
// sign-in proxy, which holds the session and needs no header. The answer is read the same way after that.
import { jig } from "../../jig-core/src/client.ts";
import { httpsOnly } from "./config.ts";
import type { JiraSettings } from "./config.ts";
import { arr, errorMessage, isObject, obj, str } from "./values.ts";

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
    /** For tests: stands in for the global `fetch`. */
    fetch?: typeof fetch;
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

/** Rejects when `signal` aborts, whatever `work` is doing. A transport is another package's code and may ignore the
 *  signal; the timeout must still hold. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

export function createHttp(settings: JiraSettings, options: HttpOptions = {}): Http {
    const send = options.fetch ?? fetch;
    const timeouts = options.timeouts ?? TIMEOUTS;
    // The token is resolved once per call and kept only for it. A sign-in service is asked for every request, because it
    // decides when its token has expired.
    let token: Promise<string> | undefined;

    /** The headers that sign a request in. A transport needs none: the proxy holds the session. */
    async function authHeaders(url: string): Promise<Record<string, string>> {
        const { auth } = settings;
        if (auth.kind === "transport") return {};
        try {
            if (auth.kind === "signIn") {
                return { ...(await jig().signIn.headers(auth.name, { system: "jira", url }, options.signal)) };
            }
            token ??= jig().secrets.resolve(auth.token, options.signal);
            const secret = await token;
            if (auth.kind === "bearer") return { Authorization: `Bearer ${secret}` };
            return { Authorization: `Basic ${Buffer.from(`${auth.email}:${secret}`).toString("base64")}` };
        } catch (error) {
            throw new NotSentError(`could not sign in to Jira: ${errorMessage(error)}`);
        }
    }

    /** Sends the request the way the settings say, and returns what came back. */
    async function travel(
        request: JiraRequest,
        url: string,
        headers: Record<string, string>,
        body: string | undefined,
        signal: AbortSignal,
    ): Promise<Answer> {
        const { auth } = settings;
        const bodyPart = body === undefined ? {} : { body };
        if (auth.kind === "transport") {
            try {
                const sent = jig().transports.request(
                    auth.name,
                    { system: "jira", method: request.method, url, headers, ...bodyPart },
                    signal,
                );
                const answer = await untilAborted(sent, signal);
                if (Buffer.byteLength(answer.body) > MAX_ANSWER_BYTES) throw new LostReplyError(TOO_LARGE);
                return { status: answer.status, headers: answer.headers, text: answer.body };
            } catch (error) {
                // jig-core says so when no transport has this name; then nothing was sent.
                if (/^no transport named /.test(errorMessage(error))) throw new NotSentError(errorMessage(error));
                throw error;
            }
        }
        // A redirect is never followed: a sign-in page or a plain-http address must not receive the credentials.
        const init = { method: request.method, headers, redirect: "manual" as const, signal, ...bodyPart };
        const response = await untilAborted(send(url, init), signal);
        const text = await untilAborted(readText(response), signal);
        return { status: response.status, headers: Object.fromEntries(response.headers), text };
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
            const headers = {
                Accept: "application/json",
                "User-Agent": "jig-jira",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                ...(await authHeaders(url.href)),
            };
            const timeoutMs = request.timeoutMs ?? timeouts.normal;
            const signals = options.signal === undefined ? [] : [options.signal];
            const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...signals]);

            let answer: Answer;
            try {
                answer = await travel(request, url.href, headers, body, signal);
            } catch (error) {
                if (error instanceof NotSentError || error instanceof LostReplyError) throw error;
                throw new LostReplyError(`no answer from Jira (${whyLost(error, timeoutMs)})`);
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

async function readText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ANSWER_BYTES) {
            await reader.cancel();
            throw new LostReplyError(TOO_LARGE);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Why a request got no answer, in words that hold no address and no credential. */
function whyLost(error: unknown, timeoutMs: number): string {
    const name = isObject(error) ? str(error.name) : "";
    if (name === "TimeoutError") {
        return `timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
    }
    if (name === "AbortError") return "cancelled";
    const code = str(obj(isObject(error) ? error.cause : undefined).code);
    return code !== "" ? code : errorMessage(error).replace(/\s+/g, " ").slice(0, 160);
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
        problem = answer.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    }
    let hint = HINTS[status] ?? "";
    if (status >= 300 && status < 400) {
        // Only the host is named: a sign-in redirect can carry state in its query.
        const host = hostOf(answer.headers.location);
        hint = `Jira redirected the request${host === "" ? "" : ` to ${host}`}; it was not followed. ` +
            "The sign-in may have expired, or the site address is wrong";
    }
    if (status === 429) {
        const wait = answer.headers["retry-after"];
        if (wait !== undefined && /^\d{1,5}$/.test(wait)) hint = `${hint} (retry after ${wait} s)`;
    }
    const detail = [problem, hint].filter((part) => part !== "").join(" - ");
    return `Jira said ${status} to ${request.method} ${request.path}: ${detail === "" ? "no details" : detail}`;
}
