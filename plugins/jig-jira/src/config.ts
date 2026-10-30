// The `jira` section of jig.json: where the Jira is, how to sign in, and which fields `update` may set. jig-core checks
// the section with validateJira when a session starts, so the rest of the plugin reads settings that are valid.
import { builtInField, isFieldId, isFieldReference } from "./fields.ts";

/** How requests are signed in. Exactly one of four, as the section's `auth` object says. */
export type Auth =
    /** Jira Cloud: the account's email and an API token (a secret reference), sent as Basic authentication. */
    | { kind: "basic"; email: string; token: string }
    /** A personal access token (a secret reference), sent as a Bearer token, as Jira Data Center takes it. */
    | { kind: "bearer"; token: string }
    /** A company sign-in service that jig-core knows by name and that supplies the headers of each request. */
    | { kind: "signIn"; name: string }
    /** A company transport that carries each request through a local sign-in proxy. The proxy holds the session, so the
     *  tool holds no token and adds no header. */
    | { kind: "transport"; name: string };

export interface JiraSettings {
    /** The base address: https, no trailing slash. It may have a path, for a Jira served below one. */
    site: string;
    auth: Auth;
    /** The fields `update` may set, by name or id. */
    updateFields: readonly string[];
    /** Friendly names for field ids, such as `Story Points` for `customfield_10016`. */
    fields: Readonly<Record<string, string>>;
    /** Folder or host names that must not appear in text sent to Jira. They are flagged in the preview. */
    privateNames: readonly string[];
    /** The environment name that jig-core's rules know this Jira by. */
    environment: string;
}

export const DEFAULT_UPDATE_FIELDS: readonly string[] = ["summary", "description", "labels", "priority", "assignee"];
export const DEFAULT_ENVIRONMENT = "external";

const SECTION_FIELDS: ReadonlySet<string> = new Set([
    "site",
    "auth",
    "updateFields",
    "fields",
    "privateNames",
    "environment",
]);
const AUTH_FIELDS: ReadonlySet<string> = new Set(["email", "token", "signIn", "transport"]);

/** A secret reference has a scheme and a name (`pass:work/jira-token`, `env:JIRA_TOKEN`, `op://vault/item/field`). A
 *  token pasted here instead has neither, and is refused without being repeated. */
const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S+$/;
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_LIST = 100;

/** The address as a URL when it is an https one, else undefined. Plain http is refused everywhere: a token must not
 *  cross the network in the clear. */
export function httpsOnly(address: unknown): URL | undefined {
    if (typeof address !== "string") return undefined;
    try {
        const url = new URL(address);
        return url.protocol === "https:" && url.hostname !== "" ? url : undefined;
    } catch {
        return undefined;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkSite(value: unknown, errors: string[]): string | undefined {
    if (value === undefined) {
        errors.push("jira.site: required, the https address of your Jira, such as https://example.atlassian.net");
        return undefined;
    }
    const url = httpsOnly(value);
    if (url === undefined) {
        errors.push(
            "jira.site: must be an https address (http is refused, so a token never crosses the network in the clear)",
        );
    } else if (url.username !== "" || url.password !== "") {
        errors.push("jira.site: must not contain a user name or password");
    } else if (url.search !== "" || url.hash !== "") {
        errors.push("jira.site: must not contain a query or a fragment");
    } else {
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
    return undefined;
}

const AUTH_CHOICES =
    'one of { "email", "token" } for Jira Cloud, { "token" } for Data Center, { "signIn" } or { "transport" }';

function checkAuth(value: unknown, errors: string[]): Auth | undefined {
    if (value === undefined || (isObject(value) && Object.keys(value).length === 0)) {
        errors.push(`jira.auth: required, ${AUTH_CHOICES}`);
        return undefined;
    }
    if (!isObject(value)) {
        errors.push("jira.auth: must be an object");
        return undefined;
    }
    const before = errors.length;
    for (const name of Object.keys(value)) if (!AUTH_FIELDS.has(name)) errors.push(`jira.auth.${name}: unknown field`);
    const { email, token, signIn, transport } = value;

    // A sign-in service and a transport each stand alone: they hold the session, so there is no token or email to give.
    if (signIn !== undefined || transport !== undefined) {
        if (email !== undefined || token !== undefined || (signIn !== undefined && transport !== undefined)) {
            errors.push("jira.auth: use exactly one of signIn, transport, or token (with an email for Jira Cloud)");
        }
        for (const [key, name] of [
            ["signIn", signIn],
            ["transport", transport],
        ] as const) {
            if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 64)) {
                errors.push(
                    `jira.auth.${key}: must be the name of a ${key === "signIn" ? "sign-in service" : "transport"}`,
                );
            }
        }
        if (errors.length > before) return undefined;
        return signIn !== undefined
            ? { kind: "signIn", name: String(signIn) }
            : { kind: "transport", name: String(transport) };
    }
    if (token === undefined) {
        errors.push("jira.auth.token: required, a secret reference such as pass:work/jira-token");
    } else if (typeof token !== "string" || !SECRET_REFERENCE.test(token)) {
        // The value is not repeated: a mistaken reference may be the token itself.
        errors.push("jira.auth.token: must be a secret reference such as pass:work/jira-token, not the token itself");
    }
    if (email !== undefined && (typeof email !== "string" || !/^[^\s:@]+@[^\s:@]+$/.test(email))) {
        errors.push("jira.auth.email: must be an email address");
    }
    if (errors.length > before) return undefined;
    return email === undefined
        ? { kind: "bearer", token: String(token) }
        : { kind: "basic", email: String(email), token: String(token) };
}

function checkList(value: unknown, key: string, errors: string[], maxLength: number): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_LIST) {
        errors.push(`jira.${key}: must be a list of at most ${MAX_LIST} names`);
        return undefined;
    }
    const names: string[] = [];
    value.forEach((item, index) => {
        if (typeof item !== "string" || item.trim() === "" || item.length > maxLength) {
            errors.push(`jira.${key}[${index}]: must be text of 1 to ${maxLength} characters`);
        } else {
            names.push(item.trim());
        }
    });
    return names;
}

