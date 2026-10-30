// Small helpers the modules share: the error that means "invalid input", and ways to put a value into a message.

/**
 * A mistake in a call's input, or in the configuration it names. jig-core takes a `TypeError` from a classification or a
 * preview to mean "invalid input" and blocks the call without asking, so every such finding is an InputError. A TypeError
 * from a bug in this plugin is not an InputError, and tool.ts keeps it from being mistaken for one.
 */
export class InputError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "InputError";
    }
}

export type Doc = Record<string, unknown>;

export function isObject(value: unknown): value is Doc {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** JSON with the keys of every object in order, so two equal values give the same text. */
export function stableJson(value: unknown): string {
    const sorted = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(sorted);
        if (isObject(item))
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => [key, sorted(item[key])]),
            );
        return item;
    };
    return JSON.stringify(sorted(value)) ?? "null";
}
