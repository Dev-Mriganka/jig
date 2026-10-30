// The one error a request throws. See http.ts.

/** Why a request got no reply (see `HttpErrorInfo` in the contract). */
export class HttpError extends Error {
    readonly code: string;
    readonly notSent: boolean;
    constructor(code: string, message: string, notSent: boolean, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "HttpError";
        this.code = code;
        this.notSent = notSent;
    }
}

/** True for an `HttpError` from any copy of this module: a plugin in its own package root has its own. */
export function isHttpError(error: unknown): error is HttpError {
    return (
        error instanceof Error &&
        error.name === "HttpError" &&
        typeof (error as { code?: unknown }).code === "string" &&
        typeof (error as { notSent?: unknown }).notSent === "boolean"
    );
}
