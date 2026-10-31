// Postman's `auth` blocks, read for the sign-ins that need no browser: bearer, basic, an API key in a header, and OAuth 2.0 with a
// client-credentials or password grant. Anything else is refused with the reason, so the request that needs it is refused by name.
import { isObject } from "../engine/values.ts";
import type { Auth } from "../model.ts";
import { attributesOf } from "./postman-values.ts";
import type { Reading } from "./postman-values.ts";

export type AuthResult = { auth: Auth; unsupported?: undefined } | { auth?: undefined; unsupported: string };

/** Auth that a request, a folder or the collection sets. Undefined for no setting at all, which inherits. */
export function authOf(raw: unknown, reading: Reading, key: string): AuthResult | undefined {
    if (!isObject(raw)) return undefined;
    const type = raw.type;
    if (typeof type !== "string") return undefined;
    const attributes = attributesOf(raw[type]);
    const get = (name: string): string => attributes.get(name) ?? "";
    switch (type) {
        case "noauth":
            return { auth: { kind: "none" } };
        case "bearer":
            return { auth: { kind: "bearer", token: get("token") } };
        case "basic":
            return { auth: { kind: "basic", username: get("username"), password: get("password") } };
        case "apikey": {
            if ((attributes.get("in") ?? "header") !== "header") {
                return {
                    unsupported:
                        "an API key sent in the query string (an address ends up in logs, so a key is sent in a header only)",
                };
            }
            return { auth: { kind: "apiKey", name: get("key"), value: get("value") } };
        }
        case "oauth2": {
            const grant = attributes.get("grant_type") ?? "";
            const headless = grant === "client_credentials" || grant === "password_credentials" || grant === "password";
            if (!headless) {
                if (attributes.get("accessToken")) {
                    reading.problems.push({
                        file: reading.shown,
                        key: `${key}.oauth2`,
                        message:
                            "holds an access token in the file. It is ignored and never sent; " +
                            "get tokens with a client-credentials or password grant",
                        level: "warning",
                    });
                }
                const named = grant === "" ? "no headless grant" : `the grant "${grant}"`;
                return {
                    unsupported: `OAuth 2.0 with ${named} (it needs a browser; only client_credentials and password work)`,
                };
            }
            if ((attributes.get("addTokenTo") ?? "header") !== "header")
                return { unsupported: "OAuth 2.0 with the token in the query string" };
            const prefix = attributes.get("headerPrefix");
            if (prefix !== undefined && prefix !== "" && prefix.toLowerCase() !== "bearer") {
                return { unsupported: `OAuth 2.0 with the header prefix "${prefix}" (only Bearer is sent)` };
            }
            const secret = attributes.get("clientSecret");
            const username = attributes.get("username");
            const password = attributes.get("password");
            const scope = attributes.get("scope");
            return {
                auth: {
                    kind: "oauth2",
                    grant: grant === "client_credentials" ? "client_credentials" : "password",
                    tokenUrl: get("accessTokenUrl"),
                    clientId: get("clientId"),
                    ...(secret === undefined || secret === "" ? {} : { clientSecret: secret }),
                    ...(username === undefined ? {} : { username }),
                    ...(password === undefined ? {} : { password }),
                    ...(scope === undefined || scope === "" ? {} : { scope }),
                    clientAuth: attributes.get("client_authentication") === "body" ? "body" : "header",
                },
            };
        }
        default:
            return {
                unsupported: `the sign-in type "${type}" is not sent (bearer, basic, apikey and OAuth 2.0 client credentials or password are)`,
            };
    }
}
