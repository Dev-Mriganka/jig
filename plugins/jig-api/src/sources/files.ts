// Reading files for the sources, and keeping a request's file references inside its collection's folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `~/work/x` is `x` in the user's work folder. Any other path is left alone. */
export function expandHome(file: string): string {
    if (file === "~") return os.homedir();
    return file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
}

/** The reason a file could not be read, in words that do not repeat the path. */
export function readFailure(error: unknown): string {
    const code =
        typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
    switch (code) {
        case "ENOENT":
            return "no such file";
        case "EACCES":
            return "permission denied";
        case "EISDIR":
            return "is a folder, not a file";
        case "ENOTDIR":
            return "is not a folder";
        default:
            return code === "" ? "could not be read" : `could not be read (${code})`;
    }
}

/** Why a read failed: our own words for a file that is too large, else the reason for the error code. */
export function whyNotRead(error: unknown): string {
    return error instanceof Error && !("code" in error) ? error.message : readFailure(error);
}

/** The text of a file, or an Error whose message says why not. A file over `maxBytes` is refused, not cut. */
export function readText(file: string, maxBytes: number): string {
    const size = fs.statSync(file).size;
    if (size > maxBytes) throw new Error(`is larger than ${Math.round(maxBytes / 1024)} KiB`);
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

/** The file's path with every link followed, if that lies inside `root`; else the reason it does not. */
export function confined(
    root: string,
    file: string,
): { path: string; problem?: undefined } | { path?: undefined; problem: string } {
    let base: string;
    let real: string;
    try {
        base = fs.realpathSync(root);
    } catch (error) {
        return { problem: `the collection's folder ${readFailure(error)}` };
    }
    try {
        real = fs.realpathSync(path.resolve(base, file));
    } catch (error) {
        return { problem: readFailure(error) };
    }
    if (real !== base && !real.startsWith(base + path.sep)) {
        return {
            problem:
                "is outside the collection's folder (after following links), and a request may only use files inside it",
        };
    }
    return { path: real };
}
