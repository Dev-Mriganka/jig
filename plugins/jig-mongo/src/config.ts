// The `mongo` section of jig.json: where each environment's database is, how to reach it, and what may be seen there. jig-core
// checks the section with validateMongo when a session starts, so the rest of the plugin reads settings that are valid.
// Nothing here touches the network or a secret store.
import { createAccess, readAllow, readDeny } from "./access.ts";
import type { Access, AccessRules } from "./access.ts";
import { jig } from "../../jig-core/src/client.ts";
import { InputError, isObject, shown } from "./values.ts";

export interface SshRoute {
    kind: "ssh";
    host: string;
    user: string;
    /** A secret reference to the private key. */
    key: string;
    port?: number;
}

/** A tunnel a company plugin provides, by name. */
export interface TunnelRoute {
    kind: "tunnel";
    name: string;
}

export type Route = { kind: "direct" } | SshRoute | TunnelRoute;

export interface HostPort {
    host: string;
    port: number;
}

export interface ParsedUri {
    scheme: "mongodb" | "mongodb+srv";
    hosts: HostPort[];
    /** The path after the hosts: the default database, without the slash. */
    database: string;
    /** The options after the question mark, as written. */
    options: string;
    text: string;
}

export interface Connection {
    environment: string;
    uri: ParsedUri;
    user: string;
    /** A secret reference. */
    password: string;
    authSource?: string;
    tls?: boolean;
    via: Route;
}

export interface MongoSettings {
    /** By jig-core environment name. A Map, so that a name such as `constructor` is only ever a name. */
    connections: ReadonlyMap<string, Connection>;
    /** What was configured, by environment. Defaults are applied when a call is made (see accessFor). */
    access: ReadonlyMap<string, AccessRules>;
}

const SECTION_FIELDS: ReadonlySet<string> = new Set(["connections", "access"]);
const CONNECTION_FIELDS: ReadonlySet<string> = new Set(["uri", "user", "password", "authSource", "tls", "via"]);
const ACCESS_FIELDS: ReadonlySet<string> = new Set(["deny", "allow", "javascript"]);
const SSH_FIELDS: ReadonlySet<string> = new Set(["host", "user", "key", "port"]);

