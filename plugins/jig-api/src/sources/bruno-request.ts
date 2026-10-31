// One Bruno request turned into a saved request: what the collection and the folders above it set for it (headers, sign-in, variables,
// a pre-request script), the address with its path parameters, and the reasons it is refused.
import path from "node:path";
import { CREDENTIAL_HEADERS } from "../model.ts";
import type { Auth, Body, SavedRequest } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import type { AuthSetting, Pairs, ParsedDefaults, ParsedRequest } from "./bruno-types.ts";
import { authTexts, bodyTexts } from "./texts.ts";
import { PROCESS_ENV } from "./bruno-reading.ts";
import type { Reading } from "./bruno-reading.ts";

const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

/** What the collection and the folders above a request set for it. */
export interface Level {
    /** The display names of the folders, outermost first. */
    folder: readonly string[];
    /** By lower-case name, so that a request's header replaces the same header of a folder. */
    headers: ReadonlyMap<string, readonly [string, string]>;
    /** The sign-in a request that inherits gets. Never `inherit`. */
    auth: AuthSetting;
    /** Whose pre-request script applies below: "the folder Admin" or "the collection". */
    prerequest: string | undefined;
    vars: ReadonlyMap<string, string>;
}

function headerMap(
    base: ReadonlyMap<string, readonly [string, string]>,
    headers: Pairs,
): Map<string, readonly [string, string]> {
    const merged = new Map(base);
    for (const [name, value] of headers) merged.set(name.toLowerCase(), [name, value]);
    return merged;
}

export function belowCollection(defaults: ParsedDefaults): Level {
    const auth: AuthSetting =
        defaults.auth.kind === "set" || defaults.auth.kind === "refused" ? defaults.auth : { kind: "none" };
    return {
        folder: [],
        headers: headerMap(new Map(), defaults.headers),
        auth,
        prerequest: defaults.prerequest ? "the collection" : undefined,
        vars: new Map(),
    };
}

/** A folder's own sign-in replaces the one above it; a folder with none, or with `inherit`, leaves it. */
export function belowFolder(parent: Level, defaults: ParsedDefaults, name: string): Level {
    return {
        folder: [...parent.folder, name],
        headers: headerMap(parent.headers, defaults.headers),
        auth: defaults.auth.kind === "set" || defaults.auth.kind === "refused" ? defaults.auth : parent.auth,
        prerequest: defaults.prerequest ? `the folder ${name}` : parent.prerequest,
        vars: new Map([...parent.vars, ...defaults.vars]),
    };
}

function escaped(name: string): string {
    return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `:id` in the address takes the value of the path parameter, or, when the file gives none, becomes a variable of that name. */
function withPathParameters(url: string, parameters: Pairs): string {
    let out = url;
    for (const [name, value] of parameters) {
        out = out.replace(
            new RegExp(`/:${escaped(name)}(?=[/?#]|$)`, "g"),
            () => `/${value === "" ? `{{${name}}}` : value}`,
        );
    }
    return out;
}

function schemeProblem(url: string): string | undefined {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
    if (scheme === undefined || scheme === "http" || scheme === "https") return undefined;
    return `the address uses ${scheme}://, and only http and https are sent (not WebSocket, gRPC or MQTT)`;
}

export function requestOf(parsed: ParsedRequest, file: string, level: Level, reading: Reading): SavedRequest {
    const name = parsed.name ?? path.basename(file).replace(/\.[^.]+$/, "");
    const hash = parsed.url.indexOf("#");
    const url = withPathParameters((hash >= 0 ? parsed.url.slice(0, hash) : parsed.url).trim(), parsed.pathParams);

    const headers = [...headerMap(level.headers, parsed.headers).values()];
    const effective: AuthSetting = parsed.auth.kind === "inherit" ? level.auth : parsed.auth;
    const auth: Auth = effective.kind === "set" ? effective.auth : { kind: "none" };
    if (parsed.body.contentType !== undefined && !headers.some(([header]) => header.toLowerCase() === "content-type")) {
        headers.push(["Content-Type", parsed.body.contentType]);
    }

    const body: Body | undefined = parsed.body.body;
    const variables = variablesIn(url, ...headers.map(([, value]) => value), ...bodyTexts(body), ...authTexts(auth));
    const signsIn = variablesIn(
        ...authTexts(auth),
        ...headers.filter(([header]) => CREDENTIAL_HEADERS.has(header.toLowerCase())).map(([, value]) => value),
    );
    for (const variable of variables) if (variable.startsWith(PROCESS_ENV)) reading.processEnv.add(variable);

    let unsupported: string | undefined;
    if (parsed.type === "websocket" || parsed.type === "grpc") {
        unsupported = `${parsed.method} is not plain HTTP, and only HTTP is sent`;
    } else if (!SENT_METHODS.has(parsed.method)) {
        unsupported = `the method ${parsed.method} is not sent (GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE are)`;
    }
    unsupported ??= schemeProblem(url);
    unsupported ??= effective.kind === "refused" ? effective.reason : undefined;
    unsupported ??= parsed.body.unsupported;
    unsupported ??= unsupportedVariable(variables);
    if (url === "") unsupported ??= "it has no address";

    const where = parsed.prerequest ? "the request" : level.prerequest;
    const defaults = new Map([...level.vars, ...parsed.vars]);
    for (const value of defaults.values()) reading.values.push(value);
    return {
        collection: reading.collection,
        folder: level.folder,
        name,
        origin: file,
        method: parsed.method,
        url,
        headers,
        ...(body === undefined ? {} : { body }),
        auth,
        variables,
        secrets: variables.filter((variable) => variable.startsWith(PROCESS_ENV) || reading.secretNames.has(variable)),
        signsIn,
        defaults,
        scripts: { prerequest: where !== undefined, ...(where === undefined ? {} : { where }) },
        ...(unsupported === undefined ? {} : { unsupported }),
        notes: [...parsed.notes, ...parsed.body.notes],
        ...(parsed.assertions.length === 0 ? {} : { assertions: parsed.assertions }),
        ...(parsed.docs === undefined ? {} : { description: parsed.docs }),
    };
}
