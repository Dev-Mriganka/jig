// OpenAPI: a service's spec (3.0 or 3.1, as JSON or YAML) read as saved requests. A spec describes what an API can do, not what a
// team saves, so this source is opt-in and held tighter than the others:
//   - it runs only in the environments the configuration lists, and in production only for reads, and only when the
//     configuration says `allowProductionReads`;
//   - its hosts are the ones the configuration maps to each environment (`servers`), because a spec's own servers rarely match
//     a team's environment names. An environment with no server maps to no host, and nothing runs in it;
//   - every credential is a slot filled from `api.secrets` and nowhere else.
// Each operation with an `operationId` is a request named by it; the agent fills its parameters and the properties of a JSON body.
// Operations without an `operationId` are listed as `METHOD path` and refused.
// Format: https://spec.openapis.org/oas/v3.1.0 and https://spec.openapis.org/oas/v3.0.3
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../engine/values.ts";
import { CREDENTIAL_HEADERS } from "../model.ts";
import type { Auth, Body, Collection, Environment, Problem, SavedRequest, Variable } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import { expandHome, readText, whyNotRead } from "./files.ts";
import { describeScalar, shapeOf, templateOf, whyNotScalar } from "./openapi-body.ts";
import type { Deref, Leaf } from "./openapi-body.ts";
import type { Source } from "./source.ts";
import { authTexts } from "./texts.ts";
import { parseYaml } from "./yaml.ts";

export interface OpenApiConfig {
    file: string;
    /** The environment's name to the server it runs against. */
    servers: ReadonlyMap<string, string>;
    /** The environments the spec may run in, in the order given. */
    environments: readonly string[];
    allowProductionReads: boolean;
}

const SPEC_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENVIRONMENTS = 20;
const NAME = /^[^\u0000-\u001f\u007f]{1,60}$/;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers the specification says a parameter cannot define: the transport and the sign-in set them. */
const IGNORED_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "authorization"]);
/** Names of headers that carry a credential, besides those every source treats so. */
const CREDENTIAL_NAME = /api[-_]?key|token|secret|passw|credential|session|signature/i;
/** The variables every environment gets: the server it runs against. */
const SERVER_URL = "serverUrl";
const SERVER_ORIGIN = "serverOrigin";

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

/** A server address: https (or http, which the engine then allows only for this machine), with no user, query or variables. */
function checkServer(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
        errors.push(`${key}: must be the address of a server, such as https://api.staging.example.com/v1`);
        return undefined;
    }
    if (/[{}]/.test(value)) {
        errors.push(`${key}: must be one address with no {variables}: a host is not filled in from a call`);
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        errors.push(`${key}: must be the address of a server, such as https://api.staging.example.com/v1`);
        return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        errors.push(`${key}: must start with https:// (plain http is only for this machine, and needs allowPlainLocal)`);
    } else if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        errors.push(`${key}: must be a host and a base path only, with no user, query or fragment`);
    } else {
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
    return undefined;
}

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): OpenApiConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry)) {
        if (!["openapi", "servers", "environments", "allowProductionReads"].includes(key)) errors.push(`${at}.${key}: unknown field`);
    }

    let file: string | undefined;
    const given = entry.openapi;
    if (typeof given !== "string" || given.trim() === "" || given.length > 1000 || given.includes("\0")) {
        errors.push(`${at}.openapi: must be the path of an OpenAPI file, JSON or YAML`);
    } else if (!path.isAbsolute(expandHome(given.trim()))) {
        errors.push(`${at}.openapi: must be an absolute path or start with ~/`);
    } else {
        file = path.normalize(expandHome(given.trim()));
    }

    const environments: string[] = [];
    if (!Array.isArray(entry.environments) || entry.environments.length === 0) {
        errors.push(`${at}.environments: required, the list of environments this spec may run in, such as ["Staging"]`);
    } else if (entry.environments.length > MAX_ENVIRONMENTS) {
        errors.push(`${at}.environments: at most ${MAX_ENVIRONMENTS} environments`);
    } else {
        for (const item of entry.environments as unknown[]) {
            if (typeof item !== "string" || !NAME.test(item)) {
                errors.push(`${at}.environments: an environment name is text of 1 to 60 characters with no control characters`);
            } else if (environments.includes(item)) errors.push(`${at}.environments: ${JSON.stringify(item)} is listed twice`);
            else environments.push(item);
        }
    }

    const servers = new Map<string, string>();
    if (entry.servers !== undefined) {
        if (!isObject(entry.servers)) {
            errors.push(`${at}.servers: must be an object that maps an environment name to the address of its server`);
        } else {
            for (const [name, value] of Object.entries(entry.servers)) {
                if (!environments.includes(name)) {
                    errors.push(`${at}.servers.${name}: is not in environments, so the spec never runs there`);
                    continue;
                }
                const server = checkServer(value, `${at}.servers.${name}`, errors);
                if (server !== undefined) servers.set(name, server);
            }
        }
    }

    let allowProductionReads = false;
    if (typeof entry.allowProductionReads === "boolean") allowProductionReads = entry.allowProductionReads;
    else if (entry.allowProductionReads !== undefined) errors.push(`${at}.allowProductionReads: must be true or false`);

    if (errors.length > before || file === undefined) return undefined;
    return { file, servers, environments, allowProductionReads };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the spec

