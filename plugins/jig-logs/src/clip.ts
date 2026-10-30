// Shortening a log message for a hit line.
//
// jig-core masks production results after the tool has run, one line at a time, and it withholds a line whose structure
// it cannot read: JSON cut off mid-object, a quoted value that never closes, a half percent escape. A plain cut through
// a long request body would therefore hide the whole hit. So a cut never leaves such a structure behind: a structure
// still open at the limit is dropped whole and shown as `{…}` or `[…]`, and the complete message stays in the backend.

/** A word cut at the limit is dropped whole if it starts this close: a phone number or `key=value` stays intact. */
const WORD_BACKOFF = 64;

/** Index where the structure still open at `end` began (JSON, a double-quoted string, `key='...'`), or undefined. */
function openStructure(text: string, end: number): number | undefined {
    let openedAt: number | undefined;
    let depth = 0;
    // "plain": inside "...". "escaped": inside \"...\" (JSON serialised into a string once). "single": key='...'.
    let string: "plain" | "escaped" | "single" | undefined;
    for (let i = 0; i < end; i++) {
        const start = i;
        const c = text[i];
        if (string === "plain") {
            if (c === "\\") i++;
            else if (c === '"') string = undefined;
        } else if (string === "escaped") {
            if (text.startsWith('\\\\\\"', i))
                i += 3; // a quote inside the inner string
            else if (text.startsWith('\\"', i)) {
                string = undefined;
                i++;
            } else if (text.startsWith("\\\\", i)) i++;
        } else if (string === "single") {
            if (c === "'") string = undefined;
        } else if (c === '"') {
            string = "plain";
        } else if (c === "\\" && text[i + 1] === '"') {
            string = "escaped";
            i++;
        } else if (c === "{" || c === "[") {
            depth++;
        } else if ((c === "}" || c === "]") && depth > 0) {
            depth--;
        } else if (c === "'" && depth === 0 && text[i - 1] === "=") {
            string = "single";
        }
        const open = string !== undefined || depth > 0;
        if (!open) openedAt = undefined;
        else if (openedAt === undefined) openedAt = start;
    }
    return openedAt;
}

function isSpace(c: string | undefined): boolean {
    return c === undefined || /\s/.test(c);
}

/** What a closed-off structure is shown as, besides a bare `…`. */
export const OBJECT_MARKER = "{…}";
export const ARRAY_MARKER = "[…]";

/** Which of the two markers a shortened text carries, so that the caller can say what they mean. */
export function closedOffMarkers(text: string): { object: boolean; array: boolean } {
    return { object: text.includes(OBJECT_MARKER), array: text.includes(ARRAY_MARKER) };
}

/** The structure open at the cut becomes a marker (`{…}`, `[…]` or `…`), so the masker has nothing to refuse. */
function closedOff(text: string, opened: number, max: number): string {
    const marker = text[opened] === "{" ? OBJECT_MARKER : text[opened] === "[" ? ARRAY_MARKER : "…";
    const head = text.slice(0, opened).trimEnd();
    const joined =
        head === "" ? marker : marker === "…" || head.endsWith("=") ? `${head}${marker}` : `${head} ${marker}`;
    return joined.length <= max ? joined : `${head}…`;
}

/**
 * Where a cut at `end` may fall: not inside a long word (a phone number, `key=value`), a percent escape or a
 * surrogate pair.
 */
function safeEnd(text: string, end: number): number {
    if (!isSpace(text[end - 1]) && !isSpace(text[end])) {
        let start = end;
        while (start > 0 && !isSpace(text[start - 1])) start--;
        // A text that is one long word has no earlier word to stop at: cut it rather than return nothing.
        if (start > 0 && end - start <= WORD_BACKOFF) end = start;
    }
    const percent = text.lastIndexOf("%", end - 1);
    if (percent >= 0 && percent >= end - 2) end = percent;
    // Do not cut a surrogate pair in half.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return end;
}

