// What the person reads before a write, and the guard that ties it to what is sent: a fingerprint of the preview. If what the
// tool would send now differs from what was approved, nothing is sent: "changed since the preview".
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { SHOWN_LINES } from "../src/engine/values.ts";
import { ok, SECRET, SECRET_REFERENCE, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => h.reset());

const POST = { method: "POST", path: "/v1/items?dryRun=true", body: { name: "Zed" }, headers: { "X-Request-Id": "t1" } };

/** The preview of a call, as jig-core asks the tool for it. */
async function previewOf(input: Record<string, unknown>) {
    return h.declaration.preview?.({ target: "api", ...input }, new AbortController().signal);
}
const fingerprintOf = async (input: Record<string, unknown>): Promise<string | undefined> => (await previewOf(input))?.fingerprint;

describe("what the preview shows", () => {
    test("the target, the sign-in, the method, the full address, the headers the model gave and the body", async () => {
        const preview = await previewOf(POST);
        assert.equal(preview?.summary, `POST ${h.api.origin}/v1/items?dryRun=true`);
        assert.equal(preview?.format, "text");
        assert.equal(preview?.body, [
            "Target: api (staging)",
            "Sign-in: none",
            "Method: POST",
            `URL: ${h.api.origin}/v1/items?dryRun=true`,
            "Headers:",
            "  X-Request-Id: t1",
            "Body (JSON, 14 bytes):",
            "{",
            '  "name": "Zed"',
            "}",
        ].join("\n"));
        assert.match(preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
    });

    test("a call with no headers and no body shows neither, and a description names the target", async () => {
        h.configure(h.section({ none: true }, { description: "The test API" }));
        const preview = await previewOf({ method: "DELETE", path: "/v1/items/7" });
        assert.equal(preview?.body, ["Target: api (staging): The test API", "Sign-in: none", "Method: DELETE", `URL: ${h.api.origin}/v1/items/7`].join("\n"));
    });

    test("the body is re-indented with its numbers untouched, and a body that is not an object is shown as it is", async () => {
        assert.match((await previewOf({ method: "PUT", path: "/x", body: { id: 12345678901234, price: 1.5, ok: true, none: null, list: [] } }))?.body ?? "", /\{\n {2}"id": 12345678901234,\n {2}"price": 1\.5,\n {2}"ok": true,\n {2}"none": null,\n {2}"list": \[\]\n\}$/);
        assert.match((await previewOf({ method: "PUT", path: "/x", body: "text" }))?.body ?? "", /Body \(JSON, 6 bytes\):\n"text"$/);
    });

    test("a long body is cut to 200 lines, says how many are left, and the whole body is still what is sent", async () => {
        const body = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`k${index}`, index]));
        const result = await h.call({ method: "POST", path: "/x", body });
        const shown = result.preview?.body ?? "";
        assert.equal(SHOWN_LINES, 200);
        assert.ok(shown.includes('  "k198": 198,'));
        assert.ok(!shown.includes('"k199"'));
        assert.ok(shown.endsWith("[102 more lines not shown; the whole body is sent]"));
        ok(result);
        assert.deepEqual(JSON.parse(h.api.requests[0]?.body ?? ""), body, "all 300 keys were sent");
    });

    test("names how each target signs in, and never a reference, a token or an address of the sign-in", async () => {
        const modes: Array<[Record<string, unknown>, string]> = [
            [{ none: true }, "Sign-in: none"],
            [{ bearer: SECRET_REFERENCE }, "Sign-in: a bearer token, added by the tool"],
            [{ oauthPassword: h.oauth() }, "Sign-in: an OAuth token (password grant), added by the tool"],
            [{ signIn: "company-sso" }, 'Sign-in: sign-in service "company-sso", added by the tool'],
            [{ transport: "company-proxy" }, 'Sign-in: transport "company-proxy", added by the tool'],
        ];
        for (const [auth, line] of modes) {
            h.configure(h.section(auth));
            const preview = await previewOf(POST);
            assert.ok(preview?.body?.split("\n").includes(line), `${line} in ${preview?.body}`);
            for (const hidden of ["pass:", SECRET, "/oauth/token", "portal", "Authorization"]) {
                assert.ok(!`${preview?.summary}\n${preview?.body}`.includes(hidden), `${hidden} in ${preview?.body}`);
            }
        }
    });

    test("is made from the call and the configuration alone: nothing is resolved, signed in, sent or asked", async () => {
        for (const auth of [{ bearer: SECRET_REFERENCE }, { oauthPassword: h.oauth() }, { signIn: "company-sso" }, { transport: "company-proxy" }]) {
            h.configure(h.section(auth));
            await previewOf(POST);
        }
        assert.deepEqual([h.jig.secretCalls, h.jig.signInCalls, h.jig.transportCalls], [[], [], []]);
        assert.deepEqual([h.api.requests.length, h.auth.requests.length], [0, 0]);
    });

    test("a long address is cut in the summary and whole in the body", async () => {
        const path = `/${"a".repeat(400)}?${"b".repeat(400)}`;
        const preview = await previewOf({ method: "POST", path });
        assert.equal(preview?.summary.length, 300);
        assert.ok(preview?.summary.endsWith("…"));
        assert.ok(preview?.body?.includes(`URL: ${h.api.origin}${path}`));
    });
});

