// Recall: which closed tickets look like this one. Shared keys come first: a ticket key, an error line or an identifier that
// two tickets both name is strong evidence, and a name that few cards hold counts for more. Then a keyword search over the
// text of the cards, which is weak evidence. The points add up to one score, a card needs `minScore` to be returned, and the
// best `max` are. Nothing here reads a file: recall.ts is given the index and the query, and gives back matches.
import { bm25, corpusOf, rarity, words } from "./bm25.ts";
import type { CardIndex } from "./cards.ts";
import { extractErrors, extractIdentifiers, extractKeys, normalizeError } from "./extract.ts";

/** Points for each kind of shared signal, and how many of each count. See docs/recall.md. */
export const POINTS = { key: 6, error: 5, identifier: 3, word: 0.5 } as const;
export const COUNTED = { keys: 3, errors: 2, identifiers: 4, wordPoints: 5 } as const;
/** How many matched words, and how many characters of an error line, a reason shows. */
const SHOWN_WORDS = 3;
const SHOWN_NAMES = 4;
const SHOWN_ERROR = 60;
/** The most identifiers, and error lines, a query holds. */
const QUERY_IDENTIFIERS = 60;
const QUERY_ERRORS = 20;

export interface RecallQuery {
    /** The ticket asking. Its own card is never returned, and it counts as a key the query names. */
    ticket: string | undefined;
    /** Ticket keys the text names, and the ticket itself. */
    keys: string[];
    identifiers: string[];
    /** Error lines as written, without timestamps. They are compared in the form `normalizeError` makes. */
    errors: string[];
    /** Root to the word as the text had it. */
    roots: Map<string, string>;
}

export interface QueryInput {
    ticket?: string;
    /** What the ticket is about in words: the message that activated it, its notes. */
    text: string;
    /** More text that can only hold names and error lines, such as saved results: it adds no search words. */
    evidence?: string;
    pattern: RegExp | undefined;
}

/** The lines of a notes file that say something, without the headings and labels every ticket's notes share. */
export function notesText(notes: string): string {
    return notes
        .replace(/^#{1,3}[ \t].*$/gm, " ")
        .replace(/^\(older lines moved to history\/[^)]*\)$/gm, " ")
        .replace(/^(?:Status|Next|Open questions):/gim, " ");
}

/** Everything recall compares: the keys, identifiers and error lines in the text, and its words. */
export function buildQuery(input: QueryInput): RecallQuery {
    const evidence = input.evidence ?? "";
    const keys = extractKeys([input.text, evidence], input.pattern, undefined);
    if (input.ticket !== undefined && !keys.includes(input.ticket)) keys.push(input.ticket);
    const roots = new Map<string, string>();
    // A ticket key is not a word: `PROJ` would match the card of any ticket of the project.
    const prose = keys.reduce((text, key) => text.split(key).join(" "), input.text);
    for (const { term, word } of words(prose)) if (!roots.has(term)) roots.set(term, word);
    return {
        ticket: input.ticket,
        keys,
        identifiers: extractIdentifiers(input.text, evidence, QUERY_IDENTIFIERS),
        errors: extractErrors(`${input.text}\n${evidence}`, QUERY_ERRORS),
        roots,
    };
}

export interface Match {
    ticket: string;
    score: number;
    /** Keys and identifiers the card shares with the query, the rarest identifiers first. */
    names: string[];
    /** The first error line they share, as the query wrote it. */
    error: string | undefined;
    /** The words that added the most, as the query wrote them. */
    words: string[];
    cause: string;
    fix: string;
}

export interface RecallOptions {
    max: number;
    minScore: number;
}

/** The sum of the `count` biggest values. */
const best = (values: number[], count: number) =>
    values
        .sort((a, b) => b - a)
        .slice(0, count)
        .reduce((sum, value) => sum + value, 0);

