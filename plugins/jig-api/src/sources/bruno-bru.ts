// The `.bru` language of Bruno, read for what this plugin uses. A file is blocks. A dictionary block holds `key: value` lines
// (a `~` before the key switches the line off), a text block holds lines of code or data, and an array block holds names:
//
//   get {                       body:json {                  vars:secret [
//     url: {{baseUrl}}/orders     {"sku": "{{sku}}"}           token,
//     auth: bearer              }                              apiKey
//   }                                                        ]
//
// A block ends at a `}` or `]` in the first column. Nothing here runs a script: a script block is only noticed.
// Format: https://docs.usebruno.com/bru-lang/language
import { apiKeyAuth, fileBody, filesOf, hasText, noBody, oauth2Auth, refusedAuth, textBody, urlencodedBody } from "./bruno-types.ts";
import type { AuthSetting, ParsedBody, ParsedDefaults, ParsedEnvironment, ParsedRequest, ParsedVariable, Pairs, Report } from "./bruno-types.ts";
import type { FormField } from "../model.ts";

interface Pair {
    key: string;
    value: string;
    enabled: boolean;
}

interface Block {
    name: string;
    /** The pairs of a dictionary block. */
    pairs: Pair[];
    /** The text of a text block, the names of an array block, or the value of a single-line entry such as `extends: x`. */
    text: string;
    items: string[];
}

/** Blocks whose lines are text and not pairs. */
const TEXT_BLOCKS: ReadonlySet<string> = new Set([
    "body", "body:json", "body:text", "body:xml", "body:sparql", "body:graphql", "body:graphql:vars", "tests", "docs",
    "script:pre-request", "script:post-response", "script:grpc:before-call-start", "script:grpc:before-message-send",
    "script:grpc:after-message-receive", "script:grpc:after-call-end",
]);

const HEADER = /^([A-Za-z][\w:.-]*)\s*([{[])\s*$/;
const SINGLE = /^(extends|color)\s*:\s*(.*)$/;
/** An array block that opens and closes on one line: `vars:secret [token, apiKey]`. */
const ONE_LINE_ARRAY = /^([A-Za-z][\w:.-]*)\s*\[(.*)\]\s*$/;
/** A pair: a key (quoted, or without spaces and colons), a colon, and the rest of the line. */
const PAIR = /^\s*(~?"(?:[^"\\]|\\.)*"|[^\s:]+)\s*:\s?(.*)$/;
/** `@description('''...''')` and the like, on a line of their own before a pair. A pair whose key starts with `@` has a colon. */
const ANNOTATION = /^\s*@[^\s():]+(?:\(.*)?$/;

const outdent = (line: string): string => line.replace(/^ {2}/, "");

function keyOf(raw: string): { key: string; enabled: boolean } {
    const quoted = /^(~?)"((?:[^"\\]|\\.)*)"$/.exec(raw);
    if (quoted !== null) return { key: (quoted[2] as string).replace(/\\(.)/g, "$1"), enabled: quoted[1] !== "~" };
    return raw.startsWith("~") ? { key: raw.slice(1), enabled: false } : { key: raw, enabled: true };
}

/** The lines of a block: from `start` to the line that closes it (`}` or `]` in the first column). */
function bodyOf(lines: readonly string[], start: number, close: string): { body: string[]; next: number } | undefined {
    for (let at = start; at < lines.length; at++) {
        if ((lines[at] as string).trimEnd() === close) return { body: lines.slice(start, at), next: at + 1 };
    }
    return undefined;
}

