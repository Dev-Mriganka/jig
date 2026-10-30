// The `mongo` section of jig.json: where each environment's database is, how to reach it, and what may be seen there. jig-core
// checks the section with validateMongo when a session starts, so the rest of the plugin reads settings that are valid.
// Nothing here touches the network or a secret store.
import { createAccess, readAllow, readDeny } from "./access.ts";
import type { Access, AccessRules } from "./access.ts";
import { jig } from "../../jig-core/src/client.ts";
import { InputError, isObject, shortList, shown } from "./values.ts";

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
    /** The name that picks this connection, when its environment has several. */
    cluster?: string;
    uri: ParsedUri;
    /** Plain text, or a secret reference (see `isReference`). */
    user: string;
    /** A secret reference. */
    password: string;
    authSource?: string;
    tls?: boolean;
    via: Route;
}

export interface MongoSettings {
    /**
     * Every connection, by `connectionKey`: the jig-core environment name, or `environment/cluster` for an environment that
     * has several. A Map, so that a name such as `constructor` is only ever a name.
     */
    connections: ReadonlyMap<string, Connection>;
    /** The cluster names of each environment that has several connections, in the order they were written. */
    clusters: ReadonlyMap<string, readonly string[]>;
    /** What was configured, by `connectionKey`. Defaults are applied when a call is made (see accessFor). */
    access: ReadonlyMap<string, AccessRules>;
}

/** The key of a connection: its environment, or `environment/cluster` when the environment has several. Neither name can hold a slash. */
export function connectionKey(environment: string, cluster?: string): string {
    return cluster === undefined ? environment : `${environment}/${cluster}`;
}

/** The environments that have a connection, each once. */
export function environmentsOf(settings: MongoSettings): string[] {
    return [...new Set([...settings.connections.values()].map((connection) => connection.environment))];
}

/**
 * Whether a user is a secret reference. One that starts with the name of a secret backend and a colon is read as one, so
 * `pass:mongo/staging-user` is looked up, and `agent` is the user's name. (jig-core's list of backends.)
 */
const REFERENCE_SCHEMES = ["pass", "env", "keychain", "op", "cmd", "file"] as const;
export function isReference(user: string): boolean {
    return REFERENCE_SCHEMES.some((scheme) => user.startsWith(`${scheme}:`) && user.length > scheme.length + 1);
}

const SECTION_FIELDS: ReadonlySet<string> = new Set(["connections", "access"]);
const CONNECTION_FIELDS: ReadonlySet<string> = new Set(["uri", "user", "password", "authSource", "tls", "via"]);
const ACCESS_FIELDS: ReadonlySet<string> = new Set(["deny", "allow", "javascript"]);
/** A cluster name is also a key beside a connection's own fields and an access list's, so it cannot be one of those. */
export const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_CLUSTERS = 10;
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

function checkConnection(
    environment: string,
    raw: unknown,
    errors: string[],
    cluster?: string,
): Connection | undefined {
    const at = `mongo.connections.${environment}${cluster === undefined ? "" : `.${cluster}`}`;
    if (!isObject(raw)) {
        errors.push(
            cluster === undefined
                ? `${at}: must be an object with uri, user and password`
                : `${at}: must be an object with uri, user and password (a connection of ${environment}), not a value`,
        );
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!CONNECTION_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);
    const uri = checkUri(raw.uri, `${at}.uri`, errors);
    const user = checkUser(raw.user, `${at}.user`, errors);
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
        ...(cluster === undefined ? {} : { cluster }),
        uri,
        user,
        password,
        via,
        ...(authSource === undefined ? {} : { authSource }),
        ...(tls === undefined ? {} : { tls }),
    };
}

/** The database user: plain text, or a secret reference such as `pass:mongo/staging-user`, read when the connection opens. */
function checkUser(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value === "string" && USER.test(value)) {
        // A reference is not repeated if it is wrong; the shape of a backend is all that is checked here.
        if (!isReference(value) || SECRET_REFERENCE.test(value)) return value;
    }
    errors.push(
        `${key}: required, the database user (plain text, or a secret reference such as pass:mongo/staging-user)`,
    );
    return undefined;
}

/** Whether the value of an environment names connections of its own (`{ orders: {...}, billing: {...} }`) and not one connection. */
function isNamedConnections(value: unknown): value is Record<string, unknown> {
    return (
        isObject(value) &&
        Object.keys(value).length > 0 &&
        !Object.keys(value).some((key) => CONNECTION_FIELDS.has(key))
    );
}

