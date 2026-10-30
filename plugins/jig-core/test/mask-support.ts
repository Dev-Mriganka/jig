// Shared by the masking tests: a fixed key, a masker, and small assertion helpers.
import assert from "node:assert/strict";
import { createMasker, MaskError } from "../src/mask/index.ts";
import type { MaskOptions, Masker } from "../src/mask/index.ts";

/** A deterministic key: `keyOf(7)` is 32 bytes of 7. */
export function keyOf(fill: number): Uint8Array {
    return new Uint8Array(32).fill(fill);
}

export function masker(fill = 7, options?: MaskOptions): Masker {
    return createMasker(keyOf(fill), options);
}

export function maskText(text: string, fill = 7): string {
    return masker(fill).text(text);
}

/** The masked copy of `value`. Typed loosely on purpose: masking keeps the shape but changes values, so a number
 *  field may come back as a token string, and the tests read results by path. */
export function maskValue(value: unknown, fill = 7, options?: MaskOptions): any {
    return masker(fill, options).value(value);
}

/** Asserts that masking throws MaskError (and nothing else), however the failure came about. */
export function assertFailsClosed(work: () => unknown, message?: string): void {
    assert.throws(work, (error: unknown) => error instanceof MaskError, message);
}

/** A string the masker cannot parse safely is withheld whole: the output is the marker and nothing of the input. */
export function assertWithheld(work: () => string, message?: string): void {
    assert.equal(work(), "[removed:unparseable]", message ?? "the string is withheld");
}

/** The masked value serialised as text, for checks that nothing sensitive survives anywhere in it. */
export function render(value: unknown): string {
    return JSON.stringify(value);
}

export function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

/** How many times `needle` occurs in `text`. */
export function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}
