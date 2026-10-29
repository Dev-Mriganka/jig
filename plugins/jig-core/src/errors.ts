// A message from anything that was thrown. Code can throw a string or an object, not only an `Error`.
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
