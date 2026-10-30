import { MaskError, unsupportedError } from "./error.ts";
import { createClassifier } from "./kinds.ts";
import type { KindOf } from "./kinds.ts";
import { Pass, UNPARSEABLE } from "./pass.ts";
import { Tokens } from "./token.ts";

/** Any failure, expected or not, becomes a MaskError with a fixed message: caller input must never reach it. */
function failClosed<T>(work: () => T): T {
    try {
        return work();
    } catch (error) {
        throw error instanceof MaskError ? error : new MaskError("masking failed: internal error");
    }
}

/** The masking engine. Stateless apart from its key and its field rules; every call gets a fresh pass. */
export class MaskEngine {
    readonly #tokens: Tokens;
    readonly #kindOf: KindOf;

    constructor(key: Uint8Array, extraFields: readonly string[] = []) {
        this.#tokens = new Tokens(key);
        this.#kindOf = createClassifier(extraFields);
    }

    text(input: string): string {
        return failClosed(() => {
            if (typeof input !== "string") throw unsupportedError();
            return this.#attempt(input) ?? this.#withholdLines(input);
        });
    }

    value<T>(input: T): T {
        return failClosed(() => new Pass(this.#tokens, this.#kindOf).walk(input, "other", "", 0) as T);
    }

    /** One masking pass over `input`; undefined when the pass withholds it (see Pass.tryText). */
    #attempt(input: string): string | undefined {
        return new Pass(this.#tokens, this.#kindOf).tryText(input, 0);
    }

    /**
     * Something in the text cannot be parsed safely. Lines are the records of a log or a summary, so each line is
     * tried on its own and only the ones that fail are replaced; the text without them is then masked once more as a
     * whole, so patterns that span lines still see both sides. If that fails too, the fault is not in one line (a
     * JSON block cut off across lines) and the whole text is withheld, as for a single string.
     */
    #withholdLines(input: string): string {
        const parts = input.split(/(\r?\n)/); // lines at even indexes, their separators at odd ones
        let withheld = false;
        if (parts.length > 1) {
            const kept = parts.map((part, index) => {
                if (index % 2 === 1 || this.#attempt(part) !== undefined) return part;
                withheld = true;
                return UNPARSEABLE;
            });
            const rest = withheld ? this.#attempt(kept.join("")) : undefined;
            if (rest !== undefined) return rest;
        }
        return UNPARSEABLE;
    }
}
