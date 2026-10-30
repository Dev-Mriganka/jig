// What `list` and `show` print: the saved requests the agent may run, and one request in full. Both read the collections and
// nothing else. A secret's value is never here, because no value is read: a secret shows as a name and whether a reference
// is set for it.
import type { Catalog } from "./catalog.ts";
import type { ApiSettings } from "./config.ts";
import { READ_METHODS } from "./engine/plan.ts";
import { oneLine } from "./engine/values.ts";
import { CREDENTIAL_HEADERS, pathOf } from "./model.ts";
import type { Auth, Collection, Environment, Problem, SavedRequest } from "./model.ts";
import { secretNamesOf } from "./resolve.ts";

const MAX_LISTED = 60;
const SHOWN_BODY_LINES = 30;

export interface Filter {
    collection: string | undefined;
    folder: string | undefined;
    text: string | undefined;
}

/** Whether the request reads: by its method, or because the configuration says so. */
export function readsOf(settings: ApiSettings, request: SavedRequest): boolean {
    return READ_METHODS.has(request.method) || settings.reads.has(request.name);
}

/** What stops a request from running, in a few words, or undefined. */
export function refusalOf(request: SavedRequest): string | undefined {
    if (request.scripts.prerequest) return `refused: it has a pre-request script (${request.scripts.where ?? "its own"}), and scripts never run`;
    if (request.unsupported !== undefined) return `refused: ${request.unsupported}`;
    return undefined;
}

/** The variables the agent has to give: used, not secret, and not defined by the collection or any of its environments. */
function neededVariables(collection: Collection, request: SavedRequest, secretNames: ReadonlySet<string>): string[] {
    return request.variables.filter((name) => {
        if (name.startsWith("$") || secretNames.has(name) || request.signsIn.includes(name)) return false;
        if (collection.variables.has(name) || request.defaults.has(name)) return false;
        return ![...collection.environments.values()].some((environment) => environment.variables.has(name));
    });
}

function problemLines(problems: readonly Problem[]): string[] {
    if (problems.length === 0) return [];
    const where = (problem: Problem): string => `${problem.file}${problem.key === "" ? "" : ` ${problem.key}`}`;
    return ["Problems:", ...problems.map((problem) => `  ${problem.level}: ${where(problem)}: ${problem.message}`)];
}

export function listText(catalog: Catalog, settings: ApiSettings, filter: Filter): string {
    const lines: string[] = [];
    const wanted = filter.text?.toLowerCase();
    const folder = filter.folder?.replace(/^\/+|\/+$/g, "");
    let listed = 0;
    let more = 0;
    for (const collection of catalog.selected(filter.collection)) {
        const secretNames = secretNamesOf(collection, settings.secrets);
        const matching = collection.requests.filter((request) => {
            const path = request.folder.join("/");
            if (folder !== undefined && path !== folder && !path.startsWith(`${folder}/`)) return false;
            return wanted === undefined || `${pathOf(request)} ${request.url}`.toLowerCase().includes(wanted);
        });
        const kind = settings.collections.get(collection.name)?.kind ?? "";
        const environments = [...collection.environments.keys()];
        const count = `${collection.requests.length} request${collection.requests.length === 1 ? "" : "s"}`;
        const named = environments.length === 0 ? "none" : environments.join(", ");
        lines.push(`${collection.name} (${kind}, ${count}; environments: ${named})`);
        for (const request of matching) {
            if (listed >= MAX_LISTED) {
                more++;
                continue;
            }
            listed++;
            const needs = neededVariables(collection, request, secretNames);
            const flags = [
                readsOf(settings, request) ? "reads" : "writes",
                ...(needs.length > 0 ? [`needs ${needs.join(", ")}`] : []),
                ...(refusalOf(request) === undefined ? [] : [refusalOf(request) as string]),
            ];
            lines.push(`  ${pathOf(request)}  ${request.method} ${oneLine(request.url, 90)}  [${flags.join("; ")}]`);
        }
        if (matching.length === 0) lines.push("  (no request matches)");
        lines.push(...problemLines(collection.problems).map((line) => `  ${line}`));
    }
    if (more > 0) lines.push(`(${more} more not shown: narrow with collection, folder or text)`);
    return lines.join("\n");
}

