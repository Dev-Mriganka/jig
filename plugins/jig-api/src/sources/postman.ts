// Postman: a collection exported as JSON (collection format v2.1, which v2.0 matches closely enough for what is read here)
// and, optionally, environments exported as JSON.
//
// What is read: folders and requests, the address (a string, or an object with `raw`), headers, the body (raw, URL-encoded
// form, multipart form, a file, GraphQL), `auth` of the types that need no browser (bearer, basic, apikey, oauth2 with a
// client-credentials or password grant), variables, and the `event` scripts, only to know whether they exist.
// What is never done: a script is not run. A request that a pre-request script applies to (its own, its folder's or the
// collection's) is refused by name, and a test script is ignored with a note.
import path from "node:path";
import { isObject } from "../engine/values.ts";
import { declaredSecrets } from "../model.ts";
import type { Auth, Collection, Environment, Problem, SavedRequest, Variable } from "../model.ts";
import { expandHome, readText, whyNotRead } from "./files.ts";
import type { Source } from "./source.ts";
import { authOf } from "./postman-auth.ts";
import { behaviourOf, scriptOf, walk } from "./postman-request.ts";
import { text, variablesOf } from "./postman-values.ts";
import type { Reading } from "./postman-values.ts";

export interface PostmanConfig {
    file: string;
    environments: ReadonlyArray<readonly [name: string, file: string]>;
}

const COLLECTION_MAX_BYTES = 32 * 1024 * 1024;
const ENVIRONMENT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENVIRONMENTS = 20;

const NAME = /^[^\u0000-\u001f\u007f]{1,60}$/;

function absolutePath(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value !== "string" || value.trim() === "" || value.length > 1000 || value.includes("\0")) {
        errors.push(`${key}: must be a path`);
        return undefined;
    }
    const file = expandHome(value.trim());
    if (!path.isAbsolute(file)) {
        errors.push(`${key}: must be an absolute path or start with ~/`);
        return undefined;
    }
    return path.normalize(file);
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): PostmanConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry))
        if (key !== "postman" && key !== "environments") errors.push(`${at}.${key}: unknown field`);

    const file = absolutePath(entry.postman, `${at}.postman`, errors);

    const environments: Array<readonly [string, string]> = [];
    const raw = entry.environments;
    if (raw !== undefined) {
        if (!isObject(raw)) {
            errors.push(
                `${at}.environments: must be an object that maps an environment name to the path of its exported file`,
            );
        } else if (Object.keys(raw).length > MAX_ENVIRONMENTS) {
            errors.push(`${at}.environments: at most ${MAX_ENVIRONMENTS} environments`);
        } else {
            for (const [name, value] of Object.entries(raw)) {
                if (!NAME.test(name)) {
                    errors.push(
                        `${at}.environments: an environment name is text of 1 to 60 characters with no control characters`,
                    );
                    continue;
                }
                const environment = absolutePath(value, `${at}.environments.${name}`, errors);
                if (environment !== undefined) environments.push([name, environment]);
            }
        }
    }
    if (errors.length > before || file === undefined) return undefined;
    return { file, environments };
}

function readJson(file: string, maxBytes: number, problems: Problem[]): unknown {
    const shown = path.basename(file);
    let content: string;
    try {
        content = readText(file, maxBytes);
    } catch (error) {
        problems.push({ file: shown, key: "", message: whyNotRead(error), level: "error" });
        return undefined;
    }
    try {
        return JSON.parse(content) as unknown;
    } catch {
        problems.push({ file: shown, key: "", message: "is not valid JSON", level: "error" });
        return undefined;
    }
}

/** An environment export: `values` of `{ key, value, type, enabled }`. */
function readEnvironment(name: string, file: string, problems: Problem[]): Environment | undefined {
    const shown = path.basename(file);
    const raw = readJson(file, ENVIRONMENT_MAX_BYTES, problems);
    return raw === undefined ? undefined : environmentFrom(name, shown, raw, problems);
}

