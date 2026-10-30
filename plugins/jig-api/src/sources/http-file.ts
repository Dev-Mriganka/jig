// `.http` files: the request files of JetBrains IDEs, the VS Code REST Client and Visual Studio, kept in a folder in git.
//
// What is read: requests separated by `###` and named by `# @name` (or `// @name`, or the text after `###`); a request is a
// method and address, headers, a blank line and a body. `{{variables}}` and `@name = value` lines; the bodies in text, JSON,
// URL-encoded form, multipart form and GraphQL; `< ./file` includes; `Authorization: Basic user password`. Environments come
// from `http-client.env.json`, and from `http-client.private.env.json`, whose every key is a secret.
// What is never done: a script is not run. A pre-request script (`< {% ... %}`) refuses the request by name, a response
// handler (`> {% ... %}`) is ignored with a note. WebSocket and gRPC requests are listed and refused as unsupported.
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../engine/values.ts";
import { CREDENTIAL_HEADERS, declaredSecrets } from "../model.ts";
import type { Auth, Body, Collection, Environment, FormField, Problem, SavedRequest, Variable } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import { expandHome, readFailure, readText, whyNotRead } from "./files.ts";
import type { Source } from "./source.ts";

export interface HttpConfig {
    folder: string;
}

const PUBLIC_ENV = "http-client.env.json";
const PRIVATE_ENV = "http-client.private.env.json";
const FILE_MAX_BYTES = 1024 * 1024;
const MAX_FILES = 500;
const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): HttpConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry)) if (key !== "http") errors.push(`${at}.${key}: unknown field`);
    const value = entry.http;
    let folder: string | undefined;
    if (typeof value !== "string" || value.trim() === "" || value.length > 1000 || value.includes("\0")) {
        errors.push(`${at}.http: must be the path of a folder of .http files`);
    } else if (!path.isAbsolute(expandHome(value.trim()))) {
        errors.push(`${at}.http: must be an absolute path or start with ~/`);
    } else {
        folder = path.normalize(expandHome(value.trim()));
    }
    return errors.length > before || folder === undefined ? undefined : { folder };
}

// ---------------------------------------------------------------------------------------------------------------------
// Environments

/** Nested objects become dotted names (`{ "client": { "host": "x" } }` is `client.host`), as `{{client.host}}` reads them. */
function flatten(value: unknown, prefix: string, into: Map<string, string>, report: (key: string, message: string) => void): void {
    if (!isObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
        const name = prefix === "" ? key : `${prefix}.${key}`;
        if (isObject(item)) flatten(item, name, into, report);
        else if (Array.isArray(item)) report(name, "is a list, which would send one request per element, and that is not supported");
        else if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") into.set(name, String(item));
        else if (item === null) into.set(name, "");
    }
}

interface EnvFile {
    shared: Map<string, string>;
    byName: Map<string, Map<string, string>>;
}

function readEnvFile(root: string, name: string, problems: Problem[]): EnvFile | undefined {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(readText(file, FILE_MAX_BYTES)) as unknown;
    } catch (error) {
        const message = error instanceof SyntaxError ? "is not valid JSON" : whyNotRead(error);
        problems.push({ file: name, key: "", message, level: "error" });
        return undefined;
    }
    if (!isObject(raw)) {
        problems.push({ file: name, key: "", message: "must be an object of environment names", level: "error" });
        return undefined;
    }
    const found: EnvFile = { shared: new Map(), byName: new Map() };
    for (const [environment, values] of Object.entries(raw)) {
        if (environment === "$schema") continue;
        if (!isObject(values)) {
            problems.push({ file: name, key: environment, message: "is not an object of variables", level: "warning" });
            continue;
        }
        const variables = new Map<string, string>();
        const { Security: security, ...rest } = values;
        if (security !== undefined) {
            problems.push({
                file: name, key: `${environment}.Security`, message: "is not read: {{$auth.token(...)}} is not supported", level: "warning",
            });
        }
        flatten(rest, "", variables, (key, message) => problems.push({ file: name, key: `${environment}.${key}`, message, level: "warning" }));
        if (environment === "$shared") for (const [key, value] of variables) found.shared.set(key, value);
        else found.byName.set(environment, variables);
    }
    return found;
}

