// What the plugin keeps on disk, in jig-core's state folder: one run folder per child, `agents/<session>/<child>/`, with `meta.json`
// (who the child is and which process runs it), `system-prompt.md` and `report.md`. The meta file is how a later session finds a child
// that outlived its parent. Pi's own session files are not touched.
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** `$JIG_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/jig`: jig-core's rule, repeated, because a plugin never imports its modules. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    const chosen = env.JIG_STATE_DIR;
    if (chosen !== undefined && chosen !== "") return path.resolve(chosen);
    const xdg = env.XDG_STATE_HOME;
    const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".local", "state");
    return path.join(base, "jig");
}

/** Pi's agent folder: `$PI_CODING_AGENT_DIR` with a leading `~` expanded, else `~/.pi/agent`. Pi's rule, repeated. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
    const chosen = env.PI_CODING_AGENT_DIR;
    if (chosen !== undefined && chosen !== "") {
        if (chosen === "~") return homedir();
        return chosen.startsWith("~/") ? path.join(homedir(), chosen.slice(2)) : path.resolve(chosen);
    }
    return path.join(homedir(), ".pi", "agent");
}

export const agentsRoot = (state: string): string => path.join(state, "agents");

/** A session or child id as a folder name: letters, digits, dot, dash and underscore. */
export function segment(text: string): string {
    const clean = text.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
    return clean === "" ? "_" : clean.slice(0, 100);
}

export const runDirOf = (state: string, session: string, id: string): string =>
    path.join(agentsRoot(state), segment(session), segment(id));

export type StoredState = "starting" | "running" | "finished" | "stopped" | "failed" | "lost";

/** Who a child is and which process runs it. */
export interface Meta {
    version: 1;
    id: string;
    name: string;
    role: string;
    session: string;
    /** The child's process and an identity for it that does not repeat when the id is reused. */
    pid?: number;
    pidStart?: string;
    /** The parent Pi, the same way. */
    parentPid: number;
    parentStart?: string;
    state: StoredState;
    startedAt: string;
    updatedAt: string;
    cwd: string;
    model?: string;
    branch?: string;
    worktree?: string;
    /** How many times this child was started: 1, then one more for each resume. */
    generation: number;
    note?: string;
}

const STATES: readonly string[] = ["starting", "running", "finished", "stopped", "failed", "lost"];

function isMeta(value: unknown): value is Meta {
    if (typeof value !== "object" || value === null) return false;
    const meta = value as Record<string, unknown>;
    return (
        meta.version === 1 &&
        typeof meta.id === "string" &&
        typeof meta.name === "string" &&
        typeof meta.role === "string" &&
        typeof meta.session === "string" &&
        typeof meta.parentPid === "number" &&
        typeof meta.state === "string" &&
        STATES.includes(meta.state) &&
        typeof meta.startedAt === "string" &&
        typeof meta.cwd === "string" &&
        typeof meta.generation === "number"
    );
}

/** Creates a folder that only the user can enter. */
export function privateFolder(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        chmodSync(dir, 0o700);
    } catch {
        // A folder we do not own keeps its mode; the file mode below still holds.
    }
}

function atomicWrite(file: string, text: string): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
}

export function writeMeta(dir: string, meta: Meta): void {
    privateFolder(dir);
    atomicWrite(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

export function readMeta(dir: string): Meta | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
        return isMeta(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function writeText(dir: string, name: string, text: string): string {
    privateFolder(dir);
    const file = path.join(dir, name);
    atomicWrite(file, text);
    return file;
}

export interface StoredChild {
    dir: string;
    meta: Meta;
}

/** Every child with a meta file, in every session. A folder without a readable meta file is skipped. */
export function listChildren(root: string): StoredChild[] {
    const found: StoredChild[] = [];
    let sessions: string[];
    try {
        sessions = readdirSync(root);
    } catch {
        return found;
    }
    for (const session of sessions) {
        let children: string[];
        try {
            children = readdirSync(path.join(root, session));
        } catch {
            continue;
        }
        for (const child of children) {
            const dir = path.join(root, session, child);
            const meta = readMeta(dir);
            if (meta !== undefined) found.push({ dir, meta });
        }
    }
    return found;
}

/** Run folders whose meta file is older than `maxAgeMs` and whose child is not running are removed. Returns how many. */
export function removeOld(root: string, nowMs: number, maxAgeMs: number, running: (meta: Meta) => boolean): number {
    let removed = 0;
    for (const { dir, meta } of listChildren(root)) {
        let modified: number;
        try {
            modified = statSync(path.join(dir, "meta.json")).mtimeMs;
        } catch {
            continue;
        }
        if (nowMs - modified < maxAgeMs || running(meta)) continue;
        try {
            rmSync(dir, { recursive: true, force: true });
            removed++;
        } catch {
            // It stays until the next session.
        }
    }
    // A session folder left empty goes too.
    try {
        for (const session of readdirSync(root)) {
            const folder = path.join(root, session);
            if (existsSync(folder) && statSync(folder).isDirectory() && readdirSync(folder).length === 0) {
                rmSync(folder, { recursive: true, force: true });
            }
        }
    } catch {
        // Nothing to tidy.
    }
    return removed;
}
