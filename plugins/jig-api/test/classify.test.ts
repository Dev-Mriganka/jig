// How jig-core classifies a call: its action is the request's name (or `call`), the environment is the collection's name for it
// mapped through api.environments (a name nobody mapped counts as production), and the effect is a read for GET, HEAD and
// OPTIONS or for a name in `reads`, a write otherwise. A folder is as strict as its strictest request. Anything invalid is a
// TypeError, which jig-core takes to mean that nobody should be asked.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { acmeSection, useAcme } from "./support/acme.ts";
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

/** The class jig-core would get for a call, which must be one. */
function classify(input: Record<string, unknown>): CallClass {
    const found = h.declaration.classify(input);
    assert.ok(found, "the call is classified");
    return found;
}
/** The values each request of the fixture needs, so that a run of it is complete. */
const VALUES: Record<string, Record<string, string>> = {
    "Get order": { orderId: "1" },
    "Cancel order": { orderId: "1" },
    "Create order": { sku: "s", quantity: "1", note: "n" },
    "Search orders": { text: "x" },
};
const run = (request: string, extra: Record<string, unknown> = {}) =>
    ({ action: "run", request, collection: "acme", environment: "Staging", variables: VALUES[request] ?? {}, ...extra });

/** A collection of the test's own, in a folder of the harness, as a Postman file of requests by method. */
function collectionOf(name: string, items: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    const file = path.join(h.dir, `${name}.postman_collection.json`);
    fs.writeFileSync(file, JSON.stringify({ info: { name }, item: items }));
    const env = path.join(h.dir, `${name}.env.json`);
    fs.writeFileSync(env, JSON.stringify({ values: [{ key: "baseUrl", value: h.api.origin, enabled: true }] }));
    return { collections: { [name]: { postman: file, environments: { Staging: env, Prod: env } } }, environments: { Staging: "staging", Prod: "production" }, allowPlainLocal: true, ...extra };
}
const request = (name: string, method: string, path = "/x"): Record<string, unknown> => ({ name, request: { method, url: { raw: `{{baseUrl}}${path}` } } });

