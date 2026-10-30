// The `http` section of jig.json: the named targets a call can reach, and how each one signs in. jig-core checks the
// section with validateHttp when a session starts, so the rest of the plugin reads settings that are valid.
import { isObject, shown } from "./engine/values.ts";

/** What the `oauthPassword` sign-in needs: the OAuth 2.0 password grant (RFC 6749, section 4.3). */
export interface OAuthPassword {
    tokenUrl: string;
    clientId: string;
    /** A secret reference. Left out for a public client, which sends only its id. */
    clientSecret?: string;
    /** Secret references to the account's name and password. */
    username: string;
    password: string;
    scope?: string;
}

/** How requests to a target are signed in. Exactly one of five, as the target's `auth` object says. */
export type Auth =
    /** Nothing is added: the API is open, or the network is its only protection. */
    | { kind: "none" }
    /** A token (a secret reference), sent as `Authorization: Bearer`. */
    | { kind: "bearer"; token: string }
    /** The tool fetches an access token with the password grant, keeps it until shortly before it expires, and sends it
     *  as a Bearer token. */
    | { kind: "oauthPassword"; oauth: OAuthPassword }
    /** A company sign-in service that jig-core knows by name and that supplies the headers of each request. */
    | { kind: "signIn"; name: string }
    /** A company transport that carries the whole request. The tool holds no credential and adds no header. */
    | { kind: "transport"; name: string };

export interface Target {
    name: string;
    /** https, no trailing slash. It may have a path, for an API served below one. */
    baseUrl: string;
    /** The environment name that jig-core's rules know this API by. A name jig-core does not know counts as production. */
    environment: string;
    auth: Auth;
    description?: string;
    /** True when plain http to this machine is allowed: for a service run beside Pi, and for tests. */
    allowPlainLocal: boolean;
}

export interface HttpSettings {
    /** By name. A Map, so that a name such as `constructor` is only ever a name. */
    targets: ReadonlyMap<string, Target>;
}

const SECTION_FIELDS: ReadonlySet<string> = new Set(["targets"]);
const TARGET_FIELDS: ReadonlySet<string> = new Set(["baseUrl", "environment", "auth", "description", "allowPlainLocal"]);
const AUTH_KINDS = ["none", "bearer", "oauthPassword", "signIn", "transport"] as const;
type AuthKind = (typeof AUTH_KINDS)[number];
const OAUTH_FIELDS: ReadonlySet<string> = new Set(["tokenUrl", "clientId", "clientSecret", "username", "password", "scope"]);

const AUTH_CHOICES =
    '{ "none": true }, { "bearer": "<secret reference>" }, { "oauthPassword": { ... } }, { "signIn": "<service>" } ' +
    'or { "transport": "<name>" }';

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** A secret reference has a scheme and a name (`pass:work/api-token`, `env:API_TOKEN`, `op://vault/item/field`). A token
 *  pasted here instead has neither, and is refused without being repeated. */
const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_TARGETS = 100;

/** Plain http is for a service on this machine only. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * Why an address may not be called, or undefined when it may. Everything is https. The one exception is `http://127.0.0.1`
 * or `http://localhost` when the target says `allowPlainLocal`: anywhere else, a credential or a body would cross the
 * network in the clear. The request function asks this again for every request, whatever the settings say.
 */
export function addressProblem(address: unknown, allowPlainLocal: boolean): string | undefined {
    const notHttps =
        'must be an https address (plain http is only for 127.0.0.1 and localhost, ' +
        'with "allowPlainLocal": true on the target)';
    if (typeof address !== "string") return notHttps;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return notHttps;
    }
    if (url.hostname === "") return notHttps;
    if (url.username !== "" || url.password !== "") return "must not contain a user name or password";
    if (url.protocol === "https:") return undefined;
    if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) {
        return allowPlainLocal ? undefined : 'plain http to this machine needs "allowPlainLocal": true on the target';
    }
    return notHttps;
}