describe("the fingerprint", () => {
    test("is the same for the same call, whatever the order or the case of the headers, and the timeout", async () => {
        const first = await fingerprintOf({ method: "POST", path: "/x", headers: { "X-A": "1", "X-B": "2" } });
        assert.equal(await fingerprintOf({ method: "POST", path: "/x", headers: { "X-A": "1", "X-B": "2" } }), first);
        assert.equal(await fingerprintOf({ method: "POST", path: "/x", headers: { "X-B": "2", "x-a": "1" } }), first);
        assert.equal(await fingerprintOf({ method: "POST", path: "/x", headers: { "X-A": "1", "X-B": "2" }, timeoutSec: 5 }), first);
    });

    test("changes with anything that is sent", async () => {
        const base = { method: "POST", path: "/x", body: { a: 1 }, headers: { "X-A": "1" } };
        const variants: Array<Record<string, unknown>> = [
            base,
            { ...base, method: "PUT" },
            { ...base, method: "DELETE" },
            { ...base, path: "/y" },
            { ...base, path: "/x?q=1" },
            { ...base, body: { a: 2 } },
            { ...base, body: { a: 1, b: 2 } },
            { ...base, body: [1] },
            { ...base, body: undefined },
            { ...base, headers: { "X-A": "2" } },
            { ...base, headers: { "X-C": "1" } },
            { ...base, headers: { "X-A": "1", "X-B": "1" } },
            { ...base, headers: undefined },
        ];
        const prints = await Promise.all(variants.map(fingerprintOf));
        assert.equal(new Set(prints).size, variants.length, "every variant has its own fingerprint");
    });

    test("changes with the target, its environment, its address and its way to sign in", async () => {
        const target = { baseUrl: h.api.origin, environment: "staging", allowPlainLocal: true, auth: { none: true } };
        h.configure({ targets: { api: target, other: target } });
        const base = await fingerprintOf({ method: "POST", path: "/x" });
        assert.notEqual(await fingerprintOf({ target: "other", method: "POST", path: "/x" }), base);
        const changed: Array<Record<string, unknown>> = [
            { ...target, environment: "production" },
            { ...target, baseUrl: h.auth.origin },
            { ...target, baseUrl: `${h.api.origin}/v2` },
            { ...target, auth: { bearer: SECRET_REFERENCE } },
            { ...target, auth: { signIn: "company-sso" } },
            { ...target, auth: { signIn: "another-sso" } },
            { ...target, auth: { transport: "company-proxy" } },
        ];
        const prints = new Set<string | undefined>([base]);
        for (const variant of changed) {
            h.configure({ targets: { api: variant } });
            prints.add(await fingerprintOf({ method: "POST", path: "/x" }));
        }
        assert.equal(prints.size, changed.length + 1);
    });
});