/** The cards that score at least `minScore` for the query, best first, at most `max`. */
export function recall(cards: CardIndex, query: RecallQuery, options: RecallOptions): Match[] {
    const entries = Object.entries(cards).filter(([, entry]) => entry.valid);
    if (entries.length === 0) return [];
    const size = entries.length;
    const corpus = corpusOf(entries.map(([, entry]) => entry));
    const held = (pick: (entry: (typeof entries)[number][1]) => readonly string[]) => {
        const counts = new Map<string, number>();
        for (const [, entry] of entries)
            for (const name of new Set(pick(entry))) counts.set(name, (counts.get(name) ?? 0) + 1);
        return counts;
    };
    const identifierHolders = held((entry) => entry.identifiers);
    const errorHolders = held((entry) => entry.errors);
    const queryKeys = new Set(query.keys);
    const queryIdentifiers = new Set(query.identifiers);
    const queryErrors = new Map<string, string>();
    for (const line of query.errors) {
        const compared = normalizeError(line);
        if (compared !== "" && !queryErrors.has(compared)) queryErrors.set(compared, line);
    }

    const matches: Match[] = [];
    for (const [ticket, entry] of entries) {
        if (ticket === query.ticket) continue;
        const cardKeys = new Set([ticket, ...entry.keys]);
        const keys = [...queryKeys].filter((key) => cardKeys.has(key));
        const errors = [...new Set(entry.errors)].filter((line) => queryErrors.has(line));
        const identifiers = [...new Set(entry.identifiers)]
            .filter((name) => queryIdentifiers.has(name))
            .map((name) => ({ name, rarity: rarity(identifierHolders.get(name) ?? 1, size) }))
            .sort((a, b) => b.rarity - a.rarity);
        const search = bm25(query.roots.keys(), entry, corpus);

        const score =
            POINTS.key * Math.min(keys.length, COUNTED.keys) +
            best(
                errors.map((line) => POINTS.error * rarity(errorHolders.get(line) ?? 1, size)),
                COUNTED.errors,
            ) +
            best(
                identifiers.map((found) => POINTS.identifier * found.rarity),
                COUNTED.identifiers,
            ) +
            Math.min(COUNTED.wordPoints, POINTS.word * search.score);
        if (score < options.minScore) continue;

        const names = [...keys, ...identifiers.map((found) => found.name)].slice(0, SHOWN_NAMES);
        // A word that is part of a name the reason already shows (`mapper` in `OrderMapper`) adds nothing to it.
        const shownNames = names.join(" ").toLowerCase();
        const shared = [...search.shares.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([root]) => query.roots.get(root) ?? root)
            .filter((word) => !shownNames.includes(word))
            .slice(0, SHOWN_WORDS);
        const firstError = errors[0];
        matches.push({
            ticket,
            score: Math.round(score * 100) / 100,
            names,
            error: firstError === undefined ? undefined : queryErrors.get(firstError),
            words: shared,
            cause: entry.cause,
            fix: entry.fix,
        });
    }
    return matches.sort((a, b) => b.score - a.score || a.ticket.localeCompare(b.ticket)).slice(0, options.max);
}

/** Why a card matched, in a line: `shares OrderService, NullPointerException; same error "..."; words: retry, queue`. */
export function reason(match: Match): string {
    const parts: string[] = [];
    if (match.names.length > 0) parts.push(`shares ${match.names.join(", ")}`);
    if (match.error !== undefined) {
        const line = match.error.length > SHOWN_ERROR ? `${match.error.slice(0, SHOWN_ERROR)}...` : match.error;
        parts.push(`same error "${line}"`);
    }
    if (match.words.length > 0) parts.push(`words: ${match.words.join(", ")}`);
    return parts.join("; ");
}

/** The matches as the agent and the user read them: the ticket, why, then its Cause and Fix. */
export function formatMatches(matches: readonly Match[]): string {
    return matches
        .map((match) => `${match.ticket}: ${reason(match)}\n  Cause: ${match.cause}\n  Fix: ${match.fix}`)
        .join("\n\n");
}

/** The one message that tells the agent about related tickets. */
export function recallMessage(ticket: string, folder: string, matches: readonly Match[]): string {
    const count = matches.length === 1 ? "1 earlier ticket may relate" : `${matches.length} earlier tickets may relate`;
    return [
        `[recall ${ticket}] ${count}. Cards: ${folder}/<KEY>/card.md. They are hints: check them against this ticket before relying on them.`,
        "",
        formatMatches(matches),
    ].join("\n");
}
