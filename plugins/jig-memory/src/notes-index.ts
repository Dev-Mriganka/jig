// A search index of the tickets that have no card yet: the ## Now block and the decisions of notes.md, bounded and derived,
// so a 73 KB note costs the same as a small one. It is a copy beside the cards index, rebuilt when a note changes, and it
// never reads or writes evidence. A written card always wins over a derived entry for the same ticket.
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { countTerms, tokenize } from "./bm25.ts";
import { clipBytes } from "./clip.ts";
import { extractErrors, extractIdentifiers, extractKeys } from "./extract.ts";
import { isSafeKey, readText, replaceFile, ticketPaths } from "./store.ts";

/** The version of the file's layout. Another version is rebuilt. */
export const NOTES_INDEX_VERSION = 1;
/** What is kept of ## Now, and of the decisions: enough to match and to show why, never the whole note. */
export const NOTES_TEXT_LIMIT = 4 * 1024;
const CUT = "\n[... cut; read notes.md for the rest]";

export interface NoteEntry {
    /** The stamp of notes.md when the entry was made. */
    mtimeMs: number;
    size: number;
    /** The date of the note's last change, `2026-11-03`, shown with a derived result. */
    date: string;
    keys: string[];
    identifiers: string[];
    errors: string[];
    /** The ## Now block, bounded. */
    now: string;
    /** The ## Decisions block, bounded. */
    decisions: string;
    length: number;
    terms: Record<string, number>;
}

/** The derived entries by ticket key. */
export type NoteIndex = Record<string, NoteEntry>;

export const notesIndexFile = (folder: string): string => path.join(folder, ".notes.json");

/** A level-2 section of a note, from its heading to the next # or ## heading, or "". */
function section(text: string, name: string): string {
    // CRLF notes are common on Windows and from pasted text; without this the heading carries a trailing \r.
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const start = lines.findIndex((line) => new RegExp(`^##[ \\t]+${name}[ \\t]*$`, "i").test(line));
    if (start < 0) return "";
    let end = start + 1;
    while (end < lines.length && !/^#{1,2}[ \t]/.test(lines[end] ?? "")) end++;
    return lines.slice(start, end).join("\n").trim();
}

/** The entry for one note. Only ## Now and ## Decisions are searched; keys, names and errors come from those two. */
export function noteEntryOf(
    ticket: string,
    text: string,
    stamp: { mtimeMs: number; size: number },
    pattern: RegExp | undefined,
): NoteEntry {
    const now = clipBytes(section(text, "Now"), NOTES_TEXT_LIMIT, CUT);
    const decisions = clipBytes(section(text, "Decisions"), NOTES_TEXT_LIMIT, CUT);
    const searched = `${now}\n${decisions}`;
    const roots = tokenize(searched);
    return {
        ...stamp,
        date: new Date(stamp.mtimeMs).toISOString().slice(0, 10),
        keys: extractKeys([searched], pattern, ticket),
        identifiers: extractIdentifiers(searched, "", undefined),
        errors: extractErrors(searched),
        now,
        decisions,
        length: roots.length,
        terms: countTerms(roots),
    };
}

const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

function isEntry(value: unknown): value is NoteEntry {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.mtimeMs !== "number" || typeof entry.size !== "number" || typeof entry.date !== "string")
        return false;
    if (!isStrings(entry.keys) || !isStrings(entry.identifiers) || !isStrings(entry.errors)) return false;
    if (typeof entry.now !== "string" || typeof entry.decisions !== "string") return false;
    if (typeof entry.length !== "number") return false;
    const terms = entry.terms;
    return (
        typeof terms === "object" &&
        terms !== null &&
        !Array.isArray(terms) &&
        Object.values(terms).every((count) => typeof count === "number")
    );
}

/** The index as it is on disk, or undefined when it is missing, unreadable, of another version or not shaped right. */
function readIndex(folder: string, pattern: string): NoteIndex | undefined {
    try {
        const indexFile = notesIndexFile(folder);
        if (!lstatSync(indexFile).isFile()) return undefined;
        const raw = JSON.parse(readText(indexFile)) as {
            version?: unknown;
            source?: unknown;
            pattern?: unknown;
            notes?: unknown;
        };
        if (raw.version !== NOTES_INDEX_VERSION || raw.source !== "notes" || raw.pattern !== pattern) return undefined;
        if (typeof raw.notes !== "object" || raw.notes === null) return undefined;
        const notes: NoteIndex = Object.create(null) as NoteIndex;
        for (const [ticket, entry] of Object.entries(raw.notes)) {
            if (!isSafeKey(ticket) || !isEntry(entry)) return undefined;
            notes[ticket] = entry;
        }
        return notes;
    } catch {
        return undefined;
    }
}

/**
 * The notes in `folder`, brought up to date: a note that is new or changed is read, a note that is gone is dropped, and
 * the file is written again when anything differed. Failing to write the file costs only speed.
 */
export function loadNoteIndex(folder: string, pattern: RegExp | undefined): NoteIndex {
    const patternKey = pattern?.source ?? "";
    const stored = readIndex(folder, patternKey);
    let dirty = stored === undefined;
    const notes: NoteIndex = Object.create(null) as NoteIndex;
    let dirents: Dirent[];
    try {
        dirents = readdirSync(folder, { withFileTypes: true });
    } catch {
        return {};
    }
    const dirs = new Set(dirents.filter((dirent) => dirent.isDirectory() && isSafeKey(dirent.name)).map((d) => d.name));
    for (const ticket of dirs) {
        const file = ticketPaths(folder, ticket).notes;
        let stamp: { mtimeMs: number; size: number };
        try {
            const stat = lstatSync(file);
            if (!stat.isFile()) {
                // A symlink, a FIFO or a device is not a note: never open it, and do not hang on a FIFO.
                if (stored?.[ticket] !== undefined) dirty = true;
                continue;
            }
            stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && stored?.[ticket] !== undefined) dirty = true;
            continue;
        }
        const known = stored?.[ticket];
        if (known !== undefined && known.mtimeMs === stamp.mtimeMs && known.size === stamp.size) {
            notes[ticket] = known;
            continue;
        }
        try {
            // Only a note that was read can change the index; an unreadable one is tried again next time without a write.
            notes[ticket] = noteEntryOf(ticket, readText(file), stamp, pattern);
            dirty = true;
        } catch {
            // A note that cannot be read now is tried again next time, and the old entry stays out.
        }
    }
    if (stored !== undefined) {
        for (const ticket of Object.keys(stored)) if (!dirs.has(ticket)) dirty = true;
    }
    if (dirty) {
        try {
            replaceFile(
                notesIndexFile(folder),
                JSON.stringify({ version: NOTES_INDEX_VERSION, source: "notes", pattern: patternKey, notes }),
            );
        } catch {
            // The index is a copy; without it the next recall reads every note again.
        }
    }
    return notes;
}
