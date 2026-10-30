// The checks on an ad-hoc `call`, which is the one request the agent writes itself: its address, its body, its headers and its
// timeout. A saved request is the team's; this one is the agent's, so each part is held to a narrow set of characters and
// sizes, and every refusal says what to change. Nothing here does I/O.
import { DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC } from "./config.ts";
import { InputError, shown } from "./engine/values.ts";

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_HEADERS = 10;

/** The characters of a path and a query. */
const CHARS = "A-Za-z0-9._~/!$&'()*+,;=:@%-";
const PATH_AND_QUERY = new RegExp(`^(/[${CHARS}]{0,400})(\\?[${CHARS}]{0,400})?$`);
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,1000}$/;

/**
 * Headers that the tool sets itself, or that control the connection or the framing of the request: a value from the agent
 * would break the request or smuggle another one. The last three ask a server to treat the request as another method, which
 * would let a GET, a read that nobody is asked about, act as a write. `Authorization` and `Cookie` are the sign-in's.
 */
export const REFUSED_HEADERS: ReadonlySet<string> = new Set([
    "authorization", "proxy-authorization", "cookie", "host", "content-length", "transfer-encoding", "connection",
    "upgrade", "te", "expect", "x-http-method-override", "x-http-method", "x-method-override",
]);

/** How many times a path is percent-decoded when it is searched for "..". */
const MAX_DECODE_ROUNDS = 5;

function fail(message: string): never {
    throw new InputError(`api call: ${message}`);
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * True when the text holds ".." once it is percent-decoded as far as it goes. A server or a proxy in front of it may decode
 * twice, so `%252e%252e` must not pass as a name. Text that is still changing after several rounds is refused too.
 */
export function climbs(text: string): boolean {
    let current = text;
    for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
        if (current.includes("..")) return true;
        const decoded = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        if (decoded === current) return false;
        current = decoded;
    }
    return true;
}

/**
 * The address of a call, cut into where it goes and what it asks for. The path is read from the text as it was written:
 * a parser would quietly resolve `..` and so hide it.
 */
export function checkUrl(value: unknown): { origin: string; rest: string } {
    if (typeof value !== "string" || value.trim() === "") fail("url is required, such as https://api.staging.example.com/v1/orders/123");
    const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(value.trim());
    if (match === null) fail(`url must be a whole address such as https://api.staging.example.com/v1/orders (got ${shown(value, 40)})`);
    const origin = match[1] as string;
    const rest = (match[2] as string) === "" ? "/" : (match[2] as string);
    const scheme = origin.slice(0, origin.indexOf(":")).toLowerCase();
    if (scheme !== "http" && scheme !== "https") fail(`the address uses ${scheme}://, and only http and https are sent (not WebSocket, gRPC or MQTT)`);
    if (origin.includes("@")) fail("the address must not contain a user name or password");
    const path = PATH_AND_QUERY.exec(rest);
    if (path === null || climbs(rest)) {
        fail(
            "the path must hold only letters, digits and . _ ~ / ! $ & ' ( ) * + , ; = : @ % - " +
                `(at most 400 characters, one optional ?query, no .. and no #fragment) (got ${shown(rest, 40)})`,
        );
    }
    return { origin, rest };
}

/** The JSON text to send. `null` and a missing body both mean no body, as models often send `null` for an unused field. */
export function checkBody(method: string, body: unknown): string | undefined {
    if (!present(body)) return undefined;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") fail(`a ${method} has no body: put the parameters in the ?query`);
    let text: string | undefined;
    try {
        text = JSON.stringify(body);
    } catch {
        fail("body must be a JSON value");
    }
    if (text === undefined) fail("body must be a JSON value");
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) fail(`body is larger than ${MAX_BODY_BYTES / 1024} KiB`);
    return text;
}

export function checkHeaders(headers: unknown): Array<[string, string]> {
    if (!present(headers)) return [];
    if (typeof headers !== "object" || Array.isArray(headers)) fail("headers must be an object of name to value");
    const entries = Object.entries(headers as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) fail(`at most ${MAX_HEADERS} headers (got ${entries.length})`);
    const seen = new Set<string>();
    const checked: Array<[string, string]> = [];
    for (const [name, value] of entries) {
        if (!HEADER_NAME.test(name)) {
            fail(`header name must be letters, digits and - starting with a letter, at most 41 characters (got ${shown(name)})`);
        }
        const lower = name.toLowerCase();
        if (REFUSED_HEADERS.has(lower)) {
            fail(`header ${name} is set by the tool or controls the connection, so it cannot be given`);
        }
        if (seen.has(lower)) fail(`header ${name} is given twice`);
        seen.add(lower);
        if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
            fail(`header ${name} must be 1 to 1000 printable ASCII characters`);
        }
        checked.push([name, value]);
    }
    return checked;
}

export function checkTimeout(value: unknown, fallback: number = DEFAULT_TIMEOUT_SEC): number {
    if (!present(value)) return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_SEC) {
        fail(`timeoutSec must be a whole number from 1 to ${MAX_TIMEOUT_SEC} (got ${shown(value)})`);
    }
    return value;
}
