// The one request function. A search is one HTTP request that the backend's adapter described (see `Wire`), and it
// travels one of two ways: straight to the backend over HTTPS, or through a transport that a company plugin registered.
// Everything above this file builds the same request and reads the same reply, so the query, bucketing and parsing code
// never knows which way it went, nor which kind of backend is at the other end.
//
// Credentials are resolved when a request is made and live only in this file's local variables. No message made here
// holds one: an error names what failed (a status, an error code) and never the headers or the body that were sent.
import { jig } from "../../jig-core/src/client.ts";
import type { Wire } from "./backends/backend.ts";
import type { Auth, Backend } from "./config.ts";
import { RequestError } from "./failure.ts";

/** One request may take this long, whichever way it travels. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A reply bigger than this is refused. 200 hits of ordinary log lines are far smaller. */
export const MAX_REPLY_BYTES = 16 * 1024 * 1024;

/** What came back: the HTTP status and the body as text. */
export interface Reply {
    status: number;
    body: string;
}

/** Sends one request to the backend of the environment it was made for. */
export type Send = (request: object) => Promise<Reply>;

export interface SenderOptions {
    /** The call's own signal: stopping the call stops the request. */
    signal?: AbortSignal | undefined;
    /** Default 30 seconds. */
    timeoutMs?: number;
    /** The network. Tests replace it. */
    fetch?: typeof fetch;
}

/** What every request asks for, and says about its body when it has one. The adapter's own headers come after. */
function headersOf(wire: Wire): Record<string, string> {
    return {
        accept: "application/json",
        ...(wire.body === undefined ? {} : { "content-type": "application/json" }),
        ...wire.headers,
    };
}

/** Network errors that mean the connection broke while the backend was working, as it does under load. */
const CONNECTION_LOST = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

/** `wire` says how a request of the environment travels (see `LogBackend.wire`); the address and the sign-in are added. */
export function sender(backend: Backend, wire: (request: object) => Wire, options: SenderOptions = {}): Send {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

    if (backend.kind === "transport") {
        const { transport } = backend;
        return (request) => {
            const how = wire(request);
            return timed(options.signal, timeoutMs, (signal) =>
                viaTransport(transport, `${backend.url}${how.path}`, how, signal),
            );
        };
    }

    const signIn = credentials(backend.auth);
    return async (request) => {
        const how = wire(request);
        const url = `${backend.url}${how.path}`;
        // The timeout starts after the credential is in hand: unlocking a secret store may wait for the user.
        const auth = await signIn(url, options.signal);
        return timed(options.signal, timeoutMs, (signal) => direct(url, how, auth, signal, options.fetch ?? fetch));
    };
}

/** Runs one request under a deadline, and turns its failures into the ones the search knows how to handle. */
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
        throw describe(error, caller, timeout);
    }
}

function describe(error: unknown, caller: AbortSignal | undefined, timeout: AbortSignal): unknown {
    // The user stopped the call: that is the answer, whatever the network reported.
    if (caller?.aborted === true) return caller.reason ?? error;
    if (timeout.aborted) return new RequestError("timeout");
    if (error instanceof RequestError) return error;
    // fetch reports every network problem as a TypeError, with the system error as its cause.
    if (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) {
        const code = networkCode(error);
        if (code !== undefined && CONNECTION_LOST.has(code)) return new RequestError("connection_lost");
        const named = code === undefined ? "" : ` (${code})`;
        return new Error(`cannot reach the backend${named}: check backend.url, the network and the certificate`);
    }
    return error;
}

/** The system error code of a failed fetch, such as ECONNREFUSED. Only a code is kept, never the error's text. */
function networkCode(error: Error): string | undefined {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

async function direct(
    url: string,
    wire: Wire,
    auth: Readonly<Record<string, string>>,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
): Promise<Reply> {
    const response = await fetchImpl(url, {
        method: wire.method,
        headers: { ...headersOf(wire), ...auth },
        ...(wire.body === undefined ? {} : { body: wire.body }),
        signal,
        // A redirect would carry the credential to an address the configuration never named.
        redirect: "manual",
    });
    return { status: response.status, body: await readText(response) };
}

/** The body as text, read as it arrives so that a reply over the limit is dropped before it is all in memory. */
async function readText(response: Response): Promise<string> {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REPLY_BYTES) {
            await reader.cancel();
            throw new RequestError("response_too_large");
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

async function viaTransport(name: string, url: string, wire: Wire, signal: AbortSignal): Promise<Reply> {
    const request = {
        system: "logs",
        method: wire.method,
        url,
        headers: headersOf(wire),
        ...(wire.body === undefined ? {} : { body: wire.body }),
    } as const;
    const reply = await untilAborted(jig().transports.request(name, request, signal), signal);
    if (Buffer.byteLength(reply.body) > MAX_REPLY_BYTES) throw new RequestError("response_too_large");
    return { status: reply.status, body: reply.body };
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
 * so a search of many buckets asks the secret store once. A sign-in service is asked for every request, because it is
 * the one that knows when a token has run out.
 */
function credentials(auth: Auth): SignIn {
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

    return async (url, signal) => {
        switch (auth.kind) {
            case "basic": {
                const password = await secret(auth.password, signal);
                return { authorization: `Basic ${Buffer.from(`${auth.username}:${password}`).toString("base64")}` };
            }
            case "apiKey":
                return { authorization: `ApiKey ${await secret(auth.apiKey, signal)}` };
            case "bearer":
                return { authorization: `Bearer ${await secret(auth.token, signal)}` };
            case "signIn":
                return { ...(await jig().signIn.headers(auth.service, { system: "logs", url }, signal)) };
        }
    };
}
