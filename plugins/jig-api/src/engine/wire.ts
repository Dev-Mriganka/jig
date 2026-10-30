// One HTTP exchange, however it travels: with `fetch`, or through a company transport. The answer comes back in the same
// shape either way. An exchange ends in one of three ways, and the callers treat them differently:
//   an Answer          the server replied, with any status;
//   NotSentError       the request never left (a bad address, no connection, a sign-in that failed): nothing happened
//                      on the other side;
//   LostReplyError     the request may have arrived, but no usable answer came back (a timeout, a dropped connection).
//                      For a write, whether it happened is unknown, so it is never sent again.
//
// A redirect is never followed, so that a token or a signature cannot be sent to another host or in the clear.
import { jig } from "../../../jig-core/src/client.ts";
import type { TransportRequest, TransportResponse } from "../../../jig-core/src/contract.ts";
import { addressProblem } from "./address.ts";
import type { Method } from "./plan.ts";
import { errorMessage, isObject, oneLine } from "./values.ts";

/** A longer answer is cut here. The model reads far less, and jig-core caps what it shows. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
/** Bytes looked at for a NUL character, which text never holds. */
const SNIFF_BYTES = 4096;

export class NotSentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NotSentError";
    }
}

export class LostReplyError extends Error {
    /** Why no answer came: the time ran out, the call was cancelled, or the connection failed. */
    readonly reason: "timeout" | "cancelled" | "failed";

    constructor(reason: "timeout" | "cancelled" | "failed", message: string) {
        super(message);
        this.name = "LostReplyError";
        this.reason = reason;
    }
}

/**
 * Where a call can be stopped: by the user at any time, and by the clock once the first request has gone out. The clock does
 * not run while a secret store waits for the user to unlock it, because that is not the API's time.
 */
export interface Stops {
    cancel: AbortSignal | undefined;
    /** The signal of the clock. The first call starts it; later calls return the same one. */
    deadline(): AbortSignal;
}

/** One request, as it goes out. */
export interface Wire {
    /** The system, as sign-in services and transports are told it: `http:<target>`. */
    system: string;
    method: Method;
    url: string;
    headers: Readonly<Record<string, string>>;
    /** Text, or the bytes of a file or a multipart form. */
    body?: string | Uint8Array;
    /** The company transport that carries the request. Without one, the request goes out with `fetch`. */
    transport?: string;
    allowPlainLocal: boolean;
    /** Default MAX_ANSWER_BYTES. */
    maxBytes?: number;
}

/** What came back, however it travelled. */
export interface Answer {
    status: number;
    /** Lower-case names. */
    headers: Readonly<Record<string, string>>;
    /** The body as text, cut at the size limit. Empty when the body is binary. */
    text: string;
    /** How many bytes of the body were read. */
    bytes: number;
    /** True when the body was longer than the limit and was cut. */
    cut: boolean;
    /** True when the body holds a NUL character, so it is not text. */
    binary: boolean;
}

/** Failures that happen before the server has read anything: the address, the name lookup and the connection. A connection
 *  that was reset or closed is not here, because the request may have been written by then. */
const BEFORE_SENDING: ReadonlySet<string> = new Set([
    "ERR_INVALID_URL",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
]);
/** The certificate is checked before any request is written, so these too mean that nothing was sent. */
const CERTIFICATE: ReadonlySet<string> = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "CERT_UNTRUSTED",
    "CERT_REVOKED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

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

function isTimeout(signal: AbortSignal): boolean {
    return isObject(signal.reason) && signal.reason.name === "TimeoutError";
}

/** The error code of a failure, which may sit in its cause (`fetch failed` is only the outer words). */
function codeOf(error: unknown): string {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && isObject(current); depth++) {
        if (typeof current.code === "string") return current.code;
        if (Array.isArray(current.errors)) {
            const inner: unknown = current.errors.find((item) => isObject(item) && typeof item.code === "string");
            if (isObject(inner) && typeof inner.code === "string") return inner.code;
        }
        current = current.cause;
    }
    return "";
}

/**
 * The error for an exchange that got no answer. Only a failure that came before the server could have read the request
 * is "not sent"; any other, such as a connection reset, leaves a write's outcome unknown. The words come from the error
 * code and never from Node's message, which can quote the address or a header.
 */
function failure(error: unknown, signal: AbortSignal): NotSentError | LostReplyError {
    if (signal.aborted) {
        return isTimeout(signal)
            ? new LostReplyError("timeout", "timed out")
            : new LostReplyError("cancelled", "cancelled");
    }
    // `fetch` refuses the ports that browsers block, before it connects, and gives that reason in words and not as a code.
    if (isObject(error) && isObject(error.cause) && error.cause.message === "bad port") {
        return new NotSentError("the port is one that fetch does not connect to");
    }
    const code = codeOf(error);
    if (BEFORE_SENDING.has(code)) return new NotSentError(`could not connect (${code})`);
    if (CERTIFICATE.has(code)) {
        return new NotSentError(
            `the TLS certificate was not accepted (${code}); certificate checks are never turned off`,
        );
    }
    return new LostReplyError("failed", code === "" ? "the connection failed" : `the connection failed (${code})`);
}

