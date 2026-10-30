// Small helpers the modules share: the error that means "invalid input", the shape an action hands back, ways to read
// kubectl's JSON, and ways to put a value or a piece of cluster text into a message.
import type { Facts } from "../../jig-core/src/contract.ts";

/**
 * A mistake in a call's input, or in the configuration it names. jig-core takes a `TypeError` from a tool's classify to
 * mean "invalid input" and blocks the call without asking. Every such finding is an InputError, which is a TypeError.
 * A TypeError from a bug in this plugin is not one, and `classifying` keeps the two apart, so a bug is never reported
 * as the model's mistake.
 */
export class InputError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "InputError";
    }
}

/**
 * What leaves a tool's classify or preview: an InputError as it is, so jig-core blocks the call without asking, and any
 * other TypeError as an ordinary error, because it is a bug here and not the model's mistake.
 */
function reported(error: unknown): unknown {
    if (error instanceof TypeError && !(error instanceof InputError)) {
        return new Error(`internal error: ${error.message}`);
    }
    return error;
}

/** Runs the checks of a tool's classify. */
export function classifying<T>(work: () => T): T {
    try {
        return work();
    } catch (error) {
        throw reported(error);
    }
}

/** Builds a tool's preview. */
export async function previewing<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        throw reported(error);
    }
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks one setting of the catalog against a pattern and returns it, or adds a problem to `errors`. A setting that is
 * missing is "required"; one that is wrong is "must be". The message never repeats the value: a configuration error may
 * be shown to the model, and a value pasted into the wrong place may be a secret.
 */
export function checkPattern(
    value: unknown,
    pattern: RegExp,
    key: string,
    what: string,
    errors: string[],
): string | undefined {
    if (value === undefined) {
        errors.push(`${key}: required, ${what}`);
        return undefined;
    }
    if (typeof value === "string" && pattern.test(value)) return value;
    errors.push(`${key}: must be ${what}`);
    return undefined;
}

/** The objects in a list from kubectl's JSON, whatever else is in it. A missing list is an empty one. */
export function objects(value: unknown): Array<Record<string, unknown>> {
    return (Array.isArray(value) ? value : []).filter(isObject);
}

/** A number from kubectl's JSON, or 0 when there is none. */
export function count(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A string that has something in it. */
export function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function printable(value: unknown): string {
    try {
        return String(value);
    } catch {
        return "(cannot be shown)";
    }
}

/** A value as it can appear in a message: JSON on one line, cut. Control characters come out escaped. */
export function shown(value: unknown, max = 40): string {
    let text: string;
    try {
        text = JSON.stringify(value) ?? printable(value);
    } catch {
        text = printable(value);
    }
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The items joined, cut after about `max` characters with a count of the rest, so a message that offers choices stays
 *  short even when a configuration has many. */
export function shortList(items: readonly string[], max = 160): string {
    let text = "";
    for (const [index, item] of items.entries()) {
        const next = text === "" ? item : `${text}, ${item}`;
        if (text !== "" && next.length > max) return `${text} (and ${items.length - index} more)`;
        text = next;
    }
    return text;
}

/** `1 pod`, `2 pods`. */
export function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The text on one line, cut after `max` characters. */
export function oneLine(text: string, max = 200): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 300 000 -> "5m00s", 45 000 -> "45s". */
export function duration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** What an action hands back to the tool. */
export interface Outcome {
    /** What the model reads. jig-core masks it for production and cuts it when it is long. */
    text: string;
    /** A few numbers and short codes for the call's record, never free text. */
    facts: Facts;
    details: Record<string, unknown>;
}

// Colour and cursor sequences (CSI) and title or link sequences (OSC), which a log line can carry. A terminal acts on
// them, and a hostile log line must not be able to make it.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Control characters but tab, newline and carriage return, and the Unicode line and paragraph separators. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Text from a pod, safe to show: no terminal sequences, and no other control character. */
export function clean(text: string): string {
    return text.replace(ANSI, "").replace(CONTROL, "?");
}

/** The lines of `text` without a trailing empty line. A carriage return (a progress bar) ends a line too. */
export function linesOf(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}
