// Bruno's OpenCollection YAML (the default format of a new collection since Bruno 3.1), read for what this plugin uses. The
// text is parsed by `yaml.ts`; this reads the objects. Every request file is `info`, one of `http` / `graphql` / `websocket` /
// `grpc`, `runtime` (variables, scripts, assertions) and `settings`; a folder file and the collection file hold `request`
// defaults (headers, auth, variables, scripts); an environment file holds `variables`.
// Format: https://github.com/opencollection-dev/opencollection (schema: packages/oc-schema/src/opencollection.schema.json)
import { isObject } from "../engine/values.ts";
import type { FormField } from "../model.ts";
import { apiKeyAuth, hasText, noBody, oauth2Auth, refusedAuth } from "./bruno-types.ts";
import type { AuthSetting, Pairs, ParsedBody, ParsedDefaults, ParsedEnvironment, ParsedRequest, ParsedVariable, Report } from "./bruno-types.ts";

const text = (value: unknown): string =>
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? (value as unknown[]).filter(isObject) : []);

/** A value that is text, or `{ type, data }`, or a list of variants of which one is selected. */
function valueOf(value: unknown): string {
    if (Array.isArray(value)) {
        const variants = list(value);
        const chosen = variants.find((variant) => variant.selected === true) ?? variants[0];
        return chosen === undefined ? "" : valueOf(chosen.value);
    }
    return isObject(value) ? text(value.data) : text(value);
}

/** The enabled `{ name, value }` entries of a list. */
function pairsOf(entries: unknown): Pairs {
    return list(entries).filter((entry) => entry.disabled !== true && text(entry.name) !== "").map((entry) => [text(entry.name), valueOf(entry.value)] as const);
}

/** The description of an item: text, or `{ content }`. */
function describedBy(value: unknown): string | undefined {
    const given = isObject(value) ? text(value.content) : text(value);
    return given.trim() === "" ? undefined : given.trim();
}

function authOf(raw: unknown): AuthSetting {
    if (raw === undefined || raw === null) return { kind: "none" };
    if (raw === "inherit") return { kind: "inherit" };
    // A bare word (`auth: none`) names the type, with no fields.
    if (typeof raw === "string") return authOf({ type: raw });
    if (!isObject(raw)) return { kind: "refused", reason: "its sign-in setting is not one that can be read" };
    const type = text(raw.type);
    // The schema keeps the fields beside `type`; Bruno's own page shows them in an object named for the type. Both are read.
    const nested = isObject(raw[type]) ? raw[type] : {};
    const get = (key: string): string => text(raw[key] ?? nested[key]);
    switch (type) {
        case "":
        case "none":
            return { kind: "none" };
        case "bearer":
            return { kind: "set", auth: { kind: "bearer", token: get("token") } };
        case "basic":
            return { kind: "set", auth: { kind: "basic", username: get("username"), password: get("password") } };
        case "apikey":
            return apiKeyAuth(get("key"), get("value"), get("placement"));
        case "oauth2": {
            const credentials = isObject(raw.credentials) ? raw.credentials : {};
            const owner = isObject(raw.resourceOwner) ? raw.resourceOwner : {};
            const token = isObject(raw.tokenConfig) && isObject(raw.tokenConfig.placement) ? raw.tokenConfig.placement : {};
            return oauth2Auth({
                grant: get("flow") || get("grantType"),
                accessTokenUrl: get("accessTokenUrl"),
                clientId: text(credentials.clientId),
                clientSecret: text(credentials.clientSecret),
                username: text(owner.username),
                password: text(owner.password),
                scope: get("scope"),
                credentialsPlacement: text(credentials.placement) || "body",
                tokenPlacement: token.query !== undefined ? "url" : "header",
                tokenPrefix: text(token.header),
            });
        }
        default:
            return refusedAuth(type);
    }
}