/** The pairs in the lines of a dictionary block. A value in `'''` may run over several lines, each indented by four spaces. */
function pairsOf(body: readonly string[]): Pair[] {
    const pairs: Pair[] = [];
    for (let at = 0; at < body.length; at++) {
        const line = body[at] as string;
        if (line.trim() === "") continue;
        if (ANNOTATION.test(line)) {
            // A description may be a multi-line text in `'''`: skip to the line that closes it.
            if (/'''/.test(line) && (line.match(/'''/g) ?? []).length === 1) {
                while (at + 1 < body.length && !(body[at + 1] as string).includes("'''")) at++;
                at++;
            }
            continue;
        }
        const match = PAIR.exec(line);
        if (match === null) continue;
        const { key, enabled } = keyOf(match[1] as string);
        let value = (match[2] as string).trim();
        if (value.startsWith("'''")) {
            const rest = value.slice(3);
            const closes = rest.indexOf("'''");
            if (closes >= 0) {
                value = rest.slice(0, closes).trim();
            } else {
                const lines = [rest];
                while (at + 1 < body.length) {
                    at++;
                    const next = body[at] as string;
                    const end = next.indexOf("'''");
                    if (end >= 0) {
                        lines.push(next.slice(0, end));
                        break;
                    }
                    lines.push(next);
                }
                value = lines.map((each) => each.slice(4)).join("\n").trim();
            }
        } else if (value.startsWith("[") && !value.includes("]")) {
            // A list value, such as the tags of a request: not used here.
            while (at + 1 < body.length && !(body[at + 1] as string).includes("]")) at++;
            at++;
            value = "";
        }
        pairs.push({ key, value, enabled });
    }
    return pairs;
}

/** The blocks of a `.bru` file, in order. What cannot be read is reported and skipped; the rest is still read. */
export function readBlocks(source: string, report: Report): Block[] {
    const lines = source.replace(/^﻿/, "").split(/\r\n|\r|\n/);
    const blocks: Block[] = [];
    let at = 0;
    while (at < lines.length) {
        const line = lines[at] as string;
        if (line.trim() === "") {
            at++;
            continue;
        }
        const list = ONE_LINE_ARRAY.exec(line);
        if (list !== null) {
            const items = (list[2] as string).split(",").map((item) => item.trim()).filter((item) => item !== "");
            blocks.push({ name: list[1] as string, pairs: [], text: "", items });
            at++;
            continue;
        }
        const single = SINGLE.exec(line);
        if (single !== null) {
            blocks.push({ name: single[1] as string, pairs: [], text: (single[2] as string).trim(), items: [] });
            at++;
            continue;
        }
        const header = HEADER.exec(line);
        if (header === null) {
            report(`line ${at + 1}`, "is not a block of a .bru file, and is skipped", "warning");
            at++;
            continue;
        }
        const name = header[1] as string;
        const opens = header[2] as string;
        const found = bodyOf(lines, at + 1, opens === "{" ? "}" : "]");
        if (found === undefined) {
            report(`line ${at + 1}`, `the block ${name} is never closed, so the rest of the file is skipped`, "error");
            break;
        }
        at = found.next;
        if (opens === "[") {
            const items = found.body.join("\n").split(/[,\n]/).map((item) => item.trim()).filter((item) => item !== "");
            blocks.push({ name, pairs: [], text: "", items });
        } else if (TEXT_BLOCKS.has(name) || name.startsWith("script:")) {
            let body = found.body.map(outdent);
            while (body.length > 0 && (body[0] as string).trim() === "") body = body.slice(1);
            blocks.push({ name, pairs: [], text: body.join("\n"), items: [] });
        } else if (name.startsWith("example") || name === "app") {
            // Examples and the app block are not read.
        } else {
            blocks.push({ name, pairs: pairsOf(found.body), text: "", items: [] });
        }
    }
    return blocks;
}

// ---------------------------------------------------------------------------------------------------------------------

const find = (blocks: readonly Block[], name: string): Block | undefined => blocks.find((block) => block.name === name);

/** The enabled pairs of every block with this name. */
function enabledPairs(blocks: readonly Block[], ...names: string[]): Pairs {
    const pairs = blocks.filter((block) => names.includes(block.name)).flatMap((block) => block.pairs);
    return pairs.filter((pair) => pair.enabled).map((pair) => [pair.key, pair.value] as const);
}

function pairValue(block: Block | undefined, key: string): string {
    return block?.pairs.find((pair) => pair.key === key)?.value ?? "";
}

