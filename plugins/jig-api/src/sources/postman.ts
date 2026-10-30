// Postman: a collection exported as JSON (collection format v2.1, which v2.0 matches closely enough for what is read here)
// and, optionally, environments exported as JSON.
//
// What is read: folders and requests, the address (a string, or an object with `raw`), headers, the body (raw, URL-encoded
// form, multipart form, a file, GraphQL), `auth` of the types that need no browser (bearer, basic, apikey, oauth2 with a
// client-credentials or password grant), variables, and the `event` scripts, only to know whether they exist.
// What is never done: a script is not run. A request that a pre-request script applies to (its own, its folder's or the
// collection's) is refused by name, and a test script is ignored with a note.
import path from "node:path";
import { isObject } from "../engine/values.ts";
import { CREDENTIAL_HEADERS, declaredSecrets } from "../model.ts";
import type { Auth, Body, Collection, Environment, FormField, Problem, SavedRequest, Variable } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import { expandHome, readText, whyNotRead } from "./files.ts";
import type { Source } from "./source.ts";
import { authTexts, bodyTexts } from "./texts.ts";

export interface PostmanConfig {
    file: string;
    environments: ReadonlyArray<readonly [name: string, file: string]>;
}

const COLLECTION_MAX_BYTES = 32 * 1024 * 1024;
const ENVIRONMENT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENVIRONMENTS = 20;

const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const NOT_HTTP = /grpc|websocket|socket\.?io|mqtt|\bsse\b|event-?stream/i;

const NAME = /^[^\u0000-\u001f\u007f]{1,60}$/;

function absolutePath(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value !== "string" || value.trim() === "" || value.length > 1000 || value.includes("\0")) {
        errors.push(`${key}: must be a path`);
        return undefined;
    }
    const file = expandHome(value.trim());
    if (!path.isAbsolute(file)) {
        errors.push(`${key}: must be an absolute path or start with ~/`);
        return undefined;
    }
    return path.normalize(file);
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): PostmanConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry)) if (key !== "postman" && key !== "environments") errors.push(`${at}.${key}: unknown field`);

    const file = absolutePath(entry.postman, `${at}.postman`, errors);

    const environments: Array<readonly [string, string]> = [];
    const raw = entry.environments;
    if (raw !== undefined) {
        if (!isObject(raw)) {
            errors.push(`${at}.environments: must be an object that maps an environment name to the path of its exported file`);
        } else if (Object.keys(raw).length > MAX_ENVIRONMENTS) {
            errors.push(`${at}.environments: at most ${MAX_ENVIRONMENTS} environments`);
        } else {
            for (const [name, value] of Object.entries(raw)) {
                if (!NAME.test(name)) {
                    errors.push(`${at}.environments: an environment name is text of 1 to 60 characters with no control characters`);
                    continue;
                }
                const environment = absolutePath(value, `${at}.environments.${name}`, errors);
                if (environment !== undefined) environments.push([name, environment]);
            }
        }
    }
    if (errors.length > before || file === undefined) return undefined;
    return { file, environments };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

/** What `load` collects while it reads. */
interface Reading {
    collection: string;
    /** The collection file's name, for `origin`. */
    shown: string;
    problems: Problem[];
    /** The variables that some environment declares secret. */
    secretNames: ReadonlySet<string>;
}

const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

/** A description, which may be text or `{ content }`. */
function descriptionOf(value: unknown): string | undefined {
    const given = isObject(value) ? value.content : value;
    return typeof given === "string" && given.trim() !== "" ? given.trim() : undefined;
}

function readJson(file: string, maxBytes: number, problems: Problem[]): unknown {
    const shown = path.basename(file);
    let content: string;
    try {
        content = readText(file, maxBytes);
    } catch (error) {
        problems.push({ file: shown, key: "", message: whyNotRead(error), level: "error" });
        return undefined;
    }
    try {
        return JSON.parse(content) as unknown;
    } catch {
        problems.push({ file: shown, key: "", message: "is not valid JSON", level: "error" });
        return undefined;
    }
}

