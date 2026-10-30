// The local-pointer check: text that goes to Jira is read by people who do not have this machine. A path under a home
// folder, a `file://` link, a `./script.sh` or the name of a private folder or host is a pointer they cannot follow, and
// often one that should not be shared at all. The check only flags them, at the top of the preview: the person approving
// decides, and nothing is blocked.

/** The line above the flags in a preview. */
export const FLAG_HEADING = "WARNING: the text points at things its readers may not be able to open:";

/** A path starts a word. This keeps `https://host/home/page` and `a/./b` out: no word character, dot, colon, slash or
 *  tilde may come right before it. */
const START = String.raw`(?<![\w.:/~-])`;
/** Where a path ends: at a space, a quote or a bracket. */
const REST = String.raw`[^\s"'<>()[\]{}]*`;

const KINDS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
    ["file link", /\bfile:\/\/[^\s"'<>]*/gi],
    ["local path", new RegExp(`${START}/(?:home|Users|root|mnt|tmp)/${REST}`, "g")],
    ["local path", new RegExp(`${START}~/${REST}`, "g")],
    ["local path", /(?<![\w])[A-Za-z]:[\\/][^\s"'<>()[\]{}]*/g],
    ["relative path", new RegExp(`${START}\\.{1,2}/[\\w.-]${REST}`, "g")],
];

/** A preview lists at most this many flags; the rest are counted. */
const MAX_LISTED = 8;
const MAX_SHOWN_CHARS = 80;

function shorten(text: string): string {
    const cleaned = text.replace(/[.,;:!?]+$/, "");
    return cleaned.length > MAX_SHOWN_CHARS ? `${cleaned.slice(0, MAX_SHOWN_CHARS - 3)}...` : cleaned;
}

function escapeRegExp(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Every string inside a value, however deep, so a field's nested options and lists are checked too. */
export function stringsIn(value: unknown, found: string[] = []): string[] {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) for (const item of value) stringsIn(item, found);
    else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsIn(item, found);
    return found;
}

/**
 * One line per distinct pointer found in the texts, such as `local path: /home/alice/notes.md`, grouped by kind.
 * `privateNames` are folder or host names the user does not want in Jira; they match without regard to case, and only
 * as whole words.
 */
export function pointersIn(texts: readonly string[], privateNames: readonly string[] = []): string[] {
    const found = new Set<string>();
    for (const text of texts) {
        for (const [label, pattern] of KINDS) {
            for (const match of text.matchAll(pattern)) found.add(`${label}: ${shorten(match[0])}`);
        }
        for (const name of privateNames) {
            const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "i");
            if (pattern.test(text)) found.add(`private name: ${shorten(name)}`);
        }
    }
    return [...found];
}

/** The flags as lines for a preview: the first few, then a count of the rest. */
export function flagLines(flags: readonly string[]): string[] {
    if (flags.length <= MAX_LISTED) return [...flags];
    return [...flags.slice(0, MAX_LISTED), `and ${flags.length - MAX_LISTED} more`];
}