/** The sign-in a mode names, from the `auth:*` blocks of the file. */
function authOf(blocks: readonly Block[], mode: string): AuthSetting {
    switch (mode) {
        case "":
        case "none":
            return { kind: "none" };
        case "inherit":
            return { kind: "inherit" };
        case "bearer":
            return { kind: "set", auth: { kind: "bearer", token: pairValue(find(blocks, "auth:bearer"), "token") } };
        case "basic": {
            const block = find(blocks, "auth:basic");
            return { kind: "set", auth: { kind: "basic", username: pairValue(block, "username"), password: pairValue(block, "password") } };
        }
        case "apikey": {
            const block = find(blocks, "auth:apikey");
            return apiKeyAuth(pairValue(block, "key"), pairValue(block, "value"), pairValue(block, "placement").replace("queryparams", "query"));
        }
        case "oauth2": {
            const block = find(blocks, "auth:oauth2");
            const get = (key: string): string => pairValue(block, key);
            return oauth2Auth({
                grant: get("grant_type"),
                accessTokenUrl: get("access_token_url"),
                clientId: get("client_id"),
                clientSecret: get("client_secret"),
                username: get("username"),
                password: get("password"),
                scope: get("scope"),
                credentialsPlacement: get("credentials_placement") || "body",
                tokenPlacement: get("token_placement"),
                tokenPrefix: get("token_header_prefix"),
            });
        }
        default:
            return refusedAuth(mode);
    }
}

/** `@contentType(text/plain)` at the end of a multipart value: the value, and the type. */
function withContentType(value: string): { value: string; contentType?: string } {
    const match = /^(.*?)\s*@contentType\((.*?)\)\s*$/s.exec(value);
    return match === null ? { value } : { value: match[1] as string, contentType: match[2] as string };
}

function bodyFrom(blocks: readonly Block[], mode: string): ParsedBody {
    const text = (name: string): string => find(blocks, name)?.text ?? "";
    switch (mode) {
        case "":
        case "none":
            return noBody();
        case "json":
            return textBody("json", text("body:json") || text("body"));
        case "text":
            return textBody("text", text("body:text"));
        case "xml":
            return textBody("xml", text("body:xml"));
        case "graphql": {
            const query = text("body:graphql");
            if (!hasText(query)) return noBody();
            const variables = text("body:graphql:vars");
            return {
                body: { kind: "graphql", query, ...(hasText(variables) ? { variables } : {}) },
                contentType: "application/json",
                notes: [],
            };
        }
        case "formUrlEncoded": {
            return urlencodedBody(enabledPairs(blocks, "body:form-urlencoded").map(([name, value]) => ({ kind: "text", name, value })));
        }
        case "multipartForm": {
            const fields: FormField[] = [];
            const notes: string[] = [];
            for (const [name, raw] of enabledPairs(blocks, "body:multipart-form")) {
                const { value, contentType } = withContentType(raw);
                const typed = contentType === undefined ? {} : { contentType };
                const files = filesOf(value);
                if (files === undefined) fields.push({ kind: "text", name, value, ...typed });
                else if (files.length === 0) notes.push(`the file field "${name}" has no file chosen, so it is left out`);
                else for (const file of files) fields.push({ kind: "file", name, file: { path: file }, ...typed });
            }
            return fields.length === 0 ? { notes } : { body: { kind: "form", encoding: "multipart", fields }, notes };
        }
        case "file": {
            // The entries are `file1: @file(path)`; the enabled one is the body.
            const entries = enabledPairs(blocks, "body:file").map(([, value]) => withContentType(value));
            const entry = entries.find((each) => filesOf(each.value) !== undefined);
            const file = entry === undefined ? undefined : filesOf(entry.value)?.[0];
            if (entry === undefined || file === undefined) return { notes: ["its body is a file, but no file is chosen, so it has no body"] };
            return fileBody(file, entry.contentType);
        }
        default:
            return { unsupported: `the body type "${mode}" is not sent`, notes: [] };
    }
}

const VERBS = ["get", "post", "put", "delete", "patch", "options", "head", "connect", "trace"];

function seqOf(meta: Block | undefined): number | undefined {
    const seq = Number(pairValue(meta, "seq"));
    return pairValue(meta, "seq") !== "" && Number.isFinite(seq) ? seq : undefined;
}

/** The variables set before the request. A name that starts with `@` is local to the request; the `@` is not part of the name. */
function varsOf(blocks: readonly Block[]): Map<string, string> {
    const found = new Map<string, string>();
    for (const [name, value] of enabledPairs(blocks, "vars:pre-request")) found.set(name.replace(/^@/, ""), value);
    return found;
}

