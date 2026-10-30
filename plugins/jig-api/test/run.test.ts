// The tool end to end on the example company's collections: list and show what is saved, run a saved request in an
// environment with the agent's values, and see exactly what reached the fake API. The classification of each call, which is
// where jig-core decides, is in classify.test.ts; here the calls are made.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { acmeSection, API_KEY, CLIENT_SECRET, SERVICE_PASSWORD, SERVICE_USER, TOKENS, useAcme } from "./support/acme.ts";
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

const acme = { collection: "acme", environment: "Staging" } as const;
const run = (request: string, variables: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    h.call({ action: "run", request, ...acme, variables, ...extra });
const basic = (pair: string): string => `Basic ${Buffer.from(pair).toString("base64")}`;
const last = (server = h.api) => {
    const request = server.requests.at(-1);
    assert.ok(request, "the server received a request");
    return request;
};

describe("list", () => {
    test("shows each collection, with its source, its size and its environments, and each request on a line", async () => {
        const text = ok(await h.call({ action: "list" }));
        assert.match(text, /^acme \(postman, 25 requests; environments: Staging, Production\)$/m);
        assert.match(text, /^ledger \(http, 20 requests; environments: staging, production\)$/m);
        assert.match(text, /^  Orders\/Get order {2}GET \{\{baseUrl\}\}\/\{\{apiVersion\}\}\/orders\/\{\{orderId\}\} {2}\[reads; needs orderId\]$/m);
        assert.match(text, /^  orders\.http\/Create order {2}POST \{\{baseUrl\}\}\/\{\{apiVersion\}\}\/orders {2}\[writes; needs sku, quantity\]$/m);
    });

    test("says whether a request reads or writes: by its method, or because the configuration says so", async () => {
        const text = ok(await h.call({ action: "list", collection: "acme" }));
        assert.match(text, /Orders\/Search orders {2}POST .*\[reads; needs text\]/);
        assert.match(text, /Orders\/Cancel order {2}DELETE .*\[writes; needs orderId\]/);
        h.configure(acmeSection(h, { reads: [] }));
        assert.match(ok(await h.call({ action: "list", collection: "acme" })), /Orders\/Search orders {2}POST .*\[writes; needs text\]/);
    });

    test("filters by collection, folder and text", async () => {
        const folder = ok(await h.call({ action: "list", collection: "acme", folder: "Smoke" }));
        assert.match(folder, /Smoke\/Health/);
        assert.match(folder, /Smoke\/Latest orders/);
        assert.doesNotMatch(folder, /Orders\/Get order|ledger/);
        const text = ok(await h.call({ action: "list", text: "SEARCH" }));
        assert.match(text, /Orders\/Search orders/);
        assert.match(text, /orders\.http\/Search orders/);
        assert.doesNotMatch(text, /Get order/);
        const none = ok(await h.call({ action: "list", collection: "acme", text: "no such request" }));
        assert.match(none, /\(no request matches\)/);
    });

    test("names what stops a request, in a few words", async () => {
        const text = ok(await h.call({ action: "list", collection: "acme" }));
        assert.match(text, /Admin\/Rebuild index .*\[writes; refused: it has a pre-request script \(the folder Admin\), and scripts never run\]/);
        assert.match(text, /Reports\/Watch orders .*refused: the address uses ws:\/\//);
        assert.match(text, /Auth styles\/Signed export .*refused: the sign-in type "awsv4" is not sent/);
    });

    test("reports the problems the files had, by file and key, with the collection they belong to", async () => {
        const text = ok(await h.call({ action: "list", collection: "acme" }));
        assert.match(text, /Problems:\n {4}warning: acme-production\.postman_environment\.json token: is a secret with a value in the file\. The value is ignored and never sent/);
        const ledger = ok(await h.call({ action: "list", collection: "ledger" }));
        assert.match(ledger, /warning: http-client\.private\.env\.json production\.token: is a secret with a value in the file/);
    });

    test("is cut at 60 requests, and says how to narrow", async () => {
        const directory = path.join(h.dir, "many");
        mkdirSync(directory);
        writeFileSync(path.join(directory, "many.http"), Array.from({ length: 70 }, (_, index) => `### Request ${index + 1}\nGET https://a.example.test/${index + 1}\n`).join("\n"));
        h.configure({ collections: { many: { http: directory } } });
        const many = ok(await h.call({ action: "list" }));
        assert.match(many, /^many \(http, 70 requests; environments: none\)\n/);
        assert.match(many, /\(10 more not shown: narrow with collection, folder or text\)$/);
        assert.equal(many.split("\n").filter((line) => /^ {2}\S.*\[reads/.test(line)).length, 60);
    });

    test("an unknown collection is invalid input that names the known ones", async () => {
        const result = await h.call({ action: "list", collection: "nope" });
        assert.equal(result.blocked, undefined);
        assert.match(result.error?.message ?? "", /^no collection named "nope"\. Known collections: acme, ledger$/);
    });

    test("reads the files on every call, so a change in them shows at once", async () => {
        const before = ok(await h.call({ action: "list", collection: "ledger", text: "health" }));
        assert.match(before, /orders\.http\/Health/);
        const file = (h.jig.api.config.section("api") as { collections: { ledger: { http: string } } }).collections.ledger.http;
        writeFileSync(`${file}/orders.http`, readFileSync(`${file}/orders.http`, "utf8").replace("### Health", "### Liveness"));
        const after = ok(await h.call({ action: "list", collection: "ledger", text: "liveness" }));
        assert.match(after, /orders\.http\/Liveness/);
    });
});

describe("show", () => {
    test("one request in full: its address, effect, sign-in, headers, body, variables and documentation", async () => {
        const text = ok(await h.call({ action: "show", request: "Create order", ...acme }));
        const lines = text.split("\n");
        assert.equal(lines[0], "Create order (acme, Orders/Create order)");
        assert.equal(lines[1], "POST {{baseUrl}}/{{apiVersion}}/orders");
        assert.ok(lines.includes("Effect: writes"));
        assert.ok(lines.includes("Sign-in: a bearer token"));
        assert.ok(lines.includes("  Content-Type: application/json"));
        assert.ok(lines.includes("Body (json):"));
        assert.match(text, /^ {4}"customerId": "\{\{customerId\}\}",$/m);
        assert.ok(lines.includes("Docs: Creates an order for a customer."));
        assert.ok(lines.includes("From: acme-orders.postman_collection.json: Orders/Create order"));
    });

    test("says where each variable gets its value in an environment, and what it still needs", async () => {
        const text = ok(await h.call({ action: "show", request: "Create order", ...acme }));
        for (const line of [
            "  baseUrl: from the environment Staging", "  apiVersion: from the collection", "  $guid: made when the request is sent",
            "  customerId: from the environment Staging", "  sku: needs a value (pass it in variables)", "  token: secret, set in api.secrets",
        ]) assert.ok(text.split("\n").includes(line), line);
        const file = ok(await h.call({ action: "show", request: "List orders", collection: "ledger", environment: "staging" }));
        assert.ok(file.split("\n").includes("  pageSize: from the file"));
    });

    test("names a secret that has no reference, and never shows a value", async () => {
        h.configure(acmeSection(h, { secrets: {} }));
        const text = ok(await h.call({ action: "show", request: "Get order", ...acme }));
        assert.ok(text.split("\n").includes("  token: secret, NOT SET in api.secrets"));
        for (const value of [TOKENS.staging.value, TOKENS.production.value, "plain-prod-token-0123456789"]) assert.ok(!text.includes(value));
    });

    test("shows a header that holds a secret or signs in by its name only", async () => {
        const text = ok(await h.call({ action: "show", request: "Get order", collection: "ledger", environment: "staging" }));
        assert.ok(text.split("\n").includes("  Authorization: (secret)"));
        assert.ok(text.split("\n").includes("  Accept: application/json"));
        assert.ok(!text.includes("Bearer"));
    });

    test("a request that is refused says so, and why", async () => {
        const text = ok(await h.call({ action: "show", request: "Rebuild index", ...acme }));
        assert.ok(text.includes("Status: refused: it has a pre-request script (the folder Admin), and scripts never run"));
        const notes = ok(await h.call({ action: "show", request: "Get order", ...acme }));
        assert.ok(notes.includes("Note: its test script is ignored (scripts never run)"));
    });

    test("a name that is not saved is invalid input that suggests the near ones; one that is in two collections asks for more", async () => {
        const near = await h.call({ action: "show", request: "order", collection: "acme" });
        assert.match(near.error?.message ?? "", /^no request named "order"; similar: Get order, List orders, Create order/);
        const none = await h.call({ action: "show", request: "zzz" });
        assert.match(none.error?.message ?? "", /^no request named "zzz"; use list to see them$/);
        const two = await h.call({ action: "show", request: "Get order" });
        assert.match(two.error?.message ?? "", /^"Get order" names 2 requests \(acme:Orders\/Get order, ledger:orders\.http\/Get order\): add collection or folder$/);
        assert.match(ok(await h.call({ action: "show", request: "Orders/Get order", collection: "acme" })), /^Get order \(acme/);
    });

    test("an environment the collection does not have is invalid input that lists the ones it has", async () => {
        const result = await h.call({ action: "show", request: "Get order", collection: "acme", environment: "Qa" });
        assert.match(result.error?.message ?? "", /^no environment named "Qa"; acme has: Staging, Production$/);
    });
});

describe("run", () => {
    test("a read runs at once, with the host of its environment, the path variable the agent gave, and the staging token", async () => {
        const text = ok(await run("Get order", { orderId: "123" }));
        assert.match(text, new RegExp(`^GET ${h.api.origin}/v1/orders/123 -> HTTP 200 OK\\nRequest: Get order \\(acme\\) in Staging \\(staging\\)\\n`));
        assert.equal(h.api.requests.length, 1);
        assert.equal(last().target, "/v1/orders/123");
        assert.equal(last().headers.authorization, `Bearer ${TOKENS.staging.value}`);
        assert.equal(last().headers.accept, "application/json", "the request's own Accept replaces the tool's");
        assert.equal(last().headers["user-agent"], "jig-api");
    });

    test("a read in production runs against the production host with the production token, and never the plain one in the file", async () => {
        const result = await h.call({ action: "run", request: "Get order", collection: "acme", environment: "Production", variables: { orderId: "9" } });
        assert.deepEqual(result.cls, { action: "Get order", environment: "production", effect: "read" });
        assert.equal(result.preview, undefined, "a read does not ask");
        ok(result);
        assert.equal(h.api.requests.length, 0, "the staging host saw nothing");
        assert.equal(h.prod.requests.length, 1);
        assert.equal(h.prod.requests[0]?.headers.authorization, `Bearer ${TOKENS.production.value}`);
        assert.ok(!JSON.stringify(h.prod.requests).includes("plain-prod-token-0123456789"));
    });

    test("the agent's values are written into the query as values: encoded, so they cannot add parameters", async () => {
        ok(await run("List orders", { status: "open&admin=true #x" }));
        assert.equal(last().target, "/v1/orders?status=open%26admin%3Dtrue%20%23x&limit=10");
    });

    test("a value in a path is one segment: a slash or dots in it do not climb", async () => {
        ok(await run("Get order", { orderId: "a/b?c=d" }));
        assert.equal(last().target, "/v1/orders/a%2Fb%3Fc%3Dd");
        for (const orderId of [".", ".."]) {
            const result = await run("Get order", { orderId });
            assert.match(result.blocked ?? "", /orderId cannot be \. or \.\. in an address/);
        }
        assert.equal(h.api.requests.length, 1);
    });

    test("a value in a JSON body stays a value: quotes and line ends are escaped, and a number outside a string must be one", async () => {
        const note = 'He said "hi", \\ and\nleft';
        const result = await run("Create order", { sku: "W-1", quantity: "2", note });
        ok(result);
        const sent = JSON.parse(last().body) as Record<string, unknown>;
        assert.deepEqual(sent, { customerId: "cust-staging-1", sku: "W-1", quantity: 2, note });
        const injected = await run("Create order", { sku: "W-1", quantity: '1, "admin": true', note: "x" });
        assert.match(injected.blocked ?? "", /quantity sits outside a string in a JSON body, so its value must be a number, true, false or null/);
        const inString = await run("Create order", { sku: 'x", "admin": "true', quantity: "1", note: "x" });
        ok(inString);
        assert.deepEqual(Object.keys(JSON.parse(last().body) as object), ["customerId", "sku", "quantity", "note"], "no field was added");
        assert.equal(h.api.requests.length, 2);
    });

    test("a write asks first and shows the request: the sign-in and the secrets by name, a generated value as a marker", async () => {
        const result = await run("Create order", { sku: "W-1", quantity: "2", note: "n" });
        assert.deepEqual(result.cls, { action: "Create order", environment: "staging", effect: "write" });
        const body = result.preview?.body ?? "";
        assert.match(body, /^Request: Create order \(acme\) in Staging \(staging\)\nSign-in: a bearer token, added by the tool\nMethod: POST\nURL: http:\/\/127\.0\.0\.1:\d+\/v1\/orders\n/);
        assert.match(body, /Idempotency-Key: \{\{\$uuid\}\}/);
        assert.match(body, /"sku": "W-1"/);
        assert.match(body, /Secrets, read when it is sent and never shown: token\nMade when it is sent: \$uuid$/);
        assert.ok(!body.includes(TOKENS.staging.value));
        assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{32}$/);
        ok(result);
    });

    test("a generated value is made when the request is sent: new each time, and the same preview still matches", async () => {
        const first = await run("Create order", { sku: "W-1", quantity: "1", note: "a" });
        const second = await run("Create order", { sku: "W-1", quantity: "1", note: "a" });
        ok(first);
        ok(second);
        const keys = h.api.requests.map((request) => request.headers["idempotency-key"]);
        assert.match(keys[0] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.notEqual(keys[0], keys[1]);
        assert.equal(first.preview?.fingerprint, second.preview?.fingerprint);
        const stamped = await h.call({ action: "run", request: "Create order", collection: "ledger", environment: "staging", variables: { sku: "W-1", quantity: "1" } });
        ok(stamped);
        assert.match((JSON.parse(last().body) as { createdAt: string }).createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test("a POST that the configuration calls a read runs at once, and a POST does not read unless it says so", async () => {
        const search = await run("Search orders", { text: 'red "shoes"' });
        assert.equal(search.cls?.effect, "read");
        assert.equal(search.preview, undefined);
        ok(search);
        assert.deepEqual(JSON.parse(last().body), { text: 'red "shoes"' });
        const create = await run("Cancel order", { orderId: "1" });
        assert.equal(create.cls?.effect, "write");
        assert.ok(create.preview);
    });

    test("the call's record carries the status", async () => {
        h.api.respond = () => ({ status: 201, body: "{}" });
        const result = await run("Create order", { sku: "W-1", quantity: "1", note: "n" });
        ok(result);
        assert.deepEqual(h.jig.facts.get(result.id), [{ status: 201 }]);
        assert.deepEqual(result.details, { request: "Create order", method: "POST", status: 201 });
    });

    test("an answer that is not a success is a result, with the status and the body", async () => {
        h.api.respond = () => ({ status: 404, body: '{"error":"no such order"}' });
        const text = ok(await run("Get order", { orderId: "7" }));
        assert.match(text, /-> HTTP 404 Not Found[\s\S]*"error": "no such order"/);
    });
});

describe("what the agent may give", () => {
    test("only variables the request uses: any other is refused with the ones it uses", async () => {
        const result = await run("Get order", { orderId: "1", colour: "red" });
        assert.match(result.blocked ?? "", /"colour" is not a variable of Get order; it uses baseUrl, apiVersion, orderId, token/);
        const generated = await run("Create order", { $guid: "x", sku: "a", quantity: "1", note: "n" });
        assert.match(generated.blocked ?? "", /"\$guid" is not a variable of Create order/);
        assert.equal(h.api.requests.length, 0);
    });

    test("never a secret, and never a variable that fills the sign-in", async () => {
        for (const [request, name] of [["Get order", "token"], ["Basic status", "serviceUser"], ["Basic status", "servicePassword"], ["Partner stock", "clientId"]] as const) {
            const result = await run(request, { [name]: "mine", orderId: "1" });
            assert.match(result.blocked ?? "", new RegExp(`${name} is a secret or fills the sign-in, so it comes from the environment and api\\.secrets, not from the call`), `${request} ${name}`);
        }
        assert.equal(h.api.requests.length, 0);
    });

    test("never the host: a variable in the host part of the address is refused", async () => {
        for (const value of [h.prod.origin, "https://evil.example.test", `${h.api.origin}`]) {
            const result = await run("Get order", { baseUrl: value, orderId: "1" });
            assert.match(result.blocked ?? "", /baseUrl would set the host of the request: the host comes from the environment, not from the call/, value);
        }
        assert.equal(h.api.requests.length, 0);
        assert.equal(h.prod.requests.length, 0);
    });

    test("a variable the agent gave overrides the environment and the collection for a value the request uses", async () => {
        ok(await run("Get order", { orderId: "1", apiVersion: "v2" }));
        assert.equal(last().path, "/v2/orders/1");
        ok(await run("Get order", { orderId: "1" }));
        assert.equal(last().path, "/v1/orders/1", "the collection's value when the agent gave none");
        const overridden = await h.call({ action: "run", request: "Create order", collection: "acme", environment: "Staging", variables: { customerId: "cust-9", sku: "s", quantity: "1", note: "n" } });
        ok(overridden);
        assert.equal((JSON.parse(last().body) as { customerId: string }).customerId, "cust-9");
    });

    test("a value must be text, a number or true or false, short, and without control characters", async () => {
        const tooLong = await run("Get order", { orderId: "a".repeat(2001) });
        assert.match(tooLong.blocked ?? "", /the value of orderId must be at most 2000 characters with no control characters/);
        const control = await run("Get order", { orderId: "a\u0000b" });
        assert.match(control.blocked ?? "", /no control characters/);
        const object = await h.call({ action: "run", request: "Get order", ...acme, variables: { orderId: { a: 1 } } });
        assert.match(object.blocked ?? "", /the value of orderId must be text, a number or true or false/);
        const number = await h.call({ action: "run", request: "Get order", ...acme, variables: { orderId: 42 } });
        ok(number);
        assert.equal(last().path, "/v1/orders/42");
    });

    test("a value in a header must be printable ASCII; in a GraphQL query, a plain token", async () => {
        const [graphql] = [await h.call({ action: "run", request: "Orders in a status", ...acme, variables: { status: "OPEN" } })];
        ok(graphql);
        assert.equal(JSON.parse(last().body).query, "{ orders(status: OPEN) { id } }");
        for (const status of ["OPEN) { id } mutation { drop", 'OPEN"', "OPEN\n{", "$x", "OPEN # c"]) {
            const injected = await h.call({ action: "run", request: "Orders in a status", ...acme, variables: { status } });
            assert.match(injected.blocked ?? "", /status goes into a GraphQL query, so its value must be letters, digits and _ \. : @ \+ - only; use a GraphQL variable/, status);
        }
        const variable = await h.call({ action: "run", request: "Orders by status", ...acme, variables: { status: 'OPEN") { x } "' } });
        ok(variable);
        assert.deepEqual(JSON.parse(last().body), {
            query: "query ($status: String!) {\n  orders(status: $status) { id total }\n}",
            variables: { status: 'OPEN") { x } "' },
        });
    });

    test("every variable that has no value is named at once", async () => {
        const result = await run("Create order", {});
        assert.match(result.blocked ?? "", /^jig-core could not decide: no value for sku, quantity, note in Staging: pass the ones the request uses in variables, or define them in the environment$/);
        assert.equal(h.api.requests.length, 0);
    });
});

describe("how each request signs in", () => {
    test("a bearer token from the collection: the token of the environment it runs in", async () => {
        ok(await run("Get order", { orderId: "1" }));
        assert.equal(last().headers.authorization, `Bearer ${TOKENS.staging.value}`);
        assert.deepEqual(h.jig.secretCalls, [TOKENS.staging.reference]);
    });

    test("a request that says noauth sends no authorization, and reads no secret", async () => {
        ok(await run("Health"));
        assert.equal(last().headers.authorization, undefined);
        assert.deepEqual(h.jig.secretCalls, []);
    });

    test("HTTP Basic: the user name from the environment, the password from its secret", async () => {
        // The password is a secret in both collections. The user name is one only where a file says so, or api.secrets does:
        // api.secrets is by variable name, so here it makes the name a secret in the Postman collection too.
        ok(await run("Basic status"));
        assert.equal(last().headers.authorization, basic(`${SERVICE_USER.value}:${SERVICE_PASSWORD.value}`));
        const file = await h.call({ action: "run", request: "Basic status", collection: "ledger", environment: "staging" });
        ok(file);
        assert.equal(last().headers.authorization, basic(`${SERVICE_USER.value}:${SERVICE_PASSWORD.value}`));
        h.configure(acmeSection(h, { secrets: { servicePassword: SERVICE_PASSWORD.reference } }));
        ok(await run("Basic status"));
        assert.equal(last().headers.authorization, basic(`svc-orders:${SERVICE_PASSWORD.value}`), "from the environment, when nothing makes it a secret");
    });

    test("an API key in a header", async () => {
        ok(await run("Key status"));
        assert.equal(last().headers["x-api-key"], API_KEY.value);
    });

    test("OAuth 2.0 client credentials: a token from the endpoint of the environment, sent as a Bearer token and kept", async () => {
        ok(await run("Partner stock"));
        assert.equal(h.auth.requests.length, 1);
        const login = h.auth.requests[0];
        assert.equal(login?.path, "/oauth/token");
        assert.equal(login?.headers.authorization, basic(`acme-orders-cli:${CLIENT_SECRET.value}`));
        assert.deepEqual(Object.fromEntries(new URLSearchParams(login?.body)), { grant_type: "client_credentials", client_id: "acme-orders-cli", scope: "stock.read" });
        assert.equal(last().headers.authorization, `Bearer ${h.issued[0]}`);
        ok(await run("Partner stock"));
        assert.equal(h.auth.requests.length, 1, "the token is kept");
    });

    test("a sign-in that is not sent is refused by its name, and nothing is sent", async () => {
        for (const [request, reason] of [
            ["Key in query", /cannot be sent: an API key sent in the query string/],
            ["Browser sign-in", /cannot be sent: OAuth 2\.0 with the grant "authorization_code" \(it needs a browser/],
            ["Signed export", /cannot be sent: the sign-in type "awsv4" is not sent/],
        ] as const) {
            const result = await run(request);
            assert.match(result.blocked ?? "", reason, request);
        }
        const digest = await h.call({ action: "run", request: "Digest status", collection: "ledger", environment: "staging" });
        assert.match(digest.blocked ?? "", /"Digest status" cannot be sent: Digest authentication is not sent/);
        assert.equal(h.api.requests.length + h.auth.requests.length, 0);
    });
});

describe("what is refused by name", () => {
    test("a request with a pre-request script, its own or its folder's, and the request still shows in list", async () => {
        for (const [request, where] of [["Rebuild index", "the folder Admin"], ["With its own script", "the request"]] as const) {
            const result = await run(request);
            assert.equal(result.blocked, `jig-core could not decide: "${request}" is refused: it has a pre-request script (${where}), and scripts never run`);
        }
        const ledger = await h.call({ action: "run", request: "Rebuild index", collection: "ledger", environment: "staging" });
        assert.match(ledger.blocked ?? "", /"Rebuild index" is refused: it has a pre-request script \(the request\)/);
        assert.equal(h.api.requests.length, 0);
    });

    test("a protocol that is not HTTP: a ws:// address, a WEBSOCKET or GRPC request, a profile that says so", async () => {
        const cases: Array<[string, string, RegExp]> = [
            ["acme", "Watch orders", /"Watch orders" cannot be sent: the address uses ws:\/\/, and only http and https are sent/],
            ["acme", "Stream profile", /"Stream profile" cannot be sent: its protocol profile \(protocol\) is not plain HTTP/],
            ["ledger", "Watch orders", /"Watch orders" cannot be sent: WEBSOCKET is not plain HTTP/],
            ["ledger", "Stream calls", /"Stream calls" cannot be sent: GRPC is not plain HTTP/],
        ];
        for (const [collection, request, reason] of cases) {
            const result = await h.call({ action: "run", request, collection, environment: collection === "acme" ? "Staging" : "staging" });
            assert.match(result.blocked ?? "", reason, request);
        }
    });

    test("a variable that needs code or another request's answer", async () => {
        const random = await run("Random number");
        assert.match(random.blocked ?? "", /"Random number" cannot be sent: \{\{\$randomInt\}\} is not supported/);
        const chained = await h.call({ action: "run", request: "Chained", collection: "ledger", environment: "staging" });
        assert.match(chained.blocked ?? "", /needs the answer of another request/);
    });
});

describe("the files of a collection", () => {
    test("a multipart form: the text field and the file, in one body whose boundary the request names", async () => {
        const result = await run("Upload receipt", { orderId: "123", note: "paid" });
        assert.match(result.preview?.body ?? "", /Body \(with a file, \d+ bytes\):\n--jig-api-[0-9a-f]{24}\r?\n/);
        assert.match(result.preview?.body ?? "", /<file receipt\.txt, 34 bytes, sha256 [0-9a-f]{12}>/);
        ok(result);
        const boundary = /boundary=(jig-api-[0-9a-f]{24})/.exec(last().headers["content-type"] ?? "")?.[1];
        assert.ok(boundary, last().headers["content-type"] ?? "no content type");
        assert.equal(last().body, [
            `--${boundary}`, 'Content-Disposition: form-data; name="note"', "", "paid",
            `--${boundary}`, 'Content-Disposition: form-data; name="receipt"; filename="receipt.txt"', "Content-Type: application/octet-stream", "", "receipt for order 123: 2 x widget\n",
            `--${boundary}--`, "",
        ].join("\r\n"));
    });

    test("the same form from a .http file, with the boundary and the part's type it names", async () => {
        const result = await h.call({ action: "run", request: "Upload receipt", collection: "ledger", environment: "staging", variables: { orderId: "5", note: "n1" } });
        ok(result);
        assert.equal(last().headers["content-type"], "multipart/form-data; boundary=ReceiptBoundary");
        assert.equal(last().body, [
            "--ReceiptBoundary", 'Content-Disposition: form-data; name="note"', "", "n1",
            "--ReceiptBoundary", 'Content-Disposition: form-data; name="receipt"; filename="receipt.txt"', "Content-Type: text/plain", "", "receipt for order 123: 2 x widget\n",
            "--ReceiptBoundary--", "",
        ].join("\r\n"));
    });

    test("a whole body from a file", async () => {
        ok(await run("Import orders"));
        assert.equal(last().method, "PUT");
        assert.equal(last().headers["content-type"], "text/csv");
        assert.equal(last().body, "receipt for order 123: 2 x widget\n");
        const file = await h.call({ action: "run", request: "Import orders", collection: "ledger", environment: "staging" });
        ok(file);
        assert.equal(last().body, "receipt for order 123: 2 x widget\n");
    });

    test("a form in the URL-encoded form: names and values are encoded, the agent's included", async () => {
        ok(await run("Place order (form)", { note: "a b&c=d" }));
        assert.equal(last().headers["content-type"], "application/x-www-form-urlencoded");
        assert.equal(last().body, "customer=cust-staging-1&note=a%20b%26c%3Dd");
        const file = await h.call({ action: "run", request: "Place order (form)", collection: "ledger", environment: "staging", variables: { note: "a b&c=d" } });
        ok(file);
        assert.equal(last().body, "customer=cust-staging-1&note=a%20b%26c%3Dd");
    });

    test("GraphQL from a .http file is a JSON post of the query and its variables", async () => {
        ok(await h.call({ action: "run", request: "Orders by status", collection: "ledger", environment: "staging", variables: { status: "OPEN" } }));
        assert.equal(last().method, "POST");
        assert.equal(last().headers["content-type"], "application/json");
        assert.deepEqual(JSON.parse(last().body), { query: "query ($status: String!) {\n  orders(status: $status) { id total }\n}", variables: { status: "OPEN" } });
    });
});

describe("the .http collection", () => {
    const ledger = (request: string, variables: Record<string, string> = {}) =>
        h.call({ action: "run", request, collection: "ledger", environment: "staging", variables });

    test("a request runs with its environment's host, the file's variables, and the private file's secret from its reference", async () => {
        ok(await ledger("List orders", { status: "open" }));
        assert.equal(last().target, "/v1/orders?status=open&limit=25");
        assert.equal(last().headers.authorization, `Bearer ${TOKENS.staging.value}`);
    });

    test("headers and generated values: a new id each time", async () => {
        const first = await ledger("Create order", { sku: "S", quantity: "3" });
        ok(first);
        assert.match(last().headers["idempotency-key"] ?? "", /^[0-9a-f-]{36}$/);
        assert.equal(last().headers["content-type"], "application/json");
        assert.equal((JSON.parse(last().body) as { quantity: number }).quantity, 3);
    });

    test("the environment decides the host: production goes to the production server", async () => {
        const result = await h.call({ action: "run", request: "Health", collection: "ledger", environment: "production" });
        ok(result);
        assert.equal(h.api.requests.length, 0);
        assert.equal(h.prod.requests.length, 1);
        assert.equal(h.prod.requests[0]?.path, "/health");
    });
});

describe("secrets", () => {
    test("come from api.secrets and from nowhere else: a secret with no reference stops the request", async () => {
        h.configure(acmeSection(h, { secrets: {} }));
        const result = await run("Get order", { orderId: "1" });
        assert.equal(result.blocked, "jig-core could not decide: token is a secret, but api.secrets has no reference for it in Staging");
        assert.equal(h.api.requests.length, 0);
        assert.deepEqual(h.jig.secretCalls, []);
    });

    test("a plain value for a secret in an export is never sent: with no reference the request is stopped, and with one the reference's value is used", async () => {
        h.configure(acmeSection(h, { secrets: { token: { Staging: TOKENS.staging.reference } } }));
        const stopped = await h.call({ action: "run", request: "Get order", ...acme, environment: "Production", variables: { orderId: "1" } });
        assert.equal(stopped.blocked, "jig-core could not decide: token is a secret, but api.secrets has no reference for it in Production");
        assert.equal(h.prod.requests.length, 0, "the plain value in the file was not used as a fallback");
        h.configure(acmeSection(h));
        ok(await h.call({ action: "run", request: "Get order", ...acme, environment: "Production", variables: { orderId: "1" } }));
        assert.equal(h.prod.requests[0]?.headers.authorization, `Bearer ${TOKENS.production.value}`);
        for (const sent of [...h.prod.requests, ...h.api.requests]) assert.ok(!JSON.stringify(sent).includes("plain-prod-token-0123456789"));
    });

    test("are bound to their environment: the staging token never goes to production", async () => {
        h.configure(acmeSection(h, { secrets: { token: { Staging: TOKENS.staging.reference, Production: TOKENS.production.reference } } }));
        ok(await run("Get order", { orderId: "1" }));
        ok(await h.call({ action: "run", request: "Get order", ...acme, environment: "Production", variables: { orderId: "1" } }));
        assert.equal(h.api.requests[0]?.headers.authorization, `Bearer ${TOKENS.staging.value}`);
        assert.equal(h.prod.requests[0]?.headers.authorization, `Bearer ${TOKENS.production.value}`);
        assert.ok(!JSON.stringify(h.prod.requests).includes(TOKENS.staging.value));
        assert.ok(!JSON.stringify(h.api.requests).includes(TOKENS.production.value));
    });

    test("a secret the server repeats is removed from the answer", async () => {
        h.api.respond = (request) => ({ body: JSON.stringify({ seen: request.headers.authorization, key: request.headers["x-api-key"] }) });
        const text = ok(await run("Get order", { orderId: "1" }));
        assert.ok(!text.includes(TOKENS.staging.value), text);
        assert.match(text, /"seen": "Bearer \[redacted\]"/);
        const key = ok(await run("Key status"));
        assert.ok(!key.includes(API_KEY.value));
        assert.match(key, /"key": "\[redacted\]"/);
    });

    test("a secret that cannot be read stops the request before anything is sent, without repeating the reference's value", async () => {
        h.jig.secrets.delete(TOKENS.staging.reference);
        const result = await run("Get order", { orderId: "1" });
        assert.equal(result.error?.message, 'api run "Get order": could not sign in (the secret could not be read: no such entry). Nothing was sent.');
        assert.equal(h.api.requests.length, 0);
    });
});

describe("limits", () => {
    test("the timeout of a run is a whole number of seconds from 1 to 120", async () => {
        for (const timeoutSec of [0, 121, 1.5, "30"]) {
            const result = await run("Get order", { orderId: "1" }, { timeoutSec });
            assert.match(result.blocked ?? "", /^jig-core could not decide: api: timeoutSec must be a whole number from 1 to 120/, String(timeoutSec));
        }
        h.configure(acmeSection(h, { timeoutSec: 45 }));
        const result = await run("Get order", { orderId: "1" });
        ok(result);
        assert.equal(h.api.requests.length, 1);
    });

    test("a body of text is at most 1 MiB, and a request with files at most 20 MiB", async () => {
        const file = path.join(h.dir, "big.postman_collection.json");
        const item = (name: string, size: number) => ({ name, request: { method: "POST", url: { raw: "{{baseUrl}}/b" }, body: { mode: "raw", raw: "x".repeat(size) } } });
        writeFileSync(file, JSON.stringify({ item: [item("Fits", 1024 * 1024), item("Too big", 1024 * 1024 + 1)] }));
        const env = path.join(h.dir, "big-env.json");
        writeFileSync(env, JSON.stringify({ values: [{ key: "baseUrl", value: h.api.origin, enabled: true }] }));
        h.configure({ collections: { big: { postman: file, environments: { Staging: env } } }, environments: { Staging: "staging" }, allowPlainLocal: true });
        ok(await h.call({ action: "run", request: "Fits", environment: "Staging" }));
        const result = await h.call({ action: "run", request: "Too big", environment: "Staging" });
        assert.equal(result.blocked, 'jig-core could not decide: the body of "Too big" is larger than 1 MiB');
    });

    test("show keeps back the value of a sign-in header that is written out in the file", async () => {
        const directory = path.join(h.dir, "literal");
        mkdirSync(directory);
        writeFileSync(path.join(directory, "r.http"), "### Literal\nGET https://a.example.test/\nAuthorization: Bearer literal-token-0123456789\nX-Plain: visible\n");
        h.configure({ collections: { literal: { http: directory } } });
        const text = ok(await h.call({ action: "show", request: "Literal" }));
        assert.ok(text.split("\n").includes("  Authorization: (secret)"));
        assert.ok(text.split("\n").includes("  X-Plain: visible"));
        assert.ok(!text.includes("literal-token-0123456789"));
    });
});