describe("changed since the preview", () => {
    const refusal = (call: string) => `http ${call}: changed since the preview; run it again to see the new preview. Nothing was sent.`;

    test("a body, a path, a header, a method or a target that a later hook changed is not sent", async () => {
        // What a later hook changes, and the call as the refusal names it: the call as it would now be sent.
        const changes: Array<[string, (input: Record<string, unknown>) => void, string]> = [
            ["the body", (input) => void (input.body = { name: "Other" }), "POST api /v1/items"],
            ["the path", (input) => void (input.path = "/v1/other"), "POST api /v1/other"],
            ["a header", (input) => void (input.headers = { "X-Request-Id": "t2" }), "POST api /v1/items"],
            ["an added header", (input) => void (input.headers = { "X-Request-Id": "t1", "X-More": "1" }), "POST api /v1/items"],
            ["the method", (input) => void (input.method = "DELETE"), "DELETE api /v1/items"],
            ["the target", (input) => void (input.target = "other"), "POST other /v1/items"],
        ];
        const target = { baseUrl: h.api.origin, environment: "staging", allowPlainLocal: true, auth: { none: true } };
        h.configure({ targets: { api: target, other: target } });
        for (const [what, change, call] of changes) {
            const result = await h.call({ method: "POST", path: "/v1/items", body: { name: "Zed" }, headers: { "X-Request-Id": "t1" } }, { between: change });
            assert.equal(result.error?.message, refusal(call), what);
        }
        assert.equal(h.api.requests.length, 0, "nothing was sent");
        assert.equal(h.jig.facts.size, 0, "nothing happened, so nothing is recorded");
    });

    test("a configuration that changed while the person read is not sent: the environment, the address or the sign-in", async () => {
        const changes: Array<[string, () => void]> = [
            ["the environment", () => h.configure(h.section({ none: true }, { environment: "production" }))],
            ["the address", () => h.configure(h.section({ none: true }, { baseUrl: `${h.api.origin}/other` }))],
            ["the sign-in", () => h.configure(h.section({ bearer: SECRET_REFERENCE }))],
        ];
        for (const [what, change] of changes) {
            h.configure();
            const result = await h.call(POST, { between: change });
            assert.equal(result.error?.message, refusal("POST api /v1/items"), what);
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("the refusal names the call without its body, its query or its headers", async () => {
        const result = await h.call({ method: "POST", path: "/v1/items?token=QUERY-SECRET", body: { password: "BODY-SECRET" } }, { between: (input) => void (input.body = {}) });
        assert.match(result.error?.message ?? "", /run it again to see the new preview/);
        for (const secret of ["BODY-SECRET", "QUERY-SECRET", "token="]) assert.ok(!(result.error?.message ?? "").includes(secret), secret);
    });

    test("running the call again shows the new preview, and a call that then matches goes through", async () => {
        const refused = await h.call(POST, { between: (input) => void (input.path = "/v1/other") });
        assert.ok(refused.error);
        const again = await h.call({ ...POST, path: "/v1/other" });
        assert.match(again.preview?.summary ?? "", /\/v1\/other$/);
        assert.match(ok(again), /-> HTTP 200 OK/);
        assert.equal(h.api.requests.length, 1);
        assert.equal(h.api.requests[0]?.target, "/v1/other");
    });

    test("an unchanged call goes through, and a change that is not sent does not matter: the timeout", async () => {
        assert.match(ok(await h.call(POST)), /-> HTTP 200 OK/);
        assert.match(ok(await h.call(POST, { between: (input) => void (input.timeoutSec = 90) })), /-> HTTP 200 OK/);
        assert.equal(h.api.requests.length, 2);
    });

    test("a call that did not ask has nothing to compare, and runs as it finds the configuration", async () => {
        const result = await h.call({ method: "GET", path: "/v1/x" }, { between: () => h.configure(h.section({ none: true }, { environment: "production" })) });
        assert.equal(result.preview, undefined);
        assert.match(ok(result), /Target: api \(production\)/);
    });

    test("a preview that could not be built has no fingerprint, and the person's choice stands", async () => {
        h.jig.approved.set("manual-1", { summary: "preview unavailable: it took longer than 15 s" });
        const result = await h.tool.execute("manual-1", { target: "api", method: "POST", path: "/v1/items" } as never, undefined, undefined, {} as never);
        assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /-> HTTP 200 OK/);
        assert.equal(h.api.requests.length, 1);
    });

    test("the fingerprint is the one the preview gave: a plan made again is the same plan", async () => {
        const result = await h.call(POST);
        assert.equal(result.preview?.fingerprint, await fingerprintOf(POST));
        ok(result);
    });
});

describe("a call that cannot run is not asked about", () => {
    test("invalid input in a write blocks the call with the reason, and nothing is sent", async () => {
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ method: "POST", path: "/a/%252e%252e/b" }, /path must start with \//],
            [{ method: "POST", path: "/x", headers: { Authorization: "Bearer x" } }, /header Authorization is set by the tool/],
            [{ method: "POST", path: "/x", body: { s: "a".repeat(300_000) } }, /body is larger than 256 KiB/],
            [{ method: "POST", path: "/x", timeoutSec: 500 }, /timeoutSec must be a whole number from 1 to 120/],
            [{ method: "POST", path: "/x", extra: 1 }, /http does not use extra\. Usage: http \{target/],
            [{ method: "HEAD", path: "/x" }, /method must be one of GET, POST, PUT, PATCH, DELETE/],
        ];
        for (const [input, reason] of cases) {
            const result = await h.call(input);
            assert.match(result.blocked ?? "", /^Blocked by jig-core: http cannot run with this input: http/);
            assert.match(result.blocked ?? "", reason);
            assert.equal(result.error, undefined, "the tool did not run");
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("a mistake in the tool itself is not mistaken for invalid input: it shows as an ordinary failure", async () => {
        const real = h.jig.api.config.section;
        h.jig.api.config.section = () => {
            throw new TypeError("a bug");
        };
        try {
            await assert.rejects(
                previewOf(POST),
                (error: unknown) => error instanceof Error && !(error instanceof TypeError) && error.message === "internal error: a bug",
            );
        } finally {
            h.jig.api.config.section = real;
        }
    });
});
