// How jig-core classifies a call: where it acts (the environment of its target) and whether it reads or writes (GET reads,
// every other method writes). An unknown target is invalid input and blocks the call without asking.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => h.reset());

const NONE = { none: true };
/** Three targets in three environments. */
function configureMany(): void {
    h.configure({
        targets: {
            api: { baseUrl: h.api.origin, environment: "staging", allowPlainLocal: true, auth: NONE, description: "The test API" },
            live: { baseUrl: "https://live.example.test", environment: "production", auth: NONE },
            tracker: { baseUrl: "https://tracker.example.test", environment: "external", auth: NONE },
        },
    });
}

describe("the class of a call", () => {
    test("a GET reads, in the environment of its target", () => {
        configureMany();
        assert.deepEqual(h.declaration.classify({ target: "api", method: "GET", path: "/x" }), { action: "api", environment: "staging", effect: "read" });
        assert.deepEqual(h.declaration.classify({ target: "live", method: "GET", path: "/x" }), { action: "live", environment: "production", effect: "read" });
        assert.deepEqual(h.declaration.classify({ target: "tracker", method: "GET", path: "/x" }), { action: "tracker", environment: "external", effect: "read" });
    });

    test("every other method writes, in the environment of its target", () => {
        configureMany();
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            assert.deepEqual(h.declaration.classify({ target: "api", method, path: "/x" }), { action: "api", environment: "staging", effect: "write" }, method);
            assert.deepEqual(h.declaration.classify({ target: "live", method, path: "/x" }), { action: "live", environment: "production", effect: "write" }, method);
            assert.deepEqual(h.declaration.classify({ target: "tracker", method, path: "/x" }), { action: "tracker", environment: "external", effect: "write" }, method);
        }
    });

    test("a method that is not GET is a write even when it is not one of the five, so that no spelling turns a write into a read", () => {
        for (const method of ["get", "Get", "HEAD", "OPTIONS", "GET ", "", undefined, 5, null]) {
            assert.equal(h.declaration.classify({ target: "api", method, path: "/x" })?.effect, "write", String(method));
        }
    });

    test("only the target and the method decide: not the path, the body or the headers", () => {
        const plain = h.declaration.classify({ target: "api", method: "GET", path: "/x" });
        const decorated = h.declaration.classify({ target: "api", method: "GET", path: "/a/b?c=d", headers: { "X-A": "1" }, timeoutSec: 5 });
        assert.deepEqual(decorated, plain);
    });

    test("the target is the action, so a rule or a session approval covers one API, not its whole environment", () => {
        const cls = h.declaration.classify({ target: "api", method: "POST", path: "/x" });
        assert.deepEqual(cls, { action: "api", environment: "staging", effect: "write" });
    });

    test("is made from the configuration, and reads it again for every call", () => {
        assert.equal(h.declaration.classify({ target: "api", method: "POST", path: "/x" })?.environment, "staging");
        h.configure(h.section({ none: true }, { environment: "qa" }));
        assert.equal(h.declaration.classify({ target: "api", method: "POST", path: "/x" })?.environment, "qa");
    });

    test("is made without touching the network", () => {
        h.declaration.classify({ target: "api", method: "POST", path: "/x" });
        h.declaration.classify({ target: "api", method: "GET", path: "/x" });
        assert.equal(h.api.requests.length, 0);
        assert.deepEqual(h.jig.secretCalls, []);
    });
});

describe("an unknown target", () => {
    test("is invalid input: a TypeError that names the known targets", () => {
        configureMany();
        assert.throws(
            () => h.declaration.classify({ target: "nope", method: "GET", path: "/x" }),
            (error: unknown) => error instanceof TypeError
                && error.message === 'http: no target named "nope". Known targets: api (staging: The test API), live (production), tracker (external)',
        );
    });

    test("a call without a target, or with one that is not text, is invalid too", () => {
        configureMany();
        assert.throws(() => h.declaration.classify({ method: "GET", path: "/x" }), (error: unknown) => error instanceof TypeError && /^http needs target\. Known targets: api/.test(error.message));
        assert.throws(() => h.declaration.classify({ target: 5, method: "GET", path: "/x" }), TypeError);
        assert.throws(() => h.declaration.classify({ target: ["api"], method: "GET", path: "/x" }), TypeError);
    });

    test("is not decided by jig-core: the call is blocked, nobody is asked, and nothing is sent", async () => {
        configureMany();
        for (const method of ["GET", "POST"]) {
            const result = await h.call({ target: "nope", method, path: "/x" });
            assert.equal(result.blocked, 'jig-core could not decide: http: no target named "nope". Known targets: api (staging: The test API), live (production), tracker (external)');
            assert.equal(result.preview, undefined, "nobody was asked");
            assert.equal(result.error, undefined, "the tool did not run");
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("the tool itself refuses it too, when jig-core runs it without a preview", async () => {
        configureMany();
        await assert.rejects(
            h.tool.execute("call-x", { target: "nope", method: "GET", path: "/x" } as never, undefined, undefined, {} as never),
            (error: unknown) => error instanceof TypeError && /no target named "nope"/.test(error.message),
        );
        const preview = h.declaration.preview;
        assert.ok(preview);
        await assert.rejects(preview({ target: "nope", method: "POST", path: "/x" }, new AbortController().signal), TypeError);
        assert.equal(h.api.requests.length, 0);
    });

    test("every target that is configured is known", async () => {
        configureMany();
        assert.match(ok(await h.call({ target: "api", method: "GET", path: "/x" })), /^GET http:\/\/127\.0\.0\.1:\d+\/x -> HTTP 200 OK/);
    });
});

describe("a tool that is not set up", () => {
    test("without an http section every call is invalid input that says what to add", () => {
        h.jig.reset();
        assert.throws(
            () => h.declaration.classify({ target: "api", method: "GET", path: "/x" }),
            (error: unknown) => error instanceof TypeError && /^http is not set up: add an "http" section with "targets" to jig\.json \(\/jig lists configuration problems\)$/.test(error.message),
        );
    });

    test("a section with an error reads as absent, as jig-core reports it at start-up and the plugin uses nothing from it", async () => {
        h.configure({ targets: { api: { baseUrl: "http://api.example.test", environment: "staging", auth: NONE } } });
        const result = await h.call({ method: "GET", path: "/x" });
        assert.match(result.blocked ?? "", /^jig-core could not decide: http is not set up/);
        assert.equal(h.api.requests.length, 0);
    });
});

describe("a call that asks", () => {
    test("a write to a test environment asks, and the preview names the environment's target", async () => {
        const result = await h.call({ method: "POST", path: "/x", body: { a: 1 } });
        assert.equal(result.cls?.effect, "write");
        assert.ok(result.preview, "a write outside the machine asks, so it has a preview");
        assert.match(result.preview.body ?? "", /^Target: api \(staging\)/);
    });

    test("a read does not ask by default, and can be made to ask by a rule: then it has a preview with a fingerprint too", async () => {
        const quiet = await h.call({ method: "GET", path: "/x" });
        assert.equal(quiet.preview, undefined);
        const asked = await h.call({ method: "GET", path: "/x" }, { ask: true });
        assert.match(asked.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
        assert.equal(asked.error, undefined);
    });
});
