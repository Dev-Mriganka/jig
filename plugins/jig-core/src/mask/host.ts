import type { Kind } from "./kinds.ts";
import type { Tokens } from "./token.ts";

/**
 * What the text stages need from the masking pass that drives them. Passing it in keeps the stages free of imports
 * back into the pass, which recurses into them (a log field's value is masked by the same rules).
 */
export interface Host {
    readonly tokens: Tokens;
    /** What a field of this name holds, judged by the rules of this masker (built-in plus the company's). */
    kindOf(key: string, parent: string): Kind;
    /** Hides `text` from every later stage and returns the placeholder; restored at the end of the pass. */
    protect(text: string): string;
    /** Masks a decoded scalar the way a field of this kind would be masked. */
    scalar(text: string, kind: Kind, depth: number): string;
    /** Masks free text (all stages). */
    text(input: string, depth: number): string;
    /** Masks parsed JSON found inside text. */
    json(value: unknown, depth: number): unknown;
}
