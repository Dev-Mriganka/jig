import { randomBytes } from "node:crypto";
import {
    chmodSync,
    linkSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MaskError } from "./error.ts";

const KEY_BYTES = 32;
/** Keys are kept this many days after their own day. A process whose clock is a little behind, or one still running
 *  across midnight, must find yesterday's key instead of minting a second one for the same day. */
const KEEP_DAYS = 2;
const DAY_MS = 86_400_000;
// A key file, or the temporary file a writer links it from: `<YYYY-MM-DD>.key` or `<YYYY-MM-DD>.key.<pid>.<hex>.tmp`.
const KEY_FILE = /^(\d{4}-\d{2}-\d{2})\.key(?:\.\d+\.[0-9a-f]+\.tmp)?$/;

function utcDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function readKey(file: string): Uint8Array | undefined {
    try {
        const bytes = readFileSync(file);
        return bytes.length === KEY_BYTES ? new Uint8Array(bytes) : undefined;
    } catch {
        return undefined;
    }
}

/** Deletes key files dated more than `KEEP_DAYS` before `now`, so old keys cannot unmask old results forever.
 *  Anything else in the folder is left alone. A leftover temporary file of a crashed writer holds key bytes too. */
function deleteOldKeys(dir: string, now: Date): void {
    const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
    for (const name of readdirSync(dir)) {
        const day = KEY_FILE.exec(name)?.[1];
        if (day === undefined) continue;
        // Compared this way round so that a name that only looks like a date (`2026-13-45`) is kept, not deleted.
        const age = (today - Date.parse(`${day}T00:00:00Z`)) / DAY_MS;
        if (!(age > KEEP_DAYS)) continue;
        try {
            unlinkSync(join(dir, name));
        } catch {
            /* a concurrent cleanup got there first */
        }
    }
}

/**
 * The key for the UTC day of `now`: 32 random bytes in `<stateDir>/mask/<YYYY-MM-DD>.key` (file 0600, folder 0700),
 * created on first use. A value masks to the same token all day and to a different one tomorrow, so a token seen in
 * one day's results says nothing about another day's. Keys older than two days are deleted.
 */
export function dailyMaskKey(stateDir: string, now: Date = new Date()): Uint8Array {
    // An unset setting must not turn into a key file in whatever folder the process happens to run in.
    if (stateDir === "") throw new MaskError("masking failed: no state folder for the masking key");
    const dir = join(stateDir, "mask");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir leaves an existing folder as it was
    deleteOldKeys(dir, now);

    const file = join(dir, `${utcDay(now)}.key`);
    const existing = readKey(file);
    if (existing !== undefined) return existing;

    // Written under a temporary name and linked into place, so no reader ever sees a half-written key, and when two
    // processes start the day together the first link wins and both use its key.
    const fresh = randomBytes(KEY_BYTES);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, fresh, { mode: 0o600, flag: "wx" });
    try {
        linkSync(temp, file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = readKey(file);
        if (winner !== undefined) return winner;
        renameSync(temp, file); // the existing file is damaged: replace it
        return new Uint8Array(fresh);
    } finally {
        try {
            unlinkSync(temp);
        } catch {
            /* renamed away, or already gone */
        }
    }
    return new Uint8Array(fresh);
}