function checkFields(value: unknown, errors: string[]): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
        errors.push("jira.fields: must be an object of friendly names and field ids");
        return undefined;
    }
    const fields: Record<string, string> = {};
    const seen = new Set<string>();
    for (const [name, id] of Object.entries(value)) {
        const lower = name.trim().toLowerCase();
        if (name.trim() === "" || name.length > 60 || /[\u0000-\u001f]/.test(name)) {
            errors.push(
                `jira.fields: "${name.slice(0, 30)}" is not a usable name (1 to 60 characters, no control characters)`,
            );
        } else if (builtInField(name) !== undefined) {
            errors.push(`jira.fields.${name}: is a field the tool already knows by that name`);
        } else if (seen.has(lower)) {
            errors.push(`jira.fields.${name}: is the same name as another entry, apart from case`);
        } else if (typeof id !== "string" || !isFieldId(id)) {
            errors.push(`jira.fields.${name}: must be a field id such as customfield_10016`);
        } else {
            seen.add(lower);
            fields[name.trim()] = id;
        }
    }
    return fields;
}

/**
 * Checks a raw `jira` section and reads it. `errors` name their key; with any error there are no settings. A misspelt
 * field is an error and not a silent default: `updateField` would otherwise leave `update` on its default list.
 */
export function readJira(raw: unknown): { settings?: JiraSettings; errors: string[] } {
    if (!isObject(raw)) return { errors: ["jira: must be an object"] };
    const errors: string[] = [];
    for (const name of Object.keys(raw)) if (!SECTION_FIELDS.has(name)) errors.push(`jira.${name}: unknown field`);

    const site = checkSite(raw.site, errors);
    const auth = checkAuth(raw.auth, errors);
    const fields = checkFields(raw.fields, errors) ?? {};
    const updateFields = checkList(raw.updateFields, "updateFields", errors, 60);
    for (const [index, name] of (updateFields ?? []).entries()) {
        if (!isFieldReference(name, fields)) {
            errors.push(
                `jira.updateFields[${index}]: "${name.slice(0, 40)}" is not a field the tool knows, ` +
                    "a name in jira.fields, or a field id",
            );
        }
    }
    const privateNames = checkList(raw.privateNames, "privateNames", errors, 100);
    const environment = raw.environment ?? DEFAULT_ENVIRONMENT;
    if (typeof environment !== "string" || !ENVIRONMENT_NAME.test(environment)) {
        errors.push("jira.environment: must be an environment name, such as external");
    }

    if (errors.length > 0 || site === undefined || auth === undefined) return { errors };
    return {
        errors,
        settings: {
            site,
            auth,
            updateFields: updateFields ?? DEFAULT_UPDATE_FIELDS,
            fields,
            privateNames: privateNames ?? [],
            environment: String(environment),
        },
    };
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateJira(raw: unknown): string[] {
    return readJira(raw).errors;
}

const parsed = new WeakMap<object, JiraSettings | undefined>();

/** The settings in a raw section, or undefined when it is absent or invalid. Read again only when the object changes. */
export function settingsOf(raw: unknown): JiraSettings | undefined {
    if (!isObject(raw)) return undefined;
    if (!parsed.has(raw)) parsed.set(raw, readJira(raw).settings);
    return parsed.get(raw);
}