function describeAuth(auth: Auth): string {
    switch (auth.kind) {
        case "none": return "none";
        case "bearer": return "a bearer token";
        case "basic": return "a user name and password (HTTP Basic)";
        case "apiKey": return `an API key in the ${auth.name} header`;
        case "oauth2": return `OAuth 2.0, ${auth.grant === "password" ? "password grant" : "client credentials"}`;
    }
}

/** Where each variable gets its value in an environment, or what it still needs. */
function variableLines(
    settings: ApiSettings,
    collection: Collection,
    request: SavedRequest,
    secretNames: ReadonlySet<string>,
    environment: Environment | undefined,
    label: string | undefined,
): string[] {
    return request.variables.map((name) => {
        if (name.startsWith("$")) return `  ${name}: made when the request is sent`;
        if (secretNames.has(name)) {
            const source = settings.secrets.get(name);
            const reference = label === undefined ? source?.everywhere : source?.byEnvironment.get(label) ?? source?.everywhere;
            return `  ${name}: secret, ${reference === undefined ? "NOT SET in api.secrets" : "set in api.secrets"}`;
        }
        if (request.signsIn.includes(name)) return `  ${name}: fills the sign-in, so it comes from the environment`;
        if (environment?.variables.has(name) === true) return `  ${name}: from the environment ${label}`;
        if (request.defaults.has(name)) return `  ${name}: from the file`;
        if (collection.variables.has(name)) return `  ${name}: from the collection`;
        return `  ${name}: needs a value (pass it in variables)`;
    });
}

export function showText(catalog: Catalog, settings: ApiSettings, request: SavedRequest, label: string | undefined): string {
    const collection = catalog.collection(request.collection);
    const secretNames = secretNamesOf(collection, settings.secrets);
    const environment = label === undefined ? undefined : catalog.environment(collection, label);
    const lines = [
        `${request.name} (${request.collection}, ${pathOf(request)})`,
        `${request.method} ${request.url}`,
        `Effect: ${readsOf(settings, request) ? "reads" : "writes"}`,
    ];
    const refusal = refusalOf(request);
    if (refusal !== undefined) lines.push(`Status: ${refusal}`);
    lines.push(`Sign-in: ${describeAuth(request.auth)}`);
    if (request.headers.length > 0) {
        lines.push("Headers:");
        for (const [name, value] of request.headers) {
            const names = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1] as string);
            const hidden = CREDENTIAL_HEADERS.has(name.toLowerCase()) || names.some((variable) => secretNames.has(variable));
            lines.push(`  ${name}: ${hidden ? "(secret)" : oneLine(value, 120)}`);
        }
    }
    if (request.body !== undefined) {
        const body = request.body;
        lines.push(`Body (${body.kind}${body.kind === "form" ? `, ${body.encoding}` : ""}):`);
        const text =
            body.kind === "raw" || body.kind === "json" ? body.text
                : body.kind === "graphql" ? [body.query, body.variables ?? ""].join("\n\n").trim()
                    : body.kind === "file" ? `file ${body.file.path}`
                        : body.fields.map((field) =>
                            field.kind === "file" ? `${field.name} = file ${field.file.path}` : `${field.name} = ${field.value}`).join("\n");
        const bodyLines = text.split("\n");
        lines.push(...bodyLines.slice(0, SHOWN_BODY_LINES).map((line) => `  ${line}`));
        if (bodyLines.length > SHOWN_BODY_LINES) lines.push(`  [${bodyLines.length - SHOWN_BODY_LINES} more lines not shown]`);
    }
    const variables = variableLines(settings, collection, request, secretNames, environment, label);
    lines.push(variables.length === 0 ? "Variables: none" : "Variables:", ...variables);
    if (request.description !== undefined) lines.push(`Docs: ${oneLine(request.description, 400)}`);
    for (const note of request.notes) lines.push(`Note: ${note}`);
    lines.push(`From: ${request.origin}`);
    return lines.join("\n");
}
