// The file system as the rules look at it. The rules are a pure function of this view, so a test can give them a
// machine that does not exist (a Mac, a WSL home, links that loop) without touching the real one.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";

export type EntryType = "file" | "directory" | "link" | "other";

export interface FileView {
    /** What is at `path` without following a link, or undefined when nothing is. */
    type(path: string): EntryType | undefined;
    /** The path with every link followed, or undefined when it does not lead to anything. */
    real(path: string): string | undefined;
    /** The names in a folder, or an empty list when it cannot be listed. */
    list(path: string): string[];
    /** The text of a small file, or undefined. */
    read(path: string): string | undefined;
    /** Where a link points, as written. */
    link(path: string): string | undefined;
}

/** Longest file the rules read (a `.git` pointer, a git configuration). */
const MAX_READ_BYTES = 256 * 1024;

export const nodeFiles: FileView = {
    type(path) {
        try {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) return "link";
            if (stat.isDirectory()) return "directory";
            return stat.isFile() ? "file" : "other";
        } catch {
            return undefined;
        }
    },
    real(path) {
        try {
            return realpathSync(path);
        } catch {
            return undefined;
        }
    },
    list(path) {
        try {
            return readdirSync(path);
        } catch {
            return [];
        }
    },
    read(path) {
        try {
            if (statSync(path).size > MAX_READ_BYTES) return undefined;
            return readFileSync(path, "utf8");
        } catch {
            return undefined;
        }
    },
    link(path) {
        try {
            return readlinkSync(path);
        } catch {
            return undefined;
        }
    },
};
