// Small helpers shared by the files of this plugin.
import { isObject } from "../../jig-core/src/kit/values.ts";

export { isObject };

/**
 * Control characters: the C0 and C1 ranges and the Unicode line and paragraph separators. They have no place in a
 * phrase, a search term or a name. In a log line they would break it into several, and a terminal acts on an escape
 * sequence that one starts, so a hostile message must not carry any into what is shown.
 */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Runs of control characters, to be replaced. */
export const CONTROL_RUNS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * A mistake in a call's input. jig-core takes a `TypeError` from a declaration or a preview to mean "invalid input" and
 * blocks the call without asking. Its name stays `TypeError`, so a message and a test treat it as one.
 */
export class InputError extends TypeError {}

/**
 * Refuses a call whose parameters are wrong. The message says how to put it right. A `TypeError` is how jig-core's
 * contract says "invalid input" (see `ToolDeclaration.preview`), so every refusal of a parameter is an InputError.
 */
export function refuse(message: string): never {
    throw new InputError(message);
}

/** A value from a call, shortened and quoted for an error message. Text is quoted, so an empty value shows. */
export function shown(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(printable(value));
    if (Array.isArray(value)) return "a list";
    if (typeof value === "object" && value !== null) return "an object";
    return String(value);
}

/** A name from the configuration, safe to put in a message: no control characters, and short. */
export function printable(text: string): string {
    const clean = text.replace(CONTROL_RUNS, "?");
    return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

/** `1 hit`, `2 hits`. */
export function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
