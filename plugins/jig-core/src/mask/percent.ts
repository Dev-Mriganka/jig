import { malformedError } from "./error.ts";

const MAX_PASSES = 3;
const decoder = new TextDecoder("utf-8", { fatal: true });

const isHex = (byte: number | undefined): boolean =>
    byte !== undefined &&
    ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66));

function isEscape(bytes: Uint8Array, at: number): boolean {
    return bytes[at] === 0x25 && isHex(bytes[at + 1]) && isHex(bytes[at + 2]);
}

/** One layer of percent-decoding. `strict` rejects a `%` that is not an escape. */
function decodeOnce(text: string, strict: boolean): string {
    const bytes = Buffer.from(text, "utf8");
    const out: number[] = [];
    for (let i = 0; i < bytes.length; ) {
        if (isEscape(bytes, i)) {
            out.push(parseInt(String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0), 16));
            i += 3;
        } else if (strict && bytes[i] === 0x25) {
            throw malformedError();
        } else {
            out.push(bytes[i] ?? 0);
            i++;
        }
    }
    try {
        return decoder.decode(Uint8Array.from(out));
    } catch {
        throw malformedError();
    }
}

/**
 * Decodes up to three layers (`%2540` is `%40` is `@`), so encoded data cannot hide from the field and text rules.
 * The source must be valid percent-encoding; later layers may hold literal `%` (from `%25`).
 * Content still encoded after three layers is deliberately rejected rather than guessed at.
 */
export function percentDecode(text: string): string {
    let current = text.replace(/\+/g, " ");
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (!current.includes("%")) return current;
        const decoded = decodeOnce(current, pass === 0);
        if (decoded === current) return current;
        current = decoded;
    }
    const bytes = Buffer.from(current, "utf8");
    for (let i = 0; i < bytes.length; i++) if (isEscape(bytes, i)) throw malformedError();
    return current;
}
