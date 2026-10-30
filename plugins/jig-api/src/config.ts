// The `api` section of jig.json: where the saved requests live, which of their environments are which of jig-core's, which
// variables are secrets, and the few switches that go with them. jig-core checks the section with validateApi when a session
// starts, so the rest of the plugin reads settings that are valid. Nothing here touches the disk: the files are read when a
// call needs them (see catalog.ts).
import { isObject, shown } from "./engine/values.ts";
import type { Collection } from "./model.ts";
import { COMING_LATER, SOURCES } from "./sources/index.ts";

/** A collection as configured: what to call it and how to read it. */
export interface ConfiguredCollection {
    name: string;
    /** `postman` or `http`: the key of its source. */
    kind: string;
    load(): Collection;
}

/** What a collection's environment name means to jig-core's rules, and how its requests get to the network. */
export interface EnvironmentMapping {
    /** The environment name that rules and classification know it by. A name jig-core does not know counts as production. */
    environment: string;
    /** A company sign-in service that signs every request in, in place of the request's own sign-in. */
    signIn?: string;
    /** A company transport that carries every request, in place of the network. */
    transport?: string;
}

/** The reference that supplies a secret variable: the same one in every environment, or one per environment. */
export interface SecretSource {
    everywhere?: string;
    /** By the collection's name for the environment. */
    byEnvironment: ReadonlyMap<string, string>;
}

export interface ApiSettings {
    /** By name. A Map, so that a name such as `constructor` is only ever a name. */
    collections: ReadonlyMap<string, ConfiguredCollection>;
    /** By the collection's name for the environment. */
    environments: ReadonlyMap<string, EnvironmentMapping>;
    /** By variable name. */
    secrets: ReadonlyMap<string, SecretSource>;
    /** Names of requests that read although their method does not. */
    reads: ReadonlySet<string>;
    /** jig-core environment names where `call` is allowed. */
    adHoc: ReadonlySet<string>;
    timeoutSec: number;
    allowPlainLocal: boolean;
}

export const DEFAULT_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 120;

const SECTION_FIELDS: ReadonlySet<string> = new Set(["collections", "environments", "secrets", "reads", "adHoc", "timeoutSec", "allowPlainLocal"]);
const MAPPING_FIELDS: ReadonlySet<string> = new Set(["environment", "signIn", "transport"]);

const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** The environment names of the collections: free text, since a team names its environments as it likes. */
const ENVIRONMENT_LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/;
/** The names jig-core's rules know environments by. */
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const VARIABLE_NAME = /^[^\s{}\u0000-\u001f\u007f]{1,100}$/;
/** A secret reference has a scheme and a name (`pass:work/api-token`, `env:API_TOKEN`, `op://vault/item/field`). A token
 *  pasted here instead has neither, and is refused without being repeated. */
const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_COLLECTIONS = 50;
const MAX_LIST = 200;

/** A secret reference, never the secret itself. The value is not repeated: a mistaken reference may be the secret. */
function checkReference(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value === "string" && SECRET_REFERENCE.test(value)) return value;
    errors.push(`${key}: must be a secret reference such as pass:work/api-token, not the secret itself`);
    return undefined;
}