/**
 * Cuts `text` to at most `max` characters, ending in `…`. A structure open at the cut is dropped whole and shown as
 * `{…}` or `[…]`.
 */
export function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    const end = max - 1;
    const opened = openStructure(text, end);
    if (opened !== undefined) return closedOff(text, opened, max);
    return `${text.slice(0, safeEnd(text, end)).trimEnd()}…`;
}

// What the masker does with any text it is given: it reads JSON segments and `key=value` pairs from the text alone.
// The functions below judge a cut the same way, so what `clipFragment` returns is something the masker can read.

/** Index of the next `{` or `[` that plausibly opens JSON (an object with a key, or an array of values), or -1. */
function jsonStart(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c !== "{" && c !== "[") continue;
        let next = i + 1;
        while (next < text.length && /\s/.test(text[next] ?? "")) next++;
        const after = text[next];
        const opens =
            c === "{"
                ? after === '"' || after === "}" || (after === "\\" && text[next + 1] === '"')
                : after === "{" || after === "[" || after === '"';
        if (opens) return i;
    }
    return -1;
}

/** Index just past the bracket that closes the one at `start`; undefined if the text ends first or they disagree. */
function jsonEnd(text: string, start: number): number | undefined {
    const escapedQuotes = text.startsWith('{\\"', start) || text.startsWith('[\\"', start);
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i] as string;
        if (escapedQuotes && c === "\\" && text[i + 1] === '"') {
            quoted = !quoted;
            i++;
            continue;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') quoted = false;
        } else if (c === '"') {
            quoted = true;
        } else if (c === "{" || c === "[") {
            stack.push(c);
        } else if (c === "}" || c === "]") {
            const opener = stack.pop();
            const mismatched = (opener === "{" && c !== "}") || (opener === "[" && c !== "]");
            if (opener === undefined || mismatched) return undefined;
            if (stack.length === 0) return i + 1;
        }
    }
    return undefined;
}

const KEY_VALUE = /(?<![^\s"'])([A-Za-z_][A-Za-z0-9_]*)=("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s&]+)/g;

/** Whether the masker cannot read this balanced segment: JSON that does not parse (`{\"a\":1}` is unescaped first). */
function unreadable(chunk: string): boolean {
    if (!chunk.includes('":')) return false;
    try {
        JSON.parse(chunk.startsWith('{\\"') || chunk.startsWith('[\\"') ? chunk.replaceAll('\\"', '"') : chunk);
        return false;
    } catch {
        return true;
    }
}

/**
 * Start of the first thing in `text` that the masker could not read: a JSON segment that does not close or parse, or a
 * quoted `key="value` that never ends.
 */
function unclosed(text: string): number | undefined {
    for (let start = jsonStart(text, 0); start >= 0;) {
        const end = jsonEnd(text, start);
        if (end === undefined || unreadable(text.slice(start, end))) return start;
        start = jsonStart(text, end);
    }
    for (const found of text.matchAll(KEY_VALUE)) {
        const raw = found[2] ?? "";
        const quoted = raw.startsWith('"') || raw.startsWith("'");
        if (quoted && (raw.length < 2 || !raw.endsWith(raw[0] ?? "")))
            return found.index + found[0].length - raw.length;
    }
    return undefined;
}

/**
 * Like `clip`, for a text that begins inside a message (a window around a term). The text before the cut says nothing
 * about what is open at it, so the cut is judged the way the masker will judge it: it reads only this text, and a JSON
 * segment it finds here must close and parse here. Whatever does not is shown as `{…}`, `[…]` or `…`.
 */
export function clipFragment(text: string, max: number): string {
    // Even a fragment that reaches the end of the message is checked: its start is still the middle of something.
    const fits = text.length <= max;
    const head = fits ? text : text.slice(0, safeEnd(text, max - 1));
    const open = unclosed(head);
    if (open !== undefined) return closedOff(head, open, max);
    return fits ? text : `${head.trimEnd()}…`;
}