/** An environment export: `values` of `{ key, value, type, enabled }`. */
function readEnvironment(name: string, file: string, problems: Problem[]): Environment | undefined {
    const shown = path.basename(file);
    const raw = readJson(file, ENVIRONMENT_MAX_BYTES, problems);
    return raw === undefined ? undefined : environmentFrom(name, shown, raw, problems);
}

/** The environment in an export that is already read, such as one kept by the Postman cloud source. */
export function environmentFrom(name: string, shown: string, raw: unknown, problems: Problem[]): Environment | undefined {
    if (!isObject(raw) || !Array.isArray(raw.values)) {
        problems.push({ file: shown, key: "values", message: "is missing: this is not an exported environment", level: "error" });
        return undefined;
    }
    const variables = new Map<string, Variable>();
    raw.values.forEach((item: unknown, index) => {
        const key = `values[${index}]`;
        if (!isObject(item) || typeof item.key !== "string" || item.key.trim() === "") {
            problems.push({ file: shown, key, message: "has no key", level: "warning" });
            return;
        }
        if (item.enabled === false) return;
        const value = text(item.value) ?? "";
        if (item.type === "secret") {
            // A secret is never read from a file: an export may hold its value in plain text, and that value is not used.
            if (value !== "") {
                problems.push({
                    file: shown,
                    key: item.key,
                    message:
                        `is a secret with a value in the file. The value is ignored and never sent; ` +
                            `give the secret in api.secrets as "${item.key}"`,
                    level: "warning",
                });
            }
            variables.set(item.key, { value: "", secret: true });
        } else {
            variables.set(item.key, { value, secret: false });
        }
    });
    return { name, file: shown, variables };
}

/** The `{ key, value }` pairs of an auth block, which is a list (v2.1) or, in older exports, an object. */
function attributesOf(block: unknown): Map<string, string> {
    const found = new Map<string, string>();
    if (Array.isArray(block)) {
        for (const item of block as unknown[]) {
            if (isObject(item) && typeof item.key === "string") {
                const value = text(item.value);
                if (value !== undefined) found.set(item.key, value);
            }
        }
    } else if (isObject(block)) {
        for (const [key, value] of Object.entries(block)) {
            const given = text(value);
            if (given !== undefined) found.set(key, given);
        }
    }
    return found;
}

type AuthResult = { auth: Auth; unsupported?: undefined } | { auth?: undefined; unsupported: string };

/** Auth that a request, a folder or the collection sets. Undefined for no setting at all, which inherits. */
function authOf(raw: unknown, reading: Reading, key: string): AuthResult | undefined {
    if (!isObject(raw)) return undefined;
    const type = raw.type;
    if (typeof type !== "string") return undefined;
    const attributes = attributesOf(raw[type]);
    const get = (name: string): string => attributes.get(name) ?? "";
    switch (type) {
        case "noauth":
            return { auth: { kind: "none" } };
        case "bearer":
            return { auth: { kind: "bearer", token: get("token") } };
        case "basic":
            return { auth: { kind: "basic", username: get("username"), password: get("password") } };
        case "apikey": {
            if ((attributes.get("in") ?? "header") !== "header") {
                return { unsupported: "an API key sent in the query string (an address ends up in logs, so a key is sent in a header only)" };
            }
            return { auth: { kind: "apiKey", name: get("key"), value: get("value") } };
        }
        case "oauth2": {
            const grant = attributes.get("grant_type") ?? "";
            const headless = grant === "client_credentials" || grant === "password_credentials" || grant === "password";
            if (!headless) {
                if (attributes.get("accessToken")) {
                    reading.problems.push({
                        file: reading.shown,
                        key: `${key}.oauth2`,
                        message:
                            "holds an access token in the file. It is ignored and never sent; " +
                                "get tokens with a client-credentials or password grant",
                        level: "warning",
                    });
                }
                const named = grant === "" ? "no headless grant" : `the grant "${grant}"`;
                return { unsupported: `OAuth 2.0 with ${named} (it needs a browser; only client_credentials and password work)` };
            }
            if ((attributes.get("addTokenTo") ?? "header") !== "header") return { unsupported: "OAuth 2.0 with the token in the query string" };
            const prefix = attributes.get("headerPrefix");
            if (prefix !== undefined && prefix !== "" && prefix.toLowerCase() !== "bearer") {
                return { unsupported: `OAuth 2.0 with the header prefix "${prefix}" (only Bearer is sent)` };
            }
            const secret = attributes.get("clientSecret");
            const username = attributes.get("username");
            const password = attributes.get("password");
            const scope = attributes.get("scope");
            return {
                auth: {
                    kind: "oauth2",
                    grant: grant === "client_credentials" ? "client_credentials" : "password",
                    tokenUrl: get("accessTokenUrl"),
                    clientId: get("clientId"),
                    ...(secret === undefined || secret === "" ? {} : { clientSecret: secret }),
                    ...(username === undefined ? {} : { username }),
                    ...(password === undefined ? {} : { password }),
                    ...(scope === undefined || scope === "" ? {} : { scope }),
                    clientAuth: attributes.get("client_authentication") === "body" ? "body" : "header",
                },
            };
        }
        default:
            return { unsupported: `the sign-in type "${type}" is not sent (bearer, basic, apikey and OAuth 2.0 client credentials or password are)` };
    }
}