function checkCollection(name: string, raw: unknown, errors: string[]): ConfiguredCollection | undefined {
    const at = `api.collections.${name}`;
    const known = SOURCES.map((source) => source.kind);
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with one source, such as { "postman": "<path>" } or { "http": "<folder>" }`);
        return undefined;
    }
    const kinds = Object.keys(raw).filter((key) => known.includes(key) || COMING_LATER.has(key));
    if (kinds.length === 0) {
        errors.push(`${at}: needs a source: one of ${known.join(", ")}`);
        for (const key of Object.keys(raw)) errors.push(`${at}.${key}: unknown field`);
        return undefined;
    }
    if (kinds.length > 1) {
        errors.push(`${at}: use exactly one source (got ${kinds.join(", ")})`);
        return undefined;
    }
    const kind = kinds[0] as string;
    const later = COMING_LATER.get(kind);
    if (later !== undefined) {
        errors.push(`${at}.${kind}: ${later} collections are coming in part 2 of jig-api; for now use ${known.join(" or ")}`);
        return undefined;
    }
    const source = SOURCES.find((candidate) => candidate.kind === kind);
    if (source === undefined) return undefined;
    const config = source.check(raw, at, errors);
    return config === undefined ? undefined : { name, kind, load: () => source.load(config, name) };
}

function checkCollections(raw: unknown, errors: string[]): Map<string, ConfiguredCollection> | undefined {
    if (raw === undefined) {
        errors.push('api.collections: required, an object that maps a name to a source, such as { "orders": { "http": "~/work/orders/http" } }');
        return undefined;
    }
    if (!isObject(raw)) {
        errors.push("api.collections: must be an object that maps a name to a source");
        return undefined;
    }
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > MAX_COLLECTIONS) {
        errors.push(`api.collections: must name 1 to ${MAX_COLLECTIONS} collections`);
        return undefined;
    }
    const collections = new Map<string, ConfiguredCollection>();
    for (const [name, value] of entries) {
        if (!COLLECTION_NAME.test(name)) {
            errors.push(
                `api.collections: ${shown(name, 30)} is not a usable name ` +
                    "(1 to 40 letters, digits, . _ -, starting with a letter or digit)",
            );
            continue;
        }
        const collection = checkCollection(name, value, errors);
        if (collection !== undefined) collections.set(name, collection);
    }
    return collections;
}

function checkMapping(label: string, raw: unknown, errors: string[]): EnvironmentMapping | undefined {
    const at = `api.environments.${label}`;
    const before = errors.length;
    const bad = `${at}: must be a jig-core environment name such as staging, or an object with "environment" (and "signIn" or "transport")`;
    if (typeof raw === "string") {
        if (ENVIRONMENT_NAME.test(raw)) return { environment: raw };
        errors.push(bad);
        return undefined;
    }
    if (!isObject(raw)) {
        errors.push(bad);
        return undefined;
    }
    for (const key of Object.keys(raw)) if (!MAPPING_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);
    const environment = typeof raw.environment === "string" && ENVIRONMENT_NAME.test(raw.environment) ? raw.environment : undefined;
    if (environment === undefined) errors.push(`${at}.environment: required, a jig-core environment name such as staging`);
    const named = (key: "signIn" | "transport", what: string): string | undefined => {
        const value = raw[key];
        if (value === undefined) return undefined;
        if (typeof value === "string" && value.trim() !== "" && value.length <= 64 && !CONTROL_CHARACTER.test(value)) return value;
        errors.push(`${at}.${key}: must be the name of a ${what}`);
        return undefined;
    };
    const signIn = named("signIn", "sign-in service");
    const transport = named("transport", "transport");
    if (signIn !== undefined && transport !== undefined) errors.push(`${at}: use signIn or transport, not both`);
    if (errors.length > before || environment === undefined) return undefined;
    return { environment, ...(signIn === undefined ? {} : { signIn }), ...(transport === undefined ? {} : { transport }) };
}

function checkEnvironments(raw: unknown, errors: string[]): Map<string, EnvironmentMapping> {
    const mappings = new Map<string, EnvironmentMapping>();
    if (raw === undefined) return mappings;
    if (!isObject(raw)) {
        errors.push("api.environments: must be an object that maps your collections' environment names to jig-core's, such as { \"Staging\": \"staging\" }");
        return mappings;
    }
    if (Object.keys(raw).length > MAX_LIST) {
        errors.push(`api.environments: at most ${MAX_LIST} environments`);
        return mappings;
    }
    for (const [label, value] of Object.entries(raw)) {
        if (!ENVIRONMENT_LABEL.test(label)) {
            errors.push("api.environments: an environment name is text of 1 to 60 characters with no control characters");
            continue;
        }
        const mapping = checkMapping(label, value, errors);
        if (mapping !== undefined) mappings.set(label, mapping);
    }
    return mappings;
}

function checkSecrets(raw: unknown, errors: string[]): Map<string, SecretSource> {
    const secrets = new Map<string, SecretSource>();
    if (raw === undefined) return secrets;
    if (!isObject(raw)) {
        errors.push("api.secrets: must be an object that maps a variable name to a secret reference, such as { \"token\": \"pass:orders/token\" }");
        return secrets;
    }
    if (Object.keys(raw).length > MAX_LIST) {
        errors.push(`api.secrets: at most ${MAX_LIST} secrets`);
        return secrets;
    }
    for (const [name, value] of Object.entries(raw)) {
        if (!VARIABLE_NAME.test(name)) {
            errors.push(`api.secrets: ${shown(name, 30)} is not a usable variable name`);
            continue;
        }
        const at = `api.secrets.${name}`;
        if (typeof value === "string") {
            const reference = checkReference(value, at, errors);
            if (reference !== undefined) secrets.set(name, { everywhere: reference, byEnvironment: new Map() });
        } else if (isObject(value) && Object.keys(value).length > 0) {
            const byEnvironment = new Map<string, string>();
            for (const [label, item] of Object.entries(value)) {
                if (!ENVIRONMENT_LABEL.test(label)) {
                    errors.push(`${at}: an environment name is text of 1 to 60 characters with no control characters`);
                    continue;
                }
                const reference = checkReference(item, `${at}.${label}`, errors);
                if (reference !== undefined) byEnvironment.set(label, reference);
            }
            if (byEnvironment.size > 0) secrets.set(name, { byEnvironment });
        } else {
            errors.push(`${at}: must be a secret reference such as pass:work/api-token, or an object of one reference per environment`);
        }
    }
    return secrets;
}

function checkNames(raw: unknown, key: string, pattern: RegExp, what: string, errors: string[]): Set<string> {
    const names = new Set<string>();
    if (raw === undefined) return names;
    if (!Array.isArray(raw) || raw.length > MAX_LIST) {
        errors.push(`${key}: must be a list of at most ${MAX_LIST} ${what}`);
        return names;
    }
    for (const item of raw as unknown[]) {
        if (typeof item === "string" && pattern.test(item)) names.add(item);
        else errors.push(`${key}: ${shown(item, 30)} is not ${what.replace(/s$/, "")}`);
    }
    return names;
}

/**
 * Checks a raw `api` section and reads it. `errors` name their key; with any error there are no settings. A misspelt field is
 * an error and not a silent default: `adhoc` would otherwise leave ad-hoc calls switched off without a word.
 */
export function readApi(raw: unknown): { settings?: ApiSettings; errors: string[] } {
    if (!isObject(raw)) return { errors: ["api: must be an object"] };
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (!SECTION_FIELDS.has(key)) errors.push(`api.${key}: unknown field`);

    const collections = checkCollections(raw.collections, errors);
    const environments = checkEnvironments(raw.environments, errors);
    const secrets = checkSecrets(raw.secrets, errors);
    const reads = checkNames(raw.reads, "api.reads", /^[^\u0000-\u001f\u007f]{1,200}$/, "request names", errors);
    const adHoc = checkNames(raw.adHoc, "api.adHoc", ENVIRONMENT_NAME, "environment names", errors);
    const mapped = new Set([...environments.values()].map((mapping) => mapping.environment));
    for (const name of adHoc) {
        if (!mapped.has(name)) errors.push(`api.adHoc: ${shown(name, 30)} is not an environment that api.environments maps to`);
    }

    let timeoutSec = DEFAULT_TIMEOUT_SEC;
    if (raw.timeoutSec !== undefined) {
        if (typeof raw.timeoutSec === "number" && Number.isSafeInteger(raw.timeoutSec) && raw.timeoutSec >= 1 && raw.timeoutSec <= MAX_TIMEOUT_SEC) {
            timeoutSec = raw.timeoutSec;
        } else {
            errors.push(`api.timeoutSec: must be a whole number from 1 to ${MAX_TIMEOUT_SEC}`);
        }
    }
    let allowPlainLocal = false;
    if (typeof raw.allowPlainLocal === "boolean") allowPlainLocal = raw.allowPlainLocal;
    else if (raw.allowPlainLocal !== undefined) errors.push("api.allowPlainLocal: must be true or false");

    if (errors.length > 0 || collections === undefined) return { errors };
    return { errors, settings: { collections, environments, secrets, reads, adHoc, timeoutSec, allowPlainLocal } };
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateApi(raw: unknown): string[] {
    return readApi(raw).errors;
}

const parsed = new WeakMap<object, ApiSettings | undefined>();

/** The settings in a raw section, or undefined when it is absent or invalid. Read again only when the object changes. */
export function settingsOf(raw: unknown): ApiSettings | undefined {
    if (!isObject(raw)) return undefined;
    if (!parsed.has(raw)) parsed.set(raw, readApi(raw).settings);
    return parsed.get(raw);
}

/** The jig-core environment a collection's environment name stands for. A name nobody mapped is production, so a typo or a
 *  forgotten mapping makes the rules stricter, never looser. */
export function jigEnvironmentOf(settings: ApiSettings, label: string): string {
    return settings.environments.get(label)?.environment ?? "production";
}
