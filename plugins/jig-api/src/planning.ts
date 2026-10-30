// Planning: from a saved request (or an ad-hoc call), the environment it runs in and the agent's values, to the Plan that is
// previewed and sent. This is where every refusal that is about the request lives: a script, an unsupported protocol or
// sign-in, a missing variable, a host outside the environment's, a blocked address, a file outside the collection.
// All of them are InputErrors, which jig-core takes to mean "invalid input" and blocks without asking.
//
// Planning reads no secret and touches no network. It reads the files a request uploads, because what is sent is what the
// fingerprint covers.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EnvironmentKind } from "../../jig-core/src/contract.ts";
import { checkBody, checkHeaders, checkTimeout, checkUrl, REFUSED_HEADERS } from "./ad-hoc.ts";
import type { Catalog } from "./catalog.ts";
import { jigEnvironmentOf } from "./config.ts";
import type { ApiSettings } from "./config.ts";
import { addressProblem } from "./engine/address.ts";
import { isMethod, METHODS, sealed } from "./engine/plan.ts";
import type { Plan, SignIn } from "./engine/plan.ts";
import { byteLengthOf, displayOf, isUpload, joined, plainOf, upload } from "./engine/text.ts";
import type { Text, Upload } from "./engine/text.ts";
import { InputError, shortList, shown } from "./engine/values.ts";
import type { Auth, Body, Collection, Environment, FileRef, SavedRequest } from "./model.ts";
import { agentValues, createResolver, secretNamesOf } from "./resolve.ts";
import type { Resolver, Slot } from "./resolve.ts";
import { confined } from "./sources/files.ts";

export interface PlanContext {
    settings: ApiSettings;
    catalog: Catalog;
    kindOf(name: string): EnvironmentKind;
}

/** A body of text, and a body that carries files: the files are limited one by one as well. */
export const MAX_SAVED_BODY_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOADED_BODY_BYTES = 2 * MAX_UPLOAD_BYTES;
const MAX_HEADERS = 60;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,60}$/;
const HEADER_VALUE = /^[\x20-\x7e\t]{0,4000}$/;
/** Headers a saved request may not set either: they control the connection, or say the request is another method. */
const SAVED_REFUSED_HEADERS: ReadonlySet<string> = new Set(
    [...REFUSED_HEADERS].filter((name) => name !== "authorization" && name !== "cookie"),
);

const quoted = (name: string): string => JSON.stringify(name);

// ---------------------------------------------------------------------------------------------------------------------
// Where a request may go

/**
 * The hosts an environment may reach: what the host part of each address in the collection comes to in that environment, for
 * the addresses that take their host from a variable. A request names its host through the environment (`{{baseUrl}}`),
 * so a request that has a host of its own written out is refused unless the environment holds the same one.
 */
export function environmentHosts(ctx: PlanContext, collection: Collection, environment: Environment, label: string): Set<string> {
    const hosts = new Set<string>();
    const add = (template: string, request: SavedRequest | undefined): void => {
        try {
            const resolver = createResolver({ collection, environment, label, request, secrets: ctx.settings.secrets, agent: new Map() });
            const found = resolver.origin(template);
            if (found?.fromVariables === true) hosts.add(new URL(found.origin).host);
        } catch {
            // An address that cannot be worked out here names no host.
        }
    };
    for (const request of collection.requests) {
        if (request.unsupported !== undefined || request.scripts.prerequest) continue;
        add(request.url, request);
        if (request.auth.kind === "oauth2") add(request.auth.tokenUrl, request);
    }
    if (collection.auth.kind === "oauth2") add(collection.auth.tokenUrl, undefined);
    return hosts;
}

/** The address, checked: a web address, not a blocked one, and on one of the environment's hosts. */
function destination(ctx: PlanContext, address: string, hosts: ReadonlySet<string>, label: string, what: string): string {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        throw new InputError(`${what} is not a valid address`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new InputError(`${what} uses ${url.protocol}//, and only http and https are sent (not WebSocket, gRPC or MQTT)`);
    }
    url.hash = "";
    const problem = addressProblem(url.href, ctx.settings.allowPlainLocal);
    if (problem !== undefined) throw new InputError(`${what}: the address ${problem}`);
    if (!hosts.has(url.host)) {
        const known = hosts.size === 0 ? "none (no request takes its host from a variable of the environment)" : shortList([...hosts], ", ", 70);
        throw new InputError(
            `${what} goes to ${url.host}, which is not a host of ${label} (${known}); ` +
                "a request takes its host from its environment, such as {{baseUrl}}",
        );
    }
    return url.href;
}

// ---------------------------------------------------------------------------------------------------------------------
// Headers, bodies and sign-in

