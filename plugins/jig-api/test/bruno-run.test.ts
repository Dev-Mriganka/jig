// The Bruno source end to end: the example orders API in both of Bruno's formats, listed, shown and run against fake servers on
// this machine, with sign-in inherited from the collection and its folders, and secrets from api.secrets and nowhere else.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { API_KEY, CLIENT_SECRET, REPORT_KEY, SERVICE_PASSWORD, SERVICE_USER, TOKENS, useBruno } from "./support/acme.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());

const basic = (pair: string): string => `Basic ${Buffer.from(pair).toString("base64")}`;
const last = (server = h.api) => {
    const request = server.requests.at(-1);
    assert.ok(request, "the server received a request");
    return request;
};

for (const format of ["yaml", "bru"] as const) {
    describe(`Bruno (${format})`, () => {
        beforeEach(() => {
            h.reset();
            useBruno(h, format);
        });
        const run = (request: string, variables: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
            h.call({ action: "run", request, collection: "acme", environment: "Staging", variables, ...extra });

        test("list names the source, the size and the environments, and what each request needs", async () => {
            const text = ok(await h.call({ action: "list" }));
            assert.match(text, /^acme \(bruno, 28 requests; environments: Production, Staging\)$/m);
            assert.match(text, /^ {2}Orders\/Get order {2}GET \{\{baseUrl\}\}\/\{\{apiVersion\}\}\/orders\/\{\{orderId\}\} {2}\[reads; needs orderId\]$/m);
            assert.match(text, /^ {2}Orders\/Create order {2}POST .*\[writes; needs sku, quantity\]$/m);
            assert.match(text, /Admin\/Rebuild index .*\[writes; refused: it has a pre-request script \(the folder Admin\), and scripts never run\]/);
            assert.match(text, /Reports\/Watch orders .*refused: WEBSOCKET is not plain HTTP/);
            assert.match(text, /Auth styles\/Key in query .*refused: an API key sent in the query string/);
        });

        test("list reports the plain secret by file and key, without its value", async () => {
            const text = ok(await h.call({ action: "list", collection: "acme", text: "health" }));
            const ext = format === "yaml" ? "yml" : "bru";
            assert.match(text, new RegExp(`warning: environments/Production\\.${ext} token: is a secret with a value in the file\\. The value is ignored and never sent`));
            assert.doesNotMatch(text, /plain-prod-token/);
        });

        test("show prints the asserts as declared and not run, the documentation and where each variable comes from", async () => {
            const text = ok(await h.call({ action: "show", request: "Get order", collection: "acme", environment: "Staging" }));
            assert.match(text, /^Sign-in: a bearer token$/m);
            assert.match(text, /^Headers:\n {2}X-Acme-Client: jig-tests\n {2}Accept: application\/json$/m);
            assert.match(text, /^ {2}apiVersion: from the collection$/m);
            assert.match(text, /^ {2}orderId: needs a value \(pass it in variables\)$/m);
            assert.match(text, /^ {2}token: secret, set in api\.secrets$/m);
            assert.match(text, /^Asserts \(declared, not run\):\n {2}res\.status eq 200\n {2}res\.body\.id isDefined$/m);
            assert.match(text, /^Docs: Reads one order by its id\.$/m);
            assert.match(text, /^Note: its tests are ignored \(scripts never run\)$/m);
        });

        test("a read signs in with the collection's bearer token and carries the collection's and the folder's headers", async () => {
            const text = ok(await run("Get order", { orderId: "123" }));
            assert.match(text, /^GET \S+\/v1\/orders\/123 -> HTTP 200 OK/);
            const request = last();
            assert.equal(request.path, "/v1/orders/123");
            assert.equal(request.headers.authorization, `Bearer ${TOKENS.staging.value}`);
            assert.equal(request.headers["x-acme-client"], "jig-tests");
            assert.equal(request.headers.accept, "application/json");
        });

        test("in production the host and the token are production's, and a value typed into the file is never sent", async () => {
            ok(await h.call({ action: "run", request: "Get order", collection: "acme", environment: "Production", variables: { orderId: "9" } }));
            const request = last(h.prod);
            assert.equal(request.headers.authorization, `Bearer ${TOKENS.production.value}`);
            assert.equal(h.api.requests.length, 0, "staging was not touched");
            assert.doesNotMatch(JSON.stringify(h.prod.requests), /plain-prod-token/);
        });

        test("a write asks first, shows its exact request, and sends the JSON body with a new id", async () => {
            const result = await run("Create order", { customerId: "c-1", sku: "A-1", quantity: "3" });
            const text = ok(result);
            assert.equal(result.cls?.effect, "write");
            assert.equal(result.cls?.environment, "staging");
            assert.match(result.preview?.body ?? "", /^Method: POST\nURL: \S+\/v1\/orders$/m);
            assert.match(text, /-> HTTP 200 OK/);
            const request = last();
            assert.equal(request.headers["content-type"], "application/json");
            assert.match(request.headers["idempotency-key"] ?? "", /^[0-9a-f-]{36}$/);
            const body = JSON.parse(request.body) as Record<string, unknown>;
            assert.deepEqual([body.customerId, body.sku, body.quantity], ["c-1", "A-1", 3]);
            assert.match(String(body.createdAt), /^\d{4}-\d{2}-\d{2}T/);
        });

        test("a request that Bruno sends as a POST but that only reads is a read when the configuration says so", async () => {
            const result = await run("Search orders", { text: "red" });
            assert.equal(result.cls?.effect, "read");
            ok(result);
            assert.deepEqual(JSON.parse(last().body), { text: "red" });
        });

        test("a multipart form uploads the file from inside the collection, with its content type", async () => {
            ok(await run("Upload receipt", { orderId: "5", note: "late" }));
            const request = last();
            assert.match(request.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
            assert.match(request.body, /name="note"\r\n\r\nlate\r\n/);
            assert.match(request.body, /name="receipt"; filename="receipt\.txt"\r\nContent-Type: text\/plain\r\n\r\norder,qty\nA-1,2\n\r\n/);
        });

        test("a whole body can be a file, sent with its content type", async () => {
            ok(await run("Import orders"));
            assert.equal(last().headers["content-type"], "text/csv");
            assert.equal(last().body, "order,qty\nA-1,2\n");
        });

        test("a file outside the collection folder is refused before anything is sent", async () => {
            const result = await run("Upload outside", { orderId: "5" });
            assert.match(result.blocked ?? "", /the file "\.\.\/outside\.txt" is outside the collection's folder/);
            assert.equal(h.api.requests.length, 0);
        });

        test("a GraphQL request is a POST of its query and its variables", async () => {
            ok(await run("Orders by status", { status: "open" }));
            const request = last();
            assert.equal(request.method, "POST");
            const body = JSON.parse(request.body) as { query: string; variables: unknown };
            assert.match(body.query, /^query Orders\(\$status: String!\)/);
            assert.deepEqual(body.variables, { status: "open" });
        });

        test("a folder's own sign-in is used by its requests and by the folders inside it", async () => {
            ok(await run("Partner status"));
            assert.equal(last().headers.authorization, basic(`${SERVICE_USER.value}:${SERVICE_PASSWORD.value}`));
            ok(await run("Deep status"));
            assert.equal(last().headers.authorization, basic(`${SERVICE_USER.value}:${SERVICE_PASSWORD.value}`));
            ok(await run("Health"));
            assert.equal(last().headers.authorization, undefined, "a request can have none");
        });

        test("an API key goes in its header", async () => {
            ok(await run("Key status"));
            assert.equal(last().headers["x-api-key"], API_KEY.value);
        });

        test("OAuth 2.0 with client credentials fetches a token with the client signed in as Bruno says, and sends it as a Bearer token", async () => {
            ok(await run("Partner stock"));
            const login = last(h.auth);
            assert.equal(login.headers.authorization, basic(`acme-orders-cli:${CLIENT_SECRET.value}`));
            assert.match(login.body, /grant_type=client_credentials/);
            assert.match(login.body, /scope=stock\.read/);
            assert.equal(last().headers.authorization, `Bearer ${h.issued[0]}`);
        });

        test("OAuth 2.0 with a password puts the client in the form, as Bruno's default does", async () => {
            ok(await run("Password stock"));
            const login = last(h.auth);
            assert.equal(login.headers.authorization, undefined);
            assert.match(login.body, /grant_type=password/);
            assert.match(login.body, /client_id=acme-orders-cli/);
            assert.ok(login.body.includes(`client_secret=${encodeURIComponent(CLIENT_SECRET.value)}`));
        });

        test("{{process.env.NAME}} comes from api.secrets under that exact name, and from nowhere else", async () => {
            ok(await run("Report with a key"));
            assert.equal(last().headers["x-report-key"], REPORT_KEY.value);
            const section = h.jig.api.config.section("api") as { secrets: Record<string, unknown> };
            const { "process.env.ACME_REPORT_KEY": _removed, ...rest } = section.secrets;
            h.configure({ ...section, secrets: rest });
            const refused = await run("Report with a key");
            assert.equal(refused.blocked, "jig-core could not decide: process.env.ACME_REPORT_KEY is a secret, but api.secrets has no reference for it in Staging");
        });

        test("the agent cannot give a secret, or a variable that signs in", async () => {
            const secret = await run("Get order", { orderId: "1", token: "my-own-token" });
            assert.match(secret.blocked ?? "", /token is a secret or fills the sign-in/);
            const header = await run("Report with a key", { "process.env.ACME_REPORT_KEY": "x" });
            assert.match(header.blocked ?? "", /process\.env\.ACME_REPORT_KEY is a secret/);
            assert.equal(h.api.requests.length, 0);
        });

        test("every request that cannot be sent is refused by name, and nothing goes out", async () => {
            const refusals: Array<[string, RegExp]> = [
                ["Rebuild index", /"Rebuild index" is refused: it has a pre-request script \(the folder Admin\), and scripts never run/],
                ["With its own script", /is refused: it has a pre-request script \(the request\)/],
                ["Watch orders", /cannot be sent: WEBSOCKET is not plain HTTP, and only HTTP is sent/],
                ["Stream profile", /cannot be sent: GRPC is not plain HTTP/],
                ["Key in query", /cannot be sent: an API key sent in the query string/],
                ["Browser sign-in", /cannot be sent: OAuth 2\.0 with the grant "authorization_code"/],
                ["Signed export", /cannot be sent: the sign-in type AWS Signature v4 is not sent/],
                ["Digest status", /cannot be sent: the sign-in type Digest authentication is not sent/],
                ["Random number", /cannot be sent: \{\{\$randomInt\}\} is not supported/],
            ];
            for (const [name, message] of refusals) {
                const result = await run(name);
                assert.match(result.blocked ?? "", message, name);
            }
            assert.equal(h.api.requests.length + h.auth.requests.length, 0);
        });

        test("a request to a host that its environment does not have is refused", async () => {
            const result = await run("Other host");
            assert.match(result.blocked ?? "", /goes to api\.other\.example\.test, which is not a host of Staging/);
            assert.equal(h.api.requests.length, 0);
        });

        test("a folder runs in Bruno's order, one line per request", async () => {
            const text = ok(await h.call({ action: "run-folder", folder: "Smoke", collection: "acme", environment: "Staging" }));
            assert.match(text, /^Folder Smoke in Staging \(staging\): 2 of 2 ran, all answered 2xx\n1\. Health: GET \S+\/health -> HTTP 200 OK\n2\. Latest orders: GET \S+\/v1\/orders\?limit=1 -> HTTP 200 OK/);
            assert.equal(h.api.requests[0]?.headers.authorization, undefined);
            assert.equal(h.api.requests[1]?.headers.authorization, `Bearer ${TOKENS.staging.value}`);
        });

        test("a folder with one refused request is refused as a whole", async () => {
            const result = await h.call({ action: "run-folder", folder: "Admin", collection: "acme", environment: "Staging" });
            assert.match(result.blocked ?? "", /is refused: it has a pre-request script/);
        });

        test("the files are read again on every call", async () => {
            const before = ok(await h.call({ action: "list", collection: "acme", text: "health" }));
            assert.match(before, /Smoke\/Health/);
            const folder = (h.jig.api.config.section("api") as { collections: { acme: { bruno: string } } }).collections.acme.bruno;
            const file = `${folder}/smoke/health.${format === "yaml" ? "yml" : "bru"}`;
            const { readFileSync, writeFileSync } = await import("node:fs");
            writeFileSync(file, readFileSync(file, "utf8").replace(/Health/, "Liveness"));
            assert.match(ok(await h.call({ action: "list", collection: "acme", text: "liveness" })), /Smoke\/Liveness/);
        });
    });
}
