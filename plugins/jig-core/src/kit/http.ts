// One HTTP request, with the credential read for it. This is the request logic that `jig().http.request` runs; jig-core
// binds the real fetch, secrets, sign-in services and transports to it, and a plugin's tests bind fakes to it.
//
// What every request gets, whoever sends it:
// - The credential comes from a source the user configured (see `HttpAuth`). It is read just before the request and is
//   never returned, so plugin code never holds it. Values are registered with the redactor by the secret backend and by
//   the sign-in service, and values made here (the Basic pair, an OAuth token) are registered through `redact`.
// - A redirect is never followed: it would carry the credential to an address nobody configured. A 3xx comes back as a
//   reply with its `location`.
// - The reply is read as it arrives and cut at `maxBytes`, so a huge reply is dropped before it is all in memory.
// - A failure is an `HttpError` with a `code`. Its message holds no header value, no credential and no query string.
// - Credentials that were sent are replaced by `[redacted]` in the reply, because a server may echo what it was sent.
// - A header that the credential also sets replaces the request's (or, when the request says `refuse`, is an error).
// - The deadline starts after the credential is in hand: unlocking a secret store may wait for the user.
// - A request is sent once. Nothing is retried, except one resend after a 401 for an OAuth token that came from the
//   cache: the server turned it down for an expired token before it acted, so a write is not repeated.
import type {
    HttpAuth,
    HttpOAuth,
    HttpRequest,
    HttpResponse,
    JigApi,
    SignInRequest,
    TransportRequest,
    TransportResponse,
} from "../contract.ts";
import { untilAborted } from "./abort.ts";
import { HttpError, isHttpError } from "./http-error.ts";
import { createTokens } from "./oauth.ts";
import type { Tokens } from "./oauth.ts";
import { isObject } from "./values.ts";

export { HttpError, isHttpError };

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_MAX_BYTES = 64 * 1024 * 1024;
/** Bytes looked at for a NUL, which text never holds. */
const SNIFF_BYTES = 4096;
export const REDACTED = "[redacted]";

/** What `createHttp` needs from the outside. jig-core passes its own; a test passes fakes. */
export interface HttpDeps {
    /** The network. Looked up when a request is sent. Default: the global `fetch`. */
    fetch?: typeof fetch;
    secrets: { resolve(ref: string, signal?: AbortSignal): Promise<string> };
    signIn: {
        headers(name: string, request: SignInRequest, signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
    };
    transports: { request(name: string, request: TransportRequest, signal?: AbortSignal): Promise<TransportResponse> };
    /** Hides a value that was made here, such as a Basic pair or an OAuth token, from every tool result. */
    redact?: (value: string) => void;
    /** The clock of the token cache, in milliseconds. Default `Date.now`. */
    now?: () => number;
}

// ---- network failures ---------------------------------------------------------------------------------------------

/** Failures before the server has read anything: the address, the name lookup and the connection. A connection that was
 *  reset or closed is not here, because the request may have been written by then. */
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

/** A code is shown in a message only when it looks like one. */
const CODE = /^[A-Za-z0-9_]{1,40}$/;

/** The error code of a failure, which may sit in its cause (`fetch failed` is only the outer words). */
function codeOf(error: unknown): string {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && isObject(current); depth++) {
        if (typeof current.code === "string" && CODE.test(current.code)) return current.code;
        if (Array.isArray(current.errors)) {
            const inner: unknown = current.errors.find((item) => isObject(item) && typeof item.code === "string");
            if (isObject(inner) && typeof inner.code === "string" && CODE.test(inner.code)) return inner.code;
        }
        current = current.cause;
    }
    return "";
}

/** True when the caller's signal fired because time ran out (`AbortSignal.timeout`), not because the call was cancelled. */
function ranOut(caller: AbortSignal): boolean {
    return isObject(caller.reason) && caller.reason.name === "TimeoutError";
}

