// One fetched hit as a line: its time and its message on one line, shortened the way the call asked for (the first
// characters, or a window around a term). Every cut goes through clip.ts, which never leaves half a JSON payload or a
// half-quoted value behind.
import { clip, clipFragment } from "./clip.ts";
import type { Source } from "./response.ts";
import { CONTROL_RUNS, isObject } from "./values.ts";

export const DEFAULT_CHARS = 300;
/** The most `chars` accepts. */
export const MAX_CHARS = 4000;
export const MIN_CHARS = 40;
/**
 * A page of this many hits or fewer, with `chars` unset, shows them whole (up to MAX_CHARS): a call that asks for so
 * few wants to read them.
 */
export const FEW_HITS = 3;
/** Hits on one page, whatever `chars` is. */
export const PAGE_HITS = 20;
/** What a page of hits may take of the text jig-core lets through uncut, which the header, counts and gaps share. */
const PAGE_CHARS = 24_000;
/** The time in front of a message, and the space after it. */
const LINE_OVERHEAD = 80;
/** A time longer than this is not one. */
const MAX_TIME_CHARS = 64;
/** In a window around a term, this share of the characters comes before it: the text after a term says more. */
const LEAD = 4;
/** Characters kept after a term in a window, at least. */
const AFTER = 8;
/** A window that starts inside a word moves forward past the next space or comma when that is this close. */
const WORD_START = 24;

/** The fields of a hit that a line is made of, as the environment names them. */
export interface Fields {
    timeField: string;
    messageField: string;
}

export interface Line {
    time: string;
    message: string;
}

/** How a message is shortened. */
export interface Shape {
    /** Characters kept, 40 to 4000. */
    chars?: number;
    /** Keep the characters around the first occurrence of this text (ignoring case) instead of the first ones. */
    around?: string;
}

/** Hits per page: 20, fewer when long messages would not fit the text cap together. */
export function hitsPerPage(chars: number = DEFAULT_CHARS): number {
    return Math.max(1, Math.min(PAGE_HITS, Math.floor(PAGE_CHARS / (chars + LINE_OVERHEAD))));
}

function oneLine(text: string): string {
    return text.replace(CONTROL_RUNS, " ").replace(/ {2,}/g, " ").trim();
}

/** A field of a hit. A dotted name such as `log.message` is found whether the document stored it so or nested. */
function fieldValue(source: Source, path: string): unknown {
    if (Object.hasOwn(source, path)) return source[path];
    let current: unknown = source;
    for (const part of path.split(".")) {
        if (!isObject(current) || !Object.hasOwn(current, part)) return undefined;
        current = current[part];
    }
    return current;
}

export function hitTime(source: Source, fields: Fields): string {
    const value = fieldValue(source, fields.timeField);
    // The time is the backend's own text and may be anything if the field was mapped to let bad dates through.
    if (typeof value === "string") return oneLine(value).slice(0, MAX_TIME_CHARS);
    // A date field stored as epoch milliseconds comes back as a number.
    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
    }
    return "";
}

/** The whole message, as the backend holds it. `match` and `exclude` read this, not the cut line. */
export function rawMessage(source: Source, fields: Fields): string {
    const value = fieldValue(source, fields.messageField);
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

const BRACKETED = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?\]\s*/;
const BARE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?(?=\s|$)\s*/;
const HIT_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?/;

/**
 * Drops a timestamp at the very start of a message when it is the hit's own time: the same second and, as far as both
 * give one, the same fraction (`[2026-10-16 10:31:12.123] DEBUG ...` against 2026-10-16T10:31:12.123456). The line
 * already starts with that time, and the copy would take a share of what a line keeps. A timestamp that differs is
 * information and stays.
 */
export function withoutStamp(message: string, time: string): string {
    const own = HIT_TIME.exec(time);
    const stamp = BRACKETED.exec(message) ?? BARE.exec(message);
    if (own === null || stamp === null || stamp[1] !== own[1] || stamp[2] !== own[2]) return message;
    const shared = Math.min((stamp[3] ?? "").length, (own[3] ?? "").length);
    if ((stamp[3] ?? "").slice(0, shared) !== (own[3] ?? "").slice(0, shared)) return message;
    const rest = message.slice(stamp[0].length);
    return rest === "" ? message : rest;
}

/**
 * `chars` characters around the first occurrence of `term`, a quarter of them before it. Starts and ends with `…` where
 * it cuts. Without the term in this message, the first characters, as without `around`.
 */
export function windowAround(message: string, term: string, chars: number): string {
    if (message.length <= chars) return message;
    // A regular expression, not toLowerCase(): lowercasing can change the length and shift every index after it.
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const found = pattern.exec(message);
    if (found === null) return clip(message, chars);
    // The term must fit with a little of what follows it, so a long term shrinks the lead.
    const lead = Math.min(Math.floor(chars / LEAD), Math.max(0, chars - term.length - AFTER));
    let first: string | undefined;
    // A cut can only remove the term by closing off a structure that starts before it and ends after the window; a
    // shorter lead starts the window inside that structure instead, where nothing opens before the term.
    for (const before of [lead, Math.floor(lead / 2), 0]) {
        const excerpt = windowFrom(message, found.index, before, chars);
        first ??= excerpt;
        if (pattern.test(excerpt)) return excerpt;
    }
    return first as string;
}

function windowFrom(message: string, at: number, before: number, chars: number): string {
    let start = Math.max(0, at - before);
    if (start > 0) {
        const gap = message.slice(start, at).search(/[\s,]/);
        if (gap >= 0 && gap < WORD_START) start += gap + 1;
    }
    return start === 0 ? clip(message, chars) : `…${clipFragment(message.slice(start), chars - 1)}`;
}

export function describeHit(source: Source, fields: Fields, shape: Shape = {}): Line {
    const time = hitTime(source, fields);
    const chars = shape.chars ?? DEFAULT_CHARS;
    const message = withoutStamp(oneLine(rawMessage(source, fields)), time);
    return {
        time,
        message: shape.around === undefined ? clip(message, chars) : windowAround(message, shape.around, chars),
    };
}
