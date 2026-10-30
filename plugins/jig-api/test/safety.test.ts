// What keeps a credential or a request from going where it was not meant to: a redirect is never followed, no cookie is kept
// or shown, an address on a host outside the environment's is refused, and so are the addresses a cloud machine trusts.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { ok, SECRET, SECRET_REFERENCE, setupHarness } from "./support/harness.ts";
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


describe("no cookie is kept, passed on or shown", () => {
    test("a cookie a server sets is not in the result, and the next request does not carry it", async () => {
        h.api.respond = (request) => ({
            headers: { "set-cookie": "session=SESSION-CANARY-123; HttpOnly", "content-type": "application/json" },
            body: JSON.stringify({ cookieSeen: request.headers.cookie ?? null }),
        });
        const first = ok(await h.call({ method: "GET", path: "/login" }));
        assert.ok(!first.includes("SESSION-CANARY-123"), first);
        assert.doesNotMatch(first, /set-cookie/i);
        const second = ok(await h.call({ method: "GET", path: "/me" }));
        assert.match(second, /"cookieSeen": null/);
        assert.equal(h.api.requests[1]?.headers.cookie, undefined, "there is no cookie jar");
    });

    test("not even when the server sets several, or in another spelling of the header", async () => {
        h.api.respond = () => ({ headers: { "Set-Cookie": "a=1", "set-cookie2": "b=2" }, body: "{}" });
        const text = ok(await h.call({ method: "GET", path: "/x" }));
        assert.doesNotMatch(text, /[ab]=\d|cookie/i);
    });

    test("an answer through a transport is cleaned the same way, before anything else sees it", async () => {
        h.configure(h.section({ transport: "company-proxy" }));
        h.jig.transports.set("company-proxy", { request: async () => ({ status: 200, headers: { "Set-Cookie": "session=SESSION-CANARY-456", "X-Request-Id": "r-1" }, body: "{}" }) });
        const text = ok(await h.call({ method: "GET", path: "/x" }));
        assert.ok(!text.includes("SESSION-CANARY-456"));
        assert.match(text, /x-request-id: r-1/);
    });

    test("the exchange itself drops them from the answer it gives back", async () => {
        h.api.respond = () => ({ headers: { "set-cookie": "s=1" }, body: "ok" });
        const { exchange } = await import("../src/engine/wire.ts");
        const answer = await exchange({ system: "api", method: "GET", url: `${h.api.origin}/x`, headers: {}, allowPlainLocal: true }, new AbortController().signal);
        assert.equal(answer.status, 200);
        assert.equal("set-cookie" in answer.headers, false);
    });

    test("a request can carry the cookie its collection gives it, because the team wrote it; it is a credential and is removed from the answer", async () => {
        const request = { name: "Cookie", request: { method: "GET", url: { raw: "{{baseUrl}}/c" }, header: [{ key: "Cookie", value: "sid={{sid}}" }] } };
        const { writeFileSync } = await import("node:fs");
        const path = await import("node:path");
        const file = path.join(h.dir, "cookie.postman_collection.json");
        writeFileSync(file, JSON.stringify({ item: [request] }));
        const env = path.join(h.dir, "cookie-env.json");
        writeFileSync(env, JSON.stringify({ values: [{ key: "baseUrl", value: h.api.origin, enabled: true }, { key: "sid", value: "", type: "secret", enabled: true }] }));
        h.configure({ collections: { cookies: { postman: file, environments: { Staging: env } } }, environments: { Staging: "staging" }, secrets: { sid: "pass:api/token" }, allowPlainLocal: true });
        h.api.respond = (received) => ({ body: JSON.stringify({ echoed: received.headers.cookie }) });
        const text = ok(await h.call({ action: "run", request: "Cookie", collection: "cookies", environment: "Staging" }));
        assert.equal(h.api.requests[0]?.headers.cookie, `sid=${SECRET}`);
        assert.ok(!text.includes(SECRET));
    });
});

describe("no redirect is followed from a saved request either", () => {
    test("a redirect to another host is a result with its location, and the other host sees nothing", async () => {
        h.api.respond = () => ({ status: 302, headers: { location: `${h.auth.origin}/stolen` }, body: "" });
        h.auth.respond = () => ({ body: "{}" });
        const text = ok(await h.call({ action: "call", environment: "Staging", collection: "base", method: "GET", url: `${h.api.origin}/x` }));
        assert.match(text, /-> HTTP 302 Found/);
        assert.ok(text.includes(`location: ${h.auth.origin}/stolen`));
        assert.equal(h.auth.requests.length, 0);
    });
});
