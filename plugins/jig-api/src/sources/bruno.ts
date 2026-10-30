// Bruno: a collection kept as a folder in git, in either of Bruno's formats. A folder with `opencollection.yml` is OpenCollection
// YAML (Bruno's default since v3.1); a folder with `bruno.json` is the `.bru` language. The language readers are bruno-yaml.ts
// and bruno-bru.ts, and both give the shapes of bruno-types.ts; this file walks the folder and turns them into saved requests.
//
// What is read: folders and requests (HTTP and GraphQL), the address with its path parameters, headers, the body (JSON, text,
// XML, URL-encoded form, multipart form with files, a file, GraphQL), the sign-in (bearer, basic, an API key in a header, OAuth 2.0
// with client credentials or a password), and what the collection and each folder set for everything below them: headers, a
// sign-in, variables. Environments come from `environments/`.
// What is never done: a script is not run. A request that a pre-request script applies to (its own, its folder's or the
// collection's) is refused by name; post-response scripts and tests are ignored with a note. `assert` blocks are read and shown,
// and not run. No `.env` file is read: `{{process.env.NAME}}` is a secret, and comes from `api.secrets` and from nowhere else.
// Formats: https://docs.usebruno.com/bru-lang/language and https://github.com/opencollection-dev/opencollection
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../engine/values.ts";
import { CREDENTIAL_HEADERS, declaredSecrets } from "../model.ts";
import type { Auth, Body, Collection, Environment, Problem, SavedRequest, Variable } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import * as bru from "./bruno-bru.ts";
import * as opencollection from "./bruno-yaml.ts";
import type { AuthSetting, Pairs, ParsedDefaults, ParsedEnvironment, ParsedRequest, ParsedVariable, Report } from "./bruno-types.ts";
import { expandHome, readFailure, readText, whyNotRead } from "./files.ts";
import type { Source } from "./source.ts";
import { authTexts, bodyTexts } from "./texts.ts";
import { parseYaml } from "./yaml.ts";

export interface BrunoConfig {
    folder: string;
}

type Format = "yaml" | "bru";

const FILE_MAX_BYTES = 1024 * 1024;
const MAX_FILES = 1000;
const MAX_DEPTH = 12;
const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
/** The variables of the process environment, which Bruno reads from a `.env` file. They are secrets here. */
const PROCESS_ENV = "process.env.";

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): BrunoConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry)) if (key !== "bruno") errors.push(`${at}.${key}: unknown field`);
    const value = entry.bruno;
    let folder: string | undefined;
    if (typeof value !== "string" || value.trim() === "" || value.length > 1000 || value.includes("\0")) {
        errors.push(`${at}.bruno: must be the path of a Bruno collection folder`);
    } else if (!path.isAbsolute(expandHome(value.trim()))) {
        errors.push(`${at}.bruno: must be an absolute path or start with ~/`);
    } else {
        folder = path.normalize(expandHome(value.trim()));
    }
    return errors.length > before || folder === undefined ? undefined : { folder };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

/** What `load` collects while it reads. */
interface Reading {
    collection: string;
    root: string;
    format: Format;
    problems: Problem[];
    /** The variables that some environment declares secret. Set once the environments are read. */
    secretNames: ReadonlySet<string>;
    /** Names of folders the collection says to skip: `ignore` in bruno.json, or `extensions.bruno.ignore` in the YAML file. */
    ignored: ReadonlySet<string>;
    files: number;
    /** The variables a `{{process.env.NAME}}` names anywhere, so that every environment can declare them secret. */
    processEnv: Set<string>;
    /** Texts that may hold a `{{process.env.NAME}}`: the values of variables. */
    values: string[];
}

/** Where a reader reports what it cannot understand, as a problem with its file. */
function reporter(problems: Problem[], file: string): Report {
    return (key, message, level) => problems.push({ file, key, message, level });
}

function textOf(file: string, relative: string, problems: Problem[]): string | undefined {
    try {
        return readText(file, FILE_MAX_BYTES);
    } catch (error) {
        problems.push({ file: relative, key: "", message: whyNotRead(error), level: "error" });
        return undefined;
    }
}

/** Which language the collection folder is in, by its root file; undefined when it is neither. */
function formatOf(root: string): Format | undefined {
    if (fs.existsSync(path.join(root, "opencollection.yml"))) return "yaml";
    if (fs.existsSync(path.join(root, "bruno.json"))) return "bru";
    return undefined;
}