/** A body is an object, or a list of variants of which one is selected. */
function bodyOf(raw: unknown): ParsedBody {
    if (Array.isArray(raw)) {
        const variants = list(raw);
        const chosen = variants.find((variant) => variant.selected === true) ?? variants[0];
        return chosen === undefined ? noBody() : bodyOf(chosen.body);
    }
    if (!isObject(raw)) return noBody();
    const data = raw.data;
    switch (text(raw.type)) {
        case "json":
            return text(data).trim() === "" ? noBody() : { body: { kind: "json", text: text(data) }, contentType: "application/json", notes: [] };
        case "text":
            return hasText(text(data)) ? { body: { kind: "raw", text: text(data), language: "text" }, contentType: "text/plain", notes: [] } : noBody();
        case "xml":
            return hasText(text(data)) ? { body: { kind: "raw", text: text(data), language: "xml" }, contentType: "application/xml", notes: [] } : noBody();
        case "form-urlencoded": {
            const fields: FormField[] = pairsOf(data).map(([name, value]) => ({ kind: "text", name, value }));
            return fields.length === 0 ? noBody() : { body: { kind: "form", encoding: "urlencoded", fields }, contentType: "application/x-www-form-urlencoded", notes: [] };
        }
        case "multipart-form": {
            const fields: FormField[] = [];
            const notes: string[] = [];
            for (const entry of list(data)) {
                if (entry.disabled === true || text(entry.name) === "") continue;
                const name = text(entry.name);
                const typed = text(entry.contentType) === "" ? {} : { contentType: text(entry.contentType) };
                if (entry.type === "file") {
                    const files = (Array.isArray(entry.value) ? (entry.value as unknown[]) : [entry.value]).map(text).filter((file) => file !== "");
                    if (files.length === 0) notes.push(`the file field "${name}" has no file chosen, so it is left out`);
                    for (const file of files) fields.push({ kind: "file", name, file: { path: file }, ...typed });
                } else {
                    fields.push({ kind: "text", name, value: text(entry.value), ...typed });
                }
            }
            return fields.length === 0 ? { notes } : { body: { kind: "form", encoding: "multipart", fields }, notes };
        }
        case "file": {
            const files = list(data);
            const chosen = files.find((file) => file.selected === true) ?? files[0];
            const path = chosen === undefined ? "" : text(chosen.filePath);
            if (chosen === undefined || path === "") return { notes: ["its body is a file, but no file is chosen, so it has no body"] };
            return { body: { kind: "file", file: { path } }, ...(text(chosen.contentType) === "" ? {} : { contentType: text(chosen.contentType) }), notes: [] };
        }
        case "sparql":
            return { unsupported: 'the body type "sparql" is not sent', notes: [] };
        case "":
            // A GraphQL request keeps its body as `{ query, variables }` with no type.
            return graphqlBody(raw);
        default:
            return { unsupported: `the body type "${text(raw.type)}" is not sent`, notes: [] };
    }
}

function graphqlBody(raw: Record<string, unknown>): ParsedBody {
    const query = text(raw.query);
    if (!hasText(query)) return noBody();
    const variables = text(raw.variables);
    return { body: { kind: "graphql", query, ...(hasText(variables) ? { variables } : {}) }, contentType: "application/json", notes: [] };
}

interface Scripts {
    prerequest: boolean;
    notes: string[];
}

/** The scripts and actions of a `runtime` or `request` object, only to know what runs before the request. */
function scriptsOf(scripts: unknown, actions: unknown): Scripts {
    const notes: string[] = [];
    let prerequest = false;
    for (const script of list(scripts)) {
        if (!hasText(text(script.code))) continue;
        const type = text(script.type);
        // `hooks` may run at any point of the request's life, so it is treated like a script that runs first.
        if (type === "before-request" || type === "hooks") prerequest = true;
        else if (type === "after-response") notes.push("its post-response script is ignored (scripts never run)");
        else if (type === "tests") notes.push("its tests are ignored (scripts never run)");
    }
    for (const action of list(actions)) {
        if (action.disabled === true) continue;
        if (text(action.phase) === "before-request") prerequest = true;
        else notes.push("its post-response variables are not set (nothing reads the answer)");
    }
    return { prerequest, notes: [...new Set(notes)] };
}

function varsOf(variables: unknown): Map<string, string> {
    const found = new Map<string, string>();
    for (const [name, value] of pairsOf(variables)) found.set(name.replace(/^@/, ""), value);
    return found;
}

const kinds: Readonly<Record<string, string>> = { http: "http", graphql: "graphql", websocket: "websocket", grpc: "grpc" };

