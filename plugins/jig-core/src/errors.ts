// A message from anything that was thrown. Code can throw a string or an object, not only an `Error`.
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A tool said the input is invalid by throwing a `TypeError` (the contract's rule): the call is blocked with the
 *  tool's message, and nobody is asked about a call that cannot run. */
export class InvalidInputError extends Error {}
