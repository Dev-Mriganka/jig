// Postman's cloud as a source: a collection and its environments fetched with an API key to a local copy, read like an exported file.
// The fetch is the command `/api refresh`, tried against a fake Postman API on this machine. The API key is a canary here: it must
// not be in a message, an error, a result or the copy on disk, whatever the service or a transport says.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { readApi } from "../src/config.ts";
import { FIXTURES } from "./support/acme.ts";
import { closedPort, startFakeApi } from "./support/fake-api.ts";
import type { FakeApi, Recorded, Reply } from "./support/fake-api.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const KEY = ["PMAK", "1a2b3c4d5e6f7a8b9c0d1e2f-3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e"].join("-");
const KEY_REFERENCE = "pass:postman/api-key";
const COLLECTION_ID = "12345678-aaaa1111-bbbb-2222-cccc-3333dddd4444";
const STAGING_ID = "12345678-eeee5555-ffff-6666-aaaa-7777bbbb8888";
const PRODUCTION_ID = "12345678-99990000-1111-2222-3333-444455556666";
const SECRET_IN_POSTMAN = "plain-secret-value-in-postman-0042";

let h: Harness;
let postman: FakeApi;
let state: string;
let saved: Record<string, string | undefined>;

/** What the fake API serves; a test changes these to change what the cloud holds. */
let collection: Record<string, unknown>;
let environments: Record<string, Record<string, unknown>>;

const fixture = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(FIXTURES, "postman", file), "utf8")) as Record<string, unknown>;

/** The fixtures with their example addresses pointing at the fake API of this test. */
function served(): void {
    const replace = (value: unknown): unknown =>
        JSON.parse(JSON.stringify(value).split("https://api.staging.acme.example.test").join(h.api.origin).split("https://api.acme.example.test").join(h.prod.origin)) as unknown;
    collection = replace(fixture("acme-orders.postman_collection.json")) as Record<string, unknown>;
    const staging = replace(fixture("acme-staging.postman_environment.json")) as Record<string, unknown>;
    const production = replace(fixture("acme-production.postman_environment.json")) as Record<string, unknown>;
    // In the cloud, a secret may carry its value.
    for (const environment of [staging, production]) {
        for (const item of environment.values as Array<Record<string, unknown>>) if (item.key === "token") item.value = SECRET_IN_POSTMAN;
    }
    environments = { [STAGING_ID]: staging, [PRODUCTION_ID]: production };
}

/** The Postman API as far as these tests need it. */
function answer(request: Recorded): Reply {
    if (request.headers["x-api-key"] !== KEY) {
        return { status: 401, body: JSON.stringify({ error: { name: "AuthenticationError", message: `Invalid API Key: ${request.headers["x-api-key"] ?? "none"}. Every request requires a valid API Key.` } }) };
    }
    const collectionMatch = /^\/collections\/(.+)$/.exec(request.path);
    if (collectionMatch !== null) return collectionMatch[1] === COLLECTION_ID ? { body: JSON.stringify({ collection }) } : { status: 400, body: '{"error":{"name":"collectionNotFoundError"}}' };
    const environmentMatch = /^\/environments\/(.+)$/.exec(request.path);
    const environment = environmentMatch === null ? undefined : environments[environmentMatch[1] as string];
    return environment === undefined ? { status: 404, body: "{}" } : { body: JSON.stringify({ environment }) };
}