const extensionOf = (format: Format): readonly string[] => (format === "yaml" ? [".yml", ".yaml"] : [".bru"]);
const folderFileOf = (format: Format): string => (format === "yaml" ? "folder.yml" : "folder.bru");
/** The files of a folder that are not requests. */
const NOT_REQUESTS: ReadonlySet<string> = new Set([
    "folder.yml", "folder.yaml", "folder.bru", "collection.bru", "opencollection.yml", "opencollection.yaml",
]);

// Environments --------------------------------------------------------------------------------------------------------

interface EnvironmentFile {
    name: string;
    file: string;
    parsed: ParsedEnvironment;
}

function readEnvironmentFiles(reading: Reading): EnvironmentFile[] {
    const { root, format, problems } = reading;
    const directory = path.join(root, "environments");
    if (!fs.existsSync(directory)) return [];
    let names: string[];
    try {
        names = fs.readdirSync(directory).sort();
    } catch (error) {
        problems.push({ file: "environments", key: "", message: readFailure(error), level: "error" });
        return [];
    }
    const found: EnvironmentFile[] = [];
    for (const entry of names) {
        const extension = extensionOf(format).find((each) => entry.endsWith(each));
        if (extension === undefined || entry.startsWith(".")) continue;
        const relative = `environments/${entry}`;
        const file = path.join(directory, entry);
        if (fs.lstatSync(file).isSymbolicLink()) {
            problems.push({ file: relative, key: "", message: "is a link, and links are not read", level: "warning" });
            continue;
        }
        const content = textOf(file, relative, problems);
        if (content === undefined) continue;
        const report = reporter(problems, relative);
        let parsed: ParsedEnvironment | undefined;
        if (format === "bru") {
            parsed = bru.readEnvironment(content, report);
        } else {
            const raw = parseYaml(content, relative, problems);
            if (raw !== undefined) parsed = opencollection.readEnvironment(raw, report);
        }
        if (parsed === undefined) continue;
        const name = parsed.name ?? entry.slice(0, entry.length - extension.length);
        if (found.some((each) => each.name === name)) {
            problems.push({ file: relative, key: "", message: `names the environment ${name} again; the later file wins`, level: "warning" });
        }
        found.push({ name, file: relative, parsed });
    }
    return found;
}

/** A variable of an environment after its `extends` chain: a name is secret if any file says so. */
interface Merged {
    secret: boolean;
    /** The last value written for it. For a secret that is a value someone typed in a file, which is refused. */
    value: string | undefined;
    external: string | undefined;
}

/** The variables of an environment: those of the environments it extends first, then its own. */
function mergedVariables(
    start: EnvironmentFile,
    all: readonly EnvironmentFile[],
    problems: Problem[],
    seen: readonly string[] = [],
): Map<string, Merged> {
    const merged = new Map<string, Merged>();
    const add = (variable: ParsedVariable): void => {
        const before = merged.get(variable.name);
        const written = variable.value !== undefined && variable.value !== "" ? variable.value : undefined;
        merged.set(variable.name, {
            secret: variable.secret || before?.secret === true,
            value: variable.secret ? (written ?? before?.value) : (variable.value ?? ""),
            external: variable.external ?? before?.external,
        });
    };
    for (const parent of start.parsed.extends) {
        const found = all.find((each) => each.name === parent);
        if (found === undefined) {
            problems.push({ file: start.file, key: "extends", message: `names the environment ${parent}, which does not exist`, level: "warning" });
        } else if (seen.includes(found.name) || found.name === start.name) {
            problems.push({ file: start.file, key: "extends", message: `extends ${parent}, which extends it back`, level: "warning" });
        } else {
            for (const [name, variable] of mergedVariables(found, all, problems, [...seen, start.name])) {
                const before = merged.get(name);
                merged.set(name, { ...variable, secret: variable.secret || before?.secret === true });
            }
        }
    }
    for (const variable of start.parsed.variables) add(variable);
    return merged;
}

