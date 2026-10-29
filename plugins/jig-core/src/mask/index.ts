// STUB: replaced by the mask port (branch build/mask). Same exports, same signatures.
export class MaskError extends Error {}
export interface Masker { text(input: string): string; value<T>(input: T): T; }
export interface MaskOptions { extraFields?: readonly string[]; }
export function createMasker(_key: Uint8Array, _options?: MaskOptions): Masker {
    throw new MaskError("masking is not built yet");
}
export function dailyMaskKey(_stateDir: string, _now?: Date): Uint8Array {
    return new Uint8Array(32);
}
