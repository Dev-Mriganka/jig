// One HTTP exchange, however it travels: over the network, or through a company transport. jig-core sends the request
// (`jig().http.request`) and reads the credential for it; this file keeps what is jig-api's own: which addresses are never
// called, and what each way a request can end means for a saved request. The answer comes back in the same shape either
// way. An exchange ends in one of three ways, and the callers treat them differently:
//   an Answer          the server replied, with any status;
//   NotSentError       the request never left (a bad address, no connection, a sign-in that failed): nothing happened
//                      on the other side;
//   LostReplyError     the request may have arrived, but no usable answer came back (a timeout, a dropped connection).
//                      For a write, whether it happened is unknown, so it is never sent again.
//
// A redirect is never followed, so that a token or a signature cannot be sent to another host or in the clear.
import { jig } from "../../../jig-core/src/client.ts";
import type { HttpAuth, HttpResponse } from "../../../jig-core/src/contract.ts";
import { isHttpError } from "../../../jig-core/src/kit/http.ts";
import { addressProblem } from "./address.ts";
import type { Method } from "./plan.ts";
import { errorMessage, oneLine } from "./values.ts";

/** A longer answer is cut here. The model reads far less, and jig-core caps what it shows. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

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

/** One request, as it goes out. */
export interface Wire {
    /** The system, as sign-in services and transports are told it: `http:<target>`. */
    system: string;
    method: Method;
    url: string;
    headers: Readonly<Record<string, string>>;
    /** The tool's own headers, which a header of the request and a credential replace without complaint. */
    defaultHeaders?: Readonly<Record<string, string>>;
    /** Text, or the bytes of a file or a multipart form. */
    body?: string | Uint8Array;
    /** The company transport that carries the request. Without one, the request goes out over the network. */
    transport?: string;
    /** Where the credential comes from, for jig-core to read. Not with a transport, which signs in itself. */
    auth?: HttpAuth;
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

/** The cookies a server sets are never kept, shown or passed on: there is no cookie jar, and a session cookie is a credential. */
const COOKIE_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);

function withoutCookies(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !COOKIE_HEADERS.has(name.toLowerCase())));
}

function answerOf(reply: HttpResponse): Answer {
    return {
        status: reply.status,
        headers: withoutCookies(reply.headers),
        text: reply.binary ? "" : reply.body,
        bytes: reply.bytes,
        cut: reply.truncated,
        binary: reply.binary,
    };
}

/**
 * The error for an exchange that got no answer. Only a failure that came before the server could have read the request
 * is "not sent"; any other, such as a connection reset, leaves a write's outcome unknown. The words come from jig-core,
 * which takes them from the error code and never from Node's message, which can quote the address or a header.
 */
function failure(error: unknown): NotSentError | LostReplyError {
    if (!isHttpError(error)) return new LostReplyError("failed", oneLine(errorMessage(error), 160));
    // The credential could not be read or made: nothing has gone to the API yet.
    if (error.code === "auth_failed") return new NotSentError(`could not sign in (${error.message})`);
    if (error.notSent) return new NotSentError(error.message);
    if (error.code === "timeout") return new LostReplyError("timeout", "timed out");
    if (error.code === "aborted") return new LostReplyError("cancelled", "cancelled");
    return new LostReplyError("failed", error.message);
}

/**
 * Sends the request once and returns the answer. `cancel` is the user's signal, and `timeoutMs` the time one exchange may
 * take, which starts after the credential is in hand. Throws NotSentError or LostReplyError.
 */
export async function exchange(wire: Wire, cancel?: AbortSignal, timeoutMs?: number): Promise<Answer> {
    if (wire.transport === undefined) {
        const problem = addressProblem(wire.url, wire.allowPlainLocal);
        if (problem !== undefined) throw new NotSentError(`the address is refused (${problem})`);
    }
    let reply: HttpResponse;
    try {
        reply = await jig().http.request(
            {
                system: wire.system,
                method: wire.method,
                url: wire.url,
                headers: wire.headers,
                ...(wire.defaultHeaders === undefined ? {} : { defaultHeaders: wire.defaultHeaders }),
                ...(wire.body === undefined ? {} : { body: wire.body }),
                ...(wire.transport === undefined ? {} : { transport: wire.transport }),
                ...(wire.auth === undefined ? {} : { auth: wire.auth }),
                // The request sets a header that the credential sets too: one of the two would silently win.
                onHeaderClash: "refuse",
                maxBytes: wire.maxBytes ?? MAX_ANSWER_BYTES,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
            cancel,
        );
    } catch (error) {
        throw failure(error);
    }
    return answerOf(reply);
}
