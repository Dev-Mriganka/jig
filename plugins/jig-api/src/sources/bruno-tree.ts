// The folder of a Bruno collection as a tree: the requests and folders in a directory (or in the bundled items of `opencollection.yml`),
// read but not yet built, put in Bruno's order, and then built into saved requests level by level.
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../engine/values.ts";
import type { SavedRequest } from "../model.ts";
import * as bru from "./bruno-bru.ts";
import * as opencollection from "./bruno-yaml.ts";
import type { ParsedDefaults, ParsedRequest } from "./bruno-types.ts";
import { readFailure } from "./files.ts";
import { parseYaml } from "./yaml.ts";
import { MAX_DEPTH, MAX_FILES, NOT_REQUESTS, extensionOf, folderFileOf, reporter, textOf } from "./bruno-reading.ts";
import type { Reading } from "./bruno-reading.ts";
import { belowFolder, requestOf } from "./bruno-request.ts";
import type { Level } from "./bruno-request.ts";

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

export function readDefaultsFile(file: string, relative: string, reading: Reading): ParsedDefaults | undefined {
    if (!fs.existsSync(file)) return undefined;
    const content = textOf(file, relative, reading.problems);
    if (content === undefined) return undefined;
    const report = reporter(reading.problems, relative);
    if (reading.format === "bru") return bru.readDefaults(content, report);
    const raw = parseYaml(content, relative, reading.problems);
    return raw === undefined ? undefined : opencollection.readDefaults(raw, report);
}

export const EMPTY_DEFAULTS: ParsedDefaults = {
    name: undefined,
    seq: undefined,
    headers: [],
    auth: { kind: "none" },
    vars: new Map(),
    prerequest: false,
    docs: undefined,
};

/** The requests and folders in a directory of the collection. */
export function entriesOfDirectory(directory: string, depth: number, reading: Reading): Entry[] {
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
                problems.push({
                    file: relative,
                    key: "",
                    message: `is more than ${MAX_DEPTH} folders deep, so it is not read`,
                    level: "warning",
                });
                continue;
            }
            const sub = path.join(directory, entry.name);
            const folderFile = folderFileOf(format);
            const defaults =
                readDefaultsFile(path.join(sub, folderFile), path.join(relative, folderFile), reading) ??
                EMPTY_DEFAULTS;
            entries.push({
                kind: "folder",
                seq: defaults.seq,
                name: defaults.name ?? entry.name,
                defaults: { ...defaults, name: defaults.name ?? entry.name },
                children: () => entriesOfDirectory(sub, depth + 1, reading),
            });
        } else if (
            entry.isFile() &&
            extensionOf(format).some((extension) => entry.name.endsWith(extension)) &&
            !NOT_REQUESTS.has(entry.name)
        ) {
            if (++reading.files > MAX_FILES) {
                if (reading.files === MAX_FILES + 1) {
                    const message = `is past the first ${MAX_FILES} files, so it and the rest are not read`;
                    problems.push({ file: relative, key: "", message, level: "warning" });
                }
                continue;
            }
            const parsed = readRequestFile(path.join(directory, entry.name), relative, reading);
            if (parsed !== undefined)
                entries.push({
                    kind: "request",
                    seq: parsed.seq,
                    name: parsed.name ?? entry.name,
                    parsed,
                    file: relative,
                });
        }
    }
    return entries;
}

/** The items of a bundled collection file (`items:` in `opencollection.yml`), which hold their folders inline. */
export function entriesOfItems(items: unknown, prefix: string, reading: Reading): Entry[] {
    if (!Array.isArray(items)) return [];
    const entries: Entry[] = [];
    (items as unknown[]).forEach((item, index) => {
        const key = `${prefix}[${index}]`;
        const report = reporter(reading.problems, "opencollection.yml");
        const kind = opencollection.itemKind(item);
        if (!isObject(item) || kind === "other") return;
        if (kind === "folder") {
            const defaults = opencollection.readDefaults(item, (inner, message, level) =>
                report(`${key}.${inner}`, message, level),
            );
            entries.push({
                kind: "folder",
                seq: defaults.seq,
                name: defaults.name ?? "(unnamed folder)",
                defaults: { ...defaults, name: defaults.name ?? "(unnamed folder)" },
                children: () => entriesOfItems(item.items, `${key}.items`, reading),
            });
        } else {
            const parsed = opencollection.readRequest(item, (inner, message, level) =>
                report(`${key}.${inner}`, message, level),
            );
            entries.push({
                kind: "request",
                seq: parsed.seq,
                name: parsed.name ?? "(unnamed)",
                parsed,
                file: `opencollection.yml: ${key}`,
            });
        }
    });
    return entries;
}

export function build(entries: readonly Entry[], level: Level, reading: Reading, found: SavedRequest[]): void {
    for (const entry of inOrder(entries)) {
        if (entry.kind === "request") found.push(requestOf(entry.parsed, entry.file, level, reading));
        else build(entry.children(), belowFolder(level, entry.defaults, entry.name), reading, found);
    }
}
