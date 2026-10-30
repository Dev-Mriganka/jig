// The one request function of the CI adapters that speak HTTP (GitLab and Jenkins). A request is described by the
// adapter, and it travels one of two ways: straight to the CI server over HTTPS, or through a transport that a company
// plugin registered. Everything above this file builds the same request and reads the same reply, so the adapters never
// know which way it went, nor how the sign-in works.
//
// Credentials are resolved when a request is made and live only in this file's local variables. No message made here
// holds one: an error names what failed (a status, an error code) and never the headers or the body that were sent.
// A redirect is never followed, because it would carry the credential to an address the catalog never named.
import { jig } from "../../../jig-core/src/client.ts";
import type { CiAuth, CiSystem } from "./config.ts";

/** One request may take this long, whichever way it travels. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A reply bigger than this is refused, unless the request asks for more (a log). */
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/** Where a CI server is and how requests to it sign in: the `url` and `auth` of a catalog entry. */
export interface CiHttp {
    system: Exclude<CiSystem, "github-actions">;
    url: string;
    auth: CiAuth;
}

export interface Request {
    method: "GET" | "POST";
    /** Below the server's address, starting with a slash, with the query string if there is one. */
    path: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    /** The most bytes of the reply that are read. A bigger reply is refused. Default: 4 MiB. */
    maxBytes?: number;
}

export interface Reply {
    status: number;
    /** Header names in lower case. */
    headers: Readonly<Record<string, string>>;
    /** The cookies the reply set, as `name=value`, for a client that has to send them back (a Jenkins crumb). */
    cookies: readonly string[];
    body: string;
}

/** Sends one request to the server of the service it was made for. */
export type Send = (request: Request) => Promise<Reply>;

export interface SenderOptions {
    /** The call's own signal: stopping the call stops the request. */
    signal?: AbortSignal | undefined;
    /** Default 30 seconds. */
    timeoutMs?: number;
    /** The network. Tests replace it. */
    fetch?: typeof fetch;
}

/**
 * Why a request got no usable reply. `lost` means the server may have acted on it: the reply was cut off or never came.
 * A write that ends this way is never sent again (see `lostReply` in the adapters).
 */
export class RequestFailure extends Error {
    readonly kind: "timeout" | "connection_lost" | "too_large" | "unreachable";
    constructor(kind: RequestFailure["kind"], message: string) {
        super(message);
        this.name = "RequestFailure";
        this.kind = kind;
    }
    get lost(): boolean {
        return this.kind === "timeout" || this.kind === "connection_lost";
    }
}

/** Network errors that mean the connection broke while the server was working, as it does under load. */
const CONNECTION_LOST = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

/** `x-total` and the like are lower case in `Headers`; a transport's may not be. */
function lowerCased(headers: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** The cookies of a transport's folded `set-cookie` header: split where a new `name=` starts, not at a date's comma. */
function splitCookies(folded: string | undefined): string[] {
    if (folded === undefined || folded === "") return [];
    return folded.split(/,\s*(?=[^;,\s]+=)/).flatMap((cookie) => cookie.split(";")[0]?.trim() ?? []);
}

export function sender(http: CiHttp, options: SenderOptions = {}): Send {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const fetchImpl = options.fetch ?? fetch;
    const { auth } = http;

    if (auth.kind === "transport") {
        const name = auth.transport;
        return (request) => timed(options.signal, timeoutMs, (signal) => viaTransport(name, http, request, signal));
    }

    const signIn = credentials(http);
    return async (request) => {
        const url = `${http.url}${request.path}`;
        // The timeout starts after the credential is in hand: unlocking a secret store may wait for the user.
        const headers = await signIn(url, options.signal);
        return timed(options.signal, timeoutMs, (signal) => direct(url, request, headers, signal, fetchImpl));
    };
}

/** Runs one request under a deadline, and turns its failures into the ones the adapters know how to handle. */
async function timed(
    caller: AbortSignal | undefined,
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<Reply>,
): Promise<Reply> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
    try {
        return await work(signal);
    } catch (error) {
        throw describe(error, caller, timeout, timeoutMs);
    }
}