function checkBaseUrl(value: unknown, allowPlainLocal: boolean, at: string, errors: string[]): string | undefined {
    if (value === undefined) {
        errors.push(`${at}.baseUrl: required, the https address of the API, such as https://api.example.test/v1`);
        return undefined;
    }
    const problem = addressProblem(value, allowPlainLocal);
    if (problem !== undefined) {
        errors.push(`${at}.baseUrl: ${problem}`);
        return undefined;
    }
    const url = new URL(String(value));
    if (url.search !== "" || url.hash !== "") {
        errors.push(`${at}.baseUrl: must not contain a query or a fragment`);
        return undefined;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A name or an id: text without control characters. */
function checkText(value: unknown, key: string, max: number, errors: string[]): string | undefined {
    const usable =
        typeof value === "string" && value.trim() !== "" && value.length <= max && !CONTROL_CHARACTER.test(value);
    if (usable) return value;
    errors.push(`${key}: must be text of 1 to ${max} characters, with no control characters`);
    return undefined;
}

/** A secret reference, never the secret itself. The value is not repeated: a mistaken reference may be the secret. */
function checkReference(value: unknown, key: string, errors: string[]): string | undefined {
    if (value === undefined) {
        errors.push(`${key}: required, a secret reference such as pass:work/api-token`);
        return undefined;
    }
    if (typeof value === "string" && SECRET_REFERENCE.test(value)) return value;
    errors.push(`${key}: must be a secret reference such as pass:work/api-token, not the secret itself`);
    return undefined;
}

function checkOAuth(raw: unknown, at: string, allowPlainLocal: boolean, errors: string[]): OAuthPassword | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with tokenUrl, clientId, username and password (and clientSecret, scope)`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!OAUTH_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    let tokenUrl: string | undefined;
    if (raw.tokenUrl === undefined) {
        errors.push(`${at}.tokenUrl: required, the address of the OAuth token endpoint`);
    } else {
        const problem = addressProblem(raw.tokenUrl, allowPlainLocal);
        if (problem !== undefined) errors.push(`${at}.tokenUrl: ${problem}`);
        else if (new URL(String(raw.tokenUrl)).hash !== "") errors.push(`${at}.tokenUrl: must not contain a fragment`);
        else tokenUrl = String(raw.tokenUrl);
    }
    let clientId: string | undefined;
    if (raw.clientId === undefined) errors.push(`${at}.clientId: required, the OAuth client id`);
    else clientId = checkText(raw.clientId, `${at}.clientId`, 200, errors);
    const clientSecret = raw.clientSecret === undefined
        ? undefined
        : checkReference(raw.clientSecret, `${at}.clientSecret`, errors);
    const username = checkReference(raw.username, `${at}.username`, errors);
    const password = checkReference(raw.password, `${at}.password`, errors);
    const scope = raw.scope === undefined ? undefined : checkText(raw.scope, `${at}.scope`, 500, errors);

    if (errors.length > before || tokenUrl === undefined || clientId === undefined) return undefined;
    if (username === undefined || password === undefined) return undefined;
    return {
        tokenUrl,
        clientId,
        username,
        password,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(scope === undefined ? {} : { scope }),
    };
}

function checkAuth(raw: unknown, at: string, allowPlainLocal: boolean, errors: string[]): Auth | undefined {
    if (raw === undefined || (isObject(raw) && Object.keys(raw).length === 0)) {
        errors.push(`${at}: required, exactly one of ${AUTH_CHOICES}`);
        return undefined;
    }
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object`);
        return undefined;
    }
    const before = errors.length;
    const isKind = (key: string): key is AuthKind => (AUTH_KINDS as readonly string[]).includes(key);
    const given = Object.keys(raw);
    for (const key of given) if (!isKind(key)) errors.push(`${at}.${key}: unknown field`);
    const kinds = given.filter(isKind);
    if (kinds.length > 1) errors.push(`${at}: use exactly one of ${AUTH_KINDS.join(", ")} (got ${kinds.join(", ")})`);
    const kind = kinds[0];
    if (errors.length > before || kind === undefined) return undefined;

    const value = raw[kind];
    switch (kind) {
        case "none":
            if (value === true) return { kind };
            errors.push(`${at}.none: must be true`);
            return undefined;
        case "bearer": {
            const token = checkReference(value, `${at}.bearer`, errors);
            return token === undefined ? undefined : { kind, token };
        }
        case "oauthPassword": {
            const oauth = checkOAuth(value, `${at}.oauthPassword`, allowPlainLocal, errors);
            return oauth === undefined ? undefined : { kind, oauth };
        }
        case "signIn":
        case "transport": {
            const what = kind === "signIn" ? "sign-in service" : "transport";
            if (typeof value === "string" && value.trim() !== "" && value.length <= 64 && !CONTROL_CHARACTER.test(value)) {
                return { kind, name: value };
            }
            errors.push(`${at}.${kind}: must be the name of a ${what}`);
            return undefined;
        }
    }
}

