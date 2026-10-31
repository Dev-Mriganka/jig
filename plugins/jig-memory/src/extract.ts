// What a text names that another ticket's text could name too: ticket keys, identifiers (classes, functions, a status
// with its path, config keys) and error lines. These are fixed patterns and no model: a card and a recall query are cut
// by the same rules, so a name that two tickets share is found as the same string. Every pattern is listed in
// docs/cards.md, and each has a test.

/** Most keys, identifiers and error lines a card keeps. */
export const MAX_KEYS = 20;
export const MAX_IDENTIFIERS = 30;
export const MAX_ERRORS = 10;
/** An error line is cut to this many characters. */
export const ERROR_LENGTH = 160;

/** Most distinct names that a text is asked for before they are ranked. A log of a million lines has more than a card
 *  could hold; the ranking only needs the commonest. */
const SCAN_LIMIT = 5000;

// A key when the memory section sets no ticketPattern: letters, a dash and digits, as in jig-review.
const GENERIC_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![A-Za-z0-9])/g;
// Words that have the shape of a key and are not one: encodings, hashes, standards and protocols. Two cards that both
// mention UTF-8 would otherwise share a key, which is the strongest signal recall has. They are left out even when the
// memory section sets a ticketPattern, because a pattern that fits `ABC-123` fits `UTF-8` too.
const NOT_KEYS: ReadonlySet<string> = new Set(
    "UTF ISO SHA RFC HTTP TLS SSL AES RSA TCP UDP IPV TLSV SSLV ECMA PBKDF HMAC WPA CRC".split(" "),
);
// More that only the generic shape lets through: a company's own pattern may well mean these.
const NOT_GENERIC_KEYS: ReadonlySet<string> = new Set("MD ES BASE UTC GMT".split(" "));

/**
 * The ticket keys in the texts, in order of first appearance and each once, without `own`. With a `pattern` (the
 * memory section's, as ticketRegex builds it) only its matches count; without one, anything shaped like `ABC-123`
 * does. Either way UTF-8, SHA-256 and the like are not keys.
 */
export function extractKeys(texts: readonly string[], pattern: RegExp | undefined, own: string | undefined): string[] {
    const found = new Set<string>();
    // matchAll needs the g flag, which ticketRegex sets but another caller might not.
    const regex =
        pattern === undefined
            ? GENERIC_KEY
            : new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const text of texts) {
        for (const match of text.matchAll(regex)) {
            const key = match[0];
            if (key === own || found.has(key)) continue;
            const prefix = key.slice(0, key.lastIndexOf("-")).toUpperCase();
            if (NOT_KEYS.has(prefix) || (pattern === undefined && NOT_GENERIC_KEYS.has(prefix))) continue;
            // A key becomes a folder name in the index, so one that is not a safe name is left out.
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
            found.add(key);
            if (found.size >= MAX_KEYS) return [...found];
        }
    }
    return [...found];
}

// -- Identifiers -----------------------------------------------------------------------------------------------------

const CLASS_NAME = /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*(?![A-Za-z0-9_])/g;
const CAMEL_NAME = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*(?![A-Za-z0-9_])/g;
const SNAKE_CALL = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?=\()/g;
const UPPER_SNAKE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}(?![A-Za-z0-9_])/g;
// A dotted key such as spring.datasource.url, only where it is given a value, so a package or a host name is not one.
const DOTTED_KEY = /(?<![A-Za-z0-9_.-])[a-z][a-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)+(?=[ \t]*(?:=|:[ \t]))/g;
const STATUS = /(?<![A-Za-z0-9_./-])[45]\d\d(?![A-Za-z0-9_./-])/g;
const PATH = /(?<![A-Za-z0-9_./:-])\/[A-Za-z0-9_.{}:~-]+(?:\/[A-Za-z0-9_.{}:~-]+)*\/?/g;
// The furthest apart a status and its path may be on one line.
const STATUS_PATH_GAP = 40;

// Products and technologies that look like class names and say nothing about a ticket.
const PRODUCT_NAMES: ReadonlySet<string> = new Set([
    "JavaScript",
    "TypeScript",
    "GitHub",
    "GitLab",
    "PostgreSQL",
    "MongoDB",
    "MySQL",
    "OpenAPI",
    "OpenSearch",
    "ElasticSearch",
    "NodeJS",
    "DevOps",
    "LinkedIn",
    "YouTube",
    "macOS",
    "WebSocket",
    "GraphQL",
    "RabbitMQ",
    "InfluxDB",
    "SQLite",
    "OAuth",
]);
// The last part of a dotted name that is a file name and not a config key.
const FILE_ENDINGS: ReadonlySet<string> = new Set([
    "yaml",
    "yml",
    "json",
    "md",
    "txt",
    "log",
    "java",
    "kt",
    "ts",
    "js",
    "mjs",
    "py",
    "rb",
    "go",
    "cs",
    "xml",
    "properties",
    "sh",
    "html",
    "css",
    "sql",
    "toml",
    "ini",
    "conf",
    "csv",
    "lock",
    "gradle",
    "env",
]);

/** A name made of words: two parts or more, none of one letter, so a random string or a token is not one. */
function isNameLike(name: string): boolean {
    if (name.length < 5 || name.length > 60) return false;
    if ((name.match(/\d/g) ?? []).length > 3) return false;
    const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
    return parts.length >= 2 && parts.every((part) => part.length >= 2);
}

