// A plan is what one call will send, worked out once from the checked call: the full address, and a fingerprint of
// everything the person is shown. The preview and the execution both make the plan from the same code, and the
// fingerprint ties them together: if the plan at execution differs from the one that was approved, nothing is sent
// (see tool.ts).
import { createHash } from "node:crypto";
import type { Auth } from "../config.ts";
import type { Call } from "../params.ts";
import { InputError } from "./values.ts";

export interface Plan {
    call: Call;
    /** The address that is called: the target's base address and the path, nothing else. */
    url: string;
    fingerprint: string;
}

/** How a target signs in, in words for the person who approves a call. Never a reference or a value. */
export function describeAuth(auth: Auth): string {
    switch (auth.kind) {
        case "none": return "none";
        case "bearer": return "a bearer token";
        case "oauthPassword": return "an OAuth token (password grant)";
        case "signIn": return `sign-in service "${auth.name}"`;
        case "transport": return `transport "${auth.name}"`;
    }
}

/** The base address with the path added to its text. It is never resolved against it, so `//other.test/x` stays a path
 *  on this host, and the host is the one the target names. */
function addressOf(call: Call): string {
    const { baseUrl } = call.target;
    const url = new URL(`${baseUrl}${call.path}${call.query}`);
    if (url.origin !== new URL(baseUrl).origin) throw new InputError("http: the path would change the host: refused");
    return url.href;
}

/** A digest of everything the preview shows, and of the environment and sign-in the call acts through. The timeout is
 *  left out: it changes how long the tool waits, not what it sends. */
function fingerprintOf(call: Call, url: string): string {
    const { target } = call;
    const headers = call.headers
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const facts = [target.name, target.environment, describeAuth(target.auth), call.method, url, headers, call.body ?? null];
    return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

export function planOf(call: Call): Plan {
    const url = addressOf(call);
    return { call, url, fingerprint: fingerprintOf(call, url) };
}
