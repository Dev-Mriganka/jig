// Masking of customer personal data in results (README, "Masking"). Tokens are keyed and deterministic for one key,
// so the model can correlate a value across results without seeing it. A result that cannot be masked is never
// partly returned: masking throws MaskError and the caller drops the result.
import { MaskEngine } from "./engine.ts";

export { MaskError } from "./error.ts";
export { dailyMaskKey } from "./key.ts";

export interface Masker {
    text(input: string): string;
    value<T>(input: T): T;
}

export interface MaskOptions {
    /** Field names a company plugin adds to the generic list of fields that hold personal data. Names are compared
     *  without case or separators, and their values become `personal#` tokens. */
    extraFields?: readonly string[];
}

/** `key` is the day's secret (32 random bytes). Throws MaskError if it is shorter than 16 bytes. */
export function createMasker(key: Uint8Array, options: MaskOptions = {}): Masker {
    const engine = new MaskEngine(key, options.extraFields);
    return {
        text: (input) => engine.text(input),
        value: <T>(input: T): T => engine.value(input),
    };
}