before(async () => {
    h = await setupHarness();
    postman = await startFakeApi();
    saved = { JIG_STATE_DIR: process.env.JIG_STATE_DIR, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
});
after(async () => {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    await postman.close();
    await h.close();
});

/** A section with one cloud collection, `cloud`, and the file collection `ledger`, and the secrets of the fixtures. */
function configure(cloud: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): void {
    h.jig.secrets.set(KEY_REFERENCE, KEY);
    h.jig.secrets.set("pass:acme/staging-token", "stg-token-4f9c2a71d3e8");
    h.jig.secrets.set("pass:acme/production-token", "prd-token-8e1b6c05a9d2");
    h.configure({
        collections: {
            cloud: { postman: { cloud: COLLECTION_ID, apiKey: KEY_REFERENCE, environments: { Staging: STAGING_ID, Production: PRODUCTION_ID }, ...cloud } },
            ledger: { http: path.join(h.dir, "ledger") },
        },
        environments: { Staging: "staging", Production: "production" },
        secrets: { token: { Staging: "pass:acme/staging-token", Production: "pass:acme/production-token" } },
        allowPlainLocal: true,
        ...extra,
    });
}

const copyPath = (): string => path.join(state, "api", "postman-cloud", `${COLLECTION_ID}.json`);
const text = (notices: Array<{ text: string }>): string => notices.map((notice) => notice.text).join("\n");

beforeEach(() => {
    h.reset();
    postman.reset();
    postman.respond = answer;
    h.options.postmanApi = postman.origin;
    state = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-cloud-"));
    process.env.JIG_STATE_DIR = state;
    fs.mkdirSync(path.join(h.dir, "ledger"));
    served();
    configure();
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

describe("before anything is fetched", () => {
    test("the collection is listed with one problem that says what to run, and it has no requests", async () => {
        const list = ok(await h.call({ action: "list", collection: "cloud" }));
        assert.match(list, /^cloud \(postman, 0 requests; environments: none\)$/m);
        assert.match(list, new RegExp(`error: ${COLLECTION_ID}\\.json: has not been fetched yet: run /api refresh cloud`));
        assert.equal(postman.requests.length, 0, "reading touches no network");
    });

    test("a request of it is not found, and the other collections are not affected", async () => {
        const result = await h.call({ action: "run", request: "Get order", collection: "cloud", environment: "Staging" });
        assert.match(result.blocked ?? "", /no request named "Get order"/);
        assert.match(ok(await h.call({ action: "list", collection: "ledger" })), /^ledger \(http, 0 requests/m);
    });
});

describe("/api refresh", () => {
    test("fetches the collection and its environments, with the key in X-API-Key, and says what it fetched", async () => {
        const notices = await h.command("/api refresh cloud");
        assert.equal(notices.length, 1);
        assert.equal(notices[0]?.level, "info");
        assert.equal(notices[0]?.text, [
            "cloud: fetched the collection and 2 environments",
            "  25 requests, no copy before",
            "  Staging: new",
            `  Staging: token is a secret with a value in Postman; the value is not kept, so give it in api.secrets`,
            "  Production: new",
            `  Production: token is a secret with a value in Postman; the value is not kept, so give it in api.secrets`,
        ].join("\n"));
        assert.deepEqual(postman.requests.map((request) => request.target), [`/collections/${COLLECTION_ID}`, `/environments/${STAGING_ID}`, `/environments/${PRODUCTION_ID}`]);
        assert.ok(postman.requests.every((request) => request.method === "GET" && request.headers["x-api-key"] === KEY));
        assert.ok(h.jig.secretCalls.every((reference) => reference === KEY_REFERENCE), "the key is read through jig-core, by its reference");
    });

    test("writes the copy where the state folder rule says, readable by its owner only", async () => {
        await h.command("/api refresh cloud");
        assert.equal(fs.statSync(copyPath()).mode & 0o777, 0o600);
        for (const folder of [path.join(state, "api"), path.join(state, "api", "postman-cloud")]) assert.equal(fs.statSync(folder).mode & 0o777, 0o700, folder);
        assert.deepEqual(fs.readdirSync(path.dirname(copyPath())), [`${COLLECTION_ID}.json`], "no temporary file is left");
    });

    test("the state folder is $JIG_STATE_DIR, else jig under $XDG_STATE_HOME", async () => {
        delete process.env.JIG_STATE_DIR;
        const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-xdg-"));
        process.env.XDG_STATE_HOME = xdg;
        try {
            await h.command("/api refresh cloud");
            assert.ok(fs.existsSync(path.join(xdg, "jig", "api", "postman-cloud", `${COLLECTION_ID}.json`)));
        } finally {
            fs.rmSync(xdg, { recursive: true, force: true });
        }
    });

    test("the copy is what the collection is read from: its requests, its environments, and nothing that was a secret", async () => {
        await h.command("/api refresh cloud");
        const list = ok(await h.call({ action: "list", collection: "cloud" }));
        assert.match(list, /^cloud \(postman, 25 requests; environments: Staging, Production\)$/m);
        assert.match(list, /Orders\/Get order {2}GET \{\{baseUrl\}\}\/\{\{apiVersion\}\}\/orders\/\{\{orderId\}\} {2}\[reads; needs orderId\]/);
        const stored = fs.readFileSync(copyPath(), "utf8");
        assert.doesNotMatch(stored, new RegExp(SECRET_IN_POSTMAN), "the value of a secret variable is not kept");
        assert.match(stored, /"key":"token","value":"","type":"secret"/);
        assert.doesNotMatch(list, new RegExp(SECRET_IN_POSTMAN));
        assert.doesNotMatch(list, /with a value in the file/, "nothing is left to refuse: the value was never kept");
    });

    test("a request of the copy runs like one of an exported file: the host is the environment's, the token comes from api.secrets", async () => {
        await h.command("/api refresh cloud");
        ok(await h.call({ action: "run", request: "Get order", collection: "cloud", environment: "Staging", variables: { orderId: "7" } }));
        const sent = h.api.requests.at(-1);
        assert.equal(sent?.path, "/v1/orders/7");
        assert.equal(sent?.headers.authorization, "Bearer stg-token-4f9c2a71d3e8");
    });

    test("a request that uploads a file is refused: a cloud collection has no folder for files", async () => {
        await h.command("/api refresh cloud");
        const list = ok(await h.call({ action: "list", collection: "cloud", folder: "Orders" }));
        assert.match(list, /Upload receipt .*refused: it uploads a file, and a Postman cloud collection has no folder to keep files in/);
        assert.match(list, /Import orders .*refused: it uploads a file/);
    });

    test("the key is in no message, no result, no error and not in the copy", async () => {
        const seen: string[] = [];
        seen.push(text(await h.command("/api refresh cloud")));
        seen.push(text(await h.command("/api refresh")));
        seen.push(ok(await h.call({ action: "list" })));
        seen.push(fs.readFileSync(copyPath(), "utf8"));
        // And when the service does not like the key and repeats it.
        h.jig.secrets.set(KEY_REFERENCE, `${KEY}-wrong`);
        const refused = await h.command("/api refresh cloud");
        seen.push(text(refused));
        for (const each of seen) assert.doesNotMatch(each, new RegExp(KEY.slice(0, 20)));
        assert.match(text(refused), /could not fetch the collection: the API key was not accepted \(HTTP 401\)/);
    });

    test("says what changed since the last copy: requests added, removed and changed, and variables by name", async () => {
        await h.command("/api refresh cloud");
        const items = (collection.item as Array<Record<string, unknown>>);
        const orders = items.find((item) => item.name === "Orders") as { item: Array<Record<string, unknown>> };
        orders.item.pop();
        (orders.item[0] as { request: { url: { raw: string } } }).request.url.raw += "?expand=items";
        orders.item.push({ name: "Refund order", request: { method: "POST", url: "{{baseUrl}}/refunds" } });
        const staging = environments[STAGING_ID] as { values: Array<Record<string, unknown>> };
        staging.values.find((item) => item.key === "customerId")!.value = "cust-staging-2";
        staging.values.push({ key: "region", value: "eu", type: "default", enabled: true });
        staging.values = staging.values.filter((item) => item.key !== "unused");
        const notices = await h.command("/api refresh cloud");
        assert.equal(notices[0]?.text, [
            "cloud: fetched the collection and 2 environments",
            "  25 requests; added: Orders/Refund order; removed: Orders/Place order (form); changed: Orders/Get order",
            "  Staging: added region; changed customerId",
            "  Staging: token is a secret with a value in Postman; the value is not kept, so give it in api.secrets",
            "  Production: no change",
            "  Production: token is a secret with a value in Postman; the value is not kept, so give it in api.secrets",
        ].join("\n"));
    });
});

describe("when the fetch goes wrong", () => {
    const refreshed = async (): Promise<string> => {
        const notices = await h.command("/api refresh cloud");
        assert.equal(notices[0]?.level, "warning");
        return text(notices);
    };

    test("a key the service does not accept is reported in the service's status, and nothing is saved", async () => {
        h.jig.secrets.set(KEY_REFERENCE, ["PMAK", "not-the-key-0000000000000000"].join("-"));
        const said = await refreshed();
        assert.equal(said, "cloud: could not fetch the collection: the API key was not accepted (HTTP 401). Nothing was saved.");
        assert.equal(fs.existsSync(copyPath()), false);
        assert.doesNotMatch(said, /Invalid API Key/, "the service's own words are not repeated");
    });

    test("a copy that exists is left as it was", async () => {
        await h.command("/api refresh cloud");
        const before = fs.readFileSync(copyPath(), "utf8");
        postman.respond = () => ({ status: 500, body: "boom" });
        assert.equal(await refreshed(), "cloud: could not fetch the collection: the service failed (HTTP 500). The local copy was not changed.");
        assert.equal(fs.readFileSync(copyPath(), "utf8"), before);
        assert.match(ok(await h.call({ action: "list", collection: "cloud" })), /25 requests/, "the old copy still serves");
    });

    test("an unknown collection, a rate limit, and an answer that is not a collection each have their own words", async () => {
        postman.respond = () => ({ status: 400, body: '{"error":{"name":"collectionNotFoundError"}}' });
        assert.match(await refreshed(), /the service does not know it \(HTTP 400\): check the id, and that the key can see it/);
        postman.respond = () => ({ status: 429, body: "{}" });
        assert.match(await refreshed(), /the service asked for fewer requests \(HTTP 429\): try again in a minute/);
        postman.respond = () => ({ body: "<html>sign in</html>" });
        assert.match(await refreshed(), /the answer is not JSON/);
        postman.respond = () => ({ body: '{"collection":{"info":{"name":"x"}}}' });
        assert.match(await refreshed(), /the answer is not a collection \(it has no items\)/);
    });

    test("a service that cannot be reached, and one that does not answer in time", async () => {
        h.options.postmanApi = `http://127.0.0.1:${await closedPort()}`;
        // ECONNREFUSED is the kernel's answer; ECONNRESET is what a forwarder in front of the port may make of it.
        assert.match(await refreshed(), /^cloud: could not fetch the collection: (could not connect \(ECONNREFUSED\) \(nothing was sent\)|no answer \(the connection failed \(ECONNRESET\)\))\. Nothing was saved\.$/);
        h.options.postmanApi = postman.origin;
        h.configure({ ...(h.jig.api.config.section("api") as object), timeoutSec: 1 });
        postman.respond = () => ({ hang: true });
        assert.match(await refreshed(), /no answer within 1 s/);
    });

    test("a key that cannot be read stops the fetch before anything is sent, without naming the key", async () => {
        h.jig.secrets.delete(KEY_REFERENCE);
        assert.equal(await refreshed(), "cloud: could not fetch the collection: could not sign in (the secret could not be read: no such entry) (nothing was sent). Nothing was saved.");
        assert.equal(postman.requests.length, 0);
    });

    test("an environment that fails keeps its earlier copy, the rest is saved, and the command says it did not all work", async () => {
        await h.command("/api refresh cloud");
        const items = (collection.item as Array<Record<string, unknown>>);
        items.pop();
        postman.respond = (request) => (request.path === `/environments/${STAGING_ID}` ? { status: 500, body: "{}" } : answer(request));
        const said = await refreshed();
        assert.match(said, /^cloud: fetched the collection and 2 environments\n {2}\d+ requests; .*removed: /);
        assert.match(said, /\n {2}Staging: could not fetch the environment: the service failed \(HTTP 500\)\. The earlier copy is kept\./);
        assert.match(said, /\n {2}Production: no change/);
        const stored = JSON.parse(fs.readFileSync(copyPath(), "utf8")) as { environments: Record<string, unknown> };
        assert.deepEqual(Object.keys(stored.environments), ["Staging", "Production"]);
    });

    test("a collection larger than an ordinary answer is fetched whole", async () => {
        (collection.item as unknown[]).push({ name: "Big", item: Array.from({ length: 3000 }, (_, index) => ({ name: `R${index}`, request: { method: "GET", url: "{{baseUrl}}/x", description: "d".repeat(1000) } })) });
        const notices = await h.command("/api refresh cloud");
        assert.equal(notices[0]?.level, "info");
        assert.ok(fs.statSync(copyPath()).size > 3 * 1024 * 1024);
        assert.match(ok(await h.call({ action: "list", collection: "cloud", text: "R2999" })), /Big\/R2999/);
    });

    test("a file in the state folder that is not one of ours is a problem, not a crash", async () => {
        fs.mkdirSync(path.dirname(copyPath()), { recursive: true });
        fs.writeFileSync(copyPath(), '{"hello":1}');
        assert.match(ok(await h.call({ action: "list", collection: "cloud" })), new RegExp(`error: ${COLLECTION_ID}\\.json: is not a copy that this plugin made: run /api refresh to fetch it again`));
        fs.writeFileSync(copyPath(), "{ not json");
        assert.match(ok(await h.call({ action: "list", collection: "cloud" })), /is not a copy that this plugin made/);
        assert.equal((await h.command("/api refresh cloud"))[0]?.level, "info", "and a refresh replaces it");
    });
});

describe("through a transport or a sign-in service", () => {
    test("a transport carries the fetch: the system, the method, the address and the headers, and the answer is read as usual", async () => {
        configure({ transport: "company-proxy" });
        h.jig.transports.set("company-proxy", {
            request: async (request) => {
                const response = await fetch(request.url, { method: request.method, headers: { ...request.headers, "x-proxy-session": "p-1" } });
                return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
            },
        });
        const notices = await h.command("/api refresh cloud");
        assert.equal(notices[0]?.level, "info");
        assert.equal(h.jig.transportCalls.length, 3);
        const [first] = h.jig.transportCalls;
        assert.equal(first?.name, "company-proxy");
        assert.equal(first?.request.system, "api:cloud");
        assert.equal(first?.request.method, "GET");
        assert.equal(first?.request.url, `${postman.origin}/collections/${COLLECTION_ID}`);
        assert.equal(first?.request.headers?.["X-API-Key"], KEY, "the key is a header of the request, as the service wants it");
        assert.equal(postman.requests[0]?.headers["x-proxy-session"], "p-1");
        assert.ok(fs.existsSync(copyPath()));
        assert.doesNotMatch(fs.readFileSync(copyPath(), "utf8") + text(notices), new RegExp(KEY.slice(0, 20)));
    });

    test("a transport that fails is reported in its own words with a key's shape removed, and the copy is untouched", async () => {
        configure({ transport: "company-proxy" });
        h.jig.transports.set("company-proxy", { request: async (request) => { throw new Error(`proxy refused ${request.headers?.["X-API-Key"] ?? ""} for ${request.url}`); } });
        const said = text(await h.command("/api refresh cloud"));
        assert.match(said, /^cloud: could not fetch the collection: no answer \(transport "company-proxy" failed: proxy refused \[redacted\] for /);
        assert.doesNotMatch(said, new RegExp(KEY.slice(0, 20)));
        assert.equal(fs.existsSync(copyPath()), false);
    });

    test("a name no company plugin registered means nothing was sent", async () => {
        configure({ transport: "missing-proxy" });
        assert.match(text(await h.command("/api refresh cloud")), /no transport named "missing-proxy" \(none is registered\); a company plugin registers it \(nothing was sent\)/);
        assert.equal(postman.requests.length, 0);
    });

    test("a sign-in service adds its headers to every fetch, and cannot also set the key's header", async () => {
        configure({ signIn: "company-sso" });
        h.jig.signIn.set("company-sso", () => ({ "X-Company-Session": "sess-9" }));
        await h.command("/api refresh cloud");
        assert.deepEqual(h.jig.signInCalls.map((call) => [call.name, call.request.system]), [["company-sso", "api:cloud"], ["company-sso", "api:cloud"], ["company-sso", "api:cloud"]]);
        assert.ok(postman.requests.every((request) => request.headers["x-company-session"] === "sess-9" && request.headers["x-api-key"] === KEY));
        h.jig.signIn.set("company-sso", () => ({ "x-api-key": "other" }));
        assert.match(text(await h.command("/api refresh cloud")), /header x-api-key is set by the sign-in, so the request cannot have it too/);
    });
});

describe("the command", () => {
    test("without refresh, or with too much, it says how it is used", async () => {
        for (const line of ["/api", "/api list", "/api refresh a b"]) {
            assert.deepEqual(await h.command(line), [{ text: "Usage: /api refresh [collection]: fetch the Postman cloud collections to their local copy", level: "warning" }], line);
        }
    });

    test("an unknown collection, a collection that is files, and a configuration with nothing to fetch are each said", async () => {
        assert.match(text(await h.command("/api refresh nope")), /^No collection is named nope\. Known: cloud, ledger$/);
        assert.match(text(await h.command("/api refresh ledger")), /^ledger is read from files, so there is nothing to fetch\. Collections that can be fetched: cloud$/);
        h.configure({ collections: { ledger: { http: path.join(h.dir, "ledger") } } });
        assert.match(text(await h.command("/api refresh")), /^No collection is a Postman cloud collection: add one under api\.collections/);
        h.jig.reset();
        assert.match(text(await h.command("/api refresh")), /^api is not set up: add an "api" section/);
    });

    test("without a name it refreshes every cloud collection", async () => {
        h.configure({
            collections: { one: { postman: { cloud: COLLECTION_ID, apiKey: KEY_REFERENCE } }, two: { postman: { cloud: COLLECTION_ID, apiKey: KEY_REFERENCE } }, ledger: { http: path.join(h.dir, "ledger") } },
            allowPlainLocal: true,
        });
        h.jig.secrets.set(KEY_REFERENCE, KEY);
        const notices = await h.command("/api refresh");
        assert.match(text(notices), /^one: fetched the collection\n.*\ntwo: fetched the collection\n/s);
        assert.equal(postman.requests.length, 2);
    });

    test("is completed with refresh", () => {
        assert.ok(h.commands.has("api"));
    });
});

describe("the configuration", () => {
    const errorsOf = (cloud: unknown, extra: Record<string, unknown> = {}): string[] => readApi({ collections: { c: { postman: cloud, ...extra } } }).errors;
    const good = { cloud: COLLECTION_ID, apiKey: KEY_REFERENCE };

    test("a collection and the reference of the key are all it needs", () => {
        const { errors, settings } = readApi({ collections: { c: { postman: good } } });
        assert.deepEqual(errors, []);
        assert.equal(settings?.collections.get("c")?.kind, "postman");
        assert.ok(settings?.collections.get("c")?.refresher);
        assert.equal(readApi({ collections: { c: { postman: "/work/p.json" } } }).settings?.collections.get("c")?.refresher, undefined);
    });

    test("the key is a reference, never the key: a pasted key is refused without being repeated", () => {
        assert.deepEqual(errorsOf({ cloud: COLLECTION_ID }), ["api.collections.c.postman.apiKey: required, a secret reference such as pass:postman/api-key"]);
        const errors = errorsOf({ ...good, apiKey: KEY });
        assert.deepEqual(errors, ["api.collections.c.postman.apiKey: must be a secret reference such as pass:work/api-token, not the secret itself"]);
        assert.doesNotMatch(errors.join(), new RegExp(KEY.slice(0, 20)));
    });

    test("ids are letters, digits and dashes, so that they cannot reach another path", () => {
        assert.deepEqual(errorsOf({ ...good, cloud: "../../etc/passwd" }), ["api.collections.c.postman.cloud: must be the id of a Postman collection (letters, digits and -)"]);
        assert.deepEqual(errorsOf({ ...good, environments: { Staging: "a/b" } }), ["api.collections.c.postman.environments.Staging: must be the id of a Postman environment (letters, digits and -)"]);
        assert.deepEqual(errorsOf({ ...good, cloud: undefined }), ["api.collections.c.postman.cloud: required, the id of the collection"]);
    });

    test("environments belong inside postman, other fields are unknown, and a transport and a sign-in service are exclusive", () => {
        assert.deepEqual(errorsOf(good, { environments: { Staging: STAGING_ID } }), ['api.collections.c.environments: for a Postman cloud collection this belongs inside postman, as { "Staging": "<environment id>" }']);
        assert.deepEqual(errorsOf({ ...good, region: "asia" }), ['api.collections.c.postman.region: must be "us" or "eu", the region of your Postman data']);
        assert.deepEqual(errorsOf({ ...good, accessKey: "PMAT-1" }), ["api.collections.c.postman.accessKey: unknown field"]);
        assert.deepEqual(errorsOf({ ...good, transport: "t", signIn: "s" }), ["api.collections.c.postman: use signIn or transport, not both"]);
        assert.deepEqual(errorsOf({ ...good, transport: 5 }), ["api.collections.c.postman.transport: must be the name of a transport"]);
        assert.deepEqual(errorsOf({ ...good, region: "eu", transport: "t", environments: { Staging: STAGING_ID } }), []);
    });
});