/** Reads `$ref`s that point inside the document. A reference to another file or address is a problem, and is not followed. */
function dereferencer(spec: Record<string, unknown>, report: (key: string, message: string) => void): Deref {
    const refused = new Set<string>();
    const follow = (node: unknown, depth: number): unknown => {
        if (!isObject(node) || typeof node.$ref !== "string") return node;
        const ref = node.$ref;
        if (!ref.startsWith("#/")) {
            if (!refused.has(ref)) {
                refused.add(ref);
                report(ref.slice(0, 60), "is a reference outside the document, which is not followed: put it in the document");
            }
            return undefined;
        }
        if (depth > 20) return undefined;
        let current: unknown = spec;
        for (const part of ref.slice(2).split("/")) {
            const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
            current = isObject(current) || Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined;
            if (current === undefined) return undefined;
        }
        return follow(current, depth + 1);
    };
    return (node) => follow(node, 0);
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The origin of a server address of the spec, with the defaults of its {variables} filled in; undefined for a relative one. */
function originOf(server: unknown): string | undefined {
    if (!isObject(server) || typeof server.url !== "string") return undefined;
    const variables = isObject(server.variables) ? server.variables : {};
    const filled = server.url.replace(/\{([^}]+)\}/g, (match, name: string) => {
        const variable = variables[name];
        return isObject(variable) && typeof variable.default === "string" ? variable.default : match;
    });
    try {
        return new URL(filled).origin;
    } catch {
        return undefined;
    }
}

// Security -------------------------------------------------------------------------------------------------------------

/** What a security scheme comes to: a sign-in made of secret slots, or the reason it is refused. */
interface Scheme {
    /** The slots it fills, each a secret variable. */
    slots: string[];
    /** The sign-in, with the scopes of the requirement that names it still to be added for OAuth. */
    auth?: (scopes: readonly string[]) => Auth;
    refused?: string;
}