/** The error for a caller's signal that has fired: the time ran out, or the call was cancelled. */
function stopped(caller: AbortSignal, notSent: boolean, error?: unknown): HttpError {
    if (ranOut(caller)) {
        return new HttpError("timeout", notSent ? "the time ran out before it was sent" : "timed out", notSent, error);
    }
    const message = notSent ? "it was cancelled before it was sent" : "cancelled";
    return new HttpError("aborted", message, notSent, caller.reason ?? error);
}

/** The error for a request that got no reply. The words come from the error code and never from Node's message, which
 *  can quote the address or a header. */
function networkFailure(error: unknown, caller: AbortSignal | undefined, deadline: AbortSignal): HttpError {
    // The user stopped the call: that is the answer, whatever the network reported.
    if (caller?.aborted === true) return stopped(caller, false, error);
    if (deadline.aborted) return new HttpError("timeout", "timed out", false);
    // `fetch` refuses the ports that browsers block, before it connects, and says so in words and not as a code.
    if (isObject(error) && isObject(error.cause) && error.cause.message === "bad port") {
        return new HttpError("bad_port", "the port is one that fetch does not connect to", true, error);
    }
    const code = codeOf(error);
    if (BEFORE_SENDING.has(code)) return new HttpError(code, `could not connect (${code})`, true, error);
    if (CERTIFICATE.has(code)) {
        return new HttpError(
            code,
            `the TLS certificate was not accepted (${code}); certificate checks are never turned off`,
            true,
            error,
        );
    }
    if (code !== "") return new HttpError(code, `the connection failed (${code})`, false, error);
    return new HttpError("network_error", "the connection failed", false, error);
}

// ---- the request --------------------------------------------------------------------------------------------------

const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
/** What a transport can carry: its contract has these five methods and a text body. */
const TRANSPORT_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function invalid(message: string): HttpError {
    return new HttpError("invalid_request", message, true);
}

/** The credential of a request, ready to go: headers, query parameters, and every value to remove from the reply. */
interface Credential {
    headers: Record<string, string>;
    query: Array<[string, string]>;
    secrets: string[];
    /** Set for an OAuth token: how to send the request again with a new one after a 401 for a cached token. */
    oauth?: { fresh: boolean; forget(): void; again(): Promise<Credential> };
}

/** The credentials in a set of request headers: each value, and the token inside `Scheme token`, because a server may
 *  repeat the token without its scheme. */
export function credentialsOf(headers: Readonly<Record<string, string>>): string[] {
    return Object.entries(headers).flatMap(([name, value]) => {
        const token = /^(?:proxy-)?authorization$/i.test(name) ? /^\S+\s+(\S.*)$/.exec(value)?.[1] : undefined;
        return token === undefined ? [value] : [value, token];
    });
}

/** A shorter value is left alone: removing it would blank common words, and jig-core still hides what it knows. */
const MIN_SCRUB_LENGTH = 8;

/** The forms in which a server may repeat a credential: as it is, inside JSON text, and URL-encoded. */
function formsOf(secret: string): string[] {
    return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
}

/** The reply with every one of the secrets removed from its headers, its cookies and its body. */
function scrubbed(response: HttpResponse, secrets: readonly string[]): HttpResponse {
    // The longest first: a value that contains a shorter one is replaced as a whole.
    const needles = [...new Set(secrets.filter((secret) => secret.length >= MIN_SCRUB_LENGTH).flatMap(formsOf))].sort(
        (a, b) => b.length - a.length,
    );
    if (needles.length === 0) return response;
    const clean = (text: string): string =>
        needles.reduce((out, needle) => (out.includes(needle) ? out.split(needle).join(REDACTED) : out), text);
    return {
        ...response,
        body: clean(response.body),
        headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, clean(value)])),
        cookies: response.cookies.map(clean),
    };
}

/** The cookies of a transport's folded `set-cookie` header: split where a new `name=` starts, not at a date's comma. */
function splitCookies(folded: string | undefined): string[] {
    if (folded === undefined || folded === "") return [];
    return folded.split(/,\s*(?=[^;,\s]+=)/).flatMap((cookie) => cookie.split(";")[0]?.trim() ?? []);
}