/** What kind of item an object is: a request of some protocol, a folder, or something else (a script file, an app). */
export function itemKind(raw: unknown): "request" | "folder" | "other" {
    if (!isObject(raw) || !isObject(raw.info)) return "other";
    const type = text(raw.info.type);
    if (type === "folder") return "folder";
    return type in kinds ? "request" : "other";
}

/** A request object. */
export function readRequest(raw: Record<string, unknown>, report: Report): ParsedRequest {
    const info = isObject(raw.info) ? raw.info : {};
    const type = kinds[text(info.type)] ?? "http";
    const details = isObject(raw[type]) ? raw[type] : {};
    const runtime = isObject(raw.runtime) ? raw.runtime : {};
    const settings = isObject(raw.settings) ? raw.settings : {};
    const scripts = scriptsOf(runtime.scripts, runtime.actions);
    const notes = [...scripts.notes];
    if (settings.followRedirects === true) notes.push("followRedirects is ignored: redirects are never followed");

    const params = list(details.params).filter((param) => param.disabled !== true);
    const method = type === "websocket" ? "WEBSOCKET" : type === "grpc" ? "GRPC" : (text(details.method) || (type === "graphql" ? "POST" : "GET")).toUpperCase();
    if (type === "http" && !isObject(raw.http)) report("http", "is missing: this file has no request", "warning");
    return {
        name: text(info.name) || undefined,
        seq: typeof info.seq === "number" && Number.isFinite(info.seq) ? info.seq : undefined,
        type,
        method,
        url: text(details.url),
        headers: pairsOf(details.headers),
        pathParams: params.filter((param) => text(param.type) === "path").map((param) => [text(param.name), text(param.value)] as const),
        body: bodyOf(details.body),
        auth: authOf(details.auth),
        vars: varsOf(runtime.variables),
        prerequest: scripts.prerequest,
        notes,
        assertions: list(runtime.assertions)
            .filter((assertion) => assertion.disabled !== true)
            .map((assertion) => [text(assertion.expression), text(assertion.operator), text(assertion.value)].filter((part) => part !== "").join(" ")),
        docs: describedBy(raw.docs),
    };
}

/** The `request` defaults of the collection file or a folder file, with the file's own name and place. */
export function readDefaults(raw: unknown, report: Report): ParsedDefaults {
    const file = isObject(raw) ? raw : {};
    if (!isObject(raw)) report("", "is not a YAML object", "error");
    const info = isObject(file.info) ? file.info : {};
    const defaults = isObject(file.request) ? file.request : {};
    const scripts = scriptsOf(defaults.scripts, defaults.actions);
    return {
        name: text(info.name) || undefined,
        seq: typeof info.seq === "number" && Number.isFinite(info.seq) ? info.seq : undefined,
        headers: pairsOf(defaults.headers),
        auth: authOf(defaults.auth),
        vars: varsOf(defaults.variables),
        prerequest: scripts.prerequest,
        docs: describedBy(file.docs),
    };
}

/** An environment object: `variables`, `externalSecrets`, `extends`, `dotEnvFilePath`. */
export function readEnvironment(raw: unknown, report: Report): ParsedEnvironment {
    const file = isObject(raw) ? raw : {};
    if (!isObject(raw)) report("", "is not a YAML object", "error");
    const variables: ParsedVariable[] = [];
    list(file.variables).forEach((entry, index) => {
        if (entry.disabled === true) return;
        const name = text(entry.name);
        if (name === "") {
            report(`variables[${index}]`, "has no name", "warning");
            return;
        }
        // A secret may carry a value in the file if someone typed one: it is kept here only so that it can be refused.
        variables.push({ name, value: entry.secret === true ? text(entry.value) : valueOf(entry.value), secret: entry.secret === true });
    });
    const external = isObject(file.externalSecrets) ? file.externalSecrets : undefined;
    for (const entry of list(external?.variables)) {
        if (text(entry.name) !== "") variables.push({ name: text(entry.name), value: undefined, secret: true, external: text(external?.type) || "an external secret manager" });
    }
    return {
        name: text(file.name) || undefined,
        variables,
        extends: text(file.extends) === "" ? [] : text(file.extends).split(",").map((part) => part.trim()).filter((part) => part !== ""),
        dotEnv: text(file.dotEnvFilePath) !== "",
    };
}
