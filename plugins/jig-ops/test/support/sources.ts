// The plugin's own source files, for the tests that check what the code is allowed to contain.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The root of the repository. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const SRC = path.join(ROOT, "plugins", "jig-ops", "src");

export interface Source {
    /** The path below `src/`, with forward slashes: `runtime/kubernetes/kubectl.ts`. */
    file: string;
    text: string;
}

function walk(folder: string, below: string): Source[] {
    const found: Source[] = [];
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = below === "" ? entry.name : `${below}/${entry.name}`;
        if (entry.isDirectory()) found.push(...walk(path.join(folder, entry.name), file));
        else if (entry.name.endsWith(".ts")) found.push({ file, text: fs.readFileSync(path.join(folder, entry.name), "utf8") });
    }
    return found.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** Every `.ts` file below `src/`, in path order. */
export function sources(): Source[] {
    return walk(SRC, "");
}

/** The code of a file without its comments. */
export function codeOf(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
}
