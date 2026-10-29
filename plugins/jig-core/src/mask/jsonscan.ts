// Finding and parsing JSON that is embedded in log text, plain (`{"a":1}`) or escaped inside another string
// (`{\"a\":1}`).

/** Index of the next `{` or `[` that plausibly opens JSON (an object with a key or nothing, or an array of values),
 *  or -1. */
export function findJsonStart(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c !== "{" && c !== "[") continue;
        let next = i + 1;
        while (next < text.length && /\s/.test(text[next] ?? "")) next++;
        const after = text[next];
        if (c === "{") {
            if (after === '"' || after === "}" || (after === "\\" && text[next + 1] === '"')) return i;
        } else if (after === "{" || after === "[" || after === '"') {
            return i;
        }
    }
    return -1;
}

/** Index just past the bracket that closes the one at `start`, or undefined when the text ends first or the brackets
 *  disagree. */
export function jsonSegmentEnd(text: string, start: number): number | undefined {
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

type JsonText = (
    text: string,
    reviver?: (key: string, value: unknown, context: { source?: string }) => unknown,
) => unknown;

/** Node has JSON.rawJSON and JSON.isRawJSON, but TypeScript's ESNext lib does not declare them, so this is a typed
 *  view of JSON. */
export const RawJson = JSON as unknown as { rawJSON(text: string): object; isRawJSON(value: unknown): boolean };

/**
 * Parses JSON, keeping numbers that JavaScript cannot print back identically (`12345678901234567890`, `1.50`)
 * as raw JSON so re-serialising masked log text never alters an identifier.
 */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
        const parse = JSON.parse as JsonText;
        const value = parse(text, (_key, v, context) =>
            typeof v === "number" && context?.source !== undefined && String(v) !== context.source
                ? RawJson.rawJSON(context.source)
                : v,
        );
        return { ok: true, value };
    } catch {
        return { ok: false };
    }
}
