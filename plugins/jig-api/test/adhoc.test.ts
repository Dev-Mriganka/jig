// `call`: an ad-hoc request, for an endpoint nobody saved. It is allowed only in the test environments the configuration lists in
// `adHoc`, never in production (whatever the configuration says), and only to a host of that environment. It signs in only
// as the environment says, or as the collection it names does.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { acmeSection, TOKENS, useAcme } from "./support/acme.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => {
    h.reset();
    useAcme(h);
});

const call = (extra: Record<string, unknown> = {}) => ({
    action: "call",
    environment: "Staging",
    method: "GET",
    url: `${h.api.origin}/v1/orders/1`,
    ...extra,
});
/** The class jig-core would get for a call, which must be one. */
function classify(input: Record<string, unknown>): CallClass {
    const found = h.declaration.classify(input);
    assert.ok(found, "the call is classified");
    return found;
}

describe("where a call is allowed", () => {
    test("in a test environment that adHoc lists", async () => {
        const result = await h.call(call());
        assert.deepEqual(result.cls, { action: "call", environment: "staging", effect: "read" });
        assert.match(ok(result), /^GET \S+\/v1\/orders\/1 -> HTTP 200 OK\nRequest: call in Staging \(staging\)\n/);
        assert.equal(h.api.requests[0]?.target, "/v1/orders/1");
    });

    test("not in an environment that adHoc does not list: the reason says what to add", async () => {
        h.configure(acmeSection(h, { adHoc: [] }));
        const result = await h.call(call());
        assert.equal(
            result.blocked,
            'jig-core could not decide: call is not allowed in Staging: add "staging" to api.adHoc to allow it',
        );
        assert.equal(result.preview, undefined, "nobody was asked");
        assert.equal(h.api.requests.length, 0);
    });

    test("never in production, though the configuration lists it", async () => {
        h.configure(acmeSection(h, { adHoc: ["staging", "production"] }));
        for (const method of ["GET", "POST"]) {
            const result = await h.call(
                call({ environment: "Production", method, url: `${h.prod.origin}/v1/orders/1` }),
            );
            assert.equal(
                result.blocked,
                "jig-core could not decide: call is never allowed in production, and Production counts as production",
            );
        }
        assert.equal(h.prod.requests.length, 0);
    });

    test("never in an environment that nobody mapped, which counts as production", async () => {
        h.configure(acmeSection(h, { environments: { Staging: "staging" }, adHoc: ["staging"] }));
        const result = await h.call(call({ environment: "Production", url: `${h.prod.origin}/x` }));
        assert.equal(
            result.blocked,
            "jig-core could not decide: call is never allowed in production, and Production counts as production because api.environments does not map it",
        );
        h.configure(acmeSection(h, { environments: {}, adHoc: [] }));
        assert.match(
            (await h.call(call())).blocked ?? "",
            /call is never allowed in production, and Staging counts as production because api\.environments does not map it/,
        );
        assert.equal(h.api.requests.length + h.prod.requests.length, 0);
    });

    test("it asks jig-core what kind an environment is, so a company's own name for production is production", async () => {
        h.jig.kinds.set("live", "production");
        h.configure(acmeSection(h, { environments: { Staging: "live", Production: "production" }, adHoc: ["live"] }));
        const result = await h.call(call());
        assert.match(result.blocked ?? "", /call is never allowed in production/);
        assert.equal(h.api.requests.length, 0);
        // And a name jig-core does not know is production, as everywhere.
        h.jig.kinds.delete("live");
        assert.match((await h.call(call())).blocked ?? "", /call is never allowed in production/);
    });

    test("an environment that no collection has is invalid input that lists the ones there are", async () => {
        const result = await h.call(call({ environment: "Qa" }));
        assert.equal(
            result.blocked,
            'jig-core could not decide: no environment named "Qa"; known: Staging, Production, staging, production',
        );
        const narrowed = await h.call(call({ environment: "staging", collection: "acme" }));
        assert.match(narrowed.blocked ?? "", /no environment named "staging"; known: Staging, Production$/);
    });

    test("another collection's environment is found by its own name", async () => {
        const result = await h.call(call({ environment: "staging", collection: "ledger" }));
        ok(result);
        assert.equal(h.api.requests.length, 1);
    });
});