function environmentsOf(reading: Reading): Map<string, Environment> {
    const { problems } = reading;
    const files = readEnvironmentFiles(reading);
    const environments = new Map<string, Environment>();
    for (const file of files) {
        if (file.parsed.dotEnv) {
            problems.push({
                file: file.file,
                key: "dotEnvFilePath",
                message: "points at a .env file, which is never read: give those values in api.secrets as process.env.NAME",
                level: "warning",
            });
        }
        const variables = new Map<string, Variable>();
        for (const [name, merged] of mergedVariables(file, files, problems)) {
            if (merged.secret) {
                // A secret is never read from a file. A value written for it is not used, and a warning says where it is.
                if (merged.value !== undefined && merged.value !== "") {
                    problems.push({
                        file: file.file,
                        key: name,
                        message:
                            `is a secret with a value in the file. The value is ignored and never sent; ` +
                                `give the secret in api.secrets as "${name}"`,
                        level: "warning",
                    });
                }
                if (merged.external !== undefined) {
                    problems.push({
                        file: file.file,
                        key: name,
                        message: `comes from ${merged.external}, which is not read: give the secret in api.secrets as "${name}"`,
                        level: "warning",
                    });
                }
                variables.set(name, { value: "", secret: true });
            } else {
                const value = merged.value ?? "";
                reading.values.push(value);
                variables.set(name, { value, secret: false });
            }
        }
        environments.set(file.name, { name: file.name, file: file.file, variables });
    }
    return environments;
}

// Requests -------------------------------------------------------------------------------------------------------------

/** What the collection and the folders above a request set for it. */
interface Level {
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

function headerMap(base: ReadonlyMap<string, readonly [string, string]>, headers: Pairs): Map<string, readonly [string, string]> {
    const merged = new Map(base);
    for (const [name, value] of headers) merged.set(name.toLowerCase(), [name, value]);
    return merged;
}

function belowCollection(defaults: ParsedDefaults): Level {
    const auth: AuthSetting = defaults.auth.kind === "set" || defaults.auth.kind === "refused" ? defaults.auth : { kind: "none" };
    return {
        folder: [],
        headers: headerMap(new Map(), defaults.headers),
        auth,
        prerequest: defaults.prerequest ? "the collection" : undefined,
        vars: new Map(),
    };
}

/** A folder's own sign-in replaces the one above it; a folder with none, or with `inherit`, leaves it. */
function belowFolder(parent: Level, defaults: ParsedDefaults, name: string): Level {
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
        out = out.replace(new RegExp(`/:${escaped(name)}(?=[/?#]|$)`, "g"), () => `/${value === "" ? `{{${name}}}` : value}`);
    }
    return out;
}

function schemeProblem(url: string): string | undefined {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
    if (scheme === undefined || scheme === "http" || scheme === "https") return undefined;
    return `the address uses ${scheme}://, and only http and https are sent (not WebSocket, gRPC or MQTT)`;
}