function schemeOf(name: string, definition: unknown, serverOrigins: ReadonlySet<string>): Scheme {
    if (!isObject(definition)) return { slots: [], refused: "its definition cannot be read" };
    switch (definition.type) {
        case "http": {
            const scheme = textOf(definition.scheme).toLowerCase();
            if (scheme === "bearer") return { slots: [name], auth: () => ({ kind: "bearer", token: `{{${name}}}` }) };
            if (scheme === "basic") {
                const slots = [`${name}.username`, `${name}.password`];
                return { slots, auth: () => ({ kind: "basic", username: `{{${slots[0]}}}`, password: `{{${slots[1]}}}` }) };
            }
            return { slots: [], refused: `the HTTP scheme "${scheme}" is not sent (bearer and basic are)` };
        }
        case "apiKey": {
            if (definition.in === "header" && textOf(definition.name) !== "") {
                return { slots: [name], auth: () => ({ kind: "apiKey", name: textOf(definition.name), value: `{{${name}}}` }) };
            }
            const where = definition.in === "query"
                ? "the query string (an address ends up in logs, so a key is sent in a header only)"
                : `a ${textOf(definition.in) || "cookie"} (no cookies are sent)`;
            return { slots: [], refused: `an API key sent in ${where}` };
        }
        case "oauth2": {
            const flows = isObject(definition.flows) ? definition.flows : {};
            const flow = isObject(flows.clientCredentials) ? "client_credentials" : isObject(flows.password) ? "password" : undefined;
            if (flow === undefined) {
                const named = Object.keys(flows).join(", ") || "none";
                return { slots: [], refused: `OAuth 2.0 with the flows ${named} (they need a browser; only clientCredentials and password work)` };
            }
            const details = (flow === "password" ? flows.password : flows.clientCredentials) as Record<string, unknown>;
            const tokenUrl = tokenAddress(textOf(details.tokenUrl), serverOrigins);
            if (tokenUrl.refused !== undefined) return { slots: [], refused: tokenUrl.refused };
            const slots = [`${name}.clientId`, `${name}.clientSecret`, ...(flow === "password" ? [`${name}.username`, `${name}.password`] : [])];
            return {
                slots,
                auth: (scopes) => ({
                    kind: "oauth2",
                    grant: flow,
                    tokenUrl: tokenUrl.template as string,
                    clientId: `{{${name}.clientId}}`,
                    clientSecret: `{{${name}.clientSecret}}`,
                    ...(flow === "password" ? { username: `{{${name}.username}}`, password: `{{${name}.password}}` } : {}),
                    ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
                    clientAuth: "header",
                }),
            };
        }
        case "openIdConnect":
            return { slots: [], refused: "OpenID Connect is not sent (it needs a browser)" };
        case "mutualTLS":
            return { slots: [], refused: "mutual TLS is not sent" };
        default:
            return { slots: [], refused: `the security scheme type "${textOf(definition.type)}" is not sent` };
    }
}

/**
 * The token address as a template on the environment's server. A relative address is on the server. An address with a host is
 * accepted only when it is on one of the spec's own servers, so that it follows the environment to its mapped server; a token
 * endpoint on any other host is not one of the environment's hosts, and the client's secret is not sent there.
 */
function tokenAddress(address: string, serverOrigins: ReadonlySet<string>): { template?: string; refused?: string } {
    if (address === "") return { refused: "OAuth 2.0 with no token address" };
    if (address.startsWith("/")) return { template: `{{${SERVER_ORIGIN}}}${address}` };
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return { refused: "OAuth 2.0 with a token address that is not an address" };
    }
    if (!serverOrigins.has(url.origin)) {
        return {
            refused:
                `OAuth 2.0 with its token address on ${url.host}, which is not one of the servers of the spec, ` +
                    "so it is not a host of the environment",
        };
    }
    return { template: `{{${SERVER_ORIGIN}}}${url.pathname}${url.search}` };
}

interface Chosen {
    auth: Auth;
    slots: string[];
    unsupported?: string;
}

/** The sign-in for a list of security requirements: the first alternative that is one scheme this plugin can send. */
function chooseAuth(requirements: unknown, schemes: ReadonlyMap<string, Scheme>): Chosen {
    if (!Array.isArray(requirements) || requirements.length === 0) return { auth: { kind: "none" }, slots: [] };
    let anonymous = false;
    const reasons: string[] = [];
    for (const requirement of requirements as unknown[]) {
        const names = isObject(requirement) ? Object.keys(requirement) : [];
        if (names.length === 0) {
            anonymous = true;
            continue;
        }
        if (names.length > 1) {
            reasons.push(`it needs several security schemes at once (${names.join(", ")}), and only one can be sent`);
            continue;
        }
        const name = names[0] as string;
        const scheme = schemes.get(name);
        if (scheme === undefined) reasons.push(`it names the security scheme ${name}, which the spec does not define`);
        else if (scheme.refused !== undefined || scheme.auth === undefined) {
            reasons.push(`the security scheme ${name}: ${scheme.refused ?? "cannot be sent"}`);
        }
        else {
            const listed = isObject(requirement) && Array.isArray(requirement[name]) ? (requirement[name] as unknown[]) : [];
            const scopes = listed.filter((scope): scope is string => typeof scope === "string");
            return { auth: scheme.auth(scopes), slots: scheme.slots };
        }
    }
    if (anonymous) return { auth: { kind: "none" }, slots: [] };
    return { auth: { kind: "none" }, slots: [], unsupported: reasons[0] ?? "it has a security requirement that cannot be read" };
}