function environmentsOf(root: string, problems: Problem[]): Map<string, Environment> {
    const publicFile = readEnvFile(root, PUBLIC_ENV, problems);
    const privateFile = readEnvFile(root, PRIVATE_ENV, problems);
    const names = new Set([...(publicFile?.byName.keys() ?? []), ...(privateFile?.byName.keys() ?? [])]);
    const environments = new Map<string, Environment>();
    for (const name of names) {
        const variables = new Map<string, Variable>();
        for (const [key, value] of publicFile?.shared ?? []) variables.set(key, { value, secret: false });
        for (const [key, value] of publicFile?.byName.get(name) ?? []) variables.set(key, { value, secret: false });
        // Every key of the private file is a secret. A value in the file is not used: a secret comes from api.secrets.
        for (const [key, value] of [...(privateFile?.shared ?? []), ...(privateFile?.byName.get(name) ?? [])]) {
            if (value !== "") {
                problems.push({
                    file: PRIVATE_ENV,
                    key: `${name}.${key}`,
                    message: `is a secret with a value in the file. The value is ignored and never sent; give the secret in api.secrets as "${key}"`,
                    level: "warning",
                });
            }
            variables.set(key, { value: "", secret: true });
        }
        environments.set(name, { name, file: publicFile?.byName.has(name) ? PUBLIC_ENV : PRIVATE_ENV, variables });
    }
    return environments;
}

// ---------------------------------------------------------------------------------------------------------------------
// Request files

/** Every `.http` and `.rest` file below the folder, in a fixed order. Links are not followed. */
function findFiles(root: string, problems: Problem[]): string[] {
    const found: string[] = [];
    const visit = (directory: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            problems.push({ file: path.relative(root, directory) || ".", key: "", message: readFailure(error), level: "error" });
            return;
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                problems.push({ file: path.relative(root, full), key: "", message: "is a link, and links are not followed", level: "warning" });
            } else if (entry.isDirectory()) {
                visit(full);
            } else if (entry.isFile() && /\.(?:http|rest)$/i.test(entry.name)) {
                found.push(full);
            }
        }
    };
    visit(root);
    if (found.length > MAX_FILES) {
        const message = `holds more than ${MAX_FILES} request files; only the first ${MAX_FILES} are read`;
        problems.push({ file: ".", key: "", message, level: "warning" });
    }
    return found.slice(0, MAX_FILES);
}

interface Block {
    /** The first line of the block, 1-based. */
    line: number;
    /** The text after `###` on the line that opened the block. */
    heading: string;
    lines: string[];
}

function splitBlocks(text: string): Block[] {
    const blocks: Block[] = [{ line: 1, heading: "", lines: [] }];
    text.split(/\r?\n/).forEach((line, index) => {
        const separator = /^#{3,}\s*(.*)$/.exec(line);
        if (separator !== null) blocks.push({ line: index + 2, heading: (separator[1] as string).trim(), lines: [] });
        else (blocks.at(-1) as Block).lines.push(line);
    });
    return blocks;
}