function checkedHeader(name: string, value: Text, refused: ReadonlySet<string>, request: string): readonly [string, Text] {
    if (!HEADER_NAME.test(name)) throw new InputError(`${quoted(request)} has a header name that cannot be sent: ${shown(name, 30)}`);
    if (refused.has(name.toLowerCase())) {
        throw new InputError(`${quoted(request)} sets the header ${name}, which the tool sets or which controls the connection`);
    }
    const plain = plainOf(value);
    if (plain !== undefined && !HEADER_VALUE.test(plain)) throw new InputError(`the header ${name} of ${quoted(request)} must be printable ASCII`);
    return [name, value];
}

/** A file of the request, read from inside the collection's folder. */
function uploadOf(collection: Collection, file: FileRef): Upload {
    const found = confined(collection.root, file.path);
    if (found.problem !== undefined) throw new InputError(`the file ${shown(file.path, 60)} ${found.problem}`);
    try {
        const size = fs.statSync(found.path).size;
        if (size > MAX_UPLOAD_BYTES) throw new InputError(`the file ${shown(file.path, 60)} is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB`);
        return upload(path.basename(found.path), fs.readFileSync(found.path));
    } catch (error) {
        if (error instanceof InputError) throw error;
        const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
        throw new InputError(`the file ${shown(file.path, 60)} ${code === "EISDIR" ? "is a folder, not a file" : "could not be read"}`);
    }
}

/** A URL-encoded value: the whole of it, the team's text and the agent's. */
function formEncoded(text: Text): Text {
    return text.map((piece) => {
        if (typeof piece === "string") return encodeURIComponent(piece);
        return "secret" in piece ? { ...piece, as: "form" as const } : piece;
    });
}

/**
 * How the agent's values are written into a raw body: by what the body is. The language the source found says so, and so does a
 * Content-Type that the request sets itself, since a body of text that the request calls JSON is JSON to the server.
 */
function slotOf(language: string | undefined, headers: ReadonlyArray<readonly [string, Text]>): Slot {
    const type = displayOf(headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? []).toLowerCase();
    if (type.includes("json")) return "json";
    if (language === "urlencoded" || type.includes("x-www-form-urlencoded")) return "form";
    if (language === "xml" || language === "html" || type.includes("xml") || type.includes("html")) return "xml";
    return "plain";
}

function boundaryOf(body: Extract<Body, { kind: "form" }>): string {
    return body.boundary ?? `jig-api-${createHash("sha256").update(JSON.stringify(body.fields)).digest("hex").slice(0, 24)}`;
}

