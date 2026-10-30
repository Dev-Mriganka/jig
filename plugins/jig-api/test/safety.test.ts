// What keeps a credential or a request from going where it was not meant to: a redirect is never followed, no cookie is kept
// or shown, an address on a host outside the environment's is refused, and so are the addresses a cloud machine trusts.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { ok, SECRET_REFERENCE, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => h.reset());

describe("a redirect is never followed", () => {
    const modes: Array<[string, () => void]> = [
        ["no sign-in", () => h.configure()],
        ["a bearer token", () => h.configure(h.section({ bearer: SECRET_REFERENCE }))],
        ["a sign-in service", () => { h.configure(h.section({ signIn: "company-sso" })); h.jig.signIn.set("company-sso", () => ({ "X-Sso-Session": "sess-4711-abcdef" })); }],
        ["the OAuth grant", () => h.configure(h.section({ oauthPassword: h.oauth() }))],
    ];

    for (const [name, setUp] of modes) {
        for (const status of [301, 302, 303, 307, 308]) {
            for (const method of ["GET", "POST"]) {
                test(`${status} to another host for a ${method} with ${name}: the other host sees nothing, and the call is not sent again`, async () => {
                    setUp();
                    h.api.respond = () => ({ status, headers: { location: `${h.auth.origin}/stolen` }, body: "" });
                    h.auth.respond = () => ({ body: "{}" });
                    if (name === "the OAuth grant") h.auth.respond = () => ({ body: JSON.stringify({ access_token: "oauth-token-abcdef", expires_in: 3600 }) });
                    const before = h.auth.requests.length;
                    const text = ok(await h.call({ method, path: "/v1/x", ...(method === "POST" ? { body: {} } : {}) }, { ask: false }));
                    assert.match(text, new RegExp(`-> HTTP ${status} `));
                    assert.ok(text.includes(`location: ${h.auth.origin}/stolen`));
                    assert.equal(h.api.requests.length, 1, "the call was sent once");
                    const afterwards = h.auth.requests.filter((request) => request.path === "/stolen");
                    assert.equal(afterwards.length, 0, "the other host got no request");
                    assert.equal(h.auth.requests.length - before, name === "the OAuth grant" ? 1 : 0, "only the sign-in itself reached it");
                });
            }
        }
    }

    test("a redirect to plain http is not followed either, so no credential is sent in the clear", async () => {
        h.configure(h.section({ bearer: SECRET_REFERENCE }));
        h.api.respond = () => ({ status: 302, headers: { location: `${h.auth.origin}/login?next=/v1/x` }, body: "" });
        const text = ok(await h.call({ method: "GET", path: "/v1/x" }));
        assert.match(text, /-> HTTP 302 Found/);
        assert.equal(h.auth.requests.length, 0);
    });

    test("a redirect from the token endpoint is not followed: the sign-in fails", async () => {
        h.configure(h.section({ oauthPassword: h.oauth() }));
        h.auth.respond = () => ({ status: 307, headers: { location: `${h.api.origin}/captured` }, body: "" });
        const result = await h.call({ method: "GET", path: "/v1/x" });
        assert.equal(result.error?.message, "api call GET /v1/x: could not sign in (the token endpoint answered HTTP 307). Nothing was sent.");
        assert.equal(h.api.requests.length, 0, "the account's name and password did not follow the redirect");
    });
});