/** `500 /orders/{id}` for a path with a status next to it, with digits and UUIDs written `{id}` and no query string. */
function statusPaths(line: string): string[] {
    const found: string[] = [];
    const statuses = [...line.matchAll(STATUS)];
    if (statuses.length === 0) return found;
    for (const path of line.matchAll(PATH)) {
        const raw = path[0].replace(/[?#].*$/, "").replace(/[.,;:)]+$/, "");
        // Something like `/` or `/1` is not a place anyone can name.
        if (!/[A-Za-z]/.test(raw)) continue;
        const start = path.index ?? 0;
        const end = start + path[0].length;
        const near = statuses
            .map((status) => {
                const at = status.index ?? 0;
                return { code: status[0], gap: at >= end ? at - end : start - (at + status[0].length) };
            })
            .filter((status) => status.gap >= 0 && status.gap <= STATUS_PATH_GAP)
            .sort((a, b) => a.gap - b.gap)[0];
        if (near === undefined) continue;
        const generic = raw
            .split("/")
            .map((segment) =>
                /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
                    ? "{id}"
                    : segment,
            )
            .join("/");
        found.push(`${near.code} ${generic}`);
    }
    return found;
}

/** The identifiers of one text, each with the number of times the text names it. */
export function countIdentifiers(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    const add = (name: string) => {
        if (counts.size >= SCAN_LIMIT && !counts.has(name)) return;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    for (const match of text.matchAll(CLASS_NAME))
        if (isNameLike(match[0]) && !PRODUCT_NAMES.has(match[0])) add(match[0]);
    for (const match of text.matchAll(CAMEL_NAME))
        if (isNameLike(match[0]) && !PRODUCT_NAMES.has(match[0])) add(match[0]);
    for (const match of text.matchAll(SNAKE_CALL)) if (match[0].length >= 5) add(match[0]);
    for (const match of text.matchAll(UPPER_SNAKE)) if (match[0].length <= 60) add(match[0]);
    for (const match of text.matchAll(DOTTED_KEY)) {
        const last = match[0].slice(match[0].lastIndexOf(".") + 1).toLowerCase();
        if (match[0].length >= 5 && !FILE_ENDINGS.has(last)) add(match[0]);
    }
    for (const line of text.split("\n")) for (const found of statusPaths(line)) add(found);
    return counts;
}

/**
 * The identifiers a ticket holds: those in its notes first, the commonest first, then those only its evidence has. At
 * most `max`.
 */
export function extractIdentifiers(notes: string, evidence: string, max = MAX_IDENTIFIERS): string[] {
    const ranked = (counts: Map<string, number>) =>
        [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const fromNotes = countIdentifiers(notes);
    const fromEvidence = countIdentifiers(evidence);
    const names = ranked(fromNotes);
    const known = new Set(names);
    for (const name of ranked(fromEvidence)) if (!known.has(name)) names.push(name);
    return names.slice(0, max);
}

// -- Error lines -----------------------------------------------------------------------------------------------------

// An exception or error name, `Caused by`, an upper-case level.
const ERROR_SHAPED = /\b[A-Z][A-Za-z0-9]*(?:Exception|Error)\b|\bCaused by\b|\b(?:ERROR|FATAL|SEVERE|CRITICAL|PANIC)\b/;
const ERROR_WORDS = /\b(?:failed|timed out|connection refused|permission denied)\b/i;
const STACK_FRAME = /^\s*at\s/;
const TIMESTAMP = /^\s*\[?(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?[\s:,-]*/;

/** An error line without its timestamp, cut to ERROR_LENGTH characters. */
function cleanLine(line: string): string {
    const bare = line.replace(TIMESTAMP, "").replace(/\s+/g, " ").trim();
    return bare.length > ERROR_LENGTH ? bare.slice(0, ERROR_LENGTH) : bare;
}

/**
 * The error line in the form that two tickets compare: lower case, with numbers, ids and bracketed thread names
 * replaced, so the same failure on two orders is one line.
 */
export function normalizeError(line: string): string {
    return cleanLine(line)
        .toLowerCase()
        .replace(/\[[^\]]{0,60}\]/g, " ")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
        .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g, "<id>")
        .replace(/\d+/g, "<n>")
        .replace(/\s+/g, " ")
        .trim();
}

/** Whether a line reports an error. A stack frame does not: its class is already an identifier. */
export function isErrorLine(line: string): boolean {
    if (line.trim() === "" || STACK_FRAME.test(line)) return false;
    return ERROR_SHAPED.test(line) || ERROR_WORDS.test(line);
}

/**
 * The distinct error lines in a text, the most frequent first (then the earliest), at most `max`, each cleaned and cut to
 * ERROR_LENGTH. Lines that differ only in numbers, ids or thread names are one line.
 */
export function extractErrors(text: string, max = MAX_ERRORS): string[] {
    const seen = new Map<string, { line: string; count: number; order: number }>();
    for (const raw of text.split("\n")) {
        if (!isErrorLine(raw)) continue;
        const line = cleanLine(raw);
        if (line === "") continue;
        const key = normalizeError(line);
        const entry = seen.get(key);
        if (entry !== undefined) entry.count++;
        else if (seen.size < SCAN_LIMIT) seen.set(key, { line, count: 1, order: seen.size });
    }
    return [...seen.values()]
        .sort((a, b) => b.count - a.count || a.order - b.order)
        .slice(0, max)
        .map((entry) => entry.line);
}
