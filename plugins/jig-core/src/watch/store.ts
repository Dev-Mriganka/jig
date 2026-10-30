// Saved watches: one small JSON file per watch, `<state>/watches/<id>.json` (file 0600, folder 0700).
//
// A watch is saved when it starts and after every poll, so a restart of Pi picks it up where it stopped. A file is
// replaced in one step (see `replacePrivateFile`), so a crash leaves the old content or the new, never half of it.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WatchResult } from "../contract.ts";
import { privateDir, replacePrivateFile, stateDir } from "../paths.ts";
import { isWatchResult } from "./clean.ts";

export type WatchStatus = "open" | "paused" | "done";

/** Exactly what is in a watch's file. */
export interface SavedWatch {
    version: 1;
    id: string;
    kind: string;
    plugin: string;
    title: string;
    /** Plain JSON, as the plugin gave it. */
    spec: unknown;
    /** What the last poll returned. Missing before the first poll, and dropped when the watch is done. */
    state?: unknown;
    status: WatchStatus;
    startedAt: string;
    /** After this the watch is polled one last time, then ends as timed out. */
    deadlineAt: string;
    /** After this the user gets a "still waiting" notice, once. */
    stallAt: string;
    /** The notice was shown, so a restart does not show it again. */
    stalled?: true;
    /** The Pi session the watch belongs to. Only that session polls it. */
    session: string;
    /** Polls that failed in a row. */
    failures: number;
    result?: WatchResult;
    finishedAt?: string;
}

// Ids are eight characters of a lowercase alphabet without i, l, o and u: short, easy to read and type, safe in a
// file name and a URL, and the same on a file system that ignores case.
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 8;
const FILE = /^([0-9a-hjkmnp-tv-z]{8})\.json$/;
const LEFTOVER = /^[0-9a-hjkmnp-tv-z]{8}\.json\.\d+\.[0-9a-f]+\.tmp$/;
/** A temporary file this old belongs to a writer that crashed. */
const LEFTOVER_AGE_MS = 60 * 60 * 1000;

export interface WatchStore {
    /** An id no saved watch has. */
    newId(): string;
    /** Writes the watch. Throws when it cannot. */
    save(watch: SavedWatch): void;
    remove(id: string): void;
    /** Every saved watch that can be read, and how many files could not be. Throws only when the folder itself cannot
     *  be read; a folder that does not exist yet holds nothing. */
    load(): { watches: SavedWatch[]; unreadable: number };
}

export function createWatchStore(): WatchStore {
    // Where the files are. Only saving creates the folder: looking for watches must leave no trace on a machine that
    // never had one.
    const folder = () => join(stateDir(), "watches");
    const fileOf = (id: string) => join(folder(), `${id}.json`);

    return {
        newId() {
            // A taken id is a one-in-a-trillion chance; the loop is there so that it still cannot overwrite a watch.
            for (let attempt = 0; attempt < 20; attempt++) {
                let id = "";
                // 256 is a multiple of 32, so every letter of the alphabet is equally likely.
                for (const byte of randomBytes(ID_LENGTH)) id += ID_ALPHABET.charAt(byte % ID_ALPHABET.length);
                if (!existsSync(fileOf(id))) return id;
            }
            throw new Error("could not find a free watch id");
        },

        save(watch) {
            privateDir("watches");
            replacePrivateFile(fileOf(watch.id), `${JSON.stringify(watch, null, 2)}\n`);
        },

        remove(id) {
            try {
                unlinkSync(fileOf(id));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        },

        load() {
            const dir = folder();
            let names: string[];
            try {
                names = readdirSync(dir);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return { watches: [], unreadable: 0 };
                throw error;
            }
            const watches: SavedWatch[] = [];
            let unreadable = 0;
            for (const name of names) {
                const id = FILE.exec(name)?.[1];
                if (id === undefined) {
                    if (LEFTOVER.test(name)) removeIfOld(join(dir, name));
                    continue;
                }
                let watch: SavedWatch | undefined;
                try {
                    watch = parseSaved(readFileSync(join(dir, name), "utf8"), id);
                } catch {
                    watch = undefined;
                }
                if (watch === undefined) unreadable++;
                else watches.push(watch);
            }
            return { watches, unreadable };
        },
    };
}

function removeIfOld(file: string): void {
    try {
        if (Date.now() - statSync(file).mtimeMs > LEFTOVER_AGE_MS) unlinkSync(file);
    } catch {
        // Gone already, or not ours to remove: either way, nothing to do.
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is string => isText(value) && !Number.isNaN(Date.parse(value));

/** The watch in a file, or undefined when the file is not one this version wrote. Only known fields are kept, and
 *  every one the engine relies on is checked, so a damaged or edited file cannot break the engine later. */
export function parseSaved(text: string, id: string): SavedWatch | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!isObject(value) || value.version !== 1 || value.id !== id) return undefined;
    const { kind, plugin, title, session, status, startedAt, deadlineAt, stallAt, failures } = value;
    if (!isText(kind) || !isText(plugin) || !isText(title) || !isText(session)) return undefined;
    if (status !== "open" && status !== "paused" && status !== "done") return undefined;
    if (!isTime(startedAt) || !isTime(deadlineAt) || !isTime(stallAt)) return undefined;
    if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) return undefined;

    const watch: SavedWatch = {
        version: 1,
        id,
        kind,
        plugin,
        title,
        spec: value.spec,
        status,
        startedAt,
        deadlineAt,
        stallAt,
        session,
        failures,
    };
    if ("state" in value) watch.state = value.state;
    if (value.stalled === true) watch.stalled = true;
    if (status === "done") {
        if (!isWatchResult(value.result)) return undefined;
        watch.result = value.result;
        if (isTime(value.finishedAt)) watch.finishedAt = value.finishedAt;
    }
    return watch;
}
