// A search that names a field Jira does not know ("Field 'PR Link' does not exist or you do not have permission to
// view it.") is what a model guesses at again and again. The field list has the real names, so the error can say which
// field was probably meant. A guess is compared word by word, an abbreviation counts ("PR" for "Pull Request"), and a
// guess that is a typo or two away from a whole name is matched by its letters.
import type { FieldInfo } from "./api.ts";

/** The field a Jira error says is unknown, or undefined for any other problem. */
export function missingField(problem: string): string | undefined {
    return /Field '([^']{1,100})' does not exist/.exec(problem)?.[1];
}

const FILLER = new Set(["by", "of", "the", "a", "an", "for", "to", "in", "on"]);
const MIN_SCORE = 0.55;
const MAX_SUGGESTIONS = 3;

/** "requests" and "request" are one word; "address" is not "addres". */
const stem = (word: string): string =>
    word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

function words(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== "" && !FILLER.has(word))
        .map(stem);
}

/** Equal, or one starts the other from three letters on ("link" and "linked"). */
const alike = (a: string, b: string): boolean =>
    a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

function distance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            const replace = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
            row[j] = Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, replace);
        }
        previous = row;
    }
    return previous[b.length] ?? 0;
}

/**
 * How well a guess names a field, from 0 to 1. Each word of the guess has to explain a word of the name, or be the
 * initials of the words that follow ("pr" for "pull request"). The score averages the share of the guess that was
 * explained and the share of the name that was covered.
 */
export function score(guess: string, name: string): number {
    const wanted = words(guess);
    const have = words(name);
    if (wanted.length === 0 || have.length === 0) return 0;
    const covered = have.map(() => false);
    let explained = 0;
    for (const word of wanted) {
        const same = have.findIndex((candidate, index) => !covered[index] && alike(word, candidate));
        if (same >= 0) {
            covered[same] = true;
            explained++;
            continue;
        }
        const initialsAt = (index: number): boolean =>
            [...word].every(
                (letter, offset) => covered[index + offset] === false && have[index + offset]?.[0] === letter,
            );
        const start = word.length < 2 ? -1 : have.findIndex((_, index) => initialsAt(index));
        if (start >= 0) {
            for (let offset = 0; offset < word.length; offset++) covered[start + offset] = true;
            explained++;
        }
    }
    const byWords =
        explained === 0 ? 0 : (explained / wanted.length + covered.filter(Boolean).length / have.length) / 2;
    const a = wanted.join("");
    const b = have.join("");
    const byLetters = 1 - distance(a, b) / Math.max(a.length, b.length);
    return Math.max(byWords, byLetters >= 0.8 ? byLetters : 0);
}

/** `Did you mean Pull Request Link (customfield_10500)?`, or undefined when no field name is close. */
export function didYouMean(guess: string, fields: readonly FieldInfo[]): string | undefined {
    const scored = fields
        .map((field) => ({ field, score: score(guess, field.name) }))
        .filter((candidate) => candidate.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score || a.field.name.localeCompare(b.field.name));
    const best = scored[0]?.score ?? 0;
    // A guess that names one field in full gets only that field; otherwise the few that are close.
    const cutoff = best >= 0.95 ? 0.95 : Math.max(MIN_SCORE, best - 0.3);
    const close = scored.filter((candidate) => candidate.score >= cutoff).slice(0, MAX_SUGGESTIONS);
    if (close.length === 0) return undefined;
    return `Did you mean ${close.map(({ field }) => `${field.name} (${field.id})`).join(" or ")}?`;
}