/** The environment in an export that is already read, such as one kept by the Postman cloud source. */
export function environmentFrom(
    name: string,
    shown: string,
    raw: unknown,
    problems: Problem[],
): Environment | undefined {
    if (!isObject(raw) || !Array.isArray(raw.values)) {
        problems.push({
            file: shown,
            key: "values",
            message: "is missing: this is not an exported environment",
            level: "error",
        });
        return undefined;
    }
    const variables = new Map<string, Variable>();
    raw.values.forEach((item: unknown, index) => {
        const key = `values[${index}]`;
        if (!isObject(item) || typeof item.key !== "string" || item.key.trim() === "") {
            problems.push({ file: shown, key, message: "has no key", level: "warning" });
            return;
        }
        if (item.enabled === false) return;
        const value = text(item.value) ?? "";
        if (item.type === "secret") {
            // A secret is never read from a file: an export may hold its value in plain text, and that value is not used.
            if (value !== "") {
                problems.push({
                    file: shown,
                    key: item.key,
                    message:
                        `is a secret with a value in the file. The value is ignored and never sent; ` +
                        `give the secret in api.secrets as "${item.key}"`,
                    level: "warning",
                });
            }
            variables.set(item.key, { value: "", secret: true });
        } else {
            variables.set(item.key, { value, secret: false });
        }
    });
    return { name, file: shown, variables };
}

/** What a Postman collection is read from: the exported JSON as parsed, and the environments exported beside it. */
export interface PostmanContent {
    /** Undefined when it could not be read; the reason is already in `problems`. */
    collection: unknown;
    /** By the name the configuration gives them; an environment that could not be read is not here. */
    environments: ReadonlyMap<string, Environment>;
}

/** Reads a collection that is already parsed. `shown` names it in messages and `root` is the folder files must stay inside. */
export function collectionFrom(
    name: string,
    shown: string,
    root: string,
    content: PostmanContent,
    problems: Problem[],
): Collection {
    const environments = new Map(content.environments);
    const secretNames = declaredSecrets(environments.values());
    const reading: Reading = { collection: name, shown, problems, secretNames };
    const raw = content.collection;
    const requests: SavedRequest[] = [];
    const variables = new Map<string, Variable>();
    let auth: Auth = { kind: "none" };
    let authRefused: string | undefined;

    if (raw !== undefined) {
        if (!isObject(raw) || !Array.isArray(raw.item)) {
            problems.push({
                file: shown,
                key: "item",
                message: "is missing: this is not an exported collection",
                level: "error",
            });
        } else {
            const schema = isObject(raw.info) && typeof raw.info.schema === "string" ? raw.info.schema : "";
            if (schema !== "" && !/\/v2\.[01](?:\.0)?\//.test(schema)) {
                problems.push({
                    file: shown,
                    key: "info.schema",
                    message: `is ${schema}: only collection format v2.0 and v2.1 are read`,
                    level: "warning",
                });
            }
            for (const [key, value] of variablesOf(raw.variable)) variables.set(key, { value, secret: false });
            const top = authOf(raw.auth, reading, "auth");
            if (top?.auth !== undefined) auth = top.auth;
            authRefused = top?.unsupported;
            walk(
                raw.item,
                {
                    folder: [],
                    auth: top,
                    prerequest: scriptOf(raw.event, "prerequest") ? "the collection" : undefined,
                    behaviour: behaviourOf(raw.protocolProfileBehavior),
                    defaults: new Map(),
                },
                reading,
                "item",
                requests,
            );
        }
    }
    return {
        name,
        root,
        requests,
        environments,
        variables,
        auth,
        ...(authRefused === undefined ? {} : { authRefused }),
        problems,
    };
}

export function load(config: PostmanConfig, name: string): Collection {
    const problems: Problem[] = [];
    const environments = new Map<string, Environment>();
    for (const [environment, file] of config.environments) {
        const read = readEnvironment(environment, file, problems);
        if (read !== undefined) environments.set(environment, read);
    }
    const collection = readJson(config.file, COLLECTION_MAX_BYTES, problems);
    return collectionFrom(
        name,
        path.basename(config.file),
        path.dirname(config.file),
        { collection, environments },
        problems,
    );
}

export const postman: Source<PostmanConfig> = { kind: "postman", check, load };
