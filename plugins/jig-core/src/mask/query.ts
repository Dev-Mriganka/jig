import { malformedError } from "./error.ts";
import type { Host } from "./host.ts";
import { removed } from "./kinds.ts";
import { percentDecode } from "./percent.ts";

// A decoded value that still has a literal `%` and could hide further syntax (`a=1;password=x`) is not guessed at.
const NESTED_SYNTAX = /[=:{[;,"']/;

/** Masks URL query values by their (decoded) parameter names. Keys are written back decoded. */
export function maskQuery(host: Host, input: string, depth: number): string {
    if (!input.includes("?")) return input;
    const pair = /([?&])([^=&\s]+)=([^&\s]*)/g;
    return input.replace(pair, (_match, separator: string, rawKey: string, rawValue: string) => {
        const value = percentDecode(rawValue);
        const key = percentDecode(rawKey);
        if (key.includes("%")) throw malformedError();
        const kind = host.kindOf(key, "");
        // Fields that are normally read as they are (or scanned as text) cannot be trusted once a `%` is left over.
        const ambiguous = value.includes("%") &&
            (kind === "safe" || ((kind === "other" || kind === "identifier") && NESTED_SYNTAX.test(value)));
        const masked = ambiguous ? removed("sensitive") : host.scalar(value, kind, depth + 1);
        return `${separator}${key}=${host.protect(masked)}`; // final: later stages must not re-scan it
    });
}