// Operations -----------------------------------------------------------------------------------------------------------

type Location = "path" | "query" | "header" | "cookie";

interface Parameter {
    name: string;
    in: Location;
    required: boolean;
    schema: Record<string, unknown>;
    description: string;
}

/** The parameters of an operation: those of its path item, then its own, which replace a path item's of the same name and place. */
function parametersOf(
    pathItem: Record<string, unknown>,
    operation: Record<string, unknown>,
    deref: Deref,
    report: (key: string, message: string) => void,
): Parameter[] {
    const found = new Map<string, Parameter>();
    for (const [from, list] of [["path item", pathItem.parameters], ["operation", operation.parameters]] as const) {
        if (!Array.isArray(list)) continue;
        (list as unknown[]).forEach((raw, index) => {
            const parameter = deref(raw);
            // A name with braces or control characters could not stand in a `{{variable}}`.
            if (!isObject(parameter) || typeof parameter.name !== "string" || parameter.name === "" || /[{}\u0000-\u001f]/.test(parameter.name)) {
                report(`${from} parameters[${index}]`, "has no name that can be a variable, and is left out");
                return;
            }
            const place = parameter.in;
            if (place !== "path" && place !== "query" && place !== "header" && place !== "cookie") {
                const message = `is "in" ${JSON.stringify(place)}, which is not path, query, header or cookie, and is left out`;
                report(`${from} parameters[${index}]`, message);
                return;
            }
            // A parameter may describe its value with `content` and not `schema`: the schema of its first media type.
            const content = isObject(parameter.content) ? Object.values(parameter.content)[0] : undefined;
            const given = deref(parameter.schema ?? (isObject(content) ? content.schema : undefined));
            found.set(`${place}:${place === "header" ? parameter.name.toLowerCase() : parameter.name}`, {
                name: parameter.name,
                in: place,
                required: place === "path" || parameter.required === true,
                schema: isObject(given) ? given : {},
                description: textOf(parameter.description).replace(/\s+/g, " ").trim(),
            });
        });
    }
    return [...found.values()];
}

/** Query names keep their brackets (`filter[status]`), which servers read as written. */
const queryName = (name: string): string => encodeURIComponent(name).replace(/%5B/gi, "[").replace(/%5D/gi, "]");

/** What a source needs to know about the spec while it reads each operation. */
interface Reading {
    collection: string;
    shown: string;
    problems: Problem[];
    deref: Deref;
    schemes: ReadonlyMap<string, Scheme>;
    rootSecurity: unknown;
    slots: Set<string>;
}

interface Part {
    kind: "path" | "query" | "header" | "body";
    name: string;
    required: boolean;
    doc: string;
    leaf?: Leaf;
}

