// The `logs` section of jig.json: where the search backend is, how to sign in to it, and where each environment's logs
// are. What an environment says about where its logs are depends on the kind of backend, so its fields are checked and
// filled in by the backend (see backends/).
//
// jig-core loads the file and calls `validateLogsSection` when it does. With errors it hands this plugin nothing, and
// the tool says it is not configured, so a typo never leaves a search half set up.
//
// A value that is a credential, such as a password, is only ever a reference to a secret (`pass:logs/reader`). An error
// about it never repeats the value: a mistake there may well be the secret itself, pasted by hand.
import { jig } from "../../jig-core/src/client.ts";
import { backends } from "./backends/index.ts";
import type { LogBackend } from "./backends/index.ts";
import { CONTROL, isObject, printable, refuse, shown } from "./values.ts";

/** The value a `filter` entry must equal. */
export type FilterValue = string | number | boolean;

/** Which kind of backend `logs.backend.url` is. A section without a type is Elasticsearch: it was the only one. */
export type BackendType = "elasticsearch" | "loki";

/** What every environment has, whatever the backend. */
interface Common {
    /** The field that hits show as their time. */
    timeField: string;
    /** The field that hits show as their text, and that `match` and `exclude` read. */
    messageField: string;
    /** The jig-core environment this search is classified in, which decides masking and rules. */
    jigEnvironment: string;
}

/** An Elasticsearch or OpenSearch environment, with the defaults filled in. It has no `type`: it was the only one. */
export interface ElasticTarget extends Common {
    type?: "elasticsearch";
    /** An index pattern, such as `app-logs-*`. */
    index: string;
    /** Fields that must equal a value, for an index that holds several environments. */
    filter: Readonly<Record<string, FilterValue>>;
    selector?: undefined;
}

/** A Loki environment: the streams its selector names, and no other. */
export interface LokiTarget extends Common {
    type: "loki";
    /** A LogQL stream selector, such as `{app="orders-api", env="staging"}`. */
    selector: string;
    index?: undefined;
    filter?: undefined;
}

/**
 * Where one environment's logs are. `type` tells the kinds apart. `index` and `selector` are each `undefined` on the
 * other kind, so either can be read on any target.
 */
export type Target = ElasticTarget | LokiTarget;

/** How a direct request signs in. Every value but `username` is a secret reference, resolved when the request is made,
 *  except `signIn`, which names a sign-in service. */
export type Auth =
    | { kind: "basic"; username: string; password: string }
    | { kind: "apiKey"; apiKey: string }
    | { kind: "bearer"; token: string }
    | { kind: "signIn"; service: string };

/** How requests reach the backend. `tenant` is Loki's, sent as the header `X-Scope-OrgID`. */
export type Backend =
    /** Straight to the backend over HTTPS, signed in with `auth`. */
    | { kind: "direct"; url: string; auth: Auth; tenant?: string }
    /** Through a transport a company plugin registered. The transport signs the request in, so there is no `auth`. */
    | { kind: "transport"; url: string; transport: string; tenant?: string };

export interface LogsSettings {
    type: BackendType;
    backend: Backend;
    /** By the name the tool's `environment` parameter uses. */
    environments: ReadonlyMap<string, Target>;
}

const MAX_ENVIRONMENTS = 50;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The shape of a secret reference (`pass:...`, `env:...`, `op://...`), without knowing which backends exist. */
const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S/;
const MAX_NAME_CHARS = 100;

function unknownFields(raw: Record<string, unknown>, known: readonly string[], key: string, errors: string[]): void {
    for (const field of Object.keys(raw)) {
        if (!known.includes(field)) errors.push(`${key}.${printable(field)} is not a known field`);
    }
}

/**
 * Like `unknownFields`, for the two places where the fields depend on the type of backend: a field that another type
 * uses is not "unknown", and the message names that type so the mistake is easy to see.
 */
function checkFields(
    raw: Record<string, unknown>,
    shared: readonly string[],
    level: "backendFields" | "environmentFields",
    key: string,
    backend: LogBackend,
    errors: string[],
): void {
    for (const field of Object.keys(raw)) {
        if (shared.includes(field) || backend.config[level].includes(field)) continue;
        const owner = Object.values(backends).find((other) => other.config[level].includes(field));
        errors.push(
            owner === undefined
                ? `${key}.${printable(field)} is not a known field`
                : `${key}.${printable(field)} is only used when logs.backend.type is "${owner.type}"`,
        );
    }
}

/**
 * The backend that `logs.backend.type` names. A section without a type is Elasticsearch. A type that is none of ours is
 * an error, and then the fields that depend on the type are not checked, so one mistake is not reported many times.
 */
