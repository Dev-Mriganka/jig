// The index file: opening it for writing, deleting it for a rebuild, and reading what `/lens status` reports.
//
// A connection lives only as long as one import or one status: nothing holds the file open between them, so deleting it
// for a rebuild never pulls it out from under a session that is idle.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./fields.ts";

/** How long a connection waits for another one's write to finish. Two Pi sessions may import at the same moment. */
const BUSY_MS = 5000;

/** SQLite's "busy" result, with any of its extended codes. */
function isBusy(error: unknown): boolean {
    const code = (error as { errcode?: unknown } | null)?.errcode;
    return typeof code === "number" && (code & 0xff) === 5;
}

/** A short wait that blocks this thread, for the rare moment when two sessions make the index together. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `step` again for as long as SQLite answers "busy". The busy timeout does not cover everything: two connections
 * that both hold a read lock and both want the exclusive one, as when each switches a new file to WAL mode, would wait
 * for each other for ever, so SQLite refuses one of them at once. Once the other has finished, the retry finds
 * nothing left to do.
 */
function whileBusy(step: () => void): void {
    const deadline = Date.now() + BUSY_MS;
    for (;;) {
        try {
            step();
            return;
        } catch (error) {
            if (!isBusy(error) || Date.now() >= deadline) throw error;
            pause(20);
        }
    }
}

/** The files SQLite keeps for one database in WAL mode. */
const FILES = ["", "-wal", "-shm"];

/** The index, ready for writing: the folder and file exist (private to the user), in WAL mode, with its tables. */
export function openIndex(file: string): DatabaseSync {
    const folder = dirname(file);
    // The index describes what the agent did, so it is private, like jig-core's records.
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    // Created here, because SQLite gives its -wal and -shm files the mode of the main file.
    closeSync(openSync(file, "a", 0o600));
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = " + BUSY_MS);
    whileBusy(() => {
        // WAL lets Grafana read while a session writes. NORMAL is safe in WAL mode, and the index is a copy that
        // /lens rebuild can make again, so a lost last write after a power cut costs nothing.
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec(SCHEMA);
    });
    return db;
}

/** Deletes the index and the files SQLite keeps beside it. A file that is not there is not an error. */
export function deleteIndex(file: string): void {
    for (const suffix of FILES) rmSync(file + suffix, { force: true });
}

export interface IndexStatus {
    file: string;
    /** The index and its write-ahead log, in bytes. */
    bytes: number;
    calls: number;
    turns: number;
    /** Record files that have been imported. */
    files: number;
    /** The latest import, in seconds since the epoch. Undefined before the first one. */
    lastImport: number | undefined;
    /** Record files with lines that could not be read, and how many. */
    skipped: Array<{ file: string; lines: number }>;
}

/** What the index holds, or undefined when there is no index yet. Opens it read only, so asking never creates it. */
export function readStatus(file: string): IndexStatus | undefined {
    if (!existsSync(file)) return undefined;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        db.exec("PRAGMA busy_timeout = " + BUSY_MS);
        const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
        const last = db.prepare("SELECT max(at) AS at FROM imported").get()?.at;
        const skipped = db.prepare("SELECT file, skipped FROM imported WHERE skipped > 0 ORDER BY file").all();
        return {
            file,
            bytes: FILES.reduce((sum, suffix) => sum + sizeOf(file + suffix), 0),
            calls: count("call"),
            turns: count("turn"),
            files: count("imported"),
            lastImport: typeof last === "number" ? last : undefined,
            skipped: skipped.map((row) => ({ file: String(row.file), lines: Number(row.skipped) })),
        };
    } finally {
        db.close();
    }
}

function sizeOf(file: string): number {
    try {
        return statSync(file).size;
    } catch {
        return 0;
    }
}