function describe(error: unknown, caller: AbortSignal | undefined, timeout: AbortSignal, timeoutMs: number): unknown {
    // The user stopped the call: that is the answer, whatever the network reported.
    if (caller?.aborted === true) return caller.reason ?? error;
    if (timeout.aborted) return new RequestFailure("timeout", `no answer within ${Math.round(timeoutMs / 1000)} s`);
    if (error instanceof RequestFailure) return error;
    // fetch reports every network problem as a TypeError, with the system error as its cause.
    if (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) {
        const code = networkCode(error);
        if (code !== undefined && CONNECTION_LOST.has(code)) {
            return new RequestFailure("connection_lost", `the connection broke before the reply came (${code})`);
        }
        const named = code === undefined ? "" : ` (${code})`;
        return new RequestFailure(
            "unreachable",
            `cannot reach the CI server${named}: check the url in the catalog, the network and the certificate`,
        );
    }
    return error;
}

/** The system error code of a failed fetch, such as ECONNREFUSED. Only a code is kept, never the error's text. */
function networkCode(error: Error): string | undefined {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function headersOf(request: Request): Record<string, string> {
    return { accept: "application/json", ...request.headers };
}

async function direct(
    url: string,
    request: Request,
    auth: Readonly<Record<string, string>>,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
): Promise<Reply> {
    const response = await fetchImpl(url, {
        method: request.method,
        headers: { ...headersOf(request), ...auth },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal,
        redirect: "manual",
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => void (headers[name.toLowerCase()] = value));
    const body = await readText(response, request.maxBytes ?? MAX_REPLY_BYTES);
    return { status: response.status, headers, cookies: cookiesOf(response), body };
}

function cookiesOf(response: Response): string[] {
    return response.headers.getSetCookie().flatMap((cookie) => cookie.split(";")[0]?.trim() ?? []);
}

/** The body as text, read as it arrives so that a reply over the limit is dropped before it is all in memory. */
async function readText(response: Response, maxBytes: number): Promise<string> {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw tooLarge(maxBytes);
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

function tooLarge(maxBytes: number): RequestFailure {
    return new RequestFailure("too_large", `the reply is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB`);
}

async function viaTransport(name: string, http: CiHttp, request: Request, signal: AbortSignal): Promise<Reply> {
    const reply = await untilAborted(
        jig().transports.request(
            name,
            {
                system: `ci:${http.system}`,
                method: request.method,
                url: `${http.url}${request.path}`,
                headers: headersOf(request),
                ...(request.body === undefined ? {} : { body: request.body }),
            },
            signal,
        ),
        signal,
    );
    const maxBytes = request.maxBytes ?? MAX_REPLY_BYTES;
    if (Buffer.byteLength(reply.body) > maxBytes) throw tooLarge(maxBytes);
    const headers = lowerCased(reply.headers ?? {});
    return { status: reply.status, headers, cookies: splitCookies(headers["set-cookie"]), body: reply.body };
}

/** A transport is another package's code and may ignore its signal. This stops waiting for it when the signal fires. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
    });
}

type SignIn = (url: string, signal: AbortSignal | undefined) => Promise<Readonly<Record<string, string>>>;

/**
 * The headers that sign a request in. A secret is resolved by the first request of a call and kept for the rest of it,
 * so a call of several requests asks the secret store once. A sign-in service is asked for every request, because it is
 * the one that knows when a token has run out.
 */
function credentials(http: CiHttp): SignIn {
    const secrets = new Map<string, Promise<string>>();
    const secret = (reference: string, signal: AbortSignal | undefined): Promise<string> => {
        let value = secrets.get(reference);
        if (value === undefined) {
            value = jig().secrets.resolve(reference, signal);
            secrets.set(reference, value);
            // A lookup that failed is made again by the next request.
            value.catch(() => secrets.delete(reference));
        }
        return value;
    };

    return async (url, signal): Promise<Record<string, string>> => {
        const { auth } = http;
        switch (auth.kind) {
            case "token":
                return { "PRIVATE-TOKEN": await secret(auth.token, signal) };
            case "basic": {
                const token = await secret(auth.token, signal);
                return { authorization: `Basic ${Buffer.from(`${auth.user}:${token}`).toString("base64")}` };
            }
            case "signIn":
                return { ...(await jig().signIn.headers(auth.service, { system: `ci:${http.system}`, url }, signal)) };
            case "transport":
                // A transport signs in itself; sender() never asks this function for one.
                return {};
        }
    };
}