function requestOf(
    pathName: string,
    method: string,
    pathItem: Record<string, unknown>,
    operation: Record<string, unknown>,
    reading: Reading,
): SavedRequest {
    const { deref } = reading;
    const key = `paths.${pathName}.${method}`;
    const report = (inner: string, message: string): void =>
        void reading.problems.push({ file: reading.shown, key: `${key}.${inner}`, message, level: "warning" });
    const id = textOf(operation.operationId).trim();
    const upper = method.toUpperCase();
    const notes: string[] = [];
    let unsupported: string | undefined;
    if (id === "") {
        unsupported = "it has no operationId, so it has no name to run it by: add one to the spec";
        notes.push("it has no operationId, so it is named by its method and path");
    }
    if (operation.deprecated === true) notes.push("the spec marks it deprecated");
    if (Array.isArray(operation.servers) && operation.servers.length > 0) {
        unsupported ??= "it has servers of its own, and a host comes only from the servers the configuration maps to the environment";
    }
    if (!SENT_METHODS.has(upper)) unsupported ??= `the method ${upper} is not sent (GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE are)`;

    // The sign-in: the operation's own security, else the spec's.
    const chosen = chooseAuth(operation.security ?? reading.rootSecurity, reading.schemes);
    if (chosen.unsupported !== undefined) unsupported ??= chosen.unsupported;
    for (const slot of chosen.slots) reading.slots.add(slot);
    const signedHeader = chosen.auth.kind === "apiKey" ? chosen.auth.name.toLowerCase() : undefined;

    // The parts that become variables: parameters first, then the properties of a JSON body.
    const parts: Part[] = [];
    const parameters = parametersOf(pathItem, operation, deref, report);
    const used: Array<{ parameter: Parameter; part: Part }> = [];
    for (const parameter of parameters) {
        const lower = parameter.name.toLowerCase();
        if (parameter.in === "header" && (IGNORED_HEADERS.has(lower) || CREDENTIAL_HEADERS.has(lower) || CREDENTIAL_NAME.test(parameter.name))) {
            // A credential is never a value the agent gives: it comes from a security scheme. The specification itself says that a
            // parameter named Accept, Content-Type or Authorization is ignored, and the key the sign-in sends is the sign-in's.
            if (parameter.required && !IGNORED_HEADERS.has(lower) && lower !== signedHeader) {
                unsupported ??=
                    `it needs the header ${parameter.name}, which carries a credential: ` +
                        "declare it as a security scheme so that it comes from api.secrets";
            } else {
                notes.push(`the header parameter ${parameter.name} is ignored: a credential or a header the tool sets comes from the sign-in`);
            }
            continue;
        }
        if (parameter.in === "cookie") {
            if (parameter.required) unsupported ??= `it needs the cookie ${parameter.name}, and no cookies are sent`;
            else notes.push(`the optional cookie ${parameter.name} is left out: no cookies are sent`);
            continue;
        }
        const why = whyNotScalar(parameter.schema);
        if (why !== undefined) {
            const what = `the ${parameter.in} parameter ${parameter.name}`;
            if (parameter.required) unsupported ??= `it needs ${what}, which is ${why} and cannot be filled from a variable`;
            else notes.push(`the optional ${what.replace(/^the /, "")} is left out: it is ${why}, and cannot be filled from a variable`);
            continue;
        }
        const docs = [describeScalar(parameter.schema), parameter.description].filter((part) => part !== "").join("; ");
        const part: Part = { kind: parameter.in, name: parameter.name, required: parameter.required, doc: `${parameter.in} parameter, ${docs}` };
        parts.push(part);
        used.push({ parameter, part });
    }

    // The body: JSON only, filled property by property.
    let bodyShape: ReturnType<typeof shapeOf> | undefined;
    const requestBody = deref(operation.requestBody);
    if (isObject(requestBody) && isObject(requestBody.content)) {
        const wanted = requestBody.required === true;
        const types = Object.keys(requestBody.content);
        const json = types.find((type) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i.test(type));
        if (json === undefined) {
            const named = types.join(", ") || "none";
            if (wanted) unsupported ??= `its request body is ${named}, and only JSON bodies are filled from a spec`;
            else notes.push(`its optional request body (${named}) is left out: only JSON bodies are filled from a spec`);
        } else {
            const media = (requestBody.content as Record<string, unknown>)[json];
            bodyShape = shapeOf(isObject(media) ? media.schema : undefined, deref, wanted);
            notes.push(...bodyShape.notes);
            if (bodyShape.unsupported !== undefined) unsupported ??= bodyShape.unsupported;
            for (const leaf of bodyShape.leaves) {
                parts.push({ kind: "body", name: leaf.path.join("."), required: leaf.required, doc: leaf.doc, leaf });
            }
        }
    }

    // Names: a part is named by its own name; when two share one (or it is one the environment sets), each is named by its place too.
    const counts = new Map<string, number>();
    for (const part of parts) counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
    const reserved = new Set([SERVER_URL, SERVER_ORIGIN]);
    const nameOf = (part: Part): string => ((counts.get(part.name) ?? 0) > 1 || reserved.has(part.name) ? `${part.kind}.${part.name}` : part.name);

    // The address: the server, the path with its parameters, and the query parameters.
    let route = pathName.startsWith("/") ? pathName : `/${pathName}`;
    for (const placeholder of [...pathName.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string)) {
        const found = used.find(({ parameter }) => parameter.in === "path" && parameter.name === placeholder);
        if (found === undefined) {
            unsupported ??= `its path has {${placeholder}}, which no path parameter describes`;
            continue;
        }
        route = route.replace(`{${placeholder}}`, () => `{{${nameOf(found.part)}}}`);
    }
    let url = `{{${SERVER_URL}}}${route}`;
    const query = used
        .filter(({ parameter }) => parameter.in === "query")
        .map(({ parameter, part }) => `${queryName(parameter.name)}={{${nameOf(part)}}}`);
    if (query.length > 0) url += `?${query.join("&")}`;

    const headers: Array<readonly [string, string]> = used
        .filter(({ parameter }) => parameter.in === "header")
        .map(({ parameter, part }) => [parameter.name, `{{${nameOf(part)}}}`]);
    let body: Body | undefined;
    if (bodyShape?.root !== undefined) {
        const names = new Map(parts.filter((part) => part.leaf !== undefined).map((part) => [part.leaf as Leaf, nameOf(part)]));
        body = { kind: "json", text: templateOf(bodyShape.root, (leaf) => names.get(leaf) as string) };
        headers.push(["Content-Type", "application/json"]);
    }

    const bodyText = body?.kind === "json" ? body.text : undefined;
    const variables = variablesIn(url, ...headers.map(([, value]) => value), bodyText, ...authTexts(chosen.auth));
    unsupported ??= unsupportedVariable(variables);
    const signsIn = variablesIn(...authTexts(chosen.auth));
    const description = [textOf(operation.summary).trim(), textOf(operation.description).trim()].filter((part) => part !== "").join("\n\n");
    const tag = Array.isArray(operation.tags) ? operation.tags.find((item): item is string => typeof item === "string" && item !== "") : undefined;

    return {
        collection: reading.collection,
        folder: tag === undefined ? [] : [tag],
        name: id === "" ? `${upper} ${pathName}` : id,
        origin: `${reading.shown}: ${upper} ${pathName}`,
        method: upper,
        url,
        headers,
        ...(body === undefined ? {} : { body }),
        auth: chosen.auth,
        variables,
        secrets: variables.filter((variable) => chosen.slots.includes(variable)),
        signsIn,
        defaults: new Map(),
        optional: parts.filter((part) => !part.required).map(nameOf),
        variableDocs: new Map(parts.map((part) => [nameOf(part), part.doc])),
        scripts: { prerequest: false },
        ...(unsupported === undefined ? {} : { unsupported }),
        notes,
        ...(description === "" ? {} : { description }),
    };
}