function checkAccess(environment: string, raw: unknown, errors: string[], cluster?: string): AccessRules | undefined {
    const at = `mongo.access.${environment}${cluster === undefined ? "" : `.${cluster}`}`;
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
    const clusters = new Map<string, string[]>();
    if (
        !isObject(raw.connections) ||
        Object.keys(raw.connections).length === 0 ||
        Object.keys(raw.connections).length > MAX_CONNECTIONS
    ) {
        errors.push(
            `mongo.connections: required, 1 to ${MAX_CONNECTIONS} environments, each with one connection or several by name, ` +
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
            } else if (isNamedConnections(value)) {
                readClusters(name, value, connections, clusters, errors);
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
                if (!isObject(raw.connections) || !Object.hasOwn(raw.connections, name)) {
                    if (isObject(raw.connections))
                        errors.push(`mongo.access.${name}: there is no connection with this name`);
                    continue;
                }
                const named = raw.connections[name];
                if (isNamedConnections(named)) {
                    readClusterAccess(name, value, Object.keys(named), access, errors);
                    continue;
                }
                const rules = checkAccess(name, value, errors);
                if (rules !== undefined) access.set(name, rules);
            }
        }
    }
    if (errors.length > 0) return { errors };
    return { errors, settings: { connections, clusters, access } };
}

/** The connections an environment names one by one. They are kept under `environment/cluster`, and the names in the order written. */
function readClusters(
    environment: string,
    raw: Record<string, unknown>,
    connections: Map<string, Connection>,
    clusters: Map<string, string[]>,
    errors: string[],
): void {
    const names = Object.keys(raw);
    if (names.length > MAX_CLUSTERS) {
        errors.push(`mongo.connections.${environment}: at most ${MAX_CLUSTERS} connections by name`);
        return;
    }
    const found: string[] = [];
    for (const cluster of names) {
        if (!CLUSTER_NAME.test(cluster) || ACCESS_FIELDS.has(cluster)) {
            errors.push(
                `mongo.connections.${environment}: ${shown(cluster, 30)} is not a usable name for a connection ` +
                    "(letters, digits, - and _, starting with a letter or digit; not deny, allow or javascript)",
            );
            continue;
        }
        const connection = checkConnection(environment, raw[cluster], errors, cluster);
        if (connection === undefined) continue;
        connections.set(connectionKey(environment, cluster), connection);
        found.push(cluster);
    }
    clusters.set(environment, found);
}

/** The access rules of an environment that has several connections: one set per connection name, never one for all. */
function readClusterAccess(
    environment: string,
    raw: unknown,
    known: readonly string[],
    access: Map<string, AccessRules>,
    errors: string[],
): void {
    const at = `mongo.access.${environment}`;
    if (!isObject(raw)) {
        errors.push(
            `${at}: must be an object by connection name, such as { "${known[0] ?? "orders"}": { "deny": [...] } }`,
        );
        return;
    }
    for (const [cluster, value] of Object.entries(raw)) {
        if (ACCESS_FIELDS.has(cluster)) {
            errors.push(
                `${at}.${cluster}: ${environment} has several connections (${shortList(known)}), so give the rules for each by name`,
            );
        } else if (!known.includes(cluster)) {
            errors.push(`${at}.${shown(cluster, 30)}: there is no connection with this name in ${environment}`);
        } else {
            const rules = checkAccess(environment, value, errors, cluster);
            if (rules !== undefined) access.set(connectionKey(environment, cluster), rules);
        }
    }
}

/**
 * Where an object of yours replaces a company's whole, when a company plugin gives defaults for the section: the route
 * is an `ssh` forward or a company `tunnel`, never both, and merging two would name both.
 */
export const MONGO_REPLACE: readonly string[] = ["connections.*.via", "connections.*.*.via"];

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
 * The access rules for an environment (and, when it has several connections, one of them), with the defaults of its kind: a test
 * environment reads everything but what is denied, and production reads nothing until it is listed. A production environment that
 * somehow holds a deny list is refused here too.
 */
export function accessFor(settings: MongoSettings, environment: string, cluster?: string): Access {
    const configured = settings.access.get(connectionKey(environment, cluster));
    const where = cluster === undefined ? environment : `${environment}/${cluster}`;
    if (isProduction(environment)) {
        if (configured !== undefined && configured.mode !== "allow") {
            throw new InputError(`${where} is production: it needs an allow list, not a deny list`);
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
