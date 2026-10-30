// Small helpers the modules share: the error that means "invalid input", and ways to put a value into a message.

/**
 * A mistake in a call's input, or in the configuration it names. jig-core takes a `TypeError` from a preview to mean
 * "invalid input" and blocks the call without asking, so every such finding is an InputError, which is a TypeError. A
 * TypeError from a bug in this plugin is not an InputError, and tool.ts keeps it from being mistaken for one.
 */
export class InputError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "InputError";
    }
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lines of a body that a person or the model is shown: a preview cuts a long body to this, and a result a long text. */
export const SHOWN_LINES = 200;

/** A message from anything that was thrown. Code can throw a string or an object, not only an `Error`. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

/**
 * The items joined, cut after about `max` characters with a count of the rest. jig-core shows a blocked call's reason to
 * the model cut at 200 characters, so a message that lists choices lists only the first few.
 */
export function shortList(items: readonly string[], separator = ", ", max = 100): string {
    let text = "";
    for (const [index, item] of items.entries()) {
        const next = text === "" ? item : `${text}${separator}${item}`;
        if (text !== "" && next.length > max) return `${text} (and ${items.length - index} more)`;
        text = next;
    }
    return text;
}

/** The text on one line, cut after `max` characters. */
export function oneLine(text: string, max = 200): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