// ---------------------------------------------------------------------------------------------------------------------

function readSpec(config: OpenApiConfig, shown: string, problems: Problem[]): Record<string, unknown> | undefined {
    let content: string;
    try {
        content = readText(config.file, SPEC_MAX_BYTES);
    } catch (error) {
        problems.push({ file: shown, key: "", message: whyNotRead(error), level: "error" });
        return undefined;
    }
    let raw: unknown;
    if (/\.json$/i.test(config.file) || content.trimStart().startsWith("{")) {
        try {
            raw = JSON.parse(content) as unknown;
        } catch {
            problems.push({ file: shown, key: "", message: "is not valid JSON", level: "error" });
            return undefined;
        }
    } else {
        raw = parseYaml(content, shown, problems);
        if (raw === undefined) return undefined;
    }
    if (!isObject(raw) || typeof raw.openapi !== "string") {
        const swagger = isObject(raw) && raw.swagger !== undefined;
        problems.push({
            file: shown,
            key: swagger ? "swagger" : "openapi",
            message: swagger ? "is a Swagger 2.0 document: only OpenAPI 3.0 and 3.1 are read" : "is missing: this is not an OpenAPI document",
            level: "error",
        });
        return undefined;
    }
    if (!/^3\.[01]\./.test(raw.openapi)) {
        problems.push({ file: shown, key: "openapi", message: `is ${raw.openapi}: only OpenAPI 3.0 and 3.1 are read`, level: "error" });
        return undefined;
    }
    return raw;
}