async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const reader = response.body?.getReader();
    if (reader === undefined) return { bytes: new Uint8Array(0), truncated: false };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks), truncated: false };
        if (value.byteLength > maxBytes - size) {
            chunks.push(value.subarray(0, maxBytes - size));
            await reader.cancel().catch(() => undefined);
            return { bytes: Buffer.concat(chunks), truncated: true };
        }
        chunks.push(value);
        size += value.byteLength;
    }
}

function responseOf(
    status: number,
    headers: Record<string, string>,
    cookies: readonly string[],
    bytes: Uint8Array,
    truncated: boolean,
): HttpResponse {
    return {
        status,
        headers,
        cookies,
        body: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
        truncated,
        binary: bytes.subarray(0, SNIFF_BYTES).includes(0),
    };
}

/** What a transport's reply becomes: its text is cut to the same limit as a reply read from the network. */
function fromTransport(reply: TransportResponse, maxBytes: number): HttpResponse {
    const text = reply.body.length > maxBytes ? reply.body.slice(0, maxBytes) : reply.body;
    let bytes: Uint8Array = Buffer.from(text, "utf8");
    let truncated = text !== reply.body;
    if (bytes.byteLength > maxBytes) {
        bytes = bytes.subarray(0, maxBytes);
        truncated = true;
    }
    const headers: Record<string, string> = {};
    // A header the transport gave as a list was sent several times; the reply folds it as the network path does, and a
    // `set-cookie` list is already one cookie per entry, so it is not split again.
    let listed: string[] | undefined;
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
        const lower = name.toLowerCase();
        const values = typeof value === "string" ? [value] : [...value];
        if (lower === "set-cookie" && typeof value !== "string") listed = [...(listed ?? []), ...values];
        headers[lower] = [...(lower in headers ? [headers[lower]] : []), ...values].join(", ");
    }
    const cookies =
        listed === undefined
            ? splitCookies(headers["set-cookie"])
            : listed.flatMap((cookie) => cookie.split(";")[0]?.trim() ?? []);
    return responseOf(reply.status, headers, cookies, bytes, truncated);
}

/** The headers a request carries before a credential is added: the caller's defaults, replaced by its own headers of the
 *  same name (ignoring case). `defaults` names the ones (in lower case) that are still a default, which a credential's
 *  header replaces without a clash. */
function requestHeaders(request: HttpRequest): { headers: Record<string, string>; defaults: Set<string> } {
    const headers: Record<string, string> = {};
    const put = (name: string, value: string): void => {
        for (const given of Object.keys(headers)) if (given.toLowerCase() === name.toLowerCase()) delete headers[given];
        headers[name] = value;
    };
    for (const [name, value] of Object.entries(request.defaultHeaders ?? {})) put(name, value);
    const defaults = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    for (const [name, value] of Object.entries(request.headers ?? {})) {
        put(name, value);
        defaults.delete(name.toLowerCase());
    }
    return { headers, defaults };
}

/** Checks the shape of `auth` and returns its one kind. */
function authKind(auth: HttpAuth): string {
    if (!isObject(auth)) throw invalid("auth must be an object with one credential source");
    const kinds = Object.keys(auth).filter((key) => (auth as Record<string, unknown>)[key] !== undefined);
    const [kind] = kinds;
    if (
        kinds.length !== 1 ||
        kind === undefined ||
        !["bearer", "basic", "header", "query", "signIn", "oauth"].includes(kind)
    ) {
        throw invalid("auth must name exactly one of bearer, basic, header, query, signIn or oauth");
    }
    return kind;
}

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

