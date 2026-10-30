// A plan is what one request will send, worked out once from a saved request (or an ad-hoc call) and the environment it
// runs in: the full address, the headers, the body, how it signs in, and a fingerprint of everything the person is shown.
// The preview and the execution both make the plan from the same code, and the fingerprint ties them together: if the plan
// at execution differs from the one that was approved, nothing is sent (see tool.ts).
//
// A plan holds no secret value. Secrets, and values made at the moment of sending, are pieces of text that are filled in
// by http.ts, so everything here can be shown, compared and hashed.
import { createHash } from "node:crypto";
import { displayOf, secretsIn } from "./text.ts";
import type { Text } from "./text.ts";

export const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

/** These do not change anything on the server. Every other method writes. */
export const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function isMethod(value: unknown): value is Method {
    return typeof value === "string" && (METHODS as readonly string[]).includes(value);
}

/** How a request signs in. Exactly one, and a request whose sign-in sets a header cannot also have that header. */
export type SignIn =
    /** Nothing is added: the API is open, or the network is its only protection. */
    | { kind: "none" }
    /** `Authorization: Bearer <token>`. */
    | { kind: "bearer"; token: Text }
    /** `Authorization: Basic <user:password>`. */
    | { kind: "basic"; username: Text; password: Text }
    /** A key in a header of the collection's choosing. */
    | { kind: "apiKey"; name: string; value: Text }
    /** The tool fetches an access token with a grant that needs no browser, keeps it until shortly before it expires, and
     *  sends it as a Bearer token. */
    | {
        kind: "oauth";
        grant: "password" | "client_credentials";
        tokenUrl: string;
        clientId: Text;
        clientSecret?: Text;
        username?: Text;
        password?: Text;
        scope?: string;
        /** Where the client's id and secret go: HTTP Basic (RFC 6749 asks for it first), or the form. */
        clientAuth: "header" | "body";
    }
    /** A company sign-in service that jig-core knows by name and that supplies the headers of each request. */
    | { kind: "service"; name: string }
    /** A company transport that carries the whole request. The tool holds no credential and adds no header. */
    | { kind: "transport"; name: string };

export interface Plan {
    /** Names the call in a message, without its address or its body: `api run "Get order"`. */
    label: string;
    /** The system, as sign-in services and transports are told it, and the scope of a cached token: `api:orders`. */
    system: string;
    /** The saved request's name, or `call` for an ad-hoc request. */
    request: string;
    collection: string | undefined;
    /** The collection's name for the environment: `Staging`. */
    environment: string;
    /** The environment jig-core's rules know it by: `staging`. */
    jigEnvironment: string;
    method: Method;
    /** The whole address, with the query. It holds no secret. */
    url: string;
    /** The request's own headers, in order, before the tool's and the sign-in's. */
    headers: ReadonlyArray<readonly [name: string, value: Text]>;
    body: Text | undefined;
    signIn: SignIn;
    timeoutSec: number;
    allowPlainLocal: boolean;
    /** A larger answer than the usual limit, for a request whose answer is a collection and not an API's reply. */
    maxAnswerBytes?: number;
    fingerprint: string;
}

/** How a request signs in, in words for the person who approves it. Never a reference or a value. */
export function describeSignIn(signIn: SignIn): string {
    switch (signIn.kind) {
        case "none": return "none";
        case "bearer": return "a bearer token";
        case "basic": return "a user name and password (HTTP Basic)";
        case "apiKey": return `an API key in the ${signIn.name} header`;
        case "oauth": return `an OAuth token (${signIn.grant === "password" ? "password grant" : "client credentials"})`;
        case "service": return `sign-in service "${signIn.name}"`;
        case "transport": return `transport "${signIn.name}"`;
    }
}

/** The texts a sign-in holds, in a fixed order. */
function signInTexts(signIn: SignIn): Text[] {
    switch (signIn.kind) {
        case "bearer": return [signIn.token];
        case "basic": return [signIn.username, signIn.password];
        case "apiKey": return [signIn.value];
        case "oauth": {
            return [signIn.clientId, signIn.clientSecret, signIn.username, signIn.password].filter((text): text is Text => text !== undefined);
        }
        default: return [];
    }
}

/** Every secret a plan uses, once each, by variable name and reference. */
export function secretsOf(plan: Omit<Plan, "fingerprint">): Array<{ name: string; reference: string }> {
    const texts = [...plan.headers.map(([, value]) => value), ...(plan.body === undefined ? [] : [plan.body]), ...signInTexts(plan.signIn)];
    const seen = new Map<string, string>();
    for (const text of texts) for (const secret of secretsIn(text)) seen.set(secret.secret, secret.reference);
    return [...seen].map(([name, reference]) => ({ name, reference })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function signInFacts(signIn: SignIn): unknown {
    switch (signIn.kind) {
        case "none": return ["none"];
        case "bearer": return ["bearer", displayOf(signIn.token)];
        case "basic": return ["basic", displayOf(signIn.username), displayOf(signIn.password)];
        case "apiKey": return ["apiKey", signIn.name.toLowerCase(), displayOf(signIn.value)];
        case "oauth": {
            const shown = (text: Text | undefined): string | null => (text === undefined ? null : displayOf(text));
            return [
                "oauth", signIn.grant, signIn.tokenUrl, shown(signIn.clientId), shown(signIn.clientSecret), shown(signIn.username),
                shown(signIn.password), signIn.scope ?? null, signIn.clientAuth,
            ];
        }
        case "service": return ["service", signIn.name];
        case "transport": return ["transport", signIn.name];
    }
}

/**
 * A digest of everything the preview shows, and of what it only names: the environment, the sign-in, the secrets and the
 * files (by their digest). The timeout is left out: it changes how long the tool waits, not what it sends.
 */
export function fingerprintOf(plan: Omit<Plan, "fingerprint">): string {
    const headers = plan.headers
        .map(([name, value]) => [name.toLowerCase(), displayOf(value)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const facts = [
        plan.collection ?? null, plan.request, plan.environment, plan.jigEnvironment, signInFacts(plan.signIn), plan.method, plan.url,
        headers, plan.body === undefined ? null : displayOf(plan.body), secretsOf(plan),
    ];
    return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

/** The plan with its fingerprint. */
export function sealed(plan: Omit<Plan, "fingerprint">): Plan {
    return { ...plan, fingerprint: fingerprintOf(plan) };
}

/** A fingerprint for several plans that are approved together. */
export function fingerprintOfAll(plans: readonly Plan[]): string {
    return createHash("sha256").update(JSON.stringify(plans.map((plan) => plan.fingerprint))).digest("hex").slice(0, 32);
}
