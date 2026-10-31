// Transports: how a company plugin carries requests to its own systems itself.
//
// Some companies keep the session for their systems in a local sign-in proxy, and a tool must send its request
// through that proxy rather than call the network with a token. A transport is that path. Tools build the same HTTP
// request either way, so a company changes only which way it travels. What comes back still goes through jig-core's
// result hook: redacted, masked where needed and capped, like any other result.
import type { Transport, TransportRequest, TransportResponse } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from "./kit/http.ts";
import { printable } from "./kit/text.ts";

export interface Transports {
    register(name: string, transport: Transport): void;
    request(name: string, request: TransportRequest, signal?: AbortSignal): Promise<TransportResponse>;
}

/** The most registered names an error lists. */
const MAX_NAMES_SHOWN = 10;

/** The response as a plain copy, checked where another package's mistake would otherwise surface as a confusing
 *  failure deep inside a tool. Header names are lower-cased; a header given twice under names that differ only in case, or
 *  as a list, keeps every value as a list. */
function checkResponse(name: string, value: unknown): TransportResponse {
    const who = `transport "${printable(name)}"`;
    if (typeof value !== "object" || value === null) throw new TypeError(`${who} returned no response`);
    const response = value as Record<string, unknown>;
    const { status, headers, body } = response;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        throw new TypeError(`${who} returned a response without a valid HTTP status`);
    }
    if (typeof body !== "string") throw new TypeError(`${who} returned a response whose body is not text`);
    const copy: Record<string, string | string[]> = {};
    if (headers !== undefined) {
        if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
            throw new TypeError(`${who} returned headers that are not an object`);
        }
        for (const [header, headerValue] of Object.entries(headers)) {
            const values: unknown[] = Array.isArray(headerValue) ? headerValue : [headerValue];
            if (values.some((item) => typeof item !== "string"))
                throw new TypeError(`${who} returned a header (${printable(header)}) that is not text`);
            const lower = header.toLowerCase();
            const before = copy[lower];
            if (before === undefined && !Array.isArray(headerValue)) copy[lower] = headerValue as string;
            else copy[lower] = [...(before === undefined ? [] : [before].flat()), ...(values as string[])];
        }
    }
    return { status, headers: copy, body };
}

/** The limits a transport is told, when the caller (a plugin that calls `transports.request` itself) gave none. */
function withLimits(request: TransportRequest): TransportRequest {
    const usable = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 1;
    return {
        ...request,
        maxBytes: usable(request.maxBytes) ? Math.floor(request.maxBytes) : DEFAULT_MAX_BYTES,
        timeoutMs: usable(request.timeoutMs) ? Math.floor(request.timeoutMs) : DEFAULT_TIMEOUT_MS,
    };
}

export function createTransports(): Transports {
    const transports = new Map<string, Transport>();

    return {
        register(name, transport) {
            if (typeof name !== "string" || name.trim() === "") throw new TypeError("a transport needs a name");
            if (typeof transport !== "object" || transport === null || typeof transport.request !== "function") {
                throw new TypeError(`transport "${printable(name)}" must have a request function`);
            }
            transports.set(name, transport);
        },

        async request(name, request, signal) {
            const transport = transports.get(name);
            if (transport === undefined) {
                const names = [...transports.keys()].slice(0, MAX_NAMES_SHOWN).map(printable);
                const known = names.length === 0 ? "none is registered" : `registered: ${names.join(", ")}`;
                throw new Error(`no transport named "${printable(name)}" (${known}); a company plugin registers it`);
            }
            let response: unknown;
            try {
                response = await transport.request(withLimits(request), signal);
            } catch (error) {
                // The request is not repeated in the message: its URL or body may carry data the model should not
                // see unmasked, and the tool knows what it asked for.
                throw new Error(`transport "${printable(name)}" failed: ${errorMessage(error)}`);
            }
            return checkResponse(name, response);
        },
    };
}
