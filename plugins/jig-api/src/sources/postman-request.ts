// One Postman item read as a saved request, and the walk of folders that finds them: the address, headers, what a request inherits from
// the folders above it, scripts (only to know whether they exist), and the reasons a request is refused. postman.ts calls `walk` once for
// the whole collection.
import { isObject } from "../engine/values.ts";
import { CREDENTIAL_HEADERS } from "../model.ts";
import type { Auth, SavedRequest } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import { authTexts, bodyTexts } from "./texts.ts";
import { authOf } from "./postman-auth.ts";
import type { AuthResult } from "./postman-auth.ts";
import { bodyOf } from "./postman-body.ts";
import { descriptionOf, text, variablesOf } from "./postman-values.ts";
import type { Reading } from "./postman-values.ts";

const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const NOT_HTTP = /grpc|websocket|socket\.?io|mqtt|\bsse\b|event-?stream/i;

/** True when an event list holds a script that is switched on and has something in it. */
export function scriptOf(events: unknown, listen: string): boolean {
    if (!Array.isArray(events)) return false;
    return (events as unknown[]).some((event) => {
        if (!isObject(event) || event.listen !== listen || event.disabled === true || !isObject(event.script))
            return false;
        const { exec, src } = event.script;
        const lines = Array.isArray(exec) ? (exec as unknown[]).filter((line) => typeof line === "string") : [exec];
        const code = lines.filter((line) => typeof line === "string").join("\n");
        return code.trim() !== "" || (src !== undefined && src !== null && src !== "");
    });
}

/** The address as one template. */
function addressOf(url: unknown): string {
    let raw: string;
    if (typeof url === "string") raw = url.trim();
    else if (!isObject(url)) return "";
    else raw = rawAddress(url);
    // A fragment is never sent.
    const hash = raw.indexOf("#");
    return hash >= 0 ? raw.slice(0, hash) : raw;
}

/** The address of a URL object: the `raw` text if there is some, else the parts put together. */
function rawAddress(url: Record<string, unknown>): string {
    let raw: string;
    if (typeof url.raw === "string" && url.raw.trim() !== "") {
        raw = url.raw.trim();
    } else {
        const host = Array.isArray(url.host)
            ? (url.host as unknown[]).map(String).join(".")
            : typeof url.host === "string"
              ? url.host
              : "";
        const segments = Array.isArray(url.path)
            ? (url.path as unknown[]).map((segment) =>
                  isObject(segment) ? String(segment.value ?? "") : String(segment),
              )
            : typeof url.path === "string"
              ? [url.path]
              : [];
        const query = Array.isArray(url.query)
            ? (url.query as unknown[]).flatMap((item) => {
                  if (!isObject(item) || item.disabled === true || typeof item.key !== "string") return [];
                  return [
                      `${item.key}${item.value === null || item.value === undefined ? "" : `=${String(item.value)}`}`,
                  ];
              })
            : [];
        const protocol = typeof url.protocol === "string" && url.protocol !== "" ? `${url.protocol}://` : "";
        const port = typeof url.port === "string" && url.port !== "" ? `:${url.port}` : "";
        const path = segments.length > 0 ? `/${segments.join("/").replace(/^\/+/, "")}` : "";
        raw = `${protocol}${host}${port}${path}${query.length > 0 ? `?${query.join("&")}` : ""}`;
    }
    // Path variables (`/orders/:id`) take the values the URL object gives them.
    if (Array.isArray(url.variable)) {
        for (const item of url.variable as unknown[]) {
            if (isObject(item) && typeof item.key === "string" && item.key !== "") {
                const value = text(item.value);
                if (value !== undefined && value !== "") {
                    const name = item.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    raw = raw.replace(new RegExp(`/:${name}(?=[/?#]|$)`, "g"), () => `/${value}`);
                }
            }
        }
    }
    return raw;
}

function headersOf(raw: unknown): Array<readonly [string, string]> {
    const headers: Array<readonly [string, string]> = [];
    if (Array.isArray(raw)) {
        for (const item of raw as unknown[]) {
            if (!isObject(item) || item.disabled === true || typeof item.key !== "string" || item.key.trim() === "")
                continue;
            headers.push([item.key.trim(), text(item.value) ?? ""]);
        }
    } else if (typeof raw === "string") {
        for (const line of raw.split(/\r?\n/)) {
            const at = line.indexOf(":");
            if (at > 0) headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
        }
    }
    return headers;
}

/** What the protocol profile of an item says about how it is sent. Only HTTP is sent, with the same care for every request. */
export function behaviourOf(raw: unknown): { unsupported: string | undefined; notes: string[] } {
    const notes: string[] = [];
    if (!isObject(raw)) return { unsupported: undefined, notes };
    for (const [key, value] of Object.entries(raw)) {
        if (NOT_HTTP.test(key) || (typeof value === "string" && NOT_HTTP.test(value))) {
            return { unsupported: `its protocol profile (${key}) is not plain HTTP, and only HTTP is sent`, notes };
        }
        if (key === "followRedirects" && value === true)
            notes.push("followRedirects is ignored: redirects are never followed");
        if (key === "strictSSL" && value === false)
            notes.push("strictSSL: false is ignored: certificates are always checked");
    }
    return { unsupported: undefined, notes };
}

