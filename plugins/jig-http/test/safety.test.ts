// What keeps a credential or a request from going where it was not meant to: a redirect is never followed, and the address is
// always the target's base address and the path, so the host cannot change.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { readHttp } from "../src/config.ts";
import { planOf } from "../src/plan.ts";
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
        assert.equal(result.error?.message, "http GET api /v1/x: could not sign in (the token endpoint answered HTTP 307). Nothing was sent.");
        assert.equal(h.api.requests.length, 0, "the account's name and password did not follow the redirect");
    });
});

describe("the host is the target's", () => {
    test("a path that looks like another host is only a path on this one", async () => {
        const paths = ["//other.example.test/x", "/@other.example.test/x", "/x@other.example.test", "/:8080/x", "///", "/x?@other.example.test", "/x?u=http://other.example.test/"];
        for (const path of paths) {
            h.api.requests.length = 0;
            const text = ok(await h.call({ method: "GET", path }));
            assert.ok(text.startsWith(`GET ${h.api.origin}${path.replace(/^(\/\/\/)$/, "$1")} -> HTTP 200`), `${path}: ${text.split("\n")[0]}`);
            assert.equal(h.api.requests.length, 1, path);
            assert.equal(h.api.requests[0]?.target, path, "the path reached this host as it was");
            assert.equal(h.api.requests[0]?.headers.host, `127.0.0.1:${h.api.port}`);
        }
    });

    test("the base address's own path stays in front of the call's path", async () => {
        h.configure(h.section({ none: true }, { baseUrl: `${h.api.origin}/tenant-a` }));
        ok(await h.call({ method: "GET", path: "//x/y" }));
        assert.equal(h.api.requests[0]?.target, "/tenant-a//x/y");
    });

    test("a path cannot climb out of the base address's path", async () => {
        h.configure(h.section({ none: true }, { baseUrl: `${h.api.origin}/tenant-a` }));
        for (const path of ["/../tenant-b/x", "/%2e%2e/tenant-b/x", "/%252e%252e/tenant-b/x", "/a/../../x"]) {
            const result = await h.call({ method: "GET", path });
            assert.match(result.error?.message ?? "", /path must start with \//, path);
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("even a path that did not pass the checks cannot change the host: the plan refuses it", () => {
        const target = readHttp({ targets: { api: { baseUrl: "https://api.example.test", environment: "staging", auth: { none: true } } } }).settings?.targets.get("api");
        assert.ok(target);
        const call = { target, method: "GET" as const, path: "/x", query: "", body: undefined, headers: [], timeoutSec: 30 };
        assert.equal(planOf(call).url, "https://api.example.test/x");
        for (const path of ["@other.example.test/x", ".other.example.test/x", ":8080/x"]) {
            assert.throws(() => planOf({ ...call, path }), (error: unknown) => error instanceof TypeError && /^http: the path would change the host: refused$/.test(error.message), path);
        }
    });

    test("the Host header is the target's, and the caller cannot set it", async () => {
        const result = await h.call({ method: "GET", path: "/x", headers: { Host: "other.example.test" } });
        assert.match(result.error?.message ?? "", /header Host is set by the tool/);
        assert.equal(h.api.requests.length, 0);
    });
});
