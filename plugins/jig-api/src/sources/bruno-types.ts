// What a Bruno file says, in one shape whichever language it was written in (`.bru` or OpenCollection YAML). The two readers
// (bruno-bru.ts, bruno-yaml.ts) produce these, and bruno.ts turns them into saved requests: inheritance, variables and
// refusals are done once, there.
import type { Auth, Body } from "../model.ts";

/** A sign-in as a collection, a folder or a request sets it. `inherit` takes the nearest one above. */
export type AuthSetting =
    | { kind: "inherit" }
    | { kind: "none" }
    | { kind: "set"; auth: Auth }
    /** A sign-in this plugin does not send, with its name: the requests that use it are refused. */
    | { kind: "refused"; reason: string };

export type Pairs = Array<readonly [name: string, value: string]>;

export interface ParsedBody {
    body?: Body;
    /** The content type Bruno sends for the body when the request sets none. */
    contentType?: string;
    unsupported?: string;
    notes: string[];
}

/** Where a reader reports what it could not understand: a key in the file, and what is wrong. */
export type Report = (key: string, message: string, level: "warning" | "error") => void;

/** What a collection file or a folder file sets for everything below it. */
export interface ParsedDefaults {
    /** The name Bruno shows. Without one, a folder is named by its directory. */
    name: string | undefined;
    seq: number | undefined;
    headers: Pairs;
    auth: AuthSetting;
    /** Variables for the requests below, with the `@` of a local variable dropped. */
    vars: Map<string, string>;
    /** True when a script runs before the requests below. */
    prerequest: boolean;
    docs: string | undefined;
}

/** What a request file says. */
export interface ParsedRequest {
    name: string | undefined;
    seq: number | undefined;
    /** `http`, `graphql`, `websocket`, `grpc`. */
    type: string;
    method: string;
    url: string;
    headers: Pairs;
    /** The values of `:name` path parameters. */
    pathParams: Pairs;
    body: ParsedBody;
    auth: AuthSetting;
    vars: Map<string, string>;
    prerequest: boolean;
    /** What is ignored: a test script, a post-response script, redirect settings. */
    notes: string[];
    /** The declared checks, as `expression operator value`. */
    assertions: string[];
    docs: string | undefined;
}

export interface ParsedVariable {
    name: string;
    /** Undefined for a secret, or a variable with no value. */
    value: string | undefined;
    secret: boolean;
    /** Where the value comes from when it is not in the file: `aws-secrets-manager`, `hashicorp-vault-server`... */
    external?: string;
}

export interface ParsedEnvironment {
    name: string | undefined;
    variables: ParsedVariable[];
    /** The environments it extends, by name, nearest first. */
    extends: string[];
    /** True when the file points at a `.env` file, which is never read. */
    dotEnv: boolean;
}

/** An empty text, or one that is only white space, is no script. */
export const hasText = (text: string | undefined): boolean => text !== undefined && text.trim() !== "";

/** The body that is no body at all. */
export const noBody = (): ParsedBody => ({ notes: [] });

/** Bruno's `@file(a|b)` value in a multipart form or a file body: the paths. */
export function filesOf(value: string): string[] | undefined {
    const match = /^@file\((.*)\)$/s.exec(value.trim());
    return match === null ? undefined : (match[1] as string).split("|").map((part) => part.trim()).filter((part) => part !== "");
}

/** The sign-in forms that this plugin does not send, by the name Bruno gives them. */
export const REFUSED_AUTH: Readonly<Record<string, string>> = {
    digest: "Digest authentication",
    ntlm: "NTLM authentication",
    awsv4: "AWS Signature v4",
    oauth1: "OAuth 1.0",
    wsse: "WS-Security (WSSE)",
    "akamai-edgegrid": "Akamai EdgeGrid",
};

export function refusedAuth(mode: string): AuthSetting {
    const named = REFUSED_AUTH[mode];
    if (named !== undefined) return { kind: "refused", reason: `the sign-in type ${named} is not sent (bearer, basic, apikey and OAuth 2.0 client credentials or password are)` };
    return { kind: "refused", reason: `the sign-in type "${mode}" is not sent (bearer, basic, apikey and OAuth 2.0 client credentials or password are)` };
}

/** What OAuth 2.0 settings of either language come to, for `oauth2Auth`. Empty text is a setting that is not there. */
export interface OAuthFields {
    grant: string;
    accessTokenUrl: string;
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    scope: string;
    /** `basic_auth_header` or `body`. Bruno's own default is `body`. */
    credentialsPlacement: string;
    /** `header` or `url` (a query parameter). */
    tokenPlacement: string;
    /** The prefix in `Authorization`, or its name: Bruno's YAML keeps the prefix where the schema says the header name. */
    tokenPrefix: string;
}

/** OAuth 2.0 with a grant that needs no browser, or the reason it is refused. */
export function oauth2Auth(fields: OAuthFields): AuthSetting {
    const grant = fields.grant === "resource_owner_password_credentials" ? "password" : fields.grant;
    if (grant !== "client_credentials" && grant !== "password") {
        const named = grant === "" ? "no headless grant" : `the grant "${grant}"`;
        return { kind: "refused", reason: `OAuth 2.0 with ${named} (it needs a browser; only client_credentials and password work)` };
    }
    if (fields.tokenPlacement !== "" && fields.tokenPlacement !== "header") {
        return { kind: "refused", reason: "OAuth 2.0 with the token in the query string (a token is sent in a header only)" };
    }
    const prefix = fields.tokenPrefix.trim();
    if (prefix !== "" && !/^(?:bearer|authorization)$/i.test(prefix)) {
        return { kind: "refused", reason: `OAuth 2.0 with the header prefix "${prefix}" (only Bearer is sent)` };
    }
    return {
        kind: "set",
        auth: {
            kind: "oauth2",
            grant,
            tokenUrl: fields.accessTokenUrl,
            clientId: fields.clientId,
            ...(fields.clientSecret === "" ? {} : { clientSecret: fields.clientSecret }),
            ...(grant === "password" ? { username: fields.username, password: fields.password } : {}),
            ...(fields.scope === "" ? {} : { scope: fields.scope }),
            clientAuth: fields.credentialsPlacement === "basic_auth_header" ? "header" : "body",
        },
    };
}

/** An API key in a header, or the reason a key anywhere else is refused. */
export function apiKeyAuth(key: string, value: string, placement: string): AuthSetting {
    if (placement !== "" && placement !== "header") {
        return { kind: "refused", reason: "an API key sent in the query string (an address ends up in logs, so a key is sent in a header only)" };
    }
    return { kind: "set", auth: { kind: "apiKey", name: key, value } };
}
