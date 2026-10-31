// The security of an OpenAPI spec: which of its security schemes this plugin can send (bearer, basic, an API key in a header, OAuth with
// client credentials or a password), the secret slots each one fills, and which alternative a request's requirements come to. A scheme
// that needs a browser, or sends a key in an address, is refused with the reason, and the request that needs it is refused by name.
import { isObject } from "../engine/values.ts";
import type { Auth } from "../model.ts";
import { SERVER_ORIGIN, textOf } from "./openapi-spec.ts";

/** What a security scheme comes to: a sign-in made of secret slots, or the reason it is refused. */
export interface Scheme {
    /** The slots it fills, each a secret variable. */
    slots: string[];
    /** The sign-in, with the scopes of the requirement that names it still to be added for OAuth. */
    auth?: (scopes: readonly string[]) => Auth;
    refused?: string;
}

export function schemeOf(name: string, definition: unknown, serverOrigins: ReadonlySet<string>): Scheme {
    if (!isObject(definition)) return { slots: [], refused: "its definition cannot be read" };
    switch (definition.type) {
        case "http": {
            const scheme = textOf(definition.scheme).toLowerCase();
            if (scheme === "bearer") return { slots: [name], auth: () => ({ kind: "bearer", token: `{{${name}}}` }) };
            if (scheme === "basic") {
                const slots = [`${name}.username`, `${name}.password`];
                return {
                    slots,
                    auth: () => ({ kind: "basic", username: `{{${slots[0]}}}`, password: `{{${slots[1]}}}` }),
                };
            }
            return { slots: [], refused: `the HTTP scheme "${scheme}" is not sent (bearer and basic are)` };
        }
        case "apiKey": {
            if (definition.in === "header" && textOf(definition.name) !== "") {
                return {
                    slots: [name],
                    auth: () => ({ kind: "apiKey", name: textOf(definition.name), value: `{{${name}}}` }),
                };
            }
            const where =
                definition.in === "query"
                    ? "the query string (an address ends up in logs, so a key is sent in a header only)"
                    : `a ${textOf(definition.in) || "cookie"} (no cookies are sent)`;
            return { slots: [], refused: `an API key sent in ${where}` };
        }
        case "oauth2": {
            const flows = isObject(definition.flows) ? definition.flows : {};
            const flow = isObject(flows.clientCredentials)
                ? "client_credentials"
                : isObject(flows.password)
                  ? "password"
                  : undefined;
            if (flow === undefined) {
                const named = Object.keys(flows).join(", ") || "none";
                return {
                    slots: [],
                    refused: `OAuth 2.0 with the flows ${named} (they need a browser; only clientCredentials and password work)`,
                };
            }
            const details = (flow === "password" ? flows.password : flows.clientCredentials) as Record<string, unknown>;
            const tokenUrl = tokenAddress(textOf(details.tokenUrl), serverOrigins);
            if (tokenUrl.refused !== undefined) return { slots: [], refused: tokenUrl.refused };
            const slots = [
                `${name}.clientId`,
                `${name}.clientSecret`,
                ...(flow === "password" ? [`${name}.username`, `${name}.password`] : []),
            ];
            return {
                slots,
                auth: (scopes) => ({
                    kind: "oauth2",
                    grant: flow,
                    tokenUrl: tokenUrl.template as string,
                    clientId: `{{${name}.clientId}}`,
                    clientSecret: `{{${name}.clientSecret}}`,
                    ...(flow === "password"
                        ? { username: `{{${name}.username}}`, password: `{{${name}.password}}` }
                        : {}),
                    ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
                    clientAuth: "header",
                }),
            };
        }
        case "openIdConnect":
            return { slots: [], refused: "OpenID Connect is not sent (it needs a browser)" };
        case "mutualTLS":
            return { slots: [], refused: "mutual TLS is not sent" };
        default:
            return { slots: [], refused: `the security scheme type "${textOf(definition.type)}" is not sent` };
    }
}

/**
 * The token address as a template on the environment's server. A relative address is on the server. An address with a host is
 * accepted only when it is on one of the spec's own servers, so that it follows the environment to its mapped server; a token
 * endpoint on any other host is not one of the environment's hosts, and the client's secret is not sent there.
 */
function tokenAddress(address: string, serverOrigins: ReadonlySet<string>): { template?: string; refused?: string } {
    if (address === "") return { refused: "OAuth 2.0 with no token address" };
    if (address.startsWith("/")) return { template: `{{${SERVER_ORIGIN}}}${address}` };
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return { refused: "OAuth 2.0 with a token address that is not an address" };
    }
    if (!serverOrigins.has(url.origin)) {
        return {
            refused:
                `OAuth 2.0 with its token address on ${url.host}, which is not one of the servers of the spec, ` +
                "so it is not a host of the environment",
        };
    }
    return { template: `{{${SERVER_ORIGIN}}}${url.pathname}${url.search}` };
}

interface Chosen {
    auth: Auth;
    slots: string[];
    unsupported?: string;
}

/** The sign-in for a list of security requirements: the first alternative that is one scheme this plugin can send. */
export function chooseAuth(requirements: unknown, schemes: ReadonlyMap<string, Scheme>): Chosen {
    if (!Array.isArray(requirements) || requirements.length === 0) return { auth: { kind: "none" }, slots: [] };
    let anonymous = false;
    const reasons: string[] = [];
    for (const requirement of requirements as unknown[]) {
        const names = isObject(requirement) ? Object.keys(requirement) : [];
        if (names.length === 0) {
            anonymous = true;
            continue;
        }
        if (names.length > 1) {
            reasons.push(`it needs several security schemes at once (${names.join(", ")}), and only one can be sent`);
            continue;
        }
        const name = names[0] as string;
        const scheme = schemes.get(name);
        if (scheme === undefined) reasons.push(`it names the security scheme ${name}, which the spec does not define`);
        else if (scheme.refused !== undefined || scheme.auth === undefined) {
            reasons.push(`the security scheme ${name}: ${scheme.refused ?? "cannot be sent"}`);
        } else {
            const listed =
                isObject(requirement) && Array.isArray(requirement[name]) ? (requirement[name] as unknown[]) : [];
            const scopes = listed.filter((scope): scope is string => typeof scope === "string");
            return { auth: scheme.auth(scopes), slots: scheme.slots };
        }
    }
    if (anonymous) return { auth: { kind: "none" }, slots: [] };
    return {
        auth: { kind: "none" },
        slots: [],
        unsupported: reasons[0] ?? "it has a security requirement that cannot be read",
    };
}
