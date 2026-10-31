// What reading a Bruno folder keeps track of, and the small helpers every part of it uses: which language the folder is in, the files
// that are not requests, how a reader reports what it cannot understand, and how a file is read. `Reading` is what `load` collects.
import fs from "node:fs";
import path from "node:path";
import type { Problem } from "../model.ts";
import type { Report } from "./bruno-types.ts";
import { readText, whyNotRead } from "./files.ts";

type Format = "yaml" | "bru";

const FILE_MAX_BYTES = 1024 * 1024;
export const MAX_FILES = 1000;
export const MAX_DEPTH = 12;

/** The variables of the process environment, which Bruno reads from a `.env` file. They are secrets here. */
export const PROCESS_ENV = "process.env.";

/** What `load` collects while it reads. */
export interface Reading {
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
export function reporter(problems: Problem[], file: string): Report {
    return (key, message, level) => problems.push({ file, key, message, level });
}

export function textOf(file: string, relative: string, problems: Problem[]): string | undefined {
    try {
        return readText(file, FILE_MAX_BYTES);
    } catch (error) {
        problems.push({ file: relative, key: "", message: whyNotRead(error), level: "error" });
        return undefined;
    }
}

/** Which language the collection folder is in, by its root file; undefined when it is neither. */
export function formatOf(root: string): Format | undefined {
    if (fs.existsSync(path.join(root, "opencollection.yml"))) return "yaml";
    if (fs.existsSync(path.join(root, "bruno.json"))) return "bru";
    return undefined;
}

export const extensionOf = (format: Format): readonly string[] => (format === "yaml" ? [".yml", ".yaml"] : [".bru"]);
export const folderFileOf = (format: Format): string => (format === "yaml" ? "folder.yml" : "folder.bru");
/** The files of a folder that are not requests. */
export const NOT_REQUESTS: ReadonlySet<string> = new Set([
    "folder.yml",
    "folder.yaml",
    "folder.bru",
    "collection.bru",
    "opencollection.yml",
    "opencollection.yaml",
]);
