// Importing: jig-core's record files into the index, a file at a time and a byte offset at a time.
//
// The record files stay the source, and this module only reads them. What it adds to the index is safe to repeat:
//  - `imported` remembers how far each file has been read, so a run reads only what is new;
//  - every line is inserted by its record id with INSERT OR IGNORE, so a line read twice is counted once, whether
//    because two sessions import at once, the offset was lost, or the index was rebuilt;
//  - a file is one transaction that also moves its offset, so the tables and the offset never disagree.
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CALL, TURN, insertSql } from "./fields.ts";
import { parseLine } from "./parse.ts";

/** How long records are kept. This is jig-core's default for `records.retentionDays`. A plugin cannot read that
 *  setting, so the index keeps this long even when jig-core is set to keep its files for longer or shorter. */
export const RETENTION_DAYS = 90;

/** The most read from a file at once. A record is a few hundred bytes, so this much without a line break is not one. */
const CHUNK = 64 * 1024 * 1024;

const NEWLINE = 0x0a;
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export interface FileCounts {
    /** New rows. A line imported before adds none. */
    calls: number;
    turns: number;
    /** Lines that are not records, and were left out. */
    skipped: number;
}

export interface ImportResult extends FileCounts {
    /** Rows older than the retention that were removed. */
    removed: number;
    /** Record files that could not be read, each with the reason. */
    problems: string[];
}

/** What one import came to, for the commands to report. */
export interface ImportOutcome {
    /** Missing when the index could not be used at all. */
    result?: ImportResult;
    /** Why the import failed, or the record files it could not read. */
    problem?: string;
}

/** A record file that could not be read. The import goes on with the others. */
class FileProblem extends Error {}

function readingFile<T>(name: string, read: () => T): T {
    try {
        return read();
    } catch (error) {
        throw new FileProblem(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}

const none = (): FileCounts => ({ calls: 0, turns: 0, skipped: 0 });

/**
 * Runs `work` in a transaction. IMMEDIATE takes the write lock at once: a deferred transaction would read first and ask
 * for the lock later, and SQLite refuses that without waiting when another session has written in between.
 */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = work();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The failure took the transaction with it.
        }
        throw error;
    }
}

function storedRow(db: DatabaseSync, name: string): { bytes: number; skipped: number } | undefined {
    const row = db.prepare("SELECT bytes, skipped FROM imported WHERE file = ?").get(name);
    return row === undefined ? undefined : { bytes: Number(row.bytes), skipped: Number(row.skipped) };
}

/** Up to `length` bytes of the file from `offset`: fewer when the file turns out to be shorter. */
function readBytes(fd: number, offset: number, length: number): Buffer {
    const buffer = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
        const n = readSync(fd, buffer, got, length - got, offset + got);
        if (n === 0) break;
        got += n;
    }
    return buffer.subarray(0, got);
}

/** Inserts the lines of text, one record each, and counts the new rows and the lines that are not records. */
function insertLines(db: DatabaseSync, text: string, counts: FileCounts): void {
    const inserts = {
        call: db.prepare(insertSql("call", CALL)),
        turn: db.prepare(insertSql("turn", TURN)),
    };
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const parsed = parseLine(line);
        if (parsed === undefined) {
            counts.skipped++;
        } else if (inserts[parsed.table].run(...parsed.values).changes > 0) {
            // A line that was imported before changes nothing, and is not counted.
            if (parsed.table === "call") counts.calls++;
            else counts.turns++;
        }
    }
}

/**
 * Imports what is new in one record file. Only complete lines count: a line that is still being written has no line
 * break yet, and waits for the next import. Throws a FileProblem when the file cannot be read.
 */