/** A request file. */
export function readRequest(source: string, report: Report): ParsedRequest | undefined {
    const blocks = readBlocks(source, report);
    const meta = find(blocks, "meta");
    const verb = blocks.find((block) => VERBS.includes(block.name) || block.name === "http" || block.name === "grpc" || block.name === "ws");
    if (verb === undefined) {
        report("", "has no request: no get, post, put, delete, patch, options, head, grpc or ws block", "warning");
        return undefined;
    }
    const type = verb.name === "grpc" ? "grpc" : verb.name === "ws" ? "websocket" : pairValue(meta, "type") === "graphql" ? "graphql" : "http";
    const named = verb.name === "http" ? pairValue(verb, "method") : verb.name;
    const method = verb.name === "grpc" ? "GRPC" : verb.name === "ws" ? "WEBSOCKET" : named.toUpperCase();

    const pathParams = enabledPairs(blocks, "params:path");
    const notes: string[] = [];
    if (hasText(find(blocks, "script:post-response")?.text)) notes.push("its post-response script is ignored (scripts never run)");
    if (hasText(find(blocks, "tests")?.text)) notes.push("its tests are ignored (scripts never run)");
    if ((find(blocks, "vars:post-response")?.pairs.length ?? 0) > 0) {
        notes.push("its post-response variables are not set (nothing reads the answer)");
    }
    const tokenRequest = ["body", "headers", "queryparams"].map((part) => `auth:oauth2:additional_params:access_token_req:${part}`);
    if (tokenRequest.some((name) => find(blocks, name) !== undefined)) {
        notes.push("the additional parameters of its OAuth 2.0 token request are not sent");
    }
    if (pairValue(find(blocks, "settings"), "followRedirects") === "true") notes.push("followRedirects is ignored: redirects are never followed");

    return {
        name: pairValue(meta, "name") || undefined,
        seq: seqOf(meta),
        type,
        method,
        url: pairValue(verb, "url"),
        headers: enabledPairs(blocks, "headers"),
        pathParams,
        body: bodyFrom(blocks, pairValue(verb, "body")),
        auth: authOf(blocks, pairValue(verb, "auth")),
        vars: varsOf(blocks),
        prerequest: hasText(find(blocks, "script:pre-request")?.text),
        notes,
        assertions: enabledPairs(blocks, "assert").map(([expression, value]) => `${expression} ${value}`.trim()),
        docs: hasText(find(blocks, "docs")?.text) ? (find(blocks, "docs")!.text as string).trim() : undefined,
    };
}

/** `collection.bru` and `folder.bru`: what is set for everything below. */
export function readDefaults(source: string, report: Report): ParsedDefaults {
    const blocks = readBlocks(source, report);
    const meta = find(blocks, "meta");
    const mode = pairValue(find(blocks, "auth"), "mode");
    return {
        name: pairValue(meta, "name") || undefined,
        seq: seqOf(meta),
        headers: enabledPairs(blocks, "headers"),
        auth: authOf(blocks, mode),
        vars: varsOf(blocks),
        prerequest: hasText(find(blocks, "script:pre-request")?.text),
        docs: hasText(find(blocks, "docs")?.text) ? (find(blocks, "docs")!.text as string).trim() : undefined,
    };
}

/** An environment file: `vars`, `vars:secret` (names only), `vars:externalsecrets:<manager>`, `extends` and `color`. */
export function readEnvironment(source: string, report: Report): ParsedEnvironment {
    const blocks = readBlocks(source, report);
    const variables: ParsedVariable[] = [];
    for (const block of blocks) {
        if (block.name === "vars") {
            for (const pair of block.pairs) if (pair.enabled) variables.push({ name: pair.key, value: pair.value, secret: false });
        } else if (block.name === "vars:secret") {
            // A name switched off with ~ is not a variable, and an annotation line is not a name.
            for (const item of block.items) if (!item.startsWith("~") && !item.startsWith("@")) variables.push({ name: item, value: undefined, secret: true });
        } else if (block.name.startsWith("vars:externalsecrets:")) {
            const manager = block.name.slice("vars:externalsecrets:".length);
            for (const pair of block.pairs) if (pair.enabled) variables.push({ name: pair.key, value: undefined, secret: true, external: manager });
        }
    }
    // `extends: name`, `extends [a, b]` or an array block: the environments it takes variables from.
    const parents = blocks.filter((block) => block.name === "extends").flatMap((block) => [...block.text.split(","), ...block.items]);
    const named = parents.map((part) => part.trim().replace(/^"(.*)"$/, "$1")).filter((part) => part !== "");
    return { name: undefined, variables, extends: named, dotEnv: false };
}