describe("what a call is classified as", () => {
    test("by its method alone: a GET, HEAD or OPTIONS reads, every other method writes", () => {
        for (const method of ["GET", "HEAD", "OPTIONS"])
            assert.equal(classify(call({ method })).effect, "read", method);
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
            assert.equal(
                classify(call({ method, ...(method === "DELETE" ? {} : { body: { a: 1 } }) })).effect,
                "write",
                method,
            );
        assert.deepEqual(classify(call({ method: "POST" })), {
            action: "call",
            environment: "staging",
            effect: "write",
        });
    });

    test("a name in `reads` cannot turn calls into reads, whether the name is `call` or a request's", () => {
        h.configure(acmeSection(h, { reads: ["call", "Create order"] }));
        assert.equal(classify(call({ method: "POST" })).effect, "write");
        assert.equal(classify(call({ method: "DELETE" })).effect, "write");
    });

    test("a write asks first and shows the request", async () => {
        const result = await h.call(call({ method: "POST", url: `${h.api.origin}/v1/orders`, body: { sku: "W-1" } }));
        assert.equal(result.cls?.effect, "write");
        assert.match(
            result.preview?.body ?? "",
            /^Request: call in Staging \(staging\)\nSign-in: none\nMethod: POST\nURL: \S+\/v1\/orders\nHeaders:\n {2}Content-Type: application\/json\nBody \(JSON, 13 bytes\):/,
        );
        ok(result);
        assert.equal(h.api.requests[0]?.body, '{"sku":"W-1"}');
    });
});