function quotedParam(value: string): string {
    return value.replace(/[\r\n]/g, " ").replace(/"/g, "%22");
}

/** The body as text, with the headers it needs added to `headers`. */
function bodyOf(body: Body, resolver: Resolver, collection: Collection, headers: Array<readonly [string, Text]>, request: string): Text {
    switch (body.kind) {
        case "raw":
            return resolver.text(body.text, slotOf(body.language, headers));
        case "json":
            return resolver.text(body.text, "json");
        case "file":
            return [uploadOf(collection, body.file)];
        case "graphql": {
            const query = plainOf(resolver.text(body.query, "graphql"));
            if (query === undefined) {
                throw new InputError(`the GraphQL query of ${quoted(request)} cannot hold a secret or a generated value: use a variable`);
            }
            const variables = body.variables === undefined ? undefined : resolver.text(body.variables, "json");
            const plain = variables === undefined ? undefined : plainOf(variables);
            if (plain !== undefined) {
                try {
                    JSON.parse(plain);
                } catch {
                    throw new InputError(`the GraphQL variables of ${quoted(request)} are not valid JSON`);
                }
            }
            return joined(
                `{"query":${JSON.stringify(query)}`,
                body.operationName === undefined ? "" : `,"operationName":${JSON.stringify(body.operationName)}`,
                variables === undefined ? "" : joined(',"variables":', variables),
                "}",
            );
        }
        case "form": {
            if (body.encoding === "urlencoded") {
                const pairs = body.fields.flatMap((field) => {
                    if (field.kind !== "text") return [];
                    return [joined(`${encodeURIComponent(field.name)}=`, formEncoded(resolver.text(field.value, "plain")))];
                });
                return joined(...pairs.flatMap((pair, index) => (index === 0 ? [pair] : ["&", pair])));
            }
            const boundary = boundaryOf(body);
            if (body.boundary === undefined && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
                headers.push(["Content-Type", [`multipart/form-data; boundary=${boundary}`]]);
            }
            const parts: Text[] = body.fields.map((field) => {
                const head = `--${boundary}\r\nContent-Disposition: form-data; name="${quotedParam(field.name)}"`;
                if (field.kind === "text") {
                    const type = field.contentType === undefined ? "" : `\r\nContent-Type: ${field.contentType}`;
                    const value = resolver.text(field.value, "plain");
                    // A value that holds the boundary would end the part and start another that the request does not have.
                    if (displayOf(value).includes(`--${boundary}`)) {
                        throw new InputError(`the field ${shown(field.name, 30)} of ${quoted(request)} holds the boundary of the form`);
                    }
                    return joined(head, type, "\r\n\r\n", value, "\r\n");
                }
                const file = uploadOf(collection, field.file);
                const filename = field.filename ?? file.upload;
                const type = field.contentType ?? "application/octet-stream";
                return joined(head, `; filename="${quotedParam(filename)}"\r\nContent-Type: ${type}\r\n\r\n`, [file], "\r\n");
            });
            return joined(...parts, `--${boundary}--\r\n`);
        }
    }
}

/** How the request signs in, from the sign-in its source found. Every address in it is checked like the request's own. */
function signInOf(auth: Auth, resolver: Resolver, endpoint: (template: string, what: string) => string, request: string): SignIn {
    switch (auth.kind) {
        case "none":
            return { kind: "none" };
        case "bearer":
            return { kind: "bearer", token: resolver.text(auth.token, "header") };
        case "basic":
            return { kind: "basic", username: resolver.text(auth.username, "header"), password: resolver.text(auth.password, "header") };
        case "apiKey": {
            const name = plainOf(resolver.text(auth.name, "plain"));
            if (name === undefined || !HEADER_NAME.test(name) || SAVED_REFUSED_HEADERS.has(name.toLowerCase())) {
                throw new InputError(`the API key of ${quoted(request)} names a header that cannot be sent: ${shown(name ?? "", 30)}`);
            }
            return { kind: "apiKey", name, value: resolver.text(auth.value, "header") };
        }
        case "oauth2": {
            const text = (template: string | undefined): Text | undefined => (template === undefined ? undefined : resolver.text(template, "plain"));
            const scope = text(auth.scope);
            const clientSecret = text(auth.clientSecret);
            const username = text(auth.username);
            const password = text(auth.password);
            return {
                kind: "oauth",
                grant: auth.grant,
                tokenUrl: endpoint(auth.tokenUrl, `the token address of ${quoted(request)}`),
                clientId: resolver.text(auth.clientId, "plain"),
                ...(clientSecret === undefined ? {} : { clientSecret }),
                ...(username === undefined ? {} : { username }),
                ...(password === undefined ? {} : { password }),
                ...(scope === undefined ? {} : { scope: plainOf(scope) ?? "" }),
                clientAuth: auth.clientAuth,
            };
        }
    }
}

/** What an environment's mapping replaces the request's own sign-in with, if anything. */
function overrideOf(ctx: PlanContext, label: string): SignIn | undefined {
    const mapping = ctx.settings.environments.get(label);
    if (mapping?.signIn !== undefined) return { kind: "service", name: mapping.signIn };
    if (mapping?.transport !== undefined) return { kind: "transport", name: mapping.transport };
    return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The plans

export interface RunInput {
    /** The collection's name for the environment. */
    environment: unknown;
    variables?: Readonly<Record<string, unknown>> | undefined;
    timeoutSec?: number | undefined;
}

/** The plan for one saved request. */
export function planRequest(ctx: PlanContext, request: SavedRequest, input: RunInput): Plan {
    const name = quoted(request.name);
    const collection = ctx.catalog.collection(request.collection);
    if (request.scripts.prerequest) {
        throw new InputError(`${name} is refused: it has a pre-request script (${request.scripts.where ?? "its own"}), and scripts never run`);
    }
    if (request.unsupported !== undefined) throw new InputError(`${name} cannot be sent: ${request.unsupported}`);
    if (!isMethod(request.method)) throw new InputError(`${name} cannot be sent: the method ${request.method} is not sent`);

    const environment = ctx.catalog.environment(collection, input.environment);
    const label = input.environment as string;
    const secretNames = secretNamesOf(collection, ctx.settings.secrets);
    const agent = agentValues(request, input.variables, secretNames);
    const resolver = createResolver({ collection, environment, label, request, secrets: ctx.settings.secrets, agent });
    const hosts = environmentHosts(ctx, collection, environment, label);
    const endpoint = (template: string, what: string): string => destination(ctx, resolver.address(template).url, hosts, label, what);

    const url = endpoint(request.url, `the address of ${name}`);
    const headers: Array<readonly [string, Text]> = [];
    if (request.headers.length > MAX_HEADERS) throw new InputError(`${name} has more than ${MAX_HEADERS} headers`);
    for (const [header, value] of request.headers) {
        headers.push(checkedHeader(header, resolver.text(value, "header"), SAVED_REFUSED_HEADERS, request.name));
    }
    const body = request.body === undefined ? undefined : bodyOf(request.body, resolver, collection, headers, request.name);
    const override = overrideOf(ctx, label);
    const signIn = override ?? signInOf(request.auth, resolver, endpoint, request.name);
    resolver.finish();

    if (body !== undefined && !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        throw new InputError(`${name} is a ${request.method} with a body, and a ${request.method} carries none`);
    }
    const limit = body?.some(isUpload) === true ? MAX_UPLOADED_BODY_BYTES : MAX_SAVED_BODY_BYTES;
    if (body !== undefined && byteLengthOf(body) > limit) {
        throw new InputError(`the body of ${name} is larger than ${limit / (1024 * 1024)} MiB`);
    }
    return sealed({
        label: `api run ${name}`,
        system: `api:${collection.name}`,
        request: request.name,
        collection: collection.name,
        environment: label,
        jigEnvironment: jigEnvironmentOf(ctx.settings, label),
        method: request.method,
        url,
        headers,
        body: body === undefined || (body.length === 0) ? undefined : body,
        signIn,
        timeoutSec: checkTimeout(input.timeoutSec, ctx.settings.timeoutSec),
        allowPlainLocal: ctx.settings.allowPlainLocal,
    });
}

export interface CallInput {
    environment: unknown;
    collection: string | undefined;
    method: unknown;
    url: unknown;
    body: unknown;
    headers: unknown;
    timeoutSec: unknown;
}

/** The plan for an ad-hoc request: allowed only where `adHoc` says, never in production. */
export function planCall(ctx: PlanContext, input: CallInput): Plan {
    const label = typeof input.environment === "string" ? input.environment : "";
    const holders = ctx.catalog.selected(input.collection).filter((collection) => collection.environments.has(label));
    if (holders.length === 0) {
        const names = [...new Set(ctx.catalog.selected(input.collection).flatMap((collection) => [...collection.environments.keys()]))];
        const known = names.length === 0 ? "none" : shortList(names, ", ", 70);
        throw new InputError(`no environment named ${shown(input.environment, 30)}; known: ${known}`);
    }
    const jigEnvironment = jigEnvironmentOf(ctx.settings, label);
    if (ctx.kindOf(jigEnvironment) === "production") {
        const why = ctx.settings.environments.has(label) ? "" : " because api.environments does not map it";
        throw new InputError(`call is never allowed in production, and ${label} counts as ${jigEnvironment}${why}`);
    }
    if (!ctx.settings.adHoc.has(jigEnvironment)) {
        throw new InputError(`call is not allowed in ${label}: add "${jigEnvironment}" to api.adHoc to allow it`);
    }
    if (!isMethod(input.method)) {
        throw new InputError(`api call: method must be one of ${METHODS.join(", ")} (got ${shown(input.method)})`);
    }
    const method = input.method;

    const given = checkUrl(input.url);
    const body = checkBody(method, input.body);
    const own = checkHeaders(input.headers);
    const timeoutSec = checkTimeout(input.timeoutSec, ctx.settings.timeoutSec);

    const hosts = new Set<string>();
    for (const collection of holders) {
        const environment = ctx.catalog.environment(collection, label);
        for (const host of environmentHosts(ctx, collection, environment, label)) hosts.add(host);
    }
    const url = destination(ctx, `${given.origin}${given.rest}`, hosts, label, "the address");

    // The sign-in: the environment's own service or transport, else the sign-in of the collection the call names.
    let signIn: SignIn = overrideOf(ctx, label) ?? { kind: "none" };
    if (signIn.kind === "none" && input.collection !== undefined) {
        const collection = holders[0] as Collection;
        if (collection.authRefused !== undefined) throw new InputError(`the sign-in of ${collection.name} cannot be sent: ${collection.authRefused}`);
        const environment = ctx.catalog.environment(collection, label);
        const resolver = createResolver({ collection, environment, label, request: undefined, secrets: ctx.settings.secrets, agent: new Map() });
        const endpoint = (template: string, what: string): string => destination(ctx, resolver.address(template).url, hosts, label, what);
        signIn = signInOf(collection.auth, resolver, endpoint, collection.name);
        resolver.finish();
    }

    const headers: Array<readonly [string, Text]> = own.map(([name, value]) => [name, [value]] as const);
    if (body !== undefined && !own.some(([name]) => name.toLowerCase() === "content-type")) headers.push(["Content-Type", ["application/json"]]);
    return sealed({
        label: `api call ${method} ${new URL(url).pathname}`,
        system: input.collection === undefined ? "api" : `api:${input.collection}`,
        request: "call",
        collection: input.collection,
        environment: label,
        jigEnvironment,
        method,
        url,
        headers,
        body: body === undefined ? undefined : [body],
        signIn,
        timeoutSec,
        allowPlainLocal: ctx.settings.allowPlainLocal,
    });
}
