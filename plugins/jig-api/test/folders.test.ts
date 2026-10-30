// run-folder: a folder of saved requests run in order, stopping at the first failure, with one line per request. It is approved
// as one: the person sees every request, and the fingerprint covers them all.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());

const request = (
    name: string,
    method: string,
    requestPath: string,
    extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ name, request: { method, url: { raw: `{{baseUrl}}${requestPath}` }, ...extra } });

/** A collection `flows`, with a folder of reads, a mixed folder, and a folder that needs a value from the agent. */
function configureFlows(extra: Record<string, unknown> = {}): void {
    const file = path.join(h.dir, "flows.postman_collection.json");
    fs.writeFileSync(
        file,
        JSON.stringify({
            info: { name: "Flows" },
            item: [
                {
                    name: "Smoke",
                    item: [
                        request("Health", "GET", "/health"),
                        request("Version", "GET", "/version"),
                        request("Orders", "GET", "/orders"),
                    ],
                },
                {
                    name: "Lifecycle",
                    item: [
                        request("Create", "POST", "/orders"),
                        request("Check", "GET", "/orders/{{orderId}}"),
                        request("Remove", "DELETE", "/orders/{{orderId}}"),
                    ],
                },
            ],
        }),
    );
    const env = path.join(h.dir, "flows-staging.json");
    fs.writeFileSync(env, JSON.stringify({ values: [{ key: "baseUrl", value: h.api.origin, enabled: true }] }));
    h.configure({
        collections: { flows: { postman: file, environments: { Staging: env } } },
        environments: { Staging: "staging" },
        allowPlainLocal: true,
        ...extra,
    });
}

beforeEach(() => {
    h.reset();
    configureFlows();
});

const folder = (name: string, extra: Record<string, unknown> = {}) =>
    h.call({ action: "run-folder", folder: name, environment: "Staging", ...extra });

describe("a folder of reads", () => {
    test("runs at once, in order, with one line per request", async () => {
        const result = await folder("Smoke");
        assert.deepEqual(result.cls, { action: "flows/Smoke", environment: "staging", effect: "read" });
        assert.equal(result.preview, undefined, "reads do not ask");
        const text = ok(result);
        assert.deepEqual(text.split("\n"), [
            "Folder Smoke in Staging (staging): 3 of 3 ran, all answered 2xx",
            `1. Health: GET ${h.api.origin}/health -> HTTP 200 OK`,
            `2. Version: GET ${h.api.origin}/version -> HTTP 200 OK`,
            `3. Orders: GET ${h.api.origin}/orders -> HTTP 200 OK`,
        ]);
        assert.deepEqual(
            h.api.requests.map((r) => r.path),
            ["/health", "/version", "/orders"],
        );
    });

    test("stops at the first request that does not answer 2xx, says which, and does not run the rest", async () => {
        h.api.respond = (r) => (r.path === "/version" ? { status: 503, body: '{"error":"down"}' } : { body: "{}" });
        const text = ok(await folder("Smoke"));
        const lines = text.split("\n");
        assert.equal(lines[0], "Folder Smoke in Staging (staging): 2 of 3 ran, stopped at the first failure");
        assert.equal(lines[1], `1. Health: GET ${h.api.origin}/health -> HTTP 200 OK`);
        assert.equal(lines[2], `2. Version: GET ${h.api.origin}/version -> HTTP 503 Service Unavailable`);
        assert.equal(lines[3], "3. Orders: skipped");
        assert.deepEqual(lines.slice(4, 6), ["", "Failed request:"]);
        assert.match(
            text,
            /Failed request:\nGET \S+\/version -> HTTP 503 Service Unavailable\nRequest: Version \(flows\) in Staging \(staging\)\n[\s\S]*"error": "down"/,
        );
        assert.equal(h.api.requests.length, 2, "the third was not sent");
    });

    test("the call's record carries how many requests ran and whether it failed", async () => {
        const passed = await folder("Smoke");
        ok(passed);
        assert.deepEqual(h.jig.facts.get(passed.id), [{ requests: 3, ran: 3, failed: 0 }]);
        h.api.respond = () => ({ status: 500, body: "{}" });
        const failed = await folder("Smoke");
        ok(failed);
        assert.deepEqual(h.jig.facts.get(failed.id), [{ requests: 3, ran: 1, failed: 1 }]);
        assert.deepEqual(failed.details, { folder: "Smoke", requests: 3, ran: 1, failed: true });
    });

    test("a request that gets no answer stops the folder, and says the outcome of a write is unknown", async () => {
        h.api.respond = (r) => (r.method === "DELETE" ? { hang: true } : { body: '{"id":1}' });
        const text = ok(await folder("Lifecycle", { variables: { orderId: "1" }, timeoutSec: 1 }));
        const lines = text.split("\n");
        assert.equal(lines[0], "Folder Lifecycle in Staging (staging): 3 of 3 ran, stopped at the first failure");
        assert.match(
            lines[3] ?? "",
            /^3\. Remove: no answer \(timed out after 1 s\)\. The outcome is unknown: the server may have carried it out\. It was not sent again\. Check with a GET before trying again\.$/,
        );
        assert.equal(h.api.requests.filter((r) => r.method === "DELETE").length, 1, "sent once");
    });
});

