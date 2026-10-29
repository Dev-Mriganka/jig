import { limitError } from "./error.ts";

// Anything larger is refused, never truncated or half masked: the caller drops the whole result. The byte limit is
// sized for one log line that carries a whole API response.
export const MAX_BYTES = 16_777_216;
const MAX_DEPTH = 64;
export const MAX_NODES = 2_000_000;

export function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/** The budget of one masking call, so one hostile input cannot take unbounded time or memory. One per call. */
export class Limits {
    #nodes = 0;
    #bytes = 0;

    /** Called for every JSON value visited. */
    visit(depth: number): void {
        this.requireDepth(depth);
        if (++this.#nodes > MAX_NODES) throw limitError("node count");
    }

    requireDepth(depth: number): void {
        if (depth > MAX_DEPTH) throw limitError("nesting depth");
    }

    /** Total size of all keys and scalars seen, so many small values cannot add up past the input limit. */
    addBytes(bytes: number): void {
        this.#bytes += bytes;
        if (this.#bytes > MAX_BYTES) throw limitError("input size");
    }
}