describe("the host of a call", () => {
    test("is one of the environment's hosts: any other is refused, and nothing is sent", async () => {
        for (const url of [
            h.prod.origin,
            "https://api.other.example.test",
            "https://api.staging.acme.example.test.evil.example.test",
            "http://127.0.0.1:1",
        ]) {
            const result = await h.call(call({ url: `${url}/v1/x` }));
            assert.match(
                result.blocked ?? "",
                /^jig-core could not decide: the address goes to \S+, which is not a host of Staging \(/,
                url,
            );
        }
        assert.equal(h.api.requests.length + h.prod.requests.length + h.auth.requests.length, 0);
    });

    test("include the hosts an environment signs in at, since the environment names them too", async () => {
        ok(await h.call(call({ url: `${h.auth.origin}/health` })));
        assert.equal(h.auth.requests.length, 1);
    });

    test("cannot be changed by the way the address is written", async () => {
        const host = new URL(h.api.origin).host;
        const tricks = [
            `https://${host}@evil.example.test/x`,
            `${h.api.origin}@evil.example.test/x`,
            `https://evil.example.test\\@${host}/x`,
            `http://evil.example.test#@${host}/x`,
            `http://evil.example.test?@${host}/x`,
        ];
        for (const url of tricks) {
            const result = await h.call(call({ url }));
            assert.notEqual(result.blocked, undefined, url);
            assert.equal(result.error, undefined, "the tool did not run");
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("a path that looks like another host is only a path on this one", async () => {
        const paths = [
            "//other.example.test/x",
            "/@other.example.test/x",
            "/x@other.example.test",
            "/:8080/x",
            "///",
            "/x?@other.example.test",
            "/x?u=http://other.example.test/",
        ];
        for (const path of paths) {
            h.api.requests.length = 0;
            const text = ok(await h.call(call({ url: `${h.api.origin}${path}` })));
            assert.ok(text.startsWith(`GET ${h.api.origin}${path} -> HTTP 200`), `${path}: ${text.split("\n")[0]}`);
            assert.equal(h.api.requests[0]?.target, path, "the path reached this host as it was");
            assert.equal(h.api.requests[0]?.headers.host, new URL(h.api.origin).host);
        }
    });

    test("a path cannot climb: a .. is refused, plain or encoded, once or twice", async () => {
        for (const path of [
            "/../tenant-b/x",
            "/%2e%2e/tenant-b/x",
            "/%252e%252e/tenant-b/x",
            "/a/../../x",
            "/a/..%2f..%2fx",
        ]) {
            const result = await h.call(call({ url: `${h.api.origin}${path}` }));
            assert.match(result.blocked ?? "", /the path must hold only letters/, path);
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("the Host header is the server's, and the caller cannot set it", async () => {
        const result = await h.call(call({ headers: { Host: "other.example.test" } }));
        assert.match(result.blocked ?? "", /header Host is set by the tool/);
        assert.equal(h.api.requests.length, 0);
    });
});

describe("how a call signs in", () => {
    test("with nothing, unless the environment or the collection it names says otherwise", async () => {
        ok(await h.call(call()));
        assert.equal(h.api.requests[0]?.headers.authorization, undefined);
        assert.deepEqual(h.jig.secretCalls, []);
    });

    test("as the collection it names does, with the environment's secret", async () => {
        ok(await h.call(call({ collection: "acme" })));
        assert.equal(h.api.requests[0]?.headers.authorization, `Bearer ${TOKENS.staging.value}`);
        const none = await h.call(call({ collection: "ledger", environment: "staging" }));
        ok(none);
        assert.equal(
            h.api.requests[1]?.headers.authorization,
            undefined,
            ".http files sign in in their requests, not for the collection",
        );
    });

    test("a collection whose own sign-in is not sent refuses the call by name", async () => {
        const file = (h.jig.api.config.section("api") as { collections: { acme: { postman: string } } }).collections
            .acme.postman;
        const { readFileSync, writeFileSync } = await import("node:fs");
        const collection = JSON.parse(readFileSync(file, "utf8")) as { auth: unknown };
        collection.auth = { type: "digest", digest: [] };
        writeFileSync(file, JSON.stringify(collection));
        const result = await h.call(call({ collection: "acme" }));
        assert.match(
            result.blocked ?? "",
            /^jig-core could not decide: the sign-in of acme cannot be sent: the sign-in type "digest" is not sent/,
        );
    });

    test("through the sign-in service or the transport that the environment names, in place of the collection's own", async () => {
        h.jig.signIn.set("company-sso", () => ({ "X-Sso-Session": "sess-4711-abcdef" }));
        h.configure(
            acmeSection(h, {
                environments: { Staging: { environment: "staging", signIn: "company-sso" }, Production: "production" },
            }),
        );
        ok(await h.call(call({ collection: "acme" })));
        assert.equal(h.api.requests[0]?.headers["x-sso-session"], "sess-4711-abcdef");
        assert.equal(h.api.requests[0]?.headers.authorization, undefined);
        assert.deepEqual(h.jig.signInCalls, [
            { name: "company-sso", request: { system: "api:acme", url: `${h.api.origin}/v1/orders/1` } },
        ]);
        assert.deepEqual(h.jig.secretCalls, []);
    });

    test("a saved request in that environment goes through it too, with the sign-in it names in place of its own", async () => {
        h.jig.transports.set("company-proxy", {
            request: async (request) => ({
                status: 200,
                headers: {},
                body: JSON.stringify({ via: "proxy", url: request.url, auth: request.headers?.Authorization ?? null }),
            }),
        });
        h.configure(
            acmeSection(h, {
                environments: {
                    Staging: { environment: "staging", transport: "company-proxy" },
                    Production: "production",
                },
            }),
        );
        const text = ok(
            await h.call({
                action: "run",
                request: "Get order",
                collection: "acme",
                environment: "Staging",
                variables: { orderId: "5" },
            }),
        );
        assert.match(text, /"via": "proxy"/);
        assert.match(text, /"auth": null/);
        assert.equal(h.api.requests.length, 0, "the tool did not call the network itself");
        assert.deepEqual(h.jig.secretCalls, [], "the transport holds the session; the tool reads no secret");
        assert.equal(h.jig.transportCalls[0]?.request.system, "api:acme");
    });
});

describe("the limits of what the agent writes", () => {
    test("a body is JSON of at most 256 KiB, and not for a read", async () => {
        const read = await h.call(call({ body: { a: 1 } }));
        assert.match(read.blocked ?? "", /a GET has no body/);
        const big = await h.call(call({ method: "POST", body: { s: "a".repeat(300_000) } }));
        assert.match(big.blocked ?? "", /body is larger than 256 KiB/);
    });

    test("headers that carry a sign-in or control the connection are refused", async () => {
        for (const name of [
            "Authorization",
            "Cookie",
            "Host",
            "Content-Length",
            "Transfer-Encoding",
            "X-HTTP-Method-Override",
        ]) {
            const result = await h.call(call({ headers: { [name]: "x" } }));
            assert.match(
                result.blocked ?? "",
                new RegExp(`header ${name} is set by the tool or controls the connection`),
                name,
            );
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("a variable of the environment is not reachable: the address is written whole", async () => {
        const result = await h.call(call({ url: "{{baseUrl}}/v1/orders" }));
        assert.match(result.blocked ?? "", /url must be a whole address/);
        const odd = await h.call(call({ url: "ws://stream.staging.acme.example.test/orders" }));
        assert.match(odd.blocked ?? "", /the address uses ws:\/\/, and only http and https are sent/);
    });
});