const HEADER = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*)$/;
const COMMENT = /^(?:#|\/\/)/;
/** The line that ends a body: a response handler, a response file, or a reference to an earlier response. */
const AFTER_BODY = /^(?:<>|>>?!?)(?:\s|$)/;

/** A request read from a block, before its file's variables and the collection's environments are known. */
interface Parsed {
    name: string | undefined;
    heading: string;
    line: number;
    method: string;
    url: string;
    headers: Array<[string, string]>;
    bodyLines: string[];
    prerequest: boolean;
    handler: boolean;
    saved: boolean;
}

function parseBlock(block: Block, variables: Map<string, string>): Parsed | undefined {
    const lines = block.lines;
    let i = 0;
    let name: string | undefined;
    let prerequest = false;

    // Before the request line: comments (some are annotations), variables, and a pre-request script.
    for (; i < lines.length; i++) {
        const trimmed = (lines[i] as string).trim();
        if (trimmed === "") continue;
        if (COMMENT.test(trimmed)) {
            const annotation = /^(?:#|\/\/)\s*@([\w-]+)(?:\s+(.*))?$/.exec(trimmed);
            if (annotation?.[1] === "name") name = (annotation[2] ?? "").replace(/^=\s*/, "").trim() || undefined;
            continue;
        }
        const variable = /^@([^\s=]+)\s*=\s*(.*)$/.exec(trimmed);
        if (variable !== null) {
            variables.set(variable[1] as string, (variable[2] as string).trim());
            continue;
        }
        if (/^<\s*\{%/.test(trimmed)) {
            prerequest = true;
            while (i < lines.length && !(lines[i] as string).includes("%}")) i++;
            continue;
        }
        break;
    }
    if (i >= lines.length) return undefined;

    let requestLine = (lines[i] as string).trim();
    i++;
    // A long address goes on indented lines (or lines that start with ? or &) below the first.
    while (i < lines.length) {
        const next = lines[i] as string;
        if (next.trim() !== "" && (/^\s/.test(next) || /^[?&]/.test(next))) {
            requestLine += next.trim();
            i++;
        } else {
            break;
        }
    }

    const headers: Array<[string, string]> = [];
    for (; i < lines.length; i++) {
        const line = lines[i] as string;
        if (line.trim() === "") break;
        if (COMMENT.test(line.trim())) continue;
        const header = HEADER.exec(line);
        if (header === null) break;
        headers.push([header[1] as string, (header[2] as string).trim()]);
    }

    while (i < lines.length && (lines[i] as string).trim() === "") i++;
    const bodyLines: string[] = [];
    for (; i < lines.length && !AFTER_BODY.test(lines[i] as string); i++) bodyLines.push(lines[i] as string);
    while (bodyLines.length > 0 && (bodyLines.at(-1) as string).trim() === "") bodyLines.pop();

    // What follows the body: a response handler (`> ...`), a file the response is saved to (`>> ...`), a reference to an
    // earlier response (`<> ...`). None of them changes what is sent.
    const trailer = lines.slice(i);
    const handler = trailer.some((line) => /^>\s/.test(line) && !line.startsWith(">>"));
    const saved = trailer.some((line) => line.startsWith(">>"));

    // `GET https://...`; a request line that is only an address is a GET. A method is written in capitals.
    const parts = /^([A-Za-z]+)\s+(\S.*)$/.exec(requestLine);
    const hasMethod = parts !== null && parts[1] === parts[1]?.toUpperCase();
    const method = hasMethod ? (parts?.[1] as string) : "GET";
    const url = (hasMethod ? (parts![2] as string) : requestLine).replace(/\s+HTTP\/[\d.]+$/i, "").trim();
    return { name, heading: block.heading, line: block.line, method, url, headers, bodyLines, prerequest, handler, saved };
}

const contentTypeOf = (headers: ReadonlyArray<readonly [string, string]>): string =>
    (headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "").toLowerCase();

interface BodyResult {
    body?: Body;
    unsupported?: string;
}

/** A multipart body written out in the file, with its boundary, read into parts. */
function multipartOf(lines: readonly string[], boundary: string): BodyResult {
    const fields: FormField[] = [];
    let current: { head: string[]; content: string[]; inHead: boolean } | undefined;
    const finish = (): string | undefined => {
        if (current === undefined) return undefined;
        const head = new Map<string, string>(current.head.flatMap((line): Array<[string, string]> => {
            const match = HEADER.exec(line);
            return match === null ? [] : [[(match[1] as string).toLowerCase(), (match[2] as string).trim()]];
        }));
        const disposition = head.get("content-disposition") ?? "";
        const field = /\bname="([^"]*)"/.exec(disposition)?.[1];
        if (field === undefined) return "a part of the multipart body has no name";
        const contentType = head.get("content-type");
        const content = [...current.content];
        while (content.length > 0 && (content.at(-1) as string).trim() === "") content.pop();
        const include = content.length === 1 ? /^<\s+(\S.*)$/.exec((content[0] as string).trim()) : null;
        const filename = /\bfilename="([^"]*)"/.exec(disposition)?.[1];
        if (include !== null) {
            fields.push({
                kind: "file", name: field, file: { path: include[1] as string },
                ...(filename === undefined ? {} : { filename }), ...(contentType === undefined ? {} : { contentType }),
            });
        } else {
            fields.push({ kind: "text", name: field, value: content.join("\r\n"), ...(contentType === undefined ? {} : { contentType }) });
        }
        return undefined;
    };
    for (const line of lines) {
        if (line === `--${boundary}` || line === `--${boundary}--`) {
            const problem = finish();
            if (problem !== undefined) return { unsupported: problem };
            current = line.endsWith("--") ? undefined : { head: [], content: [], inHead: true };
            if (current === undefined) break;
        } else if (current !== undefined) {
            if (current.inHead) {
                if (line.trim() === "") current.inHead = false;
                else current.head.push(line);
            } else {
                current.content.push(line);
            }
        }
    }
    if (fields.length === 0) return { unsupported: "its multipart body has no parts" };
    return { body: { kind: "form", encoding: "multipart", fields, boundary } };
}

