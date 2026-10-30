// The one request function of the CI adapters that speak HTTP (GitLab and Jenkins). A request is described by the
// adapter, and it travels one of two ways: straight to the CI server over HTTPS, or through a transport that a company
// plugin registered. Everything above this file builds the same request and reads the same reply, so the adapters never
// know which way it went, nor how the sign-in works.
//
// jig-core sends the request (`jig().http.request`) and reads the credential for it, so no credential is ever in this
// plugin's hands: this file says where the credential comes from and what each failure means for an adapter. No message
// made here holds one: an error names what failed (a status, an error code) and never the headers or the body that were
// sent. A redirect is never followed, because it would carry the credential to an address the catalog never named.
import { jig } from "../../../jig-core/src/client.ts";
import type { HttpAuth } from "../../../jig-core/src/contract.ts";
import { isHttpError } from "../../../jig-core/src/kit/http.ts";
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

function headersOf(request: Request): Record<string, string> {
    return { accept: "application/json", ...request.headers };
}

/** Where the credential of a request comes from: a secret reference, a sign-in service, or a transport that holds it. */
function how(auth: CiAuth): { auth: HttpAuth } | { transport: string } {
    switch (auth.kind) {
        case "token":
            return { auth: { header: { name: "PRIVATE-TOKEN", value: auth.token } } };
        case "basic":
            return { auth: { basic: { user: auth.user, password: auth.token } } };
        case "signIn":
            return { auth: { signIn: auth.service } };
        case "transport":
            // A transport signs in itself, so there is no credential to name.
            return { transport: auth.transport };
    }
}

export function sender(http: CiHttp, options: SenderOptions = {}): Send {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const signs = how(http.auth);
    // One signal for every request of the call, so that a secret is read once for a call of several requests.
    const call = AbortSignal.any(options.signal === undefined ? [] : [options.signal]);

    return async (request) => {
        const maxBytes = request.maxBytes ?? MAX_REPLY_BYTES;
        try {
            const reply = await jig().http.request(
                {
                    system: `ci:${http.system}`,
                    url: `${http.url}${request.path}`,
                    method: request.method,
                    headers: headersOf(request),
                    ...(request.body === undefined ? {} : { body: request.body }),
                    ...signs,
                    timeoutMs,
                    maxBytes,
                },
                call,
            );
            if (reply.truncated) throw tooLarge(maxBytes);
            return { status: reply.status, headers: reply.headers, cookies: reply.cookies, body: reply.body };
        } catch (error) {
            throw describe(error, timeoutMs);
        }
    };
}

function tooLarge(maxBytes: number): RequestFailure {
    return new RequestFailure("too_large", `the reply is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB`);
}

/** Turns a failure of jig-core's request into the ones the adapters know how to handle. */
function describe(error: unknown, timeoutMs: number): unknown {
    if (!isHttpError(error)) return error;
    // The user stopped the call: that is the answer, whatever the network reported.
    if (error.code === "aborted") return error.cause ?? error;
    if (error.code === "timeout") {
        return new RequestFailure("timeout", `no answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    if (CONNECTION_LOST.has(error.code)) {
        return new RequestFailure("connection_lost", `the connection broke before the reply came (${error.code})`);
    }
    const cause = error.cause;
    const fetchFailed =
        cause instanceof TypeError && (cause.message === "fetch failed" || cause.message === "terminated");
    if (error.code === "network_error" && !fetchFailed) return cause ?? error;
    if (error.code === "network_error" || /^[A-Z][A-Z0-9_]+$/.test(error.code)) {
        const named = error.code === "network_error" ? "" : ` (${error.code})`;
        return new RequestFailure(
            "unreachable",
            `cannot reach the CI server${named}: check the url in the catalog, the network and the certificate`,
        );
    }
    // A credential that could not be read, a transport that failed or is not registered: jig-core's own words.
    return new Error(error.message);
}
