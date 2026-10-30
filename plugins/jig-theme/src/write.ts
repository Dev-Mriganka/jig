// Your palettes on disk: each one is written to `<agentDir>/themes/<name>.json`, where Pi finds a theme by name.
//
// Pi's themes folder is also where you put themes by hand, so this plugin writes into it only what it can prove is its own.
// `<agentDir>/jig-theme/written.json` holds the SHA-256 of every file this plugin wrote. A file is written over, or
// deleted, only when it is absent or its hash is still the one recorded. A file that changed since (you edited it), a file
// that is not in the record (you wrote it), and anything that is not a plain file (a link into your dotfiles) is left as
// it is and said once.
import { createHash, randomBytes } from "node:crypto";
import { type Stats, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, derive, themeText } from "./build.ts";
import type { PaletteSpec } from "./config.ts";
import { PALETTE_NAME } from "./config.ts";
import { PALETTES } from "./palettes.ts";

/** A theme Pi knows: its name, and the file it came from when it has one. */
export interface KnownTheme {
    name: string;
    path: string | undefined;
}

export interface SyncResult {
    /** Palettes whose file was written: new, or changed since this plugin wrote it. */
    written: string[];
    /** The part of `written` that Pi may have read before: the file existed and its colours changed. */
    changed: string[];
    /** Palettes whose file is this plugin's and holds what the config says, whether or not it was written now. */
    owned: string[];
    /** Files deleted because their palette is no longer in the config. */
    removed: string[];
    /** What was left alone or failed, in words, one per line. Never a colour. */
    problems: string[];
}

export interface SyncOptions {
    agentDir: string;
    palettes: Readonly<Record<string, PaletteSpec>>;
    /** Every theme Pi has, so that a name another theme has is not taken over. */
    known: readonly KnownTheme[];
}

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const MAX_FILE = 1024 * 1024;

type Look = { kind: "absent" } | { kind: "file"; hash: string } | { kind: "other" };

function look(file: string): Look {
    let stat: Stats;
    try {
        stat = lstatSync(file);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A parent that is a file means there is nothing here; writing says why it cannot be made.
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
        return { kind: "other" };
    }
    if (!stat.isFile() || stat.size > MAX_FILE) return { kind: "other" };
    try {
        return { kind: "file", hash: sha256(readFileSync(file)) };
    } catch {
        return { kind: "other" };
    }
}

/** Written beside the file and moved over it, so Pi, which watches the folder, never reads half a theme. */
function writeAtomic(file: string, text: string, mode: number): void {
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(temp, text, { mode, flag: "wx" });
        renameSync(temp, file);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

const failure = (error: unknown): string => String((error as NodeJS.ErrnoException)?.code ?? "error");

interface Manifest {
    entries: Record<string, string>;
    problem?: string;
}

function readManifest(file: string): Manifest {
    const look1 = look(file);
    if (look1.kind === "absent") return { entries: {} };
    if (look1.kind === "other")
        return {
            entries: {},
            problem:
                "jig-theme/written.json is not a plain file of a sensible size; every theme file in themes/ counts as not written by jig-theme",
        };
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return {
            entries: {},
            problem:
                "jig-theme/written.json cannot be read; every theme file in themes/ counts as not written by jig-theme",
        };
    }
    const entries: Record<string, string> = {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [name, hash] of Object.entries(parsed)) {
            if (PALETTE_NAME.test(name) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
                entries[name] = hash;
        }
    }
    return { entries };
}

/**
 * Writes a palette's own file again with the text it already has, which Pi's watcher takes as a change and reads the theme
 * anew. Pi reads the themes folder when it starts and when it reloads, and a palette changed since then is only known to
 * it by its old colours until its file changes once more. Only a file this plugin wrote and nobody has changed is touched.
 */