function bodyOf(lines: readonly string[], headers: ReadonlyArray<readonly [string, string]>, graphql: boolean): BodyResult {
    if (lines.length === 0) return {};
    const text = lines.join("\n");
    const include = /^<(@?)\s+(\S.*)$/.exec(text.trim());
    if (include !== null && !text.includes("\n")) {
        if (include[1] === "@") return { unsupported: "`<@` (variables inside the included file) is not supported; use `<`" };
        return { body: { kind: "file", file: { path: include[2] as string } } };
    }
    if (graphql) {
        // The query, then after a blank line a JSON object of variables. The last blank line that is followed by an object
        // splits them, because a query may have blank lines in it.
        let at = -1;
        lines.forEach((line, index) => {
            const after = lines.slice(index + 1).join("\n").trim();
            if (index > 0 && line.trim() === "" && after.startsWith("{") && after.endsWith("}")) at = index;
        });
        const query = (at < 0 ? lines : lines.slice(0, at)).join("\n").trim();
        const variables = at < 0 ? "" : lines.slice(at + 1).join("\n").trim();
        return { body: { kind: "graphql", query, ...(variables === "" ? {} : { variables }) } };
    }
    const type = contentTypeOf(headers);
    if (type.startsWith("multipart/")) {
        const boundary = /boundary="?([^";\s]+)"?/i.exec(headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "")?.[1];
        if (boundary === undefined) return { unsupported: "its multipart body names no boundary in Content-Type" };
        return multipartOf(lines, boundary);
    }
    if (type.includes("x-www-form-urlencoded")) {
        // A long form is written on several lines; they are one line to the server.
        return { body: { kind: "raw", text: lines.map((line) => line.trim()).join(""), language: "urlencoded" } };
    }
    if (type.includes("json")) return { body: { kind: "json", text } };
    if (type.includes("xml")) return { body: { kind: "raw", text, language: "xml" } };
    if (type.includes("html")) return { body: { kind: "raw", text, language: "html" } };
    return { body: { kind: "raw", text, language: "text" } };
}

function bodyTexts(body: Body | undefined): string[] {
    if (body === undefined) return [];
    switch (body.kind) {
        case "raw":
        case "json": return [body.text];
        case "file": return [];
        case "graphql": return [body.query, ...(body.variables === undefined ? [] : [body.variables])];
        case "form": return body.fields.flatMap((field) => (field.kind === "text" ? [field.value] : []));
    }
}

interface Reading {
    collection: string;
    secretNames: ReadonlySet<string>;
}

/** The user name and password of `Basic user password` or `Basic user:password`; none for an encoded credential. */
function basicCredentials(first: string, second: string | undefined): { username: string; password: string } | undefined {
    if (second !== undefined) return { username: first, password: second };
    const colon = first.indexOf(":");
    return colon < 0 ? undefined : { username: first.slice(0, colon), password: first.slice(colon + 1) };
}

