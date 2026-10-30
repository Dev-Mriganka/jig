// Why masking gave up. Messages are fixed text and never built from the input, so they are safe to log.

/** "malformed" is handled inside the masker: that one string becomes `[removed:unparseable]`. Every other failure
 *  means the caller must drop the whole result, because there is no partial output. */
export type MaskFailure = "limit" | "malformed" | "unsupported" | "internal";

export class MaskError extends Error {
    readonly failure: MaskFailure;

    constructor(message: string, failure: MaskFailure = "internal") {
        super(message);
        this.name = "MaskError";
        this.failure = failure;
    }
}

export function limitError(what: string): MaskError {
    return new MaskError(`masking failed: ${what} exceeds the masking limit`, "limit");
}

/** Encoded content that cannot be decoded for inspection would hide data, so the string holding it is withheld. */
export function malformedError(): MaskError {
    return new MaskError("masking failed: malformed encoded content", "malformed");
}

export function unsupportedError(): MaskError {
    return new MaskError("masking failed: value is not JSON-like", "unsupported");
}

export function reservedCharacterError(): MaskError {
    return new MaskError("masking failed: input contains a reserved character", "unsupported");
}
