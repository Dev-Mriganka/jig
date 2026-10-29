import { malformedError } from "./error.ts";
import type { Host } from "./host.ts";
import type { Kind } from "./kinds.ts";

// Unquoted phone and card values may contain spaces, so they are read with their own grammar.
const PHONE_VALUE = new RegExp(
    String.raw`(?:\+[1-9](?:[ .-]?\d){7,14}|(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4})` +
        String.raw`(?:\s*(?:ext\.?|x)\s*\d{1,5})?`,
    "iy",
);
const CARD_VALUE = /(?:\d[ -]?){12,18}\d/y;

/** End of an unquoted phone or card value starting at `start`, or undefined if it holds no digits (so it is not a
 *  number at all). */
function groupedValueEnd(input: string, start: number, kind: "phone" | "card", rawValue: string): number | undefined {
    if (!/\d/.test(rawValue)) return undefined;
    const pattern = kind === "phone" ? PHONE_VALUE : CARD_VALUE;
    pattern.lastIndex = start;
    const found = pattern.exec(input);
    // A number we cannot delimit exactly may continue past what we mask: fail closed.
    if (found === null || /\d/.test(input[start + found[0].length] ?? "")) throw malformedError();
    return start + found[0].length;
}

/** `authorization=Bearer abc123`: the credential is the word after the scheme, so the value spans both. */
function withAuthScheme(input: string, valueEnd: number, rawValue: string): number {
    if (!/^(?:Bearer|Basic|Token)$/i.test(rawValue)) return valueEnd;
    const next = /\s+[^\s&]+/y;
    next.lastIndex = valueEnd;
    return next.exec(input) === null ? valueEnd : next.lastIndex;
}

/** Masks `key=value` pairs (log fields) by key name: `deviceId=abc`, `name="Casey Sample"`, `password=...`. */
export function maskLogFields(host: Host, input: string, depth: number): string {
    // A key may follow a quote, so `msg="password=abc def"` is seen from inside the quotes.
    const pattern = /(?<![^\s"'])([A-Za-z_][A-Za-z0-9_]*)=("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s&]+)/g;
    let out = "";
    let cursor = 0;
    for (let found = pattern.exec(input); found !== null; found = pattern.exec(input)) {
        const [whole, key = "", rawValue = ""] = found;
        const kind: Kind = host.kindOf(key, "");
        const quoted = rawValue.startsWith('"') || rawValue.startsWith("'");
        if (quoted && (rawValue.length < 2 || !rawValue.endsWith(rawValue[0] ?? ""))) throw malformedError();

        const valueStart = found.index + whole.length - rawValue.length;
        let valueEnd = found.index + whole.length;
        if (kind === "other") {
            // Judged by the text rules that follow; a quoted value is searched for further `key=value` pairs inside it.
            pattern.lastIndex = quoted ? valueStart + 1 : valueEnd;
            continue;
        }
        if (!quoted && (kind === "phone" || kind === "card")) {
            valueEnd = groupedValueEnd(input, valueStart, kind, rawValue) ?? valueEnd;
        }
        if (!quoted && kind === "credential") valueEnd = withAuthScheme(input, valueEnd, rawValue);
        const raw = input.slice(valueStart, valueEnd);
        const text = quoted ? raw.slice(1, -1) : raw;

        const masked = host.scalar(text, kind, depth + 1);
        // Safe values keep their quotes unless a credential shape was removed. Either way the result is final.
        const value = host.protect(kind === "safe" && masked === text ? raw : masked);
        out += `${input.slice(cursor, found.index)}${key}=${value}`;
        cursor = valueEnd;
        pattern.lastIndex = valueEnd;
    }
    return out + input.slice(cursor);
}