describe("the class of a run", () => {
    test("the action is the request's name, and the environment the one the collection's name maps to", () => {
        assert.deepEqual(classify(run("Get order")), { action: "Get order", environment: "staging", effect: "read" });
        assert.deepEqual(classify(run("Get order", { environment: "Production" })), { action: "Get order", environment: "production", effect: "read" });
        assert.deepEqual(classify(run("Create order")), { action: "Create order", environment: "staging", effect: "write" });
    });

    test("a GET, a HEAD and an OPTIONS read; every other method writes", () => {
        const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
        h.configure(collectionOf("verbs", methods.map((method) => request(method, method))));
        for (const method of methods) {
            const expected = ["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write";
            assert.deepEqual(classify({ action: "run", request: method, environment: "Staging" }), { action: method, environment: "staging", effect: expected }, method);
        }
    });

    test("a request named in `reads` reads although its method does not: a POST that searches", () => {
        assert.deepEqual(classify(run("Search orders")), { action: "Search orders", environment: "staging", effect: "read" });
        h.configure(acmeSection(h, { reads: [] }));
        assert.equal(classify(run("Search orders")).effect, "write");
        h.configure(acmeSection(h, { reads: ["Cancel order"] }));
        assert.equal(classify(run("Cancel order")).effect, "read", "the configuration's word is taken, for any method");
    });

    test("only the request and the environment decide: not the values the agent gives", () => {
        const plain = classify(run("Get order"));
        assert.deepEqual(classify(run("Get order", { variables: { orderId: "9999" }, timeoutSec: 5 })), plain);
    });

    test("an environment nobody mapped counts as production, so a forgotten mapping makes the rules stricter", () => {
        h.configure(acmeSection(h, { environments: { Staging: "staging" } }));
        assert.deepEqual(classify(run("Get order", { environment: "Production" })), { action: "Get order", environment: "production", effect: "read" });
        assert.deepEqual(classify(run("Create order", { environment: "Production" })), { action: "Create order", environment: "production", effect: "write" });
        h.configure(acmeSection(h, { environments: {}, adHoc: [] }));
        assert.equal(classify(run("Get order")).environment, "production", "even a name jig-core would know as a test environment");
    });

    test("is made from the configuration and the files, and reads them again for every call", () => {
        assert.equal(classify(run("Get order")).environment, "staging");
        h.configure(acmeSection(h, { environments: { Staging: "qa" }, adHoc: [] }));
        assert.equal(classify(run("Get order")).environment, "qa");
    });

    test("is made without touching the network or a secret", () => {
        classify(run("Create order"));
        classify(run("Get order"));
        assert.equal(h.api.requests.length + h.prod.requests.length + h.auth.requests.length, 0);
        assert.deepEqual(h.jig.secretCalls, []);
    });
});

describe("a run of a folder", () => {
    const read = (name: string) => request(name, "GET");
    const write = (name: string) => request(name, "POST");

    test("is as strict as its strictest request: one write makes it a write", () => {
        h.configure(collectionOf("flows", [
            { name: "Checks", item: [read("One"), read("Two")] },
            { name: "Mixed", item: [read("Three"), write("Four"), read("Five")] },
            { name: "Nested", item: [read("Six"), { name: "Deeper", item: [write("Seven")] }] },
        ]));
        const folder = (name: string) => classify({ action: "run-folder", folder: name, environment: "Staging" });
        assert.deepEqual(folder("Checks"), { action: "flows/Checks", environment: "staging", effect: "read" });
        assert.deepEqual(folder("Mixed"), { action: "flows/Mixed", environment: "staging", effect: "write" });
        assert.deepEqual(folder("Nested"), { action: "flows/Nested", environment: "staging", effect: "write" });
        assert.deepEqual(folder("Nested/Deeper"), { action: "flows/Nested/Deeper", environment: "staging", effect: "write" });
    });

    test("a write that the configuration calls a read does not make the folder a write", () => {
        h.configure(collectionOf("flows", [{ name: "Mixed", item: [read("Three"), write("Search")] }], { reads: ["Search"] }));
        assert.equal(classify({ action: "run-folder", folder: "Mixed", environment: "Staging" }).effect, "read");
    });

    test("is in the environment the call names, and a folder of reads in production is a read in production", () => {
        h.configure(collectionOf("flows", [{ name: "Checks", item: [read("One")] }]));
        assert.deepEqual(classify({ action: "run-folder", folder: "Checks", environment: "Prod" }), { action: "flows/Checks", environment: "production", effect: "read" });
    });

    test("a folder with a request that cannot be run cannot be run: it is invalid input, not a partial run", () => {
        assert.throws(() => classify({ action: "run-folder", folder: "Admin", collection: "acme", environment: "Staging" }), /"Rebuild index" is refused: it has a pre-request script \(the folder Admin\)/);
        assert.throws(() => classify({ action: "run-folder", folder: "Orders", collection: "acme", environment: "Staging" }), (error: unknown) => error instanceof TypeError && /^no value for /.test(error.message));
        assert.deepEqual(classify({ action: "run-folder", folder: "Smoke", collection: "acme", environment: "Staging" }), { action: "acme/Smoke", environment: "staging", effect: "read" });
    });

    test("an unknown folder is invalid input that names the folders there are", () => {
        assert.throws(() => classify({ action: "run-folder", folder: "Nope", collection: "acme", environment: "Staging" }), (error: unknown) =>
            error instanceof TypeError && /^no folder named "Nope"; folders: Orders, Smoke, Admin/.test(error.message));
    });
});

describe("list and show", () => {
    test("read this machine's files and nothing else: a local read", () => {
        assert.deepEqual(classify({ action: "list" }), { action: "list", environment: "local", effect: "read" });
        assert.deepEqual(classify({ action: "show", request: "Get order", collection: "acme" }), { action: "show", environment: "local", effect: "read" });
    });
});

describe("invalid input", () => {
    const rejected = (input: Record<string, unknown>, pattern: RegExp): void =>
        assert.throws(() => classify(input), (error: unknown) => error instanceof TypeError && pattern.test(error.message), JSON.stringify(input).slice(0, 100));

    test("an unknown request, an unknown environment and an unknown collection are TypeErrors that say what there is", () => {
        rejected(run("Nope"), /^no request named "Nope"; use list to see them$/);
        rejected(run("Get order", { environment: "Qa" }), /^no environment named "Qa"; acme has: Staging, Production$/);
        rejected(run("Get order", { collection: "nope" }), /^no collection named "nope"\. Known collections: acme, ledger$/);
        rejected(run("Get order", { collection: undefined }), /^"Get order" names 2 requests/);
    });

    test("a missing variable is a TypeError that names it", () => {
        rejected({ action: "run", request: "Get order", collection: "acme", environment: "Staging" }, /^no value for orderId in Staging: pass the ones the request uses in variables/);
    });

    test("a script, an unsupported protocol and a variable that would set the host are TypeErrors", () => {
        rejected(run("Rebuild index"), /is refused: it has a pre-request script/);
        rejected(run("Watch orders"), /cannot be sent: the address uses ws:\/\//);
        rejected(run("Get order", { variables: { orderId: "1", baseUrl: "https://evil.example.test" } }), /baseUrl would set the host of the request/);
        rejected(run("Get order", { variables: { orderId: "1", status: "open" } }), /^"status" is not a variable of Get order; it uses baseUrl, apiVersion, orderId, token$/);
    });

    test("a call with the wrong shape is refused with the usage line", () => {
        rejected({ action: "run", environment: "Staging" }, /^api run needs request\. Usage: api run \{request, environment, collection\?, folder\?, variables\?, timeoutSec\?\}$/);
        rejected({ action: "run", request: "Get order", environment: "Staging", url: "x" }, /^api run does not use url\. Usage: api run \{/);
        rejected({ action: "fly" }, /^api: unknown action "fly"; use one of list, show, run, run-folder, call$/);
        rejected({}, /^api: unknown action undefined; use one of/);
        rejected({ action: "list", collection: 5 }, /^api list: collection must be text \(got 5\)/);
        rejected({ action: "run", request: "Get order", environment: "Staging", variables: [1] }, /variables must be an object of name to value/);
    });

    test("is not decided by jig-core: the call is blocked, nobody is asked, and nothing is sent", async () => {
        for (const input of [run("Nope"), run("Create order", { variables: {} }), run("Rebuild index")]) {
            const result = await h.call(input);
            assert.match(result.blocked ?? "", /^jig-core could not decide: /);
            assert.equal(result.preview, undefined, "nobody was asked");
            assert.equal(result.error, undefined, "the tool did not run");
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("the tool itself refuses it too, when jig-core runs it without a classification", async () => {
        await assert.rejects(h.tool.execute("call-x", run("Nope") as never, undefined, undefined, {} as never), (error: unknown) => error instanceof TypeError && /no request named "Nope"/.test(error.message));
        const preview = h.declaration.preview;
        assert.ok(preview);
        await assert.rejects(preview(run("Nope"), new AbortController().signal), TypeError);
        assert.equal(h.api.requests.length, 0);
    });
});

describe("a tool that is not set up", () => {
    test("without an api section every call is invalid input that says what to add", () => {
        h.jig.reset();
        assert.throws(() => classify({ action: "list" }), (error: unknown) =>
            error instanceof TypeError && /^api is not set up: add an "api" section with "collections" to jig\.json \(\/jig lists configuration problems\)$/.test(error.message));
    });

    test("a section with an error reads as absent, as jig-core reports it at start-up and the plugin uses nothing from it", async () => {
        h.configure({ collections: { orders: { http: "relative/path" } } });
        const result = await h.call({ action: "list" });
        assert.match(result.blocked ?? "", /^jig-core could not decide: api is not set up/);
    });
});

describe("a call that asks", () => {
    test("a write to a test environment asks, with a preview that names the request and the environment", async () => {
        const result = await h.call(run("Create order"));
        assert.equal(result.cls?.effect, "write");
        assert.ok(result.preview, "a write outside the machine asks, so it has a preview");
        assert.match(result.preview.body ?? "", /^Request: Create order \(acme\) in Staging \(staging\)/);
        ok(result);
    });

    test("a read does not ask by default, and can be made to ask by a rule: then it has a preview with a fingerprint too", async () => {
        const quiet = await h.call(run("Get order"));
        assert.equal(quiet.preview, undefined);
        const asked = await h.call(run("Get order"), { ask: true });
        assert.match(asked.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
        assert.equal(asked.error, undefined);
    });
});