describe("a folder with a write", () => {
    test("is a write, asks once, and shows every request in order", async () => {
        const result = await folder("Lifecycle", { variables: { orderId: "7" } });
        assert.deepEqual(result.cls, { action: "flows/Lifecycle", environment: "staging", effect: "write" });
        const preview = result.preview;
        assert.ok(preview);
        assert.equal(preview.summary, "Folder Lifecycle: 3 requests, in order");
        assert.match(
            preview.body ?? "",
            /^Folder Lifecycle\n\n1\. Create\n {3}Request: Create \(flows\) in Staging \(staging\)\n/,
        );
        assert.match(preview.body ?? "", /2\. Check\n {3}Request: Check[\s\S]*URL: \S+\/orders\/7\n/);
        assert.match(
            preview.body ?? "",
            /3\. Remove\n {3}Request: Remove[\s\S]*Method: DELETE\n {3}URL: \S+\/orders\/7$/,
        );
        assert.match(preview.fingerprint ?? "", /^[0-9a-f]{32}$/);
        ok(result);
        assert.deepEqual(
            h.api.requests.map((r) => `${r.method} ${r.path}`),
            ["POST /orders", "GET /orders/7", "DELETE /orders/7"],
        );
    });

    test("is not sent if any request would now differ from what was approved", async () => {
        ok(await folder("Lifecycle", { variables: { orderId: "7" } }));
        h.api.reset();
        ok(await folder("Lifecycle", { variables: { orderId: "7" } }));
        const refused = await h.call(
            { action: "run-folder", folder: "Lifecycle", environment: "Staging", variables: { orderId: "7" } },
            { between: (input) => void (input.variables = { orderId: "8" }) },
        );
        assert.equal(
            refused.error?.message,
            "api run-folder Lifecycle: changed since the preview; run it again to see the new preview. Nothing was sent.",
        );
        assert.equal(h.api.requests.length, 3, "only the approved run sent anything");
    });

    test("a variable that no request of the folder uses is refused, and one that some use is given to those", async () => {
        const unused = await folder("Lifecycle", { variables: { orderId: "7", colour: "red" } });
        assert.equal(
            unused.blocked,
            'jig-core could not decide: "colour" is not a variable of any request in Lifecycle; they use baseUrl, orderId',
        );
        const missing = await folder("Lifecycle");
        assert.match(missing.blocked ?? "", /^jig-core could not decide: no value for orderId in Staging/);
    });

    test("the configuration's `reads` can make a folder of such requests a read", async () => {
        configureFlows({ reads: ["Create", "Remove"] });
        const result = await folder("Lifecycle", { variables: { orderId: "7" } });
        assert.equal(result.cls?.effect, "read");
        assert.equal(result.preview, undefined);
        ok(result);
    });
});

describe("a folder that cannot be run", () => {
    test("is refused as a whole before anything is sent: one request that cannot run stops them all", async () => {
        const file = path.join(h.dir, "flows.postman_collection.json");
        const collection = JSON.parse(fs.readFileSync(file, "utf8")) as { item: Array<{ item: unknown[] }> };
        collection.item[0]?.item.push({
            name: "Scripted",
            event: [{ listen: "prerequest", script: { exec: ["x()"] } }],
            request: { method: "GET", url: { raw: "{{baseUrl}}/s" } },
        });
        fs.writeFileSync(file, JSON.stringify(collection));
        const result = await folder("Smoke");
        assert.equal(
            result.blocked,
            'jig-core could not decide: "Scripted" is refused: it has a pre-request script (the request), and scripts never run',
        );
        assert.equal(h.api.requests.length, 0);
    });

    test("an unknown folder is invalid input, and so is a folder in two collections without the collection's name", async () => {
        const result = await folder("Nope");
        assert.equal(result.blocked, 'jig-core could not decide: no folder named "Nope"; folders: Smoke, Lifecycle');
        const other = path.join(h.dir, "other.postman_collection.json");
        fs.writeFileSync(other, JSON.stringify({ item: [{ name: "Smoke", item: [request("Ping", "GET", "/ping")] }] }));
        const section = h.jig.api.config.section("api") as { collections: Record<string, unknown> };
        h.configure({
            ...section,
            collections: {
                ...section.collections,
                other: { postman: other, environments: { Staging: path.join(h.dir, "flows-staging.json") } },
            },
        });
        const two = await folder("Smoke");
        assert.equal(two.blocked, 'jig-core could not decide: "Smoke" is a folder of flows and other: add collection');
        ok(await folder("Smoke", { collection: "other" }));
    });

    test("a folder is a path: a deeper folder, and the file of a .http collection", async () => {
        const directory = path.join(h.dir, "http");
        fs.mkdirSync(path.join(directory, "smoke"), { recursive: true });
        fs.writeFileSync(
            path.join(directory, "smoke", "health.http"),
            "GET {{baseUrl}}/health\n\n###\nGET {{baseUrl}}/ping\n",
        );
        fs.writeFileSync(path.join(directory, "other.http"), "GET {{baseUrl}}/other\n");
        fs.writeFileSync(
            path.join(directory, "http-client.env.json"),
            JSON.stringify({ staging: { baseUrl: h.api.origin } }),
        );
        h.configure({
            collections: { files: { http: directory } },
            environments: { staging: "staging" },
            allowPlainLocal: true,
        });
        const smoke = await h.call({ action: "run-folder", folder: "smoke", environment: "staging" });
        assert.deepEqual(smoke.cls, { action: "files/smoke", environment: "staging", effect: "read" });
        ok(smoke);
        assert.deepEqual(
            h.api.requests.map((r) => r.path),
            ["/health", "/ping"],
            "the other file is not in the folder",
        );
        h.api.reset();
        ok(await h.call({ action: "run-folder", folder: "smoke/health.http", environment: "staging" }));
        assert.equal(h.api.requests.length, 2);
        h.api.reset();
        ok(await h.call({ action: "run-folder", folder: "other.http", environment: "staging" }));
        assert.deepEqual(
            h.api.requests.map((r) => r.path),
            ["/other"],
        );
    });
});