function requestOf(parsed: Parsed, file: string, position: number, fileVariables: ReadonlyMap<string, string>, reading: Reading): SavedRequest {
    const folder = [...path.dirname(file).split(path.sep).filter((part) => part !== "." && part !== ""), path.basename(file)];
    const notes: string[] = [];
    let headers = [...parsed.headers];
    let method = parsed.method;
    let auth: Auth = { kind: "none" };
    let unsupported: string | undefined;

    // `GRAPHQL <address>` (JetBrains) and `X-Request-Type: GraphQL` (VS Code) both post a query and its variables as JSON.
    const typed = headers.find(([name]) => name.toLowerCase() === "x-request-type");
    const graphql = method === "GRAPHQL" || (typed !== undefined && typed[1].toLowerCase() === "graphql");
    if (typed !== undefined) headers = headers.filter((header) => header !== typed);
    if (method === "GRAPHQL") {
        method = "POST";
        if (contentTypeOf(headers) === "") headers.push(["Content-Type", "application/json"]);
    }

    // `Authorization: Basic user password` (and `user:password`) is a sign-in; the tool builds the header.
    const authorization = headers.find(([name]) => name.toLowerCase() === "authorization");
    if (authorization !== undefined) {
        const basic = /^Basic\s+(\S+)(?:\s+(\S+))?$/i.exec(authorization[1]);
        const credentials = basic === null ? undefined : basicCredentials(basic[1] as string, basic[2]);
        if (credentials !== undefined) {
            auth = { kind: "basic", ...credentials };
            headers = headers.filter((header) => header !== authorization);
        } else if (/^Digest\b/i.test(authorization[1])) {
            unsupported = "Digest authentication is not sent";
        }
    }

    const body = bodyOf(parsed.bodyLines, headers, graphql);
    const authTexts = auth.kind === "basic" ? [auth.username, auth.password] : [];
    const variables = variablesIn(parsed.url, ...headers.map(([, value]) => value), ...bodyTexts(body.body), ...authTexts);
    const signsIn = variablesIn(...authTexts, ...headers.filter(([name]) => CREDENTIAL_HEADERS.has(name.toLowerCase())).map(([, value]) => value));

    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(parsed.url)?.[1]?.toLowerCase();
    if (method === "WEBSOCKET" || method === "GRPC") {
        unsupported ??= `${method} is not plain HTTP, and only HTTP is sent`;
    } else if (!SENT_METHODS.has(method)) {
        unsupported ??= `the method ${method} is not sent (GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE are)`;
    }
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
        unsupported ??= `the address uses ${scheme}://, and only http and https are sent (not WebSocket, gRPC or MQTT)`;
    }
    unsupported ??= body.unsupported;
    unsupported ??= unsupportedVariable(variables);
    if (parsed.handler) notes.push("its response handler script is ignored (scripts never run)");
    if (parsed.saved) notes.push("its response is not saved to a file");

    const name = parsed.name ?? (parsed.heading !== "" ? parsed.heading : `${path.basename(file)}#${position}`);
    return {
        collection: reading.collection,
        folder,
        name,
        origin: `${file} (line ${parsed.line})`,
        method,
        url: parsed.url,
        headers,
        ...(body.body === undefined ? {} : { body: body.body }),
        auth,
        variables,
        secrets: variables.filter((variable) => reading.secretNames.has(variable)),
        signsIn,
        defaults: fileVariables,
        scripts: { prerequest: parsed.prerequest, ...(parsed.prerequest ? { where: "the request" } : {}) },
        ...(unsupported === undefined ? {} : { unsupported }),
        notes,
    };
}

function load(config: HttpConfig, name: string): Collection {
    const problems: Problem[] = [];
    const root = config.folder;
    const environments = environmentsOf(root, problems);
    const secretNames = declaredSecrets(environments.values());
    const reading: Reading = { collection: name, secretNames };

    const requests: SavedRequest[] = [];
    if (!fs.existsSync(root)) {
        problems.push({ file: ".", key: "", message: "the folder does not exist", level: "error" });
    } else {
        for (const file of findFiles(root, problems)) {
            const relative = path.relative(root, file);
            let text: string;
            try {
                text = readText(file, FILE_MAX_BYTES);
            } catch (error) {
                problems.push({ file: relative, key: "", message: whyNotRead(error), level: "error" });
                continue;
            }
            // The variables a file defines with `@name = value` belong to every request in it.
            const fileVariables = new Map<string, string>();
            const parsed = splitBlocks(text).flatMap((block) => parseBlock(block, fileVariables) ?? []);
            parsed.forEach((request, index) => {
                requests.push(requestOf(request, relative, index + 1, fileVariables, reading));
            });
        }
    }
    return { name, root, requests, environments, variables: new Map(), auth: { kind: "none" }, problems };
}

export const httpFile: Source<HttpConfig> = { kind: "http", check, load };
