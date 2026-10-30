// A secret reference is a scheme and a name (`pass:work/api-token`, `env:API_TOKEN`, `op://vault/item/field`). Never the secret
// itself: a token pasted where a reference belongs has neither, and is refused without being repeated. Shared by the `api`
// section (config.ts) and by the sources that take a reference of their own (a Postman API key).
export const SECRET_REFERENCE = /^[a-z][a-z0-9+.-]*:\S+$/;

/** A secret reference, never the secret itself. The value is not repeated: a mistaken reference may be the secret. */
export function checkReference(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value === "string" && SECRET_REFERENCE.test(value)) return value;
    errors.push(`${key}: must be a secret reference such as pass:work/api-token, not the secret itself`);
    return undefined;
}