/** True when an event list holds a script that is switched on and has something in it. */
function scriptOf(events: unknown, listen: string): boolean {
    if (!Array.isArray(events)) return false;
    return (events as unknown[]).some((event) => {
        if (!isObject(event) || event.listen !== listen || event.disabled === true || !isObject(event.script)) return false;
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
        const host = Array.isArray(url.host) ? (url.host as unknown[]).map(String).join(".") : typeof url.host === "string" ? url.host : "";
        const segments = Array.isArray(url.path)
            ? (url.path as unknown[]).map((segment) => (isObject(segment) ? String(segment.value ?? "") : String(segment)))
            : typeof url.path === "string" ? [url.path] : [];
        const query = Array.isArray(url.query)
            ? (url.query as unknown[]).flatMap((item) => {
                if (!isObject(item) || item.disabled === true || typeof item.key !== "string") return [];
                return [`${item.key}${item.value === null || item.value === undefined ? "" : `=${String(item.value)}`}`];
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
            if (!isObject(item) || item.disabled === true || typeof item.key !== "string" || item.key.trim() === "") continue;
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

const LANGUAGE_TYPES: Readonly<Record<string, string>> = {
    json: "application/json", xml: "application/xml", html: "text/html", text: "text/plain", javascript: "application/javascript",
};

interface BodyResult {
    body?: Body;
    /** The content type Postman sends for the body when the request sets none. */
    contentType?: string;
    unsupported?: string;
    notes: string[];
}

function bodyOf(raw: unknown): BodyResult {
    const notes: string[] = [];
    if (!isObject(raw) || raw.disabled === true || typeof raw.mode !== "string") return { notes };
    switch (raw.mode) {
        case "raw": {
            const content = typeof raw.raw === "string" ? raw.raw : "";
            if (content === "") return { notes };
            const options = isObject(raw.options) && isObject(raw.options.raw) ? raw.options.raw : {};
            const language = typeof options.language === "string" ? options.language : "text";
            const contentType = LANGUAGE_TYPES[language] ?? "text/plain";
            if (language === "json") return { body: { kind: "json", text: content }, contentType, notes };
            const markup = language === "xml" || language === "html" ? language : "text";
            return { body: { kind: "raw", text: content, language: markup }, contentType, notes };
        }
        case "urlencoded": {
            const fields: FormField[] = [];
            if (Array.isArray(raw.urlencoded)) {
                for (const item of raw.urlencoded as unknown[]) {
                    if (isObject(item) && item.disabled !== true && typeof item.key === "string") {
                        fields.push({ kind: "text", name: item.key, value: text(item.value) ?? "" });
                    }
                }
            }
            if (fields.length === 0) return { notes };
            return { body: { kind: "form", encoding: "urlencoded", fields }, contentType: "application/x-www-form-urlencoded", notes };
        }
        case "formdata": {
            const fields: FormField[] = [];
            if (Array.isArray(raw.formdata)) {
                for (const item of raw.formdata as unknown[]) {
                    if (!isObject(item) || item.disabled === true || typeof item.key !== "string") continue;
                    const contentType = typeof item.contentType === "string" && item.contentType !== "" ? item.contentType : undefined;
                    if (item.type === "file") {
                        const sources = Array.isArray(item.src) ? (item.src as unknown[]) : [item.src];
                        const files = sources.filter((source): source is string => typeof source === "string" && source !== "");
                        if (files.length === 0) notes.push(`the file field "${item.key}" has no file chosen, so it is left out`);
                        for (const file of files) {
                            const typed = contentType === undefined ? {} : { contentType };
                            fields.push({ kind: "file", name: item.key, file: { path: file }, ...typed });
                        }
                    } else {
                        const typed = contentType === undefined ? {} : { contentType };
                        fields.push({ kind: "text", name: item.key, value: text(item.value) ?? "", ...typed });
                    }
                }
            }
            if (fields.length === 0) return { notes };
            return { body: { kind: "form", encoding: "multipart", fields }, notes };
        }
        case "file": {
            const src = isObject(raw.file) ? raw.file.src : undefined;
            if (typeof src !== "string" || src === "") {
                notes.push("its body is a file, but no file is chosen, so it has no body");
                return { notes };
            }
            return { body: { kind: "file", file: { path: src } }, notes };
        }
        case "graphql": {
            const graphql = isObject(raw.graphql) ? raw.graphql : {};
            const query = typeof graphql.query === "string" ? graphql.query : "";
            if (query.trim() === "") return { notes };
            const variables = typeof graphql.variables === "string" && graphql.variables.trim() !== "" ? graphql.variables : undefined;
            return {
                body: { kind: "graphql", query, ...(variables === undefined ? {} : { variables }) },
                contentType: "application/json",
                notes,
            };
        }
        default:
            return { unsupported: `the body type "${raw.mode}" is not sent`, notes };
    }
}

/** What the protocol profile of an item says about how it is sent. Only HTTP is sent, with the same care for every request. */
function behaviourOf(raw: unknown): { unsupported: string | undefined; notes: string[] } {
    const notes: string[] = [];
    if (!isObject(raw)) return { unsupported: undefined, notes };
    for (const [key, value] of Object.entries(raw)) {
        if (NOT_HTTP.test(key) || (typeof value === "string" && NOT_HTTP.test(value))) {
            return { unsupported: `its protocol profile (${key}) is not plain HTTP, and only HTTP is sent`, notes };
        }
        if (key === "followRedirects" && value === true) notes.push("followRedirects is ignored: redirects are never followed");
        if (key === "strictSSL" && value === false) notes.push("strictSSL: false is ignored: certificates are always checked");
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

/** The `{ key, value }` variables of a collection, a folder or an item. */
function variablesOf(raw: unknown): Map<string, string> {
    const found = new Map<string, string>();
    if (!Array.isArray(raw)) return found;
    for (const item of raw as unknown[]) {
        if (!isObject(item) || item.disabled === true) continue;
        const key = typeof item.key === "string" ? item.key : typeof item.id === "string" ? item.id : "";
        const value = text(item.value);
        if (key !== "" && value !== undefined) found.set(key, value);
    }
    return found;
}

function requestOf(item: Record<string, unknown>, inherited: Inherited, reading: Reading, key: string): SavedRequest {
    const given = item.request;
    const request: Record<string, unknown> = isObject(given) ? given : { url: given, method: "GET" };
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : "(unnamed)";
    const method = (typeof request.method === "string" && request.method.trim() !== "" ? request.method.trim() : "GET").toUpperCase();
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

    const variables = variablesIn(url, ...headers.map(([, value]) => value), ...bodyTexts(body.body), ...authTexts(auth));
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
function walk(items: unknown, inherited: Inherited, reading: Reading, prefix: string, found: SavedRequest[]): void {
    if (!Array.isArray(items)) return;
    (items as unknown[]).forEach((item, index) => {
        const key = `${prefix}[${index}]`;
        if (!isObject(item)) {
            reading.problems.push({ file: reading.shown, key, message: "is not a request or a folder", level: "warning" });
            return;
        }
        if (Array.isArray(item.item)) {
            const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : "(unnamed folder)";
            const auth = authOf(item.auth, reading, `${key}.auth`);
            const behaviour = behaviourOf(item.protocolProfileBehavior);
            walk(item.item, {
                folder: [...inherited.folder, name],
                auth: auth ?? inherited.auth,
                prerequest: scriptOf(item.event, "prerequest") ? `the folder ${name}` : inherited.prerequest,
                behaviour: {
                    unsupported: inherited.behaviour.unsupported ?? behaviour.unsupported,
                    notes: [...inherited.behaviour.notes, ...behaviour.notes],
                },
                defaults: new Map([...inherited.defaults, ...variablesOf(item.variable)]),
            }, reading, `${key}.item`, found);
        } else if (item.request !== undefined) {
            found.push(requestOf(item, inherited, reading, key));
        } else {
            reading.problems.push({ file: reading.shown, key, message: "has neither a request nor items", level: "warning" });
        }
    });
}

/** What a Postman collection is read from: the exported JSON as parsed, and the environments exported beside it. */
export interface PostmanContent {
    /** Undefined when it could not be read; the reason is already in `problems`. */
    collection: unknown;
    /** By the name the configuration gives them; an environment that could not be read is not here. */
    environments: ReadonlyMap<string, Environment>;
}

/** Reads a collection that is already parsed. `shown` names it in messages and `root` is the folder files must stay inside. */
export function collectionFrom(name: string, shown: string, root: string, content: PostmanContent, problems: Problem[]): Collection {
    const environments = new Map(content.environments);
    const secretNames = declaredSecrets(environments.values());
    const reading: Reading = { collection: name, shown, problems, secretNames };
    const raw = content.collection;
    const requests: SavedRequest[] = [];
    const variables = new Map<string, Variable>();
    let auth: Auth = { kind: "none" };
    let authRefused: string | undefined;

    if (raw !== undefined) {
        if (!isObject(raw) || !Array.isArray(raw.item)) {
            problems.push({ file: shown, key: "item", message: "is missing: this is not an exported collection", level: "error" });
        } else {
            const schema = isObject(raw.info) && typeof raw.info.schema === "string" ? raw.info.schema : "";
            if (schema !== "" && !/\/v2\.[01](?:\.0)?\//.test(schema)) {
                problems.push({
                    file: shown, key: "info.schema", message: `is ${schema}: only collection format v2.0 and v2.1 are read`, level: "warning",
                });
            }
            for (const [key, value] of variablesOf(raw.variable)) variables.set(key, { value, secret: false });
            const top = authOf(raw.auth, reading, "auth");
            if (top?.auth !== undefined) auth = top.auth;
            authRefused = top?.unsupported;
            walk(raw.item, {
                folder: [],
                auth: top,
                prerequest: scriptOf(raw.event, "prerequest") ? "the collection" : undefined,
                behaviour: behaviourOf(raw.protocolProfileBehavior),
                defaults: new Map(),
            }, reading, "item", requests);
        }
    }
    return {
        name,
        root,
        requests,
        environments,
        variables,
        auth,
        ...(authRefused === undefined ? {} : { authRefused }),
        problems,
    };
}

function load(config: PostmanConfig, name: string): Collection {
    const problems: Problem[] = [];
    const environments = new Map<string, Environment>();
    for (const [environment, file] of config.environments) {
        const read = readEnvironment(environment, file, problems);
        if (read !== undefined) environments.set(environment, read);
    }
    const collection = readJson(config.file, COLLECTION_MAX_BYTES, problems);
    return collectionFrom(name, path.basename(config.file), path.dirname(config.file), { collection, environments }, problems);
}

export const postman: Source<PostmanConfig> = { kind: "postman", check, load };
