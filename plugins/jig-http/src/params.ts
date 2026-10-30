// The parameters of the `http` tool, and the checks that turn them into a Call. Everything that reaches the network has
// passed through parseCall: the target is a configured one, the path and headers hold only what is allowed, and the body is
// JSON of a known size. parseCall does no I/O.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { HttpSettings, Target } from "./config.ts";
import { InputError, shortList, shown } from "./values.ts";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export const DEFAULT_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 120;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_HEADERS = 10;

export const parameters = Type.Object({
    target: Type.String({ description: "Name of a configured API. An unknown name is refused with the names there are" }),
    method: StringEnum(METHODS, { description: "GET reads; POST, PUT, PATCH and DELETE write" }),
    path: Type.String({
        description:
            "Starts with /, at most one ?query. Letters, digits and . _ ~ / ! $ & ' ( ) * + , ; = : @ % - only, no ..",
    }),
    body: Type.Optional(Type.Unknown({ description: "JSON body: any JSON value, at most 256 KiB. Not for GET" })),
    headers: Type.Optional(Type.Object({}, {
        additionalProperties: Type.String(),
        description: 'Extra headers, at most 10, such as {"X-Request-Id": "t1"}. The tool adds the sign-in',
    })),
    timeoutSec: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_SEC,
        description: `Seconds to wait for the answer (default ${DEFAULT_TIMEOUT_SEC})`,
    })),
});

/** One call, checked: what the tool will send, in a typed form. */
export interface Call {
    target: Target;
    method: Method;
    /** The path, without its query. */
    path: string;
    /** `?a=b`, or empty. */
    query: string;
    /** The JSON text that is sent, or undefined for no body. */
    body: string | undefined;
    /** The headers the caller gave, in the order given. */
    headers: ReadonlyArray<readonly [name: string, value: string]>;
    timeoutSec: number;
}

const PARAMS: readonly string[] = ["target", "method", "path", "body", "headers", "timeoutSec"];
const REQUIRED: readonly string[] = ["target", "method", "path"];
export const USAGE = "Usage: http {target, method, path, body?, headers?, timeoutSec?}";

const NOT_SET_UP =
    'http is not set up: add an "http" section with "targets" to jig.json (/jig lists configuration problems)';

const CHARS = "A-Za-z0-9._~/!$&'()*+,;=:@%-";
const PATH_AND_QUERY = new RegExp(`^(/[${CHARS}]{0,400})(\\?[${CHARS}]{0,400})?$`);
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,1000}$/;

/**
 * Headers that the tool sets itself, or that control the connection or the framing of the request: a value from the
 * model would break the request or smuggle another one. The last three ask a server to treat the request as another
 * method, which would let a GET, a read that nobody is asked about, act as a write.
 */
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
    "authorization", "proxy-authorization", "cookie", "host", "content-length", "transfer-encoding", "connection",
    "upgrade", "te", "expect", "x-http-method-override", "x-http-method", "x-method-override",
]);

/** How many times a path is percent-decoded when it is searched for "..". */
const MAX_DECODE_ROUNDS = 5;

function fail(message: string): never {
    throw new InputError(`http: ${message}`);
}

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

export function isMethod(value: unknown): value is Method {
    return typeof value === "string" && (METHODS as readonly string[]).includes(value);
}

/** `billing (staging: the billing API)`: how an error names a target. */
function describe(target: Target): string {
    const about = target.description === undefined ? "" : `: ${target.description.slice(0, 40)}`;
    return `${target.name} (${target.environment}${about})`;
}

/**
 * The target a call names. An unknown name is invalid input, and the error lists the names there are, because the model
 * has no other way to learn them.
 */
export function findTarget(settings: HttpSettings | undefined, name: unknown): Target {
    if (settings === undefined) throw new InputError(NOT_SET_UP);
    const target = typeof name === "string" ? settings.targets.get(name) : undefined;
    if (target !== undefined) return target;
    const problem = present(name) ? `http: no target named ${shown(name, 30)}` : "http needs target";
    const known = shortList([...settings.targets.values()].map(describe), ", ", 120);
    throw new InputError(`${problem}. Known targets: ${known}`);
}

/**
 * True when the text holds ".." once it is percent-decoded as far as it goes. A server or a proxy in front of it may decode
 * twice, so `%252e%252e` must not pass as a name. Text that is still changing after several rounds is refused too.
 */
function climbs(text: string): boolean {
    let current = text;
    for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
        if (current.includes("..")) return true;
        const decoded = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        if (decoded === current) return false;
        current = decoded;
    }
    return true;
}

function checkPath(path: unknown): { path: string; query: string } {
    if (typeof path !== "string" || path === "") fail("path is required, like /v1/accounts/123");
    const match = PATH_AND_QUERY.exec(path);
    if (match === null || climbs(path)) {
        fail(
            "path must start with / and hold only letters, digits and . _ ~ / ! $ & ' ( ) * + , ; = : @ % - " +
                `(at most 400 characters, one optional ?query, no ..) (got ${shown(path)})`,
        );
    }
    return { path: match[1] ?? "", query: match[2] ?? "" };
}

/** The JSON text to send. `null` and a missing body both mean no body, as models often send `null` for an unused field. */
function checkBody(method: Method, body: unknown): string | undefined {
    if (!present(body)) return undefined;
    if (method === "GET") fail("a GET has no body: put the parameters in the path's ?query");
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

function checkHeaders(headers: unknown): Array<[string, string]> {
    if (!present(headers)) return [];
    if (typeof headers !== "object" || Array.isArray(headers)) fail("headers must be an object of name to value");
    const entries = Object.entries(headers as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) fail(`at most ${MAX_HEADERS} headers (got ${entries.length})`);
    const seen = new Set<string>();
    const checked: Array<[string, string]> = [];
    for (const [name, value] of entries) {
        if (!HEADER_NAME.test(name)) {
            fail(
                "header name must be letters, digits and - starting with a letter, at most 41 characters " +
                    `(got ${shown(name)})`,
            );
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

function checkTimeout(value: unknown): number {
    if (!present(value)) return DEFAULT_TIMEOUT_SEC;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_SEC) {
        fail(`timeoutSec must be a whole number from 1 to ${MAX_TIMEOUT_SEC} (got ${shown(value)})`);
    }
    return value;
}

/**
 * Checks a call and returns it in a typed form. Every problem is an InputError, a `TypeError` that says what to change,
 * with the usage line when the shape is wrong, so the model can correct the call at once.
 */
export function parseCall(input: Readonly<Record<string, unknown>>, settings: HttpSettings | undefined): Call {
    const extra = Object.keys(input).filter((name) => present(input[name]) && !PARAMS.includes(name));
    if (extra.length > 0) throw new InputError(`http does not use ${extra.join(", ")}. ${USAGE}`);
    const missing = REQUIRED.filter((name) => !present(input[name]));
    if (missing.length > 0) throw new InputError(`http needs ${missing.join(", ")}. ${USAGE}`);

    const target = findTarget(settings, input.target);
    const { method } = input;
    if (!isMethod(method)) fail(`method must be one of ${METHODS.join(", ")} (got ${shown(method)})`);
    const { path, query } = checkPath(input.path);
    const body = checkBody(method, input.body);
    const headers = checkHeaders(input.headers);
    return { target, method, path, query, body, headers, timeoutSec: checkTimeout(input.timeoutSec) };
}
