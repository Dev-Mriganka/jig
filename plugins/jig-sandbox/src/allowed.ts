// What the user allowed: ask-first folders, for this session or always. "Always" is kept in
// `<agent folder>/jig-sandbox/allowed.json`, a folder the sandbox locks and Pi's file tools guard, so the agent cannot
// approve itself by writing the file. Hosts (for the `ask` network mode) are kept in the same file by a later build.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AllowedFile {
    folders: string[];
}

export interface Allowed {
    /** Folders allowed for this session or always, absolute, as the rules should drop them from the ask-first list. */
    folders(): string[];
    /** What is kept for always. */
    always(): AllowedFile;
    /** What was allowed for this session only. */
    session(): string[];
    allowSession(folder: string): void;
    /** Throws when the file cannot be written: the user is told, and the answer then counts for this session only. */
    allowAlways(folder: string): void;
    /** Takes a folder or a host out of both lists. Returns what was removed. */
    forget(what: string): { folders: string[] };
    /** The file's problem, when it is unreadable, for `/sandbox`. */
    problem(): string | undefined;
}

const FILE = "allowed.json";

function readFile(file: string): { value: AllowedFile; problem?: string } {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        // No file is the usual case: nothing was allowed for always.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: { folders: [] } };
        return { value: { folders: [] }, problem: `${file} cannot be read: ${(error as Error).message}` };
    }
    try {
        const parsed = JSON.parse(text) as unknown;
        const folders = (parsed as { folders?: unknown } | null)?.folders;
        if (!Array.isArray(folders)) throw new Error("it has no list of folders");
        return {
            value: {
                folders: folders.filter((item): item is string => typeof item === "string" && path.isAbsolute(item)),
            },
        };
    } catch (error) {
        // A damaged file allows nothing: the safe reading of a file nobody can trust.
        return { value: { folders: [] }, problem: `${file} is not valid and is ignored: ${(error as Error).message}` };
    }
}

/** The allowed folders of a session. `agentDir` is read at each use, because Pi can be pointed elsewhere. */
export function createAllowed(agentDir: () => string): Allowed {
    const sessionFolders = new Set<string>();
    const file = (): string => path.join(agentDir(), "jig-sandbox", FILE);

    return {
        folders: () => [...new Set([...sessionFolders, ...readFile(file()).value.folders])],
        always: () => readFile(file()).value,
        session: () => [...sessionFolders],
        problem: () => readFile(file()).problem,
        allowSession(folder) {
            sessionFolders.add(folder);
        },
        allowAlways(folder) {
            const here = file();
            const current = readFile(here).value;
            if (!current.folders.includes(folder)) current.folders.push(folder);
            mkdirSync(path.dirname(here), { recursive: true, mode: 0o700 });
            const temporary = `${here}.${process.pid}.tmp`;
            writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
            chmodSync(temporary, 0o600);
            renameSync(temporary, here);
            sessionFolders.add(folder);
        },
        forget(what) {
            const removed: string[] = [];
            const current = readFile(file()).value;
            const kept = current.folders.filter((folder) => {
                const matches = folder === what || folder.endsWith(`/${what.replace(/^~\//, "")}`);
                if (matches) removed.push(folder);
                return !matches;
            });
            for (const folder of [...sessionFolders]) {
                if (folder === what || folder.endsWith(`/${what.replace(/^~\//, "")}`)) {
                    sessionFolders.delete(folder);
                    if (!removed.includes(folder)) removed.push(folder);
                }
            }
            if (kept.length !== current.folders.length) {
                const here = file();
                const temporary = `${here}.${process.pid}.tmp`;
                writeFileSync(temporary, `${JSON.stringify({ folders: kept }, null, 2)}\n`, { mode: 0o600 });
                renameSync(temporary, here);
            }
            return { folders: removed };
        },
    };
}
