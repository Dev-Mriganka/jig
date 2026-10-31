// The index of cards, `.cards.json` in the folder of all tickets: for each valid card its keys, identifiers, error lines
// (in the form two tickets compare), term counts and its Cause and Fix lines. Recall reads this one file and not a
// thousand cards. The index is a copy: it is rebuilt when it is missing or unreadable, and a card is read again only
// when its size or modification time differs from the stamp the index holds for it.
import { type Dirent, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { countTerms, tokenize } from "./bm25.ts";
import { checkCard, isValid } from "./card.ts";
import { normalizeError } from "./extract.ts";
import { isSafeKey, readText, replaceFile, ticketPaths } from "./store.ts";

/** The version of the file's layout. An index with another version is rebuilt. */
export const INDEX_VERSION = 1;

export interface CardEntry {
    /** The stamp of card.md when the entry was made. */
    mtimeMs: number;
    size: number;
    /** False for a card that failed the check: it has a stamp so it is not read again, and no content. */
    valid: boolean;
    keys: string[];
    identifiers: string[];
    /** The error lines as `normalizeError` makes them, each once. */
    errors: string[];
    cause: string;
    fix: string;
    /** The number of roots in the card's text, and how many times each occurs. */
    length: number;
    terms: Record<string, number>;
}

/** The entries by ticket key. */
export type CardIndex = Record<string, CardEntry>;

export const indexFile = (folder: string): string => path.join(folder, ".cards.json");

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The entry for the text of `ticket`'s card. A card that does not pass the check gets an entry with no content. */
export function entryOf(ticket: string, text: string, stamp: { mtimeMs: number; size: number }): CardEntry {
    const checked = checkCard(text);
    const empty: CardEntry = {
        ...stamp,
        valid: false,
        keys: [],
        identifiers: [],
        errors: [],
        cause: "",
        fix: "",
        length: 0,
        terms: {},
    };
    const front = checked.front;
    if (front === undefined || !isValid(checked, ticket)) return empty;
    const { Problem = "", Cause = "", Fix = "" } = checked.sections;
    const roots = tokenize([Problem, Cause, Fix, front.repositories.join(" ")].join("\n"));
    return {
        ...stamp,
        valid: true,
        keys: front.keys,
        identifiers: front.identifiers,
        errors: [...new Set(front.errors.map(normalizeError).filter((line) => line !== ""))],
        cause: oneLine(Cause),
        fix: oneLine(Fix),
        length: roots.length,
        terms: countTerms(roots),
    };
}

const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

function isEntry(value: unknown): value is CardEntry {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.mtimeMs !== "number" || typeof entry.size !== "number" || typeof entry.valid !== "boolean")
        return false;
    if (!isStrings(entry.keys) || !isStrings(entry.identifiers) || !isStrings(entry.errors)) return false;
    if (typeof entry.cause !== "string" || typeof entry.fix !== "string" || typeof entry.length !== "number")
        return false;
    const terms = entry.terms;
    return (
        typeof terms === "object" &&
        terms !== null &&
        !Array.isArray(terms) &&
        Object.values(terms).every((count) => typeof count === "number")
    );
}

/** The index as it is on disk, or undefined when it is missing, unreadable, of another version or not shaped right. */
function readIndex(folder: string): CardIndex | undefined {
    try {
        const raw = JSON.parse(readText(indexFile(folder))) as { version?: unknown; cards?: unknown };
        if (raw.version !== INDEX_VERSION || typeof raw.cards !== "object" || raw.cards === null) return undefined;
        const cards: CardIndex = Object.create(null) as CardIndex;
        for (const [ticket, entry] of Object.entries(raw.cards)) {
            if (!isSafeKey(ticket) || !isEntry(entry)) return undefined;
            cards[ticket] = entry;
        }
        return cards;
    } catch {
        return undefined;
    }
}

/**
 * The index of the cards in `folder`, brought up to date: a card that is new or changed is read, a card that is gone is
 * dropped, and the file is written again when anything differed. Failing to write the file costs only speed.
 */
export function loadCards(folder: string): CardIndex {
    const stored = readIndex(folder);
    let dirty = stored === undefined;
    let dirents: Dirent[];
    try {
        dirents = readdirSync(folder, { withFileTypes: true });
    } catch {
        return {};
    }
    const cards: CardIndex = Object.create(null) as CardIndex;
    for (const dirent of dirents) {
        if (!dirent.isDirectory() || !isSafeKey(dirent.name)) continue;
        const file = ticketPaths(folder, dirent.name).card;
        let stamp: { mtimeMs: number; size: number };
        try {
            const stat = statSync(file);
            stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
            continue;
        }
        const known = stored?.[dirent.name];
        if (known !== undefined && known.mtimeMs === stamp.mtimeMs && known.size === stamp.size) {
            cards[dirent.name] = known;
            continue;
        }
        dirty = true;
        try {
            cards[dirent.name] = entryOf(dirent.name, readText(file), stamp);
        } catch {
            // A card that cannot be read now is tried again next time.
        }
    }
    if (stored !== undefined && Object.keys(stored).some((ticket) => cards[ticket] === undefined)) dirty = true;
    if (dirty) {
        try {
            replaceFile(indexFile(folder), JSON.stringify({ version: INDEX_VERSION, cards }));
        } catch {
            // The index is a copy; without it the next recall reads the cards again.
        }
    }
    return cards;
}
