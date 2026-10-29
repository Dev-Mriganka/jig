// Where jig-core keeps things: the state folder (records, spill files, previews, the daily mask key) and the
// configuration file. The state describes what the agent did, so folders are private to the user (0700) and files
// too (0600).
//
// This module does not import Pi: `index.ts` passes Pi's agent folder in, which keeps the unit tests of the small
// modules from loading all of Pi.
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CONFIG_FILE_NAME = "jig.json";

/** `$JIG_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/jig`. A relative `XDG_STATE_HOME` is ignored, as the
 *  XDG specification says. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    const chosen = env.JIG_STATE_DIR;
    if (chosen !== undefined && chosen !== "") return resolve(chosen);
    const xdg = env.XDG_STATE_HOME;
    const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
    return join(base, "jig");
}

/** The configuration file inside Pi's agent folder. A separate Pi profile has its own agent folder, so it has its
 *  own `jig.json`. */
export function configFile(agentDir: string): string {
    return join(agentDir, CONFIG_FILE_NAME);
}

/** Creates a folder with mode 0700 and tightens it when it already existed. */
function makePrivate(dir: string): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
}

/** The state folder, or a folder below it, created private. Each level below the state folder is tightened too. */
export function privateDir(...parts: string[]): string {
    let dir = makePrivate(stateDir());
    for (const part of parts) dir = makePrivate(join(dir, part));
    return dir;
}

/** Adds one line to a file, creating it private. The line is written with a single `write`, so lines from two Pi
 *  sessions that append at the same moment do not mix. */
export function appendPrivateLine(file: string, line: string): void {
    const fd = openSync(file, "a", 0o600);
    try {
        fchmodSync(fd, 0o600);
        writeSync(fd, line);
    } finally {
        closeSync(fd);
    }
}

/** Creates a new private file. Fails when the file exists (`wx`), so a caller can pick another name instead of
 *  overwriting something. */
export function createPrivateFile(file: string, data: string): void {
    const fd = openSync(file, "wx", 0o600);
    try {
        fchmodSync(fd, 0o600);
        writeSync(fd, data);
    } finally {
        closeSync(fd);
    }
}

/** Deletes the regular files directly in `dir` that were last changed more than `maxAgeDays` ago, and returns how
 *  many. Links are never followed. A missing folder counts as empty. */
export function removeOldFiles(dir: string, maxAgeDays: number, now: number = Date.now()): number {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return 0;
    }
    let deleted = 0;
    for (const name of names) {
        const file = join(dir, name);
        try {
            const stat = lstatSync(file);
            if (stat.isFile() && now - stat.mtimeMs > maxAgeDays * 24 * 60 * 60 * 1000) {
                unlinkSync(file);
                deleted++;
            }
        } catch {
            // Removed by someone else in the meantime.
        }
    }
    return deleted;
}

/** Removes a folder when it is empty. Used for the per-session spill folders that old-file cleanup leaves behind. */
export function removeIfEmpty(dir: string): void {
    try {
        rmdirSync(dir);
    } catch {
        // Not empty, or already gone.
    }
}