export function rewriteOwned(agentDir: string, name: string): boolean {
    if (!PALETTE_NAME.test(name)) return false;
    const recorded = readManifest(path.join(agentDir, "jig-theme", "written.json")).entries[name];
    const file = path.join(agentDir, "themes", `${name}.json`);
    const found = look(file);
    if (recorded === undefined || found.kind !== "file" || found.hash !== recorded) return false;
    try {
        writeAtomic(file, readFileSync(file, "utf8"), 0o644);
        return true;
    } catch {
        return false;
    }
}

/**
 * Makes the themes folder hold your palettes: writes new ones, rewrites ones whose colours changed, deletes the files of
 * palettes you removed, and leaves alone every file it cannot prove is its own. Nothing is created on disk when there are
 * no palettes and nothing was written before.
 */
export function syncPalettes(options: SyncOptions): SyncResult {
    const themes = path.join(options.agentDir, "themes");
    const manifestFile = path.join(options.agentDir, "jig-theme", "written.json");
    const result: SyncResult = { written: [], changed: [], owned: [], removed: [], problems: [] };
    const before = readManifest(manifestFile);
    const entries = { ...before.entries };
    const names = Object.keys(options.palettes);
    if (names.length === 0 && Object.keys(entries).length === 0) return result;
    if (before.problem !== undefined && names.length > 0) result.problems.push(before.problem);

    for (const name of names) {
        const spec = options.palettes[name] as PaletteSpec;
        const base = PALETTES[spec.base];
        const file = path.join(themes, `${name}.json`);
        if (base === undefined || !PALETTE_NAME.test(name)) continue;
        const taken = options.known.find((theme) => theme.name === name && theme.path !== file);
        if (taken !== undefined) {
            result.problems.push(`the theme name "${name}" is taken by another theme; jig-theme does not write it`);
            continue;
        }
        const text = themeText(build(derive(base, spec), name));
        const hash = sha256(text);
        const found = look(file);
        if (found.kind === "other") {
            result.problems.push(`themes/${name}.json is not a plain file; jig-theme leaves it`);
            continue;
        }
        if (found.kind === "file" && found.hash === hash) {
            entries[name] = hash;
            result.owned.push(name);
            continue;
        }
        if (found.kind === "file" && entries[name] !== found.hash) {
            result.problems.push(
                entries[name] === undefined
                    ? `themes/${name}.json is not one jig-theme wrote; jig-theme leaves it`
                    : `themes/${name}.json was changed by hand; jig-theme leaves it`,
            );
            continue;
        }
        try {
            mkdirSync(themes, { recursive: true });
            writeAtomic(file, text, 0o644);
        } catch (error) {
            result.problems.push(`themes/${name}.json could not be written (${failure(error)})`);
            continue;
        }
        entries[name] = hash;
        result.written.push(name);
        result.owned.push(name);
        if (found.kind === "file") result.changed.push(name);
    }

    for (const [name, hash] of Object.entries(entries)) {
        if (Object.hasOwn(options.palettes, name)) continue;
        const file = path.join(themes, `${name}.json`);
        const found = look(file);
        if (found.kind === "absent") {
            delete entries[name];
        } else if (found.kind === "file" && found.hash === hash) {
            try {
                unlinkSync(file);
                result.removed.push(name);
                delete entries[name];
            } catch (error) {
                result.problems.push(`themes/${name}.json could not be deleted (${failure(error)})`);
            }
        } else {
            // It is yours now: the palette is gone from the config, and the file is not what was written.
            result.problems.push(`themes/${name}.json was changed by hand; jig-theme leaves it`);
            delete entries[name];
        }
    }

    if (JSON.stringify(entries) !== JSON.stringify(before.entries) || before.problem !== undefined) {
        try {
            mkdirSync(path.dirname(manifestFile), { recursive: true, mode: 0o700 });
            writeAtomic(manifestFile, `${JSON.stringify(entries, null, 2)}\n`, 0o600);
        } catch (error) {
            result.problems.push(
                `jig-theme/written.json could not be written (${failure(error)}); the files stay, and are not deleted later`,
            );
        }
    }
    return result;
}