const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S+$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;
const SSH_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER = /^[^\u0000-\u001f\u007f]{1,128}$/;
const AUTH_SOURCE = /^[A-Za-z0-9_.$-]{1,64}$/;
const URI_SHAPE = /^(mongodb(?:\+srv)?):\/\/(?:([^@/?#]*)@)?([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/;
/** Options that would carry a credential or switch off the checks of the certificate. */
const URI_OPTION_REFUSED = /password|secret|token|authmechanismproperties|tlsinsecure|tlsallowinvalid/i;
const MAX_CONNECTIONS = 20;

function checkReference(value: unknown, key: string, errors: string[]): string | undefined {
    // The value is not repeated: a mistaken reference may be the secret itself.
    if (typeof value === "string" && SECRET_REFERENCE.test(value)) return value;
    errors.push(`${key}: must be a secret reference such as pass:mongo/staging, not the secret itself`);
    return undefined;
}

/** Whether jig-core counts the environment as production. A name it cannot answer for counts as production. */
function isProduction(name: string): boolean {
    try {
        return jig().environments.kindOf(name) === "production";
    } catch {
        return true;
    }
}

function parseHost(text: string): HostPort | undefined {
    const bracket = /^(\[[^\]]+\])(?::(\d+))?$/.exec(text);
    const plain = /^([^:]+)(?::(\d+))?$/.exec(text);
    const match = bracket ?? plain;
    if (match === null) return undefined;
    const host = match[1] as string;
    const port = match[2] === undefined ? 27017 : Number(match[2]);
    if (!HOST.test(host) || port < 1 || port > 65535) return undefined;
    return { host, port };
}

/** Reads a connection string. A string with a user in it, a password option or an option that weakens TLS is refused. */
function checkUri(value: unknown, at: string, errors: string[]): ParsedUri | undefined {
    const bad = (message: string): undefined => {
        errors.push(`${at}: ${message}`);
        return undefined;
    };
    if (typeof value !== "string" || value === "")
        return bad('required, such as "mongodb://db.staging.example.com:27017"');
    const match = URI_SHAPE.exec(value);
    if (match === null) return bad("must be a mongodb:// or mongodb+srv:// address");
    const [, scheme, userinfo, hostText, database = "", options = ""] = match as unknown as [
        string,
        "mongodb" | "mongodb+srv",
        string | undefined,
        string,
        string | undefined,
        string | undefined,
    ];
    // Never repeated in the message: it holds a password.
    if (userinfo !== undefined && userinfo !== "")
        return bad("must not hold a user or a password: put them in user and password (a secret reference)");
    const hosts = hostText.split(",").map(parseHost);
    if (hosts.some((host) => host === undefined)) return bad("a host or port in it is not valid");
    if (scheme === "mongodb+srv" && (hosts.length !== 1 || /:\d+$/.test(hostText)))
        return bad("mongodb+srv takes one host and no port");
    for (const option of options.split("&").filter(Boolean)) {
        const name = option.split("=")[0] ?? "";
        if (URI_OPTION_REFUSED.test(name))
            return bad(
                `the option ${shown(name, 30)} is not allowed: credentials go in password, and TLS checks stay on`,
            );
    }
    return { scheme, hosts: hosts as HostPort[], database, options, text: value };
}

function checkSsh(raw: unknown, at: string, errors: string[]): SshRoute | undefined {
    if (!isObject(raw)) {
        errors.push(
            `${at}: must be an object such as { "host": "bastion.example.com", "user": "agent", "key": "pass:ssh/bastion" }`,
        );
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!SSH_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);
    // A host or user that began with a dash would be read by ssh as an option.
    const host = typeof raw.host === "string" && HOST.test(raw.host) ? raw.host : undefined;
    if (host === undefined) errors.push(`${at}.host: required, a host name such as bastion.example.com`);
    const user = typeof raw.user === "string" && SSH_USER.test(raw.user) ? raw.user : undefined;
    if (user === undefined) errors.push(`${at}.user: required, a user name`);
    const key = checkReference(raw.key, `${at}.key`, errors);
    let port: number | undefined;
    if (raw.port !== undefined) {
        if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535)
            port = raw.port;
        else errors.push(`${at}.port: must be a whole number from 1 to 65535`);
    }
    if (errors.length > before || host === undefined || user === undefined || key === undefined) return undefined;
    return { kind: "ssh", host, user, key, ...(port === undefined ? {} : { port }) };
}

function checkVia(raw: unknown, uri: ParsedUri | undefined, at: string, errors: string[]): Route | undefined {
    if (raw === undefined) return { kind: "direct" };
    if (!isObject(raw)) {
        errors.push(`${at}: must be { "ssh": {...} } or { "tunnel": "<name>" }`);
        return undefined;
    }
    for (const key of Object.keys(raw))
        if (key !== "ssh" && key !== "tunnel") errors.push(`${at}.${key}: unknown field`);
    if ("ssh" in raw && "tunnel" in raw) {
        errors.push(`${at}: use ssh or tunnel, not both`);
        return undefined;
    }
    if ("tunnel" in raw) {
        if (typeof raw.tunnel === "string" && TUNNEL_NAME.test(raw.tunnel)) return { kind: "tunnel", name: raw.tunnel };
        errors.push(`${at}.tunnel: must be the name of a tunnel a company plugin provides`);
        return undefined;
    }
    if (!("ssh" in raw)) {
        errors.push(`${at}: must be { "ssh": {...} } or { "tunnel": "<name>" }`);
        return undefined;
    }
    const route = checkSsh(raw.ssh, `${at}.ssh`, errors);
    // A forward reaches one host and port. A replica set would be discovered past it, and SRV needs the DNS of the far side.
    if (uri !== undefined && (uri.scheme === "mongodb+srv" || uri.hosts.length !== 1)) {
        errors.push(
            `${at}.ssh: needs a uri with exactly one host and port (mongodb://host:27017), not a replica set list or mongodb+srv`,
        );
    }
    return route;
}

function checkConnection(environment: string, raw: unknown, errors: string[]): Connection | undefined {
    const at = `mongo.connections.${environment}`;
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with uri, user and password`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!CONNECTION_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);
    const uri = checkUri(raw.uri, `${at}.uri`, errors);
    const user = typeof raw.user === "string" && USER.test(raw.user) ? raw.user : undefined;
    if (user === undefined)
        errors.push(`${at}.user: required, the database user (plain text; a read-only user for production)`);
    const password = checkReference(raw.password, `${at}.password`, errors);
    let authSource: string | undefined;
    if (raw.authSource !== undefined) {
        if (typeof raw.authSource === "string" && AUTH_SOURCE.test(raw.authSource)) authSource = raw.authSource;
        else errors.push(`${at}.authSource: must be a database name such as admin`);
    }
    let tls: boolean | undefined;
    if (raw.tls !== undefined) {
        if (typeof raw.tls === "boolean") tls = raw.tls;
        else errors.push(`${at}.tls: must be true or false`);
    }
    const via = checkVia(raw.via, uri, `${at}.via`, errors);
    if (
        errors.length > before ||
        uri === undefined ||
        user === undefined ||
        password === undefined ||
        via === undefined
    )
        return undefined;
    return {
        environment,
        uri,
        user,
        password,
        via,
        ...(authSource === undefined ? {} : { authSource }),
        ...(tls === undefined ? {} : { tls }),
    };
}

function checkAccess(environment: string, raw: unknown, errors: string[]): AccessRules | undefined {
    const at = `mongo.access.${environment}`;
    if (!isObject(raw)) {
        errors.push(`${at}: must be { "deny": [...] } or { "allow": { "db.collection": ["field"] } }`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!ACCESS_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);
    const production = isProduction(environment);
    let javascript = false;
    if (raw.javascript !== undefined) {
        if (typeof raw.javascript !== "boolean") errors.push(`${at}.javascript: must be true or false`);
        else if (raw.javascript && production)
            errors.push(`${at}.javascript: server-side JavaScript is never allowed in production`);
        else javascript = raw.javascript;
    }
    if ("deny" in raw && "allow" in raw) {
        errors.push(`${at}: use deny or allow, not both`);
        return undefined;
    }
    if (production && !("allow" in raw)) {
        errors.push(
            `${at}: production needs an allow list: { "allow": { "db.collection": ["field"] } }; a deny list is not allowed there`,
        );
        return undefined;
    }
    if ("allow" in raw) {
        const allow = readAllow(raw.allow, `${at}.allow`, errors);
        return errors.length > before || allow === undefined ? undefined : { mode: "allow", allow, javascript };
    }
    const deny =
        "deny" in raw
            ? readDeny(raw.deny, `${at}.deny`, errors)
            : { databases: new Set<string>(), collections: new Set<string>(), fields: [] };
    return errors.length > before || deny === undefined ? undefined : { mode: "deny", deny, javascript };
}

/**
 * Checks a raw `mongo` section and reads it. `errors` name their key; with any error there are no settings. A misspelt field is an
 * error and not a silent default, and so is a production environment without an allow list.
 */
export function readMongo(raw: unknown): { settings?: MongoSettings; errors: string[] } {
    if (!isObject(raw)) return { errors: ["mongo: must be an object"] };
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (!SECTION_FIELDS.has(key)) errors.push(`mongo.${key}: unknown field`);

    const connections = new Map<string, Connection>();
    if (
        !isObject(raw.connections) ||
        Object.keys(raw.connections).length === 0 ||
        Object.keys(raw.connections).length > MAX_CONNECTIONS
    ) {
        errors.push(
            `mongo.connections: required, 1 to ${MAX_CONNECTIONS} connections by environment name, ` +
                    'such as { "staging": { "uri": "mongodb://db.staging.example.com:27017", ... } }',
        );
    } else {
        for (const [name, value] of Object.entries(raw.connections)) {
            if (!ENVIRONMENT_NAME.test(name)) {
                errors.push(
                    `mongo.connections: ${shown(name, 30)} is not an environment name (letters, digits, - and _, starting with a letter)`,
                );
            } else if (name === "local" || name === "external") {
                // Writes to these are not asked about as writes to a test environment are, so a database is never one of them.
                errors.push(
                    `mongo.connections.${name}: a database is a test or production environment; define one in jig.json "environments" and use its name`,
                );
            } else {
                const connection = checkConnection(name, value, errors);
                if (connection !== undefined) connections.set(name, connection);
            }
        }
    }

    const access = new Map<string, AccessRules>();
    if (raw.access !== undefined) {
        if (!isObject(raw.access)) {
            errors.push("mongo.access: must be an object by environment name");
        } else {
            for (const [name, value] of Object.entries(raw.access)) {
                if (isObject(raw.connections) && !Object.hasOwn(raw.connections, name)) {
                    errors.push(`mongo.access.${name}: there is no connection with this name`);
                    continue;
                }
                const rules = checkAccess(name, value, errors);
                if (rules !== undefined) access.set(name, rules);
            }
        }
    }
    if (errors.length > 0) return { errors };
    return { errors, settings: { connections, access } };
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateMongo(raw: unknown): string[] {
    return readMongo(raw).errors;
}

const parsed = new WeakMap<object, MongoSettings | undefined>();

/** The settings in a raw section, or undefined when it is absent or invalid. Read again only when the object changes. */
export function settingsOf(raw: unknown): MongoSettings | undefined {
    if (!isObject(raw)) return undefined;
    if (!parsed.has(raw)) parsed.set(raw, readMongo(raw).settings);
    return parsed.get(raw);
}

/**
 * The access rules for an environment, with the defaults of its kind: a test environment reads everything but what is denied, and
 * production reads nothing until it is listed. A production environment that somehow holds a deny list is refused here too.
 */
export function accessFor(settings: MongoSettings, environment: string): Access {
    const configured = settings.access.get(environment);
    if (isProduction(environment)) {
        if (configured !== undefined && configured.mode !== "allow") {
            throw new InputError(`${environment} is production: it needs an allow list, not a deny list`);
        }
        return createAccess({
            ...(configured ?? { mode: "allow", allow: new Map() }),
            javascript: false,
        } as AccessRules);
    }
    return createAccess(
        configured ?? {
            mode: "deny",
            deny: { databases: new Set(), collections: new Set(), fields: [] },
            javascript: false,
        },
    );
}