export function importFile(db: DatabaseSync, folder: string, name: string, now: Date, chunkSize = CHUNK): FileCounts {
    const fd = readingFile(name, () => openSync(join(folder, name), "r"));
    try {
        // The usual case is a file with nothing new, and it must not ask for the write lock.
        const known = storedRow(db, name)?.bytes ?? 0;
        if (known === readingFile(name, () => fstatSync(fd).size)) return none();

        return inTransaction(db, () => {
            // Read again now that this session holds the lock: another one may have imported the file since.
            const row = storedRow(db, name);
            const size = readingFile(name, () => fstatSync(fd).size);
            // A file smaller than what was read is not the file that was read, so it is read from the start. The
            // record ids keep the lines already imported from counting twice.
            const resumed = row !== undefined && row.bytes <= size;
            const start = resumed ? row.bytes : 0;
            let offset = start;
            const counts = none();

            while (offset < size) {
                const chunk = readingFile(name, () => readBytes(fd, offset, Math.min(size - offset, chunkSize)));
                const end = chunk.lastIndexOf(NEWLINE);
                if (end === -1) {
                    if (chunk.length < chunkSize) break;
                    // A whole chunk without a line break cannot be a record. Passing it is the only way on.
                    counts.skipped++;
                    offset += chunk.length;
                    continue;
                }
                insertLines(db, chunk.toString("utf8", 0, end), counts);
                offset += end + 1;
            }

            // Nothing to record when only a line that is still being written was found. A file that was replaced is
            // recorded even then, so its old offset is forgotten.
            if (offset > start || counts.skipped > 0 || (row !== undefined && !resumed)) {
                db.prepare(
                    `INSERT INTO imported (file, bytes, skipped, at) VALUES (?, ?, ?, ?)
                     ON CONFLICT (file) DO UPDATE
                     SET bytes = excluded.bytes, skipped = excluded.skipped, at = excluded.at`,
                ).run(name, offset, (resumed ? row.skipped : 0) + counts.skipped, now.getTime() / 1000);
            }
            return counts;
        });
    } finally {
        closeSync(fd);
    }
}

/** Midnight UTC of the day that is `days` before today, in seconds since the epoch: the oldest time the index keeps. */
export function cutoffOf(now: Date, days: number): number {
    return (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86_400_000) / 1000;
}

/** The record files from the cutoff day on, oldest first. jig-core deletes a file by the same rule, by its day. */
function recordFiles(folder: string, cutoff: number): string[] {
    let entries;
    try {
        entries = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => {
            const day = DAY_FILE.exec(name);
            return day !== null && Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) / 1000 >= cutoff;
        })
        .sort();
}

/** Removes rows older than the cutoff, and forgets files that are gone or too old to import. Returns the rows gone. */
function removeOld(db: DatabaseSync, cutoff: number, current: ReadonlySet<string>): number {
    const files = db.prepare("SELECT file FROM imported").all().map((row) => String(row.file));
    const stale = files.filter((name) => !current.has(name));
    const old = db
        .prepare("SELECT (SELECT count(*) FROM call WHERE time < ?) + (SELECT count(*) FROM turn WHERE time < ?) AS n")
        .get(cutoff, cutoff);
    // Most imports have nothing to remove, and then they must not ask for the write lock.
    if (stale.length === 0 && Number(old?.n ?? 0) === 0) return 0;
    return inTransaction(db, () => {
        const removed = Number(db.prepare("DELETE FROM call WHERE time < ?").run(cutoff).changes)
            + Number(db.prepare("DELETE FROM turn WHERE time < ?").run(cutoff).changes);
        const forget = db.prepare("DELETE FROM imported WHERE file = ?");
        for (const name of stale) forget.run(name);
        return removed;
    });
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Imports every record file in the folder that is new, or has grown, and applies the retention. Between files it lets
 * Pi's event loop run, so the first import over many days of records does not freeze the screen. A record file that
 * cannot be read is reported in `problems` and does not stop the others; an error from the index itself does.
 */
export async function importRecords(
    db: DatabaseSync,
    options: { records: string; now: Date; retentionDays?: number },
): Promise<ImportResult> {
    const cutoff = cutoffOf(options.now, options.retentionDays ?? RETENTION_DAYS);
    const names = recordFiles(options.records, cutoff);
    const result: ImportResult = { ...none(), removed: 0, problems: [] };
    for (const name of names) {
        try {
            const counts = importFile(db, options.records, name, options.now);
            result.calls += counts.calls;
            result.turns += counts.turns;
            result.skipped += counts.skipped;
        } catch (error) {
            if (!(error instanceof FileProblem)) throw error;
            // A file that jig-core cleaned up a moment ago is not a problem.
            const gone = (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
            if (!gone) result.problems.push(error.message);
        }
        await nextTurn();
    }
    result.removed = removeOld(db, cutoff, new Set(names));
    return result;
}