function checkTarget(name: string, raw: unknown, errors: string[]): Target | undefined {
    const at = `http.targets.${name}`;
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with baseUrl, environment and auth`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!TARGET_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    let allowPlainLocal = false;
    if (typeof raw.allowPlainLocal === "boolean") allowPlainLocal = raw.allowPlainLocal;
    else if (raw.allowPlainLocal !== undefined) errors.push(`${at}.allowPlainLocal: must be true or false`);

    const baseUrl = checkBaseUrl(raw.baseUrl, allowPlainLocal, at, errors);

    let environment: string | undefined;
    if (raw.environment === undefined) {
        errors.push(
            `${at}.environment: required, the environment name that jig-core's rules know this API by, such as staging`,
        );
    } else if (typeof raw.environment === "string" && ENVIRONMENT_NAME.test(raw.environment)) {
        environment = raw.environment;
    } else {
        errors.push(`${at}.environment: must be an environment name, such as staging`);
    }

    const auth = checkAuth(raw.auth, `${at}.auth`, allowPlainLocal, errors);
    const description = raw.description === undefined
        ? undefined
        : checkText(raw.description, `${at}.description`, 200, errors);

    if (errors.length > before || baseUrl === undefined || environment === undefined || auth === undefined) return undefined;
    return { name, baseUrl, environment, auth, allowPlainLocal, ...(description === undefined ? {} : { description }) };
}

function checkTargets(raw: unknown, errors: string[]): Map<string, Target> | undefined {
    if (raw === undefined) {
        errors.push('http.targets: required, an object that maps a name to { "baseUrl", "environment", "auth" }');
        return undefined;
    }
    if (!isObject(raw)) {
        errors.push("http.targets: must be an object that maps a name to a target");
        return undefined;
    }
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > MAX_TARGETS) {
        errors.push(`http.targets: must name 1 to ${MAX_TARGETS} targets`);
        return undefined;
    }
    const targets = new Map<string, Target>();
    for (const [name, value] of entries) {
        if (!TARGET_NAME.test(name)) {
            errors.push(
                `http.targets: ${shown(name, 30)} is not a usable name ` +
                    "(1 to 40 letters, digits, . _ -, starting with a letter or digit)",
            );
            continue;
        }
        const target = checkTarget(name, value, errors);
        if (target !== undefined) targets.set(name, target);
    }
    return targets;
}

/**
 * Checks a raw `http` section and reads it. `errors` name their key; with any error there are no settings. A misspelt
 * field is an error and not a silent default: `enviroment` would otherwise leave a target without its environment.
 */
export function readHttp(raw: unknown): { settings?: HttpSettings; errors: string[] } {
    if (!isObject(raw)) return { errors: ["http: must be an object"] };
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (!SECTION_FIELDS.has(key)) errors.push(`http.${key}: unknown field`);
    const targets = checkTargets(raw.targets, errors);
    if (errors.length > 0 || targets === undefined) return { errors };
    return { errors, settings: { targets } };
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateHttp(raw: unknown): string[] {
    return readHttp(raw).errors;
}

const parsed = new WeakMap<object, HttpSettings | undefined>();

/** The settings in a raw section, or undefined when it is absent or invalid. Read again only when the object changes. */
export function settingsOf(raw: unknown): HttpSettings | undefined {
    if (!isObject(raw)) return undefined;
    if (!parsed.has(raw)) parsed.set(raw, readHttp(raw).settings);
    return parsed.get(raw);
}