function requestOf(parsed: ParsedRequest, file: string, level: Level, reading: Reading): SavedRequest {
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

// The tree -------------------------------------------------------------------------------------------------------------

/** A request or a folder found in a folder, read but not yet built, so that they can be put in Bruno's order. */
type Entry =
    | { kind: "request"; seq: number | undefined; name: string; parsed: ParsedRequest; file: string }
    | { kind: "folder"; seq: number | undefined; name: string; defaults: ParsedDefaults; children: () => Entry[] };

/** Bruno's order: by `seq`, and what has none after what has, by name. */
function inOrder(entries: readonly Entry[]): Entry[] {
    return [...entries].sort((a, b) => {
        if (a.seq !== b.seq) {
            if (a.seq === undefined) return 1;
            if (b.seq === undefined) return -1;
            return a.seq - b.seq;
        }
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

function readRequestFile(file: string, relative: string, reading: Reading): ParsedRequest | undefined {
    const content = textOf(file, relative, reading.problems);
    if (content === undefined) return undefined;
    const report = reporter(reading.problems, relative);
    if (reading.format === "bru") return bru.readRequest(content, report);
    const raw = parseYaml(content, relative, reading.problems);
    if (!isObject(raw)) {
        if (raw !== undefined) report("", "is not a YAML object", "warning");
        return undefined;
    }
    if (opencollection.itemKind(raw) !== "request") {
        // A script file, an app or any other YAML file: not a request, and nothing to report.
        if (isObject(raw.info) && raw.info.type !== undefined) return undefined;
        report("", "is not a request: it has no info with a type", "warning");
        return undefined;
    }
    return opencollection.readRequest(raw, report);
}

function readDefaultsFile(file: string, relative: string, reading: Reading): ParsedDefaults | undefined {
    if (!fs.existsSync(file)) return undefined;
    const content = textOf(file, relative, reading.problems);
    if (content === undefined) return undefined;
    const report = reporter(reading.problems, relative);
    if (reading.format === "bru") return bru.readDefaults(content, report);
    const raw = parseYaml(content, relative, reading.problems);
    return raw === undefined ? undefined : opencollection.readDefaults(raw, report);
}

const EMPTY_DEFAULTS: ParsedDefaults = {
    name: undefined, seq: undefined, headers: [], auth: { kind: "none" }, vars: new Map(), prerequest: false, docs: undefined,
};

/** The requests and folders in a directory of the collection. */
function entriesOfDirectory(directory: string, depth: number, reading: Reading): Entry[] {
    const { root, problems, format } = reading;
    const relativeDirectory = path.relative(root, directory);
    let names: fs.Dirent[];
    try {
        names = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        problems.push({ file: relativeDirectory || ".", key: "", message: readFailure(error), level: "error" });
        return [];
    }
    const entries: Entry[] = [];
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const relative = path.join(relativeDirectory, entry.name);
        if (entry.name.startsWith(".") || entry.name === "node_modules" || reading.ignored.has(entry.name)) continue;
        if (entry.isSymbolicLink()) {
            problems.push({ file: relative, key: "", message: "is a link, and links are not read", level: "warning" });
        } else if (entry.isDirectory()) {
            if (relativeDirectory === "" && entry.name === "environments") continue;
            if (depth >= MAX_DEPTH) {
                problems.push({ file: relative, key: "", message: `is more than ${MAX_DEPTH} folders deep, so it is not read`, level: "warning" });
                continue;
            }
            const sub = path.join(directory, entry.name);
            const folderFile = folderFileOf(format);
            const defaults = readDefaultsFile(path.join(sub, folderFile), path.join(relative, folderFile), reading) ?? EMPTY_DEFAULTS;
            entries.push({
                kind: "folder",
                seq: defaults.seq,
                name: defaults.name ?? entry.name,
                defaults: { ...defaults, name: defaults.name ?? entry.name },
                children: () => entriesOfDirectory(sub, depth + 1, reading),
            });
        } else if (entry.isFile() && extensionOf(format).some((extension) => entry.name.endsWith(extension)) && !NOT_REQUESTS.has(entry.name)) {
            if (++reading.files > MAX_FILES) {
                if (reading.files === MAX_FILES + 1) {
                    const message = `is past the first ${MAX_FILES} files, so it and the rest are not read`;
                    problems.push({ file: relative, key: "", message, level: "warning" });
                }
                continue;
            }
            const parsed = readRequestFile(path.join(directory, entry.name), relative, reading);
            if (parsed !== undefined) entries.push({ kind: "request", seq: parsed.seq, name: parsed.name ?? entry.name, parsed, file: relative });
        }
    }
    return entries;
}

/** The items of a bundled collection file (`items:` in `opencollection.yml`), which hold their folders inline. */
function entriesOfItems(items: unknown, prefix: string, reading: Reading): Entry[] {
    if (!Array.isArray(items)) return [];
    const entries: Entry[] = [];
    (items as unknown[]).forEach((item, index) => {
        const key = `${prefix}[${index}]`;
        const report = reporter(reading.problems, "opencollection.yml");
        const kind = opencollection.itemKind(item);
        if (!isObject(item) || kind === "other") return;
        if (kind === "folder") {
            const defaults = opencollection.readDefaults(item, (inner, message, level) => report(`${key}.${inner}`, message, level));
            entries.push({
                kind: "folder",
                seq: defaults.seq,
                name: defaults.name ?? "(unnamed folder)",
                defaults: { ...defaults, name: defaults.name ?? "(unnamed folder)" },
                children: () => entriesOfItems(item.items, `${key}.items`, reading),
            });
        } else {
            const parsed = opencollection.readRequest(item, (inner, message, level) => report(`${key}.${inner}`, message, level));
            entries.push({ kind: "request", seq: parsed.seq, name: parsed.name ?? "(unnamed)", parsed, file: `opencollection.yml: ${key}` });
        }
    });
    return entries;
}

function build(entries: readonly Entry[], level: Level, reading: Reading, found: SavedRequest[]): void {
    for (const entry of inOrder(entries)) {
        if (entry.kind === "request") found.push(requestOf(entry.parsed, entry.file, level, reading));
        else build(entry.children(), belowFolder(level, entry.defaults, entry.name), reading, found);
    }
}

// The collection -------------------------------------------------------------------------------------------------------

const namesIn = (list: unknown): Set<string> =>
    new Set(Array.isArray(list) ? (list as unknown[]).filter((item): item is string => typeof item === "string") : []);

function ignoredBy(root: string, problems: Problem[]): Set<string> {
    const file = path.join(root, "bruno.json");
    if (!fs.existsSync(file)) return new Set();
    const content = textOf(file, "bruno.json", problems);
    if (content === undefined) return new Set();
    try {
        const raw = JSON.parse(content) as unknown;
        return isObject(raw) ? namesIn(raw.ignore) : new Set();
    } catch {
        problems.push({ file: "bruno.json", key: "", message: "is not valid JSON", level: "error" });
        return new Set();
    }
}

function load(config: BrunoConfig, name: string): Collection {
    const problems: Problem[] = [];
    const root = config.folder;
    const empty = (): Collection => ({ name, root, requests: [], environments: new Map(), variables: new Map(), auth: { kind: "none" }, problems });
    if (!fs.existsSync(root)) {
        problems.push({ file: ".", key: "", message: "the folder does not exist", level: "error" });
        return empty();
    }
    const format = formatOf(root);
    if (format === undefined) {
        problems.push({ file: ".", key: "", message: "is not a Bruno collection: it has neither opencollection.yml nor bruno.json", level: "error" });
        return empty();
    }
    const reading: Reading = {
        collection: name, root, format, problems, secretNames: new Set(), ignored: new Set(), files: 0, processEnv: new Set(), values: [],
    };

    // Environments first: which variables are secret decides how the requests are read.
    const environments = environmentsOf(reading);

    // The collection's own settings, and its bundled items if the file holds any.
    let defaults = EMPTY_DEFAULTS;
    let bundled: unknown;
    if (format === "yaml") {
        const content = textOf(path.join(root, "opencollection.yml"), "opencollection.yml", problems);
        const raw = content === undefined ? undefined : parseYaml(content, "opencollection.yml", problems);
        if (raw !== undefined) {
            defaults = opencollection.readDefaults(raw, reporter(problems, "opencollection.yml"));
            if (isObject(raw)) {
                bundled = raw.items;
                const extensions = isObject(raw.extensions) && isObject(raw.extensions.bruno) ? raw.extensions.bruno : {};
                reading.ignored = namesIn(extensions.ignore);
                const inline = isObject(raw.config) ? raw.config.environments : undefined;
                if (Array.isArray(inline) && inline.length > 0) {
                    problems.push({
                        file: "opencollection.yml",
                        key: "config.environments",
                        message: "environments inside the collection file are not read: keep them in environments/",
                        level: "warning",
                    });
                }
            }
        }
    } else {
        reading.ignored = ignoredBy(root, problems);
        defaults = readDefaultsFile(path.join(root, "collection.bru"), "collection.bru", reading) ?? EMPTY_DEFAULTS;
    }

    reading.secretNames = declaredSecrets(environments.values());
    const top = belowCollection(defaults);
    const requests: SavedRequest[] = [];
    build([...entriesOfDirectory(root, 0, reading), ...entriesOfItems(bundled, "items", reading)], top, reading, requests);

    // The collection's variables are the weakest values.
    const variables = new Map<string, Variable>();
    for (const [key, value] of defaults.vars) {
        reading.values.push(value);
        variables.set(key, { value, secret: false });
    }

    // `{{process.env.NAME}}` anywhere, even inside the value of another variable, is a secret in every environment.
    for (const value of reading.values) {
        for (const variable of variablesIn(value)) if (variable.startsWith(PROCESS_ENV)) reading.processEnv.add(variable);
    }
    for (const environment of environments.values()) {
        const declared = environment.variables as Map<string, Variable>;
        for (const variable of reading.processEnv) declared.set(variable, { value: "", secret: true });
    }

    const refused = top.auth.kind === "refused" ? top.auth.reason : undefined;
    return {
        name,
        root,
        requests,
        environments,
        variables,
        auth: top.auth.kind === "set" ? top.auth.auth : { kind: "none" },
        ...(refused === undefined ? {} : { authRefused: refused }),
        problems,
    };
}

export const bruno: Source<BrunoConfig> = { kind: "bruno", check, load };
