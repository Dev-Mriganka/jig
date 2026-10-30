// The texts of a request in which a `{{variable}}` may stand, for the sources to work out which variables it uses.
import type { Auth, Body } from "../model.ts";

/** The texts of a sign-in: every one of them fills the sign-in, so the agent never gives their variables. */
export function authTexts(auth: Auth): string[] {
    switch (auth.kind) {
        case "none": return [];
        case "bearer": return [auth.token];
        case "basic": return [auth.username, auth.password];
        case "apiKey": return [auth.name, auth.value];
        case "oauth2": {
            const fields = [auth.tokenUrl, auth.clientId, auth.clientSecret, auth.username, auth.password, auth.scope];
            return fields.filter((item): item is string => item !== undefined);
        }
    }
}

/** The texts of a body. A file has none. */
export function bodyTexts(body: Body | undefined): string[] {
    if (body === undefined) return [];
    switch (body.kind) {
        case "raw":
        case "json": return [body.text];
        case "file": return [];
        case "graphql": return [body.query, ...(body.variables === undefined ? [] : [body.variables])];
        case "form": return body.fields.flatMap((field) => (field.kind === "text" ? [field.value] : []));
    }
}
