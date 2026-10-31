// What the user allowed: ask-first folders and, in the `ask` network mode, hosts; each for this session or always. "Always" is
// kept in `<agent folder>/jig-sandbox/allowed.json`, a folder the sandbox locks and Pi's file tools guard, so the agent cannot
// approve itself by writing the file.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parsePattern } from "./network/hosts.ts";

export interface AllowedFile {
    folders: string[];
    /** Host patterns (`api.example.com:443`, `*.example.com`). */
    hosts: string[];
}

export interface Allowed {
    /** Folders allowed for this session or always, absolute, as the rules should drop them from the ask-first list. */
    folders(): string[];
    /** Host patterns allowed for this session or always. */
    hosts(): string[];
    /** What is kept for always. */
    always(): AllowedFile;
    /** What was allowed for this session only. */
    session(): string[];
    sessionHosts(): string[];
    allowSession(folder: string): void;
    /** Throws when the file cannot be written: the user is told, and the answer then counts for this session only. */
    allowAlways(folder: string): void;
    allowHostSession(host: string): void;
    allowHostAlways(host: string): void;
    /** Takes a folder or a host out of both lists. Returns what was removed. */
    forget(what: string): { folders: string[]; hosts: string[] };
    /** The file's problem, when it is unreadable, for `/sandbox`. */
    problem(): string | undefined;
}

const FILE = "allowed.json";
const EMPTY = (): AllowedFile => ({ folders: [], hosts: [] });

function readFile(file: string): { value: AllowedFile; problem?: string } {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        // No file is the usual case: nothing was allowed for always.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: EMPTY() };
        return { value: EMPTY(), problem: `${file} cannot be read: ${(error as Error).message}` };
    }
    try {
        const parsed = JSON.parse(text) as { folders?: unknown; hosts?: unknown } | null;
        const folders = parsed?.folders;
        const hosts = parsed?.hosts;
        if (!Array.isArray(folders) && !Array.isArray(hosts)) throw new Error("it has no list of folders or hosts");
        return {
            value: {
                folders: (Array.isArray(folders) ? folders : []).filter(
                    (item): item is string => typeof item === "string" && path.isAbsolute(item),
                ),
                hosts: (Array.isArray(hosts) ? hosts : []).filter(
                    (item): item is string => typeof item === "string" && parsePattern(item) !== undefined,
                ),
            },
        };
    } catch (error) {
        // A damaged file allows nothing: the safe reading of a file nobody can trust.
        return { value: EMPTY(), problem: `${file} is not valid and is ignored: ${(error as Error).message}` };
    }
}

/** The file's text: `hosts` is written only when there are some, so a file of folders stays as it was. */
function serialize(value: AllowedFile): string {
    return `${JSON.stringify(value.hosts.length === 0 ? { folders: value.folders } : value, null, 2)}\n`;
}

/** The allowed folders and hosts of a session. `agentDir` is read at each use, because Pi can be pointed elsewhere. */
export function createAllowed(agentDir: () => string): Allowed {
    const sessionFolders = new Set<string>();
    const sessionHosts = new Set<string>();
    const file = (): string => path.join(agentDir(), "jig-sandbox", FILE);

    const write = (value: AllowedFile): void => {
        const here = file();
        mkdirSync(path.dirname(here), { recursive: true, mode: 0o700 });
        const temporary = `${here}.${process.pid}.tmp`;
        writeFileSync(temporary, serialize(value), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, here);
    };
    const matches = (item: string, what: string): boolean =>
        item === what || item.endsWith(`/${what.replace(/^~\//, "")}`);

    return {
        folders: () => [...new Set([...sessionFolders, ...readFile(file()).value.folders])],
        hosts: () => [...new Set([...sessionHosts, ...readFile(file()).value.hosts])],
        always: () => readFile(file()).value,
        session: () => [...sessionFolders],
        sessionHosts: () => [...sessionHosts],
        problem: () => readFile(file()).problem,
        allowSession(folder) {
            sessionFolders.add(folder);
        },
        allowAlways(folder) {
            const current = readFile(file()).value;
            if (!current.folders.includes(folder)) current.folders.push(folder);
            write(current);
            sessionFolders.add(folder);
        },
        allowHostSession(host) {
            sessionHosts.add(host);
        },
        allowHostAlways(host) {
            const current = readFile(file()).value;
            if (!current.hosts.includes(host)) current.hosts.push(host);
            write(current);
            sessionHosts.add(host);
        },
        forget(what) {
            const removed = { folders: [] as string[], hosts: [] as string[] };
            const current = readFile(file()).value;
            const keptFolders = current.folders.filter((folder) => {
                const hit = matches(folder, what);
                if (hit) removed.folders.push(folder);
                return !hit;
            });
            const keptHosts = current.hosts.filter((host) => {
                const hit = host === what;
                if (hit) removed.hosts.push(host);
                return !hit;
            });
            for (const folder of [...sessionFolders]) {
                if (matches(folder, what)) {
                    sessionFolders.delete(folder);
                    if (!removed.folders.includes(folder)) removed.folders.push(folder);
                }
            }
            for (const host of [...sessionHosts]) {
                if (host === what) {
                    sessionHosts.delete(host);
                    if (!removed.hosts.includes(host)) removed.hosts.push(host);
                }
            }
            if (keptFolders.length !== current.folders.length || keptHosts.length !== current.hosts.length) {
                write({ folders: keptFolders, hosts: keptHosts });
            }
            return removed;
        },
    };
}