function load(config: OpenApiConfig, name: string): Collection {
    const problems: Problem[] = [];
    const shown = path.basename(config.file);
    const root = path.dirname(config.file);
    const empty = (): Collection => ({
        name, root, requests: [], environments: new Map(), variables: new Map(), auth: { kind: "none" },
        productionReads: config.allowProductionReads, problems,
    });
    if (!fs.existsSync(config.file)) {
        problems.push({ file: shown, key: "", message: "no such file", level: "error" });
        return empty();
    }
    const spec = readSpec(config, shown, problems);
    if (spec === undefined) return empty();

    const deref = dereferencer(spec, (ref, message) => problems.push({ file: shown, key: ref, message, level: "warning" }));
    const declared = Array.isArray(spec.servers) ? (spec.servers as unknown[]) : [];
    const serverOrigins = new Set(declared.map(originOf).filter((origin): origin is string => origin !== undefined));
    const components = isObject(spec.components) ? spec.components : {};
    const schemes = new Map<string, Scheme>();
    if (isObject(components.securitySchemes)) {
        for (const [scheme, raw] of Object.entries(components.securitySchemes)) schemes.set(scheme, schemeOf(scheme, deref(raw), serverOrigins));
    }

    const reading: Reading = { collection: name, shown, problems, deref, schemes, rootSecurity: spec.security, slots: new Set() };
    const requests: SavedRequest[] = [];
    const seen = new Set<string>();
    if (isObject(spec.paths)) {
        for (const [pathName, rawItem] of Object.entries(spec.paths)) {
            const pathItem = deref(rawItem);
            if (!isObject(pathItem)) continue;
            const methods = Object.keys(pathItem).filter((each): each is (typeof METHODS)[number] => (METHODS as readonly string[]).includes(each));
            for (const method of methods) {
                const operation = deref(pathItem[method]);
                if (!isObject(operation)) continue;
                const request = requestOf(pathName, method, pathItem, operation, reading);
                // An operationId is unique in a spec; a second one with the same name could not be told apart.
                if (seen.has(request.name) && textOf(operation.operationId).trim() !== "") {
                    const message = `${request.name} is used again: the later operation is refused`;
                    problems.push({ file: shown, key: `paths.${pathName}.${method}.operationId`, message, level: "warning" });
                    const again = `its operationId ${request.name} is used by another operation too`;
                    requests.push({ ...request, unsupported: request.unsupported ?? again });
                } else {
                    requests.push(request);
                }
                seen.add(request.name);
            }
        }
    }

    // The collection's own sign-in, for an ad-hoc call: the spec's security.
    const top = chooseAuth(spec.security, schemes);
    for (const slot of top.slots) reading.slots.add(slot);

    // The environments: only those the configuration lists. Each is the server it maps to, and the credential slots, which are
    // declared secret so that they come from api.secrets and nowhere else.
    const environments = new Map<string, Environment>();
    for (const label of config.environments) {
        const server = config.servers.get(label);
        const variables = new Map<string, Variable>();
        variables.set(SERVER_URL, { value: server ?? "", secret: false });
        variables.set(SERVER_ORIGIN, { value: server === undefined ? "" : new URL(server).origin, secret: false });
        for (const slot of reading.slots) variables.set(slot, { value: "", secret: true });
        environments.set(label, {
            name: label,
            file: shown,
            variables,
            ...(server === undefined
                ? { unavailable: `no server is mapped to it: add ${JSON.stringify(label)} to servers in the configuration of ${name}` }
                : {}),
        });
    }

    return {
        name,
        root,
        requests,
        environments,
        variables: new Map(),
        auth: top.auth,
        ...(top.unsupported === undefined ? {} : { authRefused: top.unsupported }),
        productionReads: config.allowProductionReads,
        problems,
    };
}

export const openapi: Source<OpenApiConfig> = { kind: "openapi", check, load };