function backendFor(raw: unknown, errors: string[]): LogBackend | undefined {
    const type = isObject(raw) ? raw.type : undefined;
    if (type === undefined) return backends.elasticsearch;
    if (typeof type === "string" && Object.hasOwn(backends, type)) return backends[type as BackendType];
    const types = Object.keys(backends).map((name) => `"${name}"`);
    errors.push(`logs.backend.type must be ${types.join(" or ")}`);
    return undefined;
}

/** The name of a transport or a sign-in service: text, as another package registered it. */
function isServiceName(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.trim() === value &&
        value.length > 0 &&
        value.length <= MAX_NAME_CHARS &&
        !CONTROL.test(value)
    );
}

/** The backend's address. A direct request carries a credential, so it must be https; a transport signs in itself. */
function checkUrl(value: unknown, key: string, secure: boolean, example: string, errors: string[]): void {
    if (typeof value !== "string" || value === "") {
        errors.push(`${key} must be the address of the search backend, such as ${example}`);
        return;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        errors.push(`${key} is not a valid address`);
        return;
    }
    // The address is never repeated below: a user name and password in it are credentials.
    if (url.protocol !== "https:" && (secure || url.protocol !== "http:")) {
        const allowed = secure ? "https://, because a credential travels with every request" : "http:// or https://";
        errors.push(`${key} must start with ${allowed}`);
    }
    if (url.username !== "" || url.password !== "") {
        errors.push(`${key} must not hold a user name or password: put them in backend.auth`);
    }
    if (url.search !== "" || url.hash !== "")
        errors.push(`${key} must not have a query string or a fragment: the index is added to it`);
}

function checkReference(value: unknown, key: string, errors: string[]): void {
    if (typeof value !== "string" || value.length > 500 || !SECRET_REFERENCE.test(value)) {
        errors.push(`${key} must be a secret reference such as pass:logs/reader, never the secret itself`);
    }
}

function checkAuth(raw: unknown, errors: string[]): void {
    const key = "logs.backend.auth";
    if (!isObject(raw)) {
        errors.push(`${key} must be an object`);
        return;
    }
    unknownFields(raw, ["username", "password", "apiKey", "token", "signIn"], key, errors);
    const kinds = [
        ...(raw.username !== undefined || raw.password !== undefined ? ["username with password"] : []),
        ...(raw.apiKey !== undefined ? ["apiKey"] : []),
        ...(raw.token !== undefined ? ["token"] : []),
        ...(raw.signIn !== undefined ? ["signIn"] : []),
    ];
    if (kinds.length !== 1) {
        const found = kinds.length === 0 ? "none" : kinds.join(", ");
        errors.push(`${key} needs exactly one of username with password, apiKey, token and signIn (found ${found})`);
        return;
    }
    if (raw.username !== undefined || raw.password !== undefined) {
        // A colon would end the user name early in the `user:password` that basic sign-in sends.
        if (
            typeof raw.username !== "string" ||
            raw.username === "" ||
            raw.username.includes(":") ||
            CONTROL.test(raw.username)
        ) {
            errors.push(`${key}.username must be a user name: text without a colon`);
        }
        checkReference(raw.password, `${key}.password`, errors);
    } else if (raw.apiKey !== undefined) {
        checkReference(raw.apiKey, `${key}.apiKey`, errors);
    } else if (raw.token !== undefined) {
        checkReference(raw.token, `${key}.token`, errors);
    } else if (!isServiceName(raw.signIn)) {
        errors.push(`${key}.signIn must be the name of a sign-in service`);
    }
}

function checkBackend(raw: unknown, backend: LogBackend | undefined, errors: string[]): void {
    if (!isObject(raw)) {
        errors.push("logs.backend must be an object");
        return;
    }
    if (backend !== undefined) {
        checkFields(raw, ["type", "url", "auth", "transport"], "backendFields", "logs.backend", backend, errors);
        backend.checkBackendFields?.(raw, "logs.backend", errors);
    }
    const viaTransport = raw.transport !== undefined;
    const example = (backend ?? backends.elasticsearch).config.exampleUrl;
    checkUrl(raw.url, "logs.backend.url", !viaTransport, example, errors);
    if (viaTransport) {
        if (!isServiceName(raw.transport)) errors.push("logs.backend.transport must be the name of a transport");
        if (raw.auth !== undefined)
            errors.push("logs.backend.auth cannot be used with transport: the transport signs the request in");
    } else if (raw.auth === undefined) {
        errors.push(
            "logs.backend needs auth (username with password, apiKey, token or signIn), " +
                "or a transport that signs the request in",
        );
    } else {
        checkAuth(raw.auth, errors);
    }
}