function schemeProblem(url: string): string | undefined {
    const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
    const scheme = match?.[1]?.toLowerCase();
    if (scheme === undefined || scheme === "http" || scheme === "https") return undefined;
    return `the address uses ${scheme}://, and only http and https are sent (not WebSocket, gRPC or MQTT)`;
}

/** Everything an item inherits from the folders above it. */
interface Inherited {
    folder: readonly string[];
    auth: AuthResult | undefined;
    prerequest: string | undefined;
    behaviour: { unsupported: string | undefined; notes: string[] };
    defaults: ReadonlyMap<string, string>;
}

function requestOf(item: Record<string, unknown>, inherited: Inherited, reading: Reading, key: string): SavedRequest {
    const given = item.request;
    const request: Record<string, unknown> = isObject(given) ? given : { url: given, method: "GET" };
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : "(unnamed)";
    const method = (
        typeof request.method === "string" && request.method.trim() !== "" ? request.method.trim() : "GET"
    ).toUpperCase();
    const url = addressOf(request.url);
    const headers = [...headersOf(request.header)];
    const body = bodyOf(request.body);
    const notes = [...inherited.behaviour.notes, ...body.notes];
    const behaviour = behaviourOf(item.protocolProfileBehavior);
    notes.push(...behaviour.notes);

    // The sign-in: the request's own, else the nearest folder's, else the collection's.
    const own = authOf(request.auth, reading, `${key}.request.auth`);
    const effective = own ?? inherited.auth;
    const auth: Auth = effective?.auth ?? { kind: "none" };

    if (body.contentType !== undefined && !headers.some(([header]) => header.toLowerCase() === "content-type")) {
        headers.push(["Content-Type", body.contentType]);
    }

    const variables = variablesIn(
        url,
        ...headers.map(([, value]) => value),
        ...bodyTexts(body.body),
        ...authTexts(auth),
    );
    const signsIn = variablesIn(
        ...authTexts(auth),
        ...headers.filter(([header]) => CREDENTIAL_HEADERS.has(header.toLowerCase())).map(([, value]) => value),
    );

    let unsupported: string | undefined;
    if (!SENT_METHODS.has(method)) {
        unsupported = /^(?:WEBSOCKET|WS|GRPC|MQTT)$/.test(method)
            ? `${method} is not plain HTTP, and only HTTP is sent`
            : `the method ${method} is not sent (GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE are)`;
    }
    unsupported ??= schemeProblem(url);
    unsupported ??= inherited.behaviour.unsupported ?? behaviour.unsupported;
    unsupported ??= effective?.unsupported;
    unsupported ??= body.unsupported;
    unsupported ??= unsupportedVariable(variables);
    if (url === "") unsupported ??= "it has no address";

    // Scripts: the request's own pre-request script, or one from a folder or the collection above it.
    const ownScript = scriptOf(item.event, "prerequest");
    const where = ownScript ? "the request" : inherited.prerequest;
    if (scriptOf(item.event, "test")) notes.push("its test script is ignored (scripts never run)");

    const defaults = new Map([...inherited.defaults, ...variablesOf(item.variable)]);
    const description = descriptionOf(request.description) ?? descriptionOf(item.description);
    return {
        collection: reading.collection,
        folder: inherited.folder,
        name,
        origin: `${reading.shown}: ${[...inherited.folder, name].join("/")}`,
        method,
        url,
        headers,
        ...(body.body === undefined ? {} : { body: body.body }),
        auth,
        variables,
        secrets: variables.filter((variable) => reading.secretNames.has(variable)),
        signsIn,
        defaults,
        scripts: { prerequest: where !== undefined, ...(where === undefined ? {} : { where }) },
        ...(unsupported === undefined ? {} : { unsupported }),
        notes,
        ...(description === undefined ? {} : { description }),
    };
}

/** Walks the items of the collection or of a folder, and collects the requests in order. */
export function walk(
    items: unknown,
    inherited: Inherited,
    reading: Reading,
    prefix: string,
    found: SavedRequest[],
): void {
    if (!Array.isArray(items)) return;
    (items as unknown[]).forEach((item, index) => {
        const key = `${prefix}[${index}]`;
        if (!isObject(item)) {
            reading.problems.push({
                file: reading.shown,
                key,
                message: "is not a request or a folder",
                level: "warning",
            });
            return;
        }
        if (Array.isArray(item.item)) {
            const name =
                typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : "(unnamed folder)";
            const auth = authOf(item.auth, reading, `${key}.auth`);
            const behaviour = behaviourOf(item.protocolProfileBehavior);
            walk(
                item.item,
                {
                    folder: [...inherited.folder, name],
                    auth: auth ?? inherited.auth,
                    prerequest: scriptOf(item.event, "prerequest") ? `the folder ${name}` : inherited.prerequest,
                    behaviour: {
                        unsupported: inherited.behaviour.unsupported ?? behaviour.unsupported,
                        notes: [...inherited.behaviour.notes, ...behaviour.notes],
                    },
                    defaults: new Map([...inherited.defaults, ...variablesOf(item.variable)]),
                },
                reading,
                `${key}.item`,
                found,
            );
        } else if (item.request !== undefined) {
            found.push(requestOf(item, inherited, reading, key));
        } else {
            reading.problems.push({
                file: reading.shown,
                key,
                message: "has neither a request nor items",
                level: "warning",
            });
        }
    });
}