async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
    const reader = response.body?.getReader();
    if (reader === undefined) return { bytes: new Uint8Array(0), cut: false };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks), cut: false };
        if (value.byteLength > maxBytes - size) {
            chunks.push(value.subarray(0, maxBytes - size));
            await reader.cancel().catch(() => undefined);
            return { bytes: Buffer.concat(chunks), cut: true };
        }
        chunks.push(value);
        size += value.byteLength;
    }
}

/** The cookies a server sets are never kept, shown or passed on: there is no cookie jar, and a session cookie is a credential. */
const COOKIE_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);

function withoutCookies(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !COOKIE_HEADERS.has(name.toLowerCase())));
}

function answerOf(status: number, headers: Readonly<Record<string, string>>, bytes: Uint8Array, cut: boolean): Answer {
    const binary = bytes.subarray(0, SNIFF_BYTES).includes(0);
    return {
        status,
        headers: withoutCookies(headers),
        text: binary ? "" : new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
        cut,
        binary,
    };
}

async function viaFetch(wire: Wire, signal: AbortSignal, maxBytes: number): Promise<Answer> {
    const problem = addressProblem(wire.url, wire.allowPlainLocal);
    if (problem !== undefined) throw new NotSentError(`the address is refused (${problem})`);
    let headers: Headers;
    try {
        headers = new Headers(wire.headers);
    } catch {
        // The message of `Headers` repeats the value, which may be a credential.
        throw new NotSentError("a header holds a character that cannot be sent");
    }
    const init: RequestInit = {
        method: wire.method,
        headers,
        redirect: "manual",
        signal,
        ...(wire.body === undefined ? {} : { body: wire.body }),
    };
    try {
        const response = await untilAborted(fetch(wire.url, init), signal);
        const { bytes, cut } = await untilAborted(readBody(response, maxBytes), signal);
        return answerOf(response.status, Object.fromEntries(response.headers), bytes, cut);
    } catch (error) {
        throw failure(error, signal);
    }
}

/** A transport's answer is text already. It is cut to the same size limit as an answer read from the network. */
function answerFromTransport(response: TransportResponse, maxBytes: number): Answer {
    const text = response.body.length > maxBytes ? response.body.slice(0, maxBytes) : response.body;
    let bytes: Uint8Array = Buffer.from(text, "utf8");
    let cut = text !== response.body;
    if (bytes.byteLength > maxBytes) {
        bytes = bytes.subarray(0, maxBytes);
        cut = true;
    }
    return answerOf(response.status, response.headers, bytes, cut);
}

/** What a transport can carry: its contract has these five methods and a text body. */
const TRANSPORT_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function viaTransport(wire: Wire, name: string, signal: AbortSignal, maxBytes: number): Promise<Answer> {
    if (!TRANSPORT_METHODS.has(wire.method)) {
        throw new NotSentError(`a transport carries GET, POST, PUT, PATCH and DELETE, and not ${wire.method}`);
    }
    if (wire.body !== undefined && typeof wire.body !== "string") {
        throw new NotSentError("a transport carries a text body, and not a file or a multipart form");
    }
    const request: TransportRequest = {
        system: wire.system,
        method: wire.method as TransportRequest["method"],
        url: wire.url,
        headers: wire.headers,
        ...(wire.body === undefined ? {} : { body: wire.body }),
    };
    try {
        const response = await untilAborted(jig().transports.request(name, request, signal), signal);
        return answerFromTransport(response, maxBytes);
    } catch (error) {
        if (signal.aborted) throw failure(error, signal);
        const message = errorMessage(error);
        // jig-core says so when no transport has this name; then nothing was sent.
        if (/^no transport named /.test(message)) throw new NotSentError(message);
        throw new LostReplyError("failed", oneLine(message, 160));
    }
}

/** Sends the request once and returns the answer. Throws NotSentError or LostReplyError. */
export async function exchange(wire: Wire, signal: AbortSignal): Promise<Answer> {
    if (signal.aborted) {
        const why = isTimeout(signal) ? "the time ran out" : "it was cancelled";
        throw new NotSentError(`${why} before it was sent`);
    }
    const maxBytes = wire.maxBytes ?? MAX_ANSWER_BYTES;
    if (wire.transport === undefined) return viaFetch(wire, signal, maxBytes);
    return viaTransport(wire, wire.transport, signal, maxBytes);
}
