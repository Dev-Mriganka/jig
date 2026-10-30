// Small helpers the modules share: the error that means "invalid input", and ways to put a value into a message.

/**
 * A mistake in a call's input, or in the configuration it names. jig-core takes a `TypeError` from a tool's classify to
 * mean "invalid input" and blocks the call without asking. Every such finding is an InputError, which is a TypeError.
 * A TypeError from a bug in this plugin is not one, and tool.ts keeps the two apart, so a bug is never reported as the
 * model's mistake.
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