export function createHttp(deps: HttpDeps): JigApi["http"] {
    const now = deps.now ?? Date.now;
    const tokens: Tokens = createTokens(now);
    const send: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    const redact = deps.redact ?? (() => {});

    // Requests that share one signal (the several requests of one call) read a secret once: a store that is locked
    // asks the user to unlock it once, and a search of many buckets does not run the backend for every one. A failed
    // read is not kept, and a request with no signal reads every time. A sign-in service is asked for every request,
    // because it is the one that knows when a token has run out.
    const reads = new WeakMap<AbortSignal, Map<string, Promise<string>>>();

    /** Reads a secret. A failure is `auth_failed` with the backend's own words, which never repeat the reference. */
    async function secret(reference: string, caller: AbortSignal | undefined): Promise<string> {
        let kept = caller === undefined ? undefined : reads.get(caller);
        let pending = kept?.get(reference);
        if (pending === undefined) {
            pending = deps.secrets.resolve(reference, caller);
            if (caller !== undefined) {
                if (kept === undefined) {
                    kept = new Map();
                    reads.set(caller, kept);
                }
                const map = kept;
                map.set(reference, pending);
                pending.catch(() => map.delete(reference));
            }
        }
        try {
            return await pending;
        } catch (error) {
            throw credentialFailure(error, caller);
        }
    }

    function credentialFailure(error: unknown, caller: AbortSignal | undefined): HttpError {
        if (isHttpError(error)) return error;
        if (caller?.aborted === true) return stopped(caller, true, error);
        const message = error instanceof Error ? error.message : String(error);
        return new HttpError("auth_failed", message, true, error);
    }

    /** The credential for one request. A token's secrets are read only when a new token is needed. */
    async function credentialFor(
        request: HttpRequest,
        auth: HttpAuth,
        caller: AbortSignal | undefined,
        clock: () => AbortSignal,
    ): Promise<Credential> {
        const kind = authKind(auth);
        switch (kind) {
            case "bearer": {
                const reference = (auth as { bearer: string }).bearer;
                if (!text(reference)) throw invalid("auth.bearer must be a secret reference");
                const token = await secret(reference, caller);
                return { headers: { Authorization: `Bearer ${token}` }, query: [], secrets: [token] };
            }
            case "basic": {
                const { user, password: reference } =
                    (auth as { basic: { user: string; password: string } }).basic ?? {};
                if (typeof user !== "string" || !text(reference)) {
                    throw invalid("auth.basic needs a user name and a secret reference for the password");
                }
                const password = await secret(reference, caller);
                const pair = Buffer.from(`${user}:${password}`).toString("base64");
                // The pair sits inside a longer base64 string, which the redactor does not find on its own.
                redact(pair);
                return { headers: { Authorization: `Basic ${pair}` }, query: [], secrets: [password, pair] };
            }
            case "header": {
                const {
                    name,
                    value: reference,
                    prefix,
                } = (auth as { header: { name: string; value: string; prefix?: string } }).header ?? {};
                if (!text(name) || !text(reference) || (prefix !== undefined && typeof prefix !== "string")) {
                    throw invalid("auth.header needs a header name and a secret reference for the value");
                }
                const value = await secret(reference, caller);
                const sent = `${prefix ?? ""}${value}`;
                return { headers: { [name]: sent }, query: [], secrets: credentialsOf({ [name]: sent }).concat(value) };
            }
            case "query": {
                const { name, value: reference } = (auth as { query: { name: string; value: string } }).query ?? {};
                if (!text(name) || !text(reference)) {
                    throw invalid("auth.query needs a parameter name and a secret reference for the value");
                }
                const value = await secret(reference, caller);
                return { headers: {}, query: [[name, value]], secrets: [value] };
            }
            case "signIn": {
                const name = (auth as { signIn: string }).signIn;
                if (!text(name)) throw invalid("auth.signIn must name a sign-in service");
                try {
                    // Asked for every request: the service decides when its token has expired.
                    // It signs the request as it will be sent: the method, the headers (without this credential)
                    // and the body, and not only the address.
                    const headers = await deps.signIn.headers(
                        name,
                        {
                            system: request.system,
                            url: request.url,
                            method: request.method,
                            headers: requestHeaders(request).headers,
                            ...(request.body === undefined ? {} : { body: request.body }),
                        },
                        caller,
                    );
                    return { headers: { ...headers }, query: [], secrets: credentialsOf(headers) };
                } catch (error) {
                    throw credentialFailure(error, caller);
                }
            }
            case "oauth": {
                const oauth = (auth as { oauth: HttpOAuth }).oauth;
                const login = {
                    cache: oauth?.cache ?? "",
                    system: request.system,
                    read: (reference: string) => secret(reference, caller),
                    redact,
                    send: (tokenRequest: HttpRequest, signal: AbortSignal) =>
                        exchange(tokenRequest, undefined, signal, caller),
                    clock,
                };
                const token = await tokens.get(login, oauth);
                return {
                    headers: { Authorization: `Bearer ${token.value}` },
                    query: [],
                    secrets: [token.value],
                    oauth: {
                        fresh: token.fresh,
                        forget: () => tokens.forget(token.id),
                        again: async () => {
                            const next = await tokens.get(login, oauth);
                            return {
                                headers: { Authorization: `Bearer ${next.value}` },
                                query: [],
                                secrets: [next.value],
                            };
                        },
                    },
                };
            }
            default:
                throw invalid("auth must name exactly one of bearer, basic, header, query, signIn or oauth");
        }
    }

    /** One exchange with the network or a transport, under the signal. Throws `HttpError`. */
    async function exchange(
        request: HttpRequest,
        credential: Credential | undefined,
        deadline: AbortSignal,
        caller: AbortSignal | undefined,
    ): Promise<HttpResponse> {
        const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
        const signal = caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
        if (signal.aborted) {
            // Nothing has gone out: say whether the call was cancelled or the time ran out first.
            if (caller?.aborted === true) throw stopped(caller, true);
            throw new HttpError("timeout", "the time ran out before it was sent", true);
        }
        // The defaults first, then the request's own, which replace a default of the same name (ignoring case).
        const { headers, defaults } = requestHeaders(request);
        if (credential !== undefined) {
            for (const [name, value] of Object.entries(credential.headers)) {
                const lower = name.toLowerCase();
                const clash = Object.keys(headers).some(
                    (given) => given.toLowerCase() === lower && !defaults.has(lower),
                );
                if (clash && request.onHeaderClash === "refuse") {
                    throw invalid(`header ${name} is set by the sign-in, so the request cannot have it too`);
                }
                // The credential's header replaces the request's, and a default's, of the same name.
                for (const given of Object.keys(headers)) if (given.toLowerCase() === lower) delete headers[given];
                headers[name] = value;
            }
        }

        if (request.transport !== undefined) return viaTransport(request, headers, signal, caller, deadline, maxBytes);

        const address = new URL(request.url);
        for (const [name, value] of credential?.query ?? []) address.searchParams.append(name, value);
        let sentHeaders: Headers;
        try {
            sentHeaders = new Headers(headers);
        } catch {
            // The message of `Headers` repeats the value, which may be a credential.
            throw invalid("a header holds a character that cannot be sent");
        }
        const init: RequestInit = {
            method: request.method,
            headers: sentHeaders,
            redirect: "manual",
            signal,
            ...(request.body === undefined ? {} : { body: request.body }),
        };
        try {
            const reply = await untilAborted(send(address.href, init), signal);
            const { bytes, truncated } = await untilAborted(readBody(reply, maxBytes), signal);
            const received: Record<string, string> = {};
            reply.headers.forEach((value, name) => {
                const lower = name.toLowerCase();
                received[lower] = lower === "set-cookie" && lower in received ? `${received[lower]}, ${value}` : value;
            });
            const cookies = reply.headers.getSetCookie().flatMap((cookie) => cookie.split(";")[0]?.trim() ?? []);
            return responseOf(reply.status, received, cookies, bytes, truncated);
        } catch (error) {
            throw networkFailure(error, caller, deadline);
        }
    }

    async function viaTransport(
        request: HttpRequest,
        headers: Record<string, string>,
        signal: AbortSignal,
        caller: AbortSignal | undefined,
        deadline: AbortSignal,
        maxBytes: number,
    ): Promise<HttpResponse> {
        const name = request.transport as string;
        if (!TRANSPORT_METHODS.has(request.method)) {
            throw invalid(`a transport carries GET, POST, PUT, PATCH and DELETE, and not ${request.method}`);
        }
        if (request.body !== undefined && typeof request.body !== "string") {
            throw invalid("a transport carries a text body, and not a file or a multipart form");
        }
        const sent: TransportRequest = {
            system: request.system,
            method: request.method as TransportRequest["method"],
            url: request.url,
            headers,
            ...(request.body === undefined ? {} : { body: request.body }),
            maxBytes,
            timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        };
        try {
            const reply = await untilAborted(deps.transports.request(name, sent, signal), signal);
            return fromTransport(reply, maxBytes);
        } catch (error) {
            if (caller?.aborted === true) throw stopped(caller, false, error);
            if (deadline.aborted) throw new HttpError("timeout", "timed out", false);
            const message = error instanceof Error ? error.message : String(error);
            // jig-core says so when no transport has this name; then nothing was sent.
            if (/^no transport named /.test(message)) throw new HttpError("no_transport", message, true, error);
            throw new HttpError("transport_failed", message.replace(/\s+/g, " ").slice(0, 160), false, error);
        }
    }

    return {
        async request(request, caller) {
            if (!isObject(request)) throw invalid("the request must be an object");
            if (!text(request.system)) throw invalid("the request needs a system name");
            if (typeof request.url !== "string" || !/^https?:\/\//i.test(request.url)) {
                throw invalid("the address must be an http or https address");
            }
            try {
                new URL(request.url);
            } catch {
                throw invalid("the address is not a valid web address");
            }
            if (!METHODS.has(request.method as string)) throw invalid("the method is not one that can be sent");
            if (request.auth !== undefined && request.transport !== undefined) {
                throw invalid("a transport signs in itself, so the request cannot also name a credential");
            }
            if (request.transport !== undefined && !text(request.transport)) {
                throw invalid("transport must name a registered transport");
            }
            if (
                request.onHeaderClash !== undefined &&
                request.onHeaderClash !== "replace" &&
                request.onHeaderClash !== "refuse"
            ) {
                throw invalid("onHeaderClash must be replace or refuse");
            }
            for (const given of [request.headers, request.defaultHeaders]) {
                for (const [name, value] of Object.entries(given ?? {})) {
                    if (typeof value !== "string") throw invalid(`header ${name.slice(0, 40)} must be text`);
                }
            }
            const timeoutMs = Math.min(
                MAX_TIMEOUT_MS,
                Math.max(1, Math.round(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
            );
            const maxBytes = Math.min(MAX_MAX_BYTES, Math.max(1, Math.floor(request.maxBytes ?? DEFAULT_MAX_BYTES)));
            if (Number.isNaN(timeoutMs) || Number.isNaN(maxBytes))
                throw invalid("timeoutMs and maxBytes must be numbers");
            const asked: HttpRequest = { ...request, timeoutMs, maxBytes };

            // The deadline starts at the first request that goes out, after the credential is in hand.
            let clock: AbortSignal | undefined;
            const deadline = (): AbortSignal => {
                clock ??= AbortSignal.timeout(timeoutMs);
                return clock;
            };

            let credential: Credential | undefined;
            if (request.auth !== undefined) credential = await credentialFor(asked, request.auth, caller, deadline);
            let reply = await exchange(asked, credential, deadline(), caller);
            if (credential?.oauth !== undefined && reply.status === 401 && !credential.oauth.fresh) {
                // The server turned a cached token down before it acted, so sending again cannot repeat a write.
                credential.oauth.forget();
                const again = await credential.oauth.again();
                credential = { ...again };
                reply = await exchange(asked, credential, deadline(), caller);
            }
            return credential === undefined ? reply : scrubbed(reply, credential.secrets);
        },
    };
}
