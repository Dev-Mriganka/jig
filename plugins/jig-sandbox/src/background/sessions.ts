// What a session keeps on disk for its tasks, and how a crashed session's leftovers are found: a private folder per session
// under `<agent folder>/jig-sandbox/background` (a folder the sandbox cannot write, so a command cannot swap a log for a link
// to a file Pi can read and the command cannot), an `owner.pid` file naming the Pi process, and a `manifest.json` naming the
// shells of the tasks that run. The next session start reads them and stops what a crash left behind.
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ProcessPort } from "./process.ts";

export const OWNER_FILE = "owner.pid";
export const MANIFEST_FILE = "manifest.json";
/** The only names clean-up ever removes from a session's folder. */
const OURS = /^(bg-\d+\.log(\.1)?|manifest\.json|owner\.pid)$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A name that is safe as a folder: letters, digits, dots, dashes and underscores. */
function safeName(name: string): string {
    const clean = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    return /^\.*$/.test(clean) ? "_" : clean;
}

export function backgroundRoot(agentDir: string): string {
    return path.join(agentDir, "jig-sandbox", "background");
}

export function sessionFolder(agentDir: string, sessionId: string): string {
    return path.join(backgroundRoot(agentDir), safeName(sessionId));
}

/** Makes a folder that only this user can enter. */
function ensureFolder(folder: string): string {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    return folder;
}

export function ensureSessionFolder(agentDir: string, sessionId: string): string {
    return ensureFolder(sessionFolder(agentDir, sessionId));
}

function writeAtomic(file: string, text: string): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
}

export interface ManifestEntry {
    id: string;
    /** The task's shell, which leads its process group. */
    pid: number;
    /** Field 22 of its `/proc/<pid>/stat`: with the pid it names one process for good. */
    startTicks: string;
}

export function writeManifest(folder: string, entries: readonly ManifestEntry[]): void {
    writeAtomic(path.join(folder, MANIFEST_FILE), JSON.stringify({ tasks: entries }));
}

export function writeOwner(folder: string, pid: number, startTicks: string | undefined): void {
    writeAtomic(path.join(folder, OWNER_FILE), `${pid} ${startTicks ?? ""}\n`);
}

function readOwner(folder: string): { pid: number; startTicks: string } | undefined {
    try {
        const [pid, ticks] = readFileSync(path.join(folder, OWNER_FILE), "utf8").trim().split(" ");
        const number = Number(pid);
        return Number.isInteger(number) && number > 1 && ticks ? { pid: number, startTicks: ticks } : undefined;
    } catch {
        return undefined;
    }
}

function readManifest(folder: string): ManifestEntry[] {
    try {
        const parsed = JSON.parse(readFileSync(path.join(folder, MANIFEST_FILE), "utf8")) as { tasks?: unknown };
        if (!Array.isArray(parsed.tasks)) return [];
        return parsed.tasks.filter(
            (entry): entry is ManifestEntry =>
                typeof entry?.id === "string" &&
                Number.isInteger(entry.pid) &&
                entry.pid > 1 &&
                typeof entry.startTicks === "string",
        );
    } catch {
        return [];
    }
}

export interface CleanupOptions {
    agentDir: string;
    port: ProcessPort;
    now: number;
    /** The session whose folder is in use now: never touched. */
    keep?: string;
}

/**
 * Stops what a session that is gone left behind, and removes its folder. A folder whose owner is still alive is never touched.
 * A task is stopped only when the process at its pid started at the time the manifest says, so a pid that was used again is
 * never hit. Returns what it did, for tests.
 */
export function cleanupSessions(options: CleanupOptions): { removed: string[]; killed: number[] } {
    const root = backgroundRoot(options.agentDir);
    const done = { removed: [] as string[], killed: [] as number[] };
    let names: string[];
    try {
        names = readdirSync(root);
    } catch {
        return done;
    }
    for (const name of names) {
        const folder = path.join(root, name);
        try {
            if (!lstatSync(folder).isDirectory()) continue;
        } catch {
            continue;
        }
        if (options.keep !== undefined && path.resolve(folder) === path.resolve(options.keep)) continue;
        const owner = readOwner(folder);
        if (owner && options.port.alive(owner.pid) && options.port.startTicks(owner.pid) === owner.startTicks) continue;
        for (const task of readManifest(folder)) {
            if (options.port.startTicks(task.pid) !== task.startTicks) continue;
            // The shell's descendants lead groups of their own under bubblewrap: stop those, then the shell's.
            for (const group of options.port.innerGroups(task.pid)) options.port.signal(-group, "SIGKILL");
            options.port.signal(-task.pid, "SIGKILL");
            done.killed.push(task.pid);
        }
        // A folder with nothing of ours in it that is not old is left for its owner to come back to; a dead owner's goes.
        let files: string[];
        try {
            files = readdirSync(folder);
        } catch {
            continue;
        }
        let newest = 0;
        for (const file of files) {
            try {
                newest = Math.max(newest, statSync(path.join(folder, file)).mtimeMs);
            } catch {
                // Gone.
            }
        }
        if (owner === undefined && options.now - newest < DAY_MS) continue;
        for (const file of files) {
            if (!OURS.test(file)) continue;
            try {
                if (lstatSync(path.join(folder, file)).isFile()) unlinkSync(path.join(folder, file));
            } catch {
                // Gone.
            }
        }
        try {
            rmdirSync(folder);
            done.removed.push(name);
        } catch {
            // A file that is not ours is in it: it stays, with the folder.
        }
    }
    return done;
}

/** Removes a session's folder when it ends. */
export function removeSessionFolder(folder: string): void {
    try {
        rmSync(folder, { recursive: true, force: true });
    } catch {
        // The next session start finds it.
    }
}