function checkEnvironment(raw: unknown, key: string, backend: LogBackend, errors: string[]): void {
    if (!isObject(raw)) {
        errors.push(`${key} must be an object with at least ${backend.config.needs}`);
        return;
    }
    checkFields(raw, ["jigEnvironment"], "environmentFields", key, backend, errors);
    backend.checkEnvironmentFields(raw, key, errors);
    if (
        raw.jigEnvironment !== undefined &&
        (typeof raw.jigEnvironment !== "string" || !NAME.test(raw.jigEnvironment))
    ) {
        errors.push(`${key}.jigEnvironment must be the name of a jig-core environment`);
    }
}

function checkEnvironments(raw: unknown, backend: LogBackend | undefined, errors: string[]): void {
    if (!isObject(raw)) {
        errors.push("logs.environments must be an object that maps an environment name to its settings");
        return;
    }
    const names = Object.keys(raw);
    if (names.length === 0) errors.push("logs.environments needs at least one environment");
    if (names.length > MAX_ENVIRONMENTS)
        errors.push(`logs.environments may hold at most ${MAX_ENVIRONMENTS} environments`);
    for (const name of names.slice(0, MAX_ENVIRONMENTS)) {
        if (!NAME.test(name)) {
            errors.push(
                `logs.environments: ${shown(name)} is not a usable name: use letters, digits and . _ -, at most 64`,
            );
        } else if (backend !== undefined) {
            checkEnvironment(raw[name], `logs.environments.${name}`, backend, errors);
        }
    }
}

/** The error messages for a `logs` section, each naming the key. Empty when the section is fine. */
export function validateLogsSection(raw: unknown): string[] {
    if (!isObject(raw)) return ["logs must be an object"];
    const errors: string[] = [];
    unknownFields(raw, ["backend", "environments"], "logs", errors);
    const backend = backendFor(raw.backend, errors);
    if (raw.backend === undefined) errors.push("logs.backend is needed: where the search backend is");
    else checkBackend(raw.backend, backend, errors);
    if (raw.environments === undefined) errors.push("logs.environments is needed: at least one environment to search");
    else checkEnvironments(raw.environments, backend, errors);
    return errors;
}

function authFrom(raw: Record<string, unknown>): Auth {
    if (raw.apiKey !== undefined) return { kind: "apiKey", apiKey: raw.apiKey as string };
    if (raw.token !== undefined) return { kind: "bearer", token: raw.token as string };
    if (raw.signIn !== undefined) return { kind: "signIn", service: raw.signIn as string };
    return { kind: "basic", username: raw.username as string, password: raw.password as string };
}

function backendFrom(raw: Record<string, unknown>): Backend {
    // The request's path is added to the address, so it is kept as the parser reads it, without a trailing slash.
    const parsed = new URL(raw.url as string);
    const url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
    const tenant = raw.tenant === undefined ? {} : { tenant: raw.tenant as string };
    if (raw.transport !== undefined) return { kind: "transport", url, transport: raw.transport as string, ...tenant };
    return { kind: "direct", url, auth: authFrom(raw.auth as Record<string, unknown>), ...tenant };
}

/** The settings with every default filled in, or undefined when the section is absent or not valid. Pure, so tests can
 *  feed it any section. */
export function settingsFrom(raw: unknown): LogsSettings | undefined {
    if (!isObject(raw) || validateLogsSection(raw).length > 0) return undefined;
    const backend = backendFor(raw.backend, []) as LogBackend;
    const environments = new Map<string, Target>();
    for (const [name, environment] of Object.entries(raw.environments as Record<string, Record<string, unknown>>)) {
        environments.set(name, backend.environment(name, environment));
    }
    return { type: backend.type, backend: backendFrom(raw.backend as Record<string, unknown>), environments };
}

/** The settings as jig-core loaded them at the last session start. Read per call, never kept. */
export function logsSettings(): LogsSettings | undefined {
    return settingsFrom(jig().config.section("logs"));
}

const NOT_CONFIGURED =
    'logs is not configured: add a "logs" section with "backend" and "environments" to jig.json, ' +
    "or fix the errors /jig shows for it";

/** The settings, or a refusal that says the tool is not configured. */
export function requireSettings(): LogsSettings {
    const settings = logsSettings();
    if (settings === undefined) return refuse(NOT_CONFIGURED);
    return settings;
}

/**
 * The environment a call names. An environment nobody configured is invalid input, and the message lists the ones
 * that exist so that the call can be corrected at once.
 */
export function targetFor(settings: LogsSettings, name: unknown): Target {
    const known = [...settings.environments.keys()].join(", ");
    if (typeof name !== "string" || name === "") return refuse(`logs needs environment: one of ${known}`);
    const target = settings.environments.get(name);
    if (target === undefined) return refuse(`logs: unknown environment ${shown(name)}; use one of ${known}`);
    return target;
}
