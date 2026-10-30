import { malformedError } from "./error.ts";
import type { Host } from "./host.ts";
import { findJsonStart, jsonSegmentEnd, parseJson } from "./jsonscan.ts";

/**
 * Masks JSON inside text with the field rules, so `payload={"password":"x"}` is judged by its field names.
 * JSON that cannot be delimited or parsed is refused rather than guessed at: a truncated payload may hold data.
 */
export function maskEmbeddedJson(host: Host, input: string, depth: number): string {
    const trimmed = input.trim();
    if (trimmed.startsWith('"')) {
        const whole = parseJson(trimmed);
        if (whole.ok && typeof whole.value === "string") return JSON.stringify(host.text(whole.value, depth + 1));
    }
    let out = "";
    let cursor = 0;
    for (let start = findJsonStart(input, 0); start >= 0; start = findJsonStart(input, cursor)) {
        const end = jsonSegmentEnd(input, start);
        if (end === undefined) throw malformedError();
        out += input.slice(cursor, start);
        const chunk = input.slice(start, end);
        // `{\"a\":1}`: JSON that was itself serialised into a string, once.
        const escaped = chunk.startsWith('{\\"') || chunk.startsWith('[\\"');
        const parsed = parseJson(escaped ? chunk.replaceAll('\\"', '"') : chunk);
        if (parsed.ok) {
            out += host.protect(JSON.stringify(host.json(parsed.value, depth + 1)));
        } else if (chunk.includes('":')) {
            throw malformedError(); // looks like key/value JSON but is not parseable
        } else {
            out += chunk; // brackets in code or prose: leave it to the text rules
        }
        cursor = end;
    }
    return out + input.slice(cursor);
}
