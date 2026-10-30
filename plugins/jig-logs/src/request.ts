// The one request function. A search is one HTTP request that the backend's adapter described (see `Wire`), and it
// travels one of two ways: straight to the backend over HTTPS, or through a transport that a company plugin registered.
// Everything above this file builds the same request and reads the same reply, so the query, bucketing and parsing code
// never knows which way it went, nor which kind of backend is at the other end.
//
// jig-core sends the request (`jig().http.request`) and reads the credential for it, so no credential is ever in this
// plugin's hands: this file says where the credential comes from and what to do with each way a request can fail. No
// message made here holds one: an error names what failed (a status, an error code) and never the headers or the body
// that were sent.
import { jig } from "../../jig-core/src/client.ts";
import type { HttpAuth } from "../../jig-core/src/contract.ts";
import { isHttpError } from "../../jig-core/src/kit/http.ts";
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

/** Where the credential of a direct request comes from. Every value but `username` is a secret reference. */
function credential(auth: Auth): HttpAuth {
    switch (auth.kind) {
        case "basic":
            return { basic: { user: auth.username, password: auth.password } };
        case "apiKey":
            return { header: { name: "authorization", value: auth.apiKey, prefix: "ApiKey " } };
        case "bearer":
            return { bearer: auth.token };
        case "signIn":
            return { signIn: auth.service };
    }
}

/** `wire` says how a request of the environment travels (see `LogBackend.wire`); this adds the address and sign-in. */
export function sender(backend: Backend, wire: (request: object) => Wire, options: SenderOptions = {}): Send {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    // One signal for every request of the call, so that a secret is read once for a search of many buckets.
    const call = AbortSignal.any(options.signal === undefined ? [] : [options.signal]);
    const how = backend.kind === "transport" ? { transport: backend.transport } : { auth: credential(backend.auth) };

    return async (request) => {
        const http = wire(request);
        try {
            const reply = await jig().http.request(
                {
                    system: "logs",
                    url: `${backend.url}${http.path}`,
                    method: http.method,
                    headers: headersOf(http),
                    ...(http.body === undefined ? {} : { body: http.body }),
                    ...how,
                    timeoutMs,
                    maxBytes: MAX_REPLY_BYTES,
                },
                call,
            );
            if (reply.truncated) throw new RequestError("response_too_large");
            return { status: reply.status, body: reply.body };
        } catch (error) {
            throw describe(error);
        }
    };
}

/** Turns a failure of jig-core's request into the ones the search knows how to handle. */
function describe(error: unknown): unknown {
    if (!isHttpError(error)) return error;
    // The user stopped the call: that is the answer, whatever the network reported.
    if (error.code === "aborted") return error.cause ?? error;
    if (error.code === "timeout") return new RequestError("timeout");
    if (CONNECTION_LOST.has(error.code)) return new RequestError("connection_lost");
    if (error.code === "network_error") {
        const cause = error.cause;
        // fetch reports every network problem as a TypeError; anything else is not the network's doing.
        if (cause instanceof TypeError && (cause.message === "fetch failed" || cause.message === "terminated")) {
            return new Error("cannot reach the backend: check backend.url, the network and the certificate");
        }
        return cause ?? error;
    }
    // A code that is a system or a certificate code means the backend could not be reached; the others (a credential
    // that could not be read, a transport that failed) carry their own words.
    if (/^[A-Z][A-Z0-9_]+$/.test(error.code)) {
        return new Error(
            `cannot reach the backend (${error.code}): check backend.url, the network and the certificate`,
        );
    }
    return new Error(error.message);
}
