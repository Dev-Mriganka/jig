// The OpenAPI source end to end: a spec that runs only where the configuration opts in, against the server it maps to each
// environment, with optional parameters left out, required ones enforced, and every credential a slot filled from api.secrets.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { API_KEY, CLIENT_ID, CLIENT_SECRET, SERVICE_PASSWORD, SERVICE_USER, TOKENS, useOpenApi } from "./support/acme.ts";
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

for (const format of ["yaml", "json"] as const) {
    describe(`OpenAPI (${format})`, () => {
        beforeEach(() => {
            h.reset();
            useOpenApi(h, format);
        });
        const run = (request: string, variables: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
            h.call({ action: "run", request, collection: "acme", environment: "Staging", variables, ...extra });

        test("list names the spec's operations with what each needs and what it can take, and what stops one", async () => {
            const text = ok(await h.call({ action: "list" }));
            assert.match(text, /^acme \(openapi, 19 requests; environments: Staging\)$/m);
            assert.match(text, /^ {2}Orders\/listOrders {2}GET \{\{serverUrl\}\}\/orders\?status=.* {2}\[reads; optional status, limit, filter\[customer\], X-Request-Id\]$/m);
            assert.match(text, /^ {2}Orders\/getOrder {2}GET \{\{serverUrl\}\}\/orders\/\{\{orderId\}\} {2}\[reads; needs orderId\]$/m);
            assert.match(text, /^ {2}Orders\/createOrder {2}POST .*\[writes; needs customerId, sku, quantity; optional gift, note, address\.street, address\.city\]$/m);
            assert.match(text, /Orders\/uploadReceipt .*refused: its request body is multipart\/form-data, and only JSON bodies are filled from a spec/);
            assert.match(text, /GET \/legacy\/ping .*refused: it has no operationId/);
            assert.match(text, /Partner\/getKeyInQuery .*refused: the security scheme queryKeyAuth: an API key sent in the query string/);
        });

        test("show tells what each variable is, which are optional, and the docs", async () => {
            const text = ok(await h.call({ action: "show", request: "createOrder", collection: "acme", environment: "Staging" }));
            assert.match(text, /^Sign-in: a bearer token$/m);
            assert.match(text, /^ {2}sku: needs a value \(pass it in variables\) \[body property sku, string; Stock keeping unit\.\]$/m);
            assert.match(text, /^ {2}note: optional, left out when not given \(pass it in variables\) \[body property note, string\]$/m);
            assert.match(text, /^ {2}bearerAuth: secret, set in api\.secrets$/m);
            assert.match(text, /^Note: the optional property lines is left out: it is a list/m);
            assert.match(text, /^Docs: Create an order$/m);
        });

        test("a read goes to the server mapped to the environment, signed in with the slot's secret", async () => {
            const text = ok(await run("getOrder", { orderId: "123" }));
            assert.match(text, /^GET \S+\/v1\/orders\/123 -> HTTP 200 OK/);
            assert.equal(last().path, "/v1/orders/123");
            assert.equal(last().headers.authorization, `Bearer ${TOKENS.staging.value}`);
        });

        test("optional parameters nobody gave are left out of the address and the headers; those given are in", async () => {
            ok(await run("listOrders"));
            assert.equal(last().target, "/v1/orders");
            assert.equal(last().headers["x-request-id"], undefined);
            ok(await run("listOrders", { status: "open", "filter[customer]": "c 1", "X-Request-Id": "t-9" }));
            assert.equal(last().target, "/v1/orders?status=open&filter[customer]=c%201");
            assert.equal(last().headers["x-request-id"], "t-9");
        });

        test("a required parameter is enforced, and all that are missing are named", async () => {
            const result = await run("createOrder", { customerId: "c-1" });
            assert.equal(result.blocked, "jig-core could not decide: no value for sku, quantity in Staging: pass the ones the request uses in variables, or define them in the environment");
            assert.equal(h.api.requests.length, 0);
            assert.match((await run("getOrder")).blocked ?? "", /no value for orderId in Staging/);
        });

        test("a JSON body is built from the properties given: required ones always, optional ones only when given, objects only when something in them is", async () => {
            const minimal = await run("createOrder", { customerId: "c-1", sku: "A-1", quantity: "3" });
            const text = ok(minimal);
            assert.equal(minimal.cls?.effect, "write");
            assert.match(text, /-> HTTP 200 OK/);
            assert.deepEqual(JSON.parse(last().body), { customerId: "c-1", sku: "A-1", quantity: 3 });
            assert.equal(last().headers["content-type"], "application/json");
            ok(await run("createOrder", { customerId: "c-1", sku: "A-1", quantity: "3", gift: "true", note: 'say "hi"', "address.city": "Oslo" }));
            assert.deepEqual(JSON.parse(last().body), { customerId: "c-1", sku: "A-1", quantity: 3, gift: true, note: 'say "hi"', address: { city: "Oslo" } });
        });

        test("a value of the agent is written as a value: a number where a number is, escaped inside a string", async () => {
            const number = await run("createOrder", { customerId: "c-1", sku: "A-1", quantity: "3, \"admin\": true" });
            assert.match(number.blocked ?? "", /quantity sits outside a string in a JSON body, so its value must be a number, true, false or null/);
            ok(await run("createOrder", { customerId: 'x", "admin": "y', sku: "A-1", quantity: "1" }));
            assert.deepEqual(JSON.parse(last().body), { customerId: 'x", "admin": "y', sku: "A-1", quantity: 1 });
        });

        test("a path parameter is one path segment, whatever the agent writes", async () => {
            ok(await run("getOrder", { orderId: "a/b?c=d" }));
            assert.equal(last().path, "/v1/orders/a%2Fb%3Fc%3Dd");
            const dots = await run("getOrder", { orderId: ".." });
            assert.match(dots.blocked ?? "", /orderId cannot be \. or \.\. in an address/);
        });

        test("parameters of one name are told apart by where they are", async () => {
            ok(await run("addNote", { "path.id": "cust-1", "body.id": "note-7", note: "hello" }));
            assert.equal(last().path, "/v1/customers/cust-1/notes");
            assert.deepEqual(JSON.parse(last().body), { id: "note-7", note: "hello" });
        });

        test("the host is the environment's: the agent cannot give it, and the spec's own servers are not used", async () => {
            const result = await run("getHealth", { serverUrl: "https://evil.example.test/v1" });
            assert.match(result.blocked ?? "", /serverUrl would set the host of the request: the host comes from the environment, not from the call/);
            const spec = await run("getHealth", { serverOrigin: "https://evil.example.test" });
            assert.match(spec.blocked ?? "", /is not a variable of getHealth|would set the host/);
            ok(await run("getHealth"));
            assert.equal(last().path, "/v1/health");
            assert.equal(last().headers.authorization, undefined, "security: [] means no sign-in");
        });

        test("the agent cannot give a credential, and a slot with no reference in api.secrets stops the call", async () => {
            const given = await run("getOrder", { orderId: "1", bearerAuth: "my-own" });
            assert.match(given.blocked ?? "", /bearerAuth is a secret or fills the sign-in/);
            const section = h.jig.api.config.section("api") as { secrets: Record<string, unknown> };
            const { bearerAuth: _removed, ...rest } = section.secrets;
            h.configure({ ...section, secrets: rest });
            assert.equal((await run("getOrder", { orderId: "1" })).blocked, "jig-core could not decide: bearerAuth is a secret, but api.secrets has no reference for it in Staging");
        });

        test("basic, an API key in a header, and OAuth 2.0 client credentials sign in from their slots", async () => {
            ok(await run("getPartnerStatus"));
            assert.equal(last().headers.authorization, basic(`${SERVICE_USER.value}:${SERVICE_PASSWORD.value}`));
            ok(await run("getKeyStatus"));
            assert.equal(last().headers["x-api-key"], API_KEY.value);

            h.api.respond = (request) =>
                (request.path === "/oauth/token" ? { body: JSON.stringify({ access_token: "OAUTH-CANARY-TOKEN-1", token_type: "Bearer", expires_in: 3600 }) } : { body: '{"ok":true}' });
            ok(await run("getPartnerStock"));
            const [login, call] = h.api.requests.slice(-2);
            assert.equal(login?.path, "/oauth/token", "a relative token address is on the host of the server that the environment maps");
            assert.equal(login?.headers.authorization, basic(`${CLIENT_ID.value}:${CLIENT_SECRET.value}`));
            assert.match(login?.body ?? "", /grant_type=client_credentials/);
            assert.match(login?.body ?? "", /scope=stock\.read/);
            assert.equal(call?.headers.authorization, "Bearer OAUTH-CANARY-TOKEN-1");
        });

        test("OAuth 2.0 with a password, from a token address that the spec wrote with the production host", async () => {
            h.api.respond = (request) =>
                (request.path === "/v1/oauth/password-token" ? { body: JSON.stringify({ access_token: "OAUTH-CANARY-TOKEN-2", token_type: "Bearer" }) } : { body: '{"ok":true}' });
            ok(await run("getPasswordStock"));
            const login = h.api.requests.at(-2);
            assert.equal(login?.path, "/v1/oauth/password-token", "an address on a server of the spec follows the environment's server");
            assert.match(login?.body ?? "", /grant_type=password/);
            assert.match(login?.body ?? "", new RegExp(`username=${encodeURIComponent(SERVICE_USER.value)}`));
        });

        test("every operation that cannot be sent is refused by name, and nothing goes out", async () => {
            const refusals: Array<[string, RegExp]> = [
                ["uploadReceipt", /cannot be sent: its request body is multipart\/form-data/],
                ["importOrders", /cannot be sent: its request body is text\/csv/],
                ["listItems", /cannot be sent: it needs the header X-Api-Key, which carries a credential/],
                ["getKeyInQuery", /cannot be sent: the security scheme queryKeyAuth: an API key sent in the query string/],
                ["getBrowserStock", /cannot be sent: the security scheme browserFlow: OAuth 2\.0 with the flows authorizationCode/],
                ["getOffsiteStock", /cannot be sent: the security scheme offsiteToken: OAuth 2\.0 with its token address on auth\.other\.example\.test/],
                ["GET /legacy/ping", /cannot be sent: it has no operationId/],
            ];
            for (const [name, message] of refusals) assert.match((await run(name)).blocked ?? "", message, name);
            assert.equal(h.api.requests.length, 0);
        });

        test("a folder runs the operations of a tag, one line each", async () => {
            const text = ok(await h.call({ action: "run-folder", folder: "Smoke", collection: "acme", environment: "Staging" }));
            assert.match(text, /^Folder Smoke in Staging \(staging\): 1 of 1 ran, all answered 2xx\n1\. getHealth: GET \S+\/v1\/health -> HTTP 200 OK/);
        });

        test("a POST that only reads is a read when api.reads names its operation", async () => {
            h.configure({ ...(h.jig.api.config.section("api") as object), reads: ["searchOrders"] });
            const result = await run("searchOrders", { text: "red" });
            assert.equal(result.cls?.effect, "read");
            ok(result);
            assert.deepEqual(JSON.parse(last().body), { text: "red" });
        });
    });

    describe(`OpenAPI is opt-in (${format})`, () => {
        beforeEach(() => h.reset());
        const run = (environment: string, request = "getOrder") => h.call({ action: "run", request, collection: "acme", environment, variables: { orderId: "1" } });

        test("an environment the configuration does not list does not exist for the spec", async () => {
            useOpenApi(h, format, { environments: ["Staging"] });
            const result = await run("Production");
            assert.equal(result.blocked, 'jig-core could not decide: no environment named "Production"; acme has: Staging');
            assert.equal(h.prod.requests.length, 0);
        });

        test("production is refused for a read unless allowProductionReads is true, and says how to allow it", async () => {
            useOpenApi(h, format, { environments: ["Staging", "Production"] });
            const result = await run("Production");
            assert.equal(result.blocked, 'jig-core could not decide: "getOrder" does not run in Production, which counts as production: acme runs in production only with "allowProductionReads": true');
            assert.equal(h.prod.requests.length, 0);
        });

        test("with allowProductionReads a read runs in production, against production's server, with production's secret", async () => {
            useOpenApi(h, format, { environments: ["Staging", "Production"], allowProductionReads: true });
            const result = await run("Production");
            ok(result);
            assert.equal(result.cls?.environment, "production");
            assert.equal(last(h.prod).path, "/v1/orders/1");
            assert.equal(last(h.prod).headers.authorization, `Bearer ${TOKENS.production.value}`);
            assert.equal(h.api.requests.length, 0);
        });

        test("a write in production is still a write in production, which the floor denies whatever the configuration says", async () => {
            useOpenApi(h, format, { environments: ["Staging", "Production"], allowProductionReads: true });
            const result = await h.call({ action: "run", request: "createOrder", collection: "acme", environment: "Production", variables: { customerId: "c", sku: "s", quantity: "1" } });
            assert.deepEqual([result.cls?.effect, result.cls?.environment], ["write", "production"]);
        });

        test("an environment that api.environments does not map counts as production, so a forgotten mapping is stricter", async () => {
            useOpenApi(h, format, { environments: ["Staging", "Qa"], servers: { Staging: `${h.api.origin}/v1`, Qa: `${h.api.origin}/v1` } });
            const result = await run("Qa");
            assert.equal(result.blocked, 'jig-core could not decide: "getOrder" does not run in Qa, which counts as production because api.environments does not map "Qa": acme runs in production only with "allowProductionReads": true');
        });

        test("an environment with no server is refused, and the refusal says what to add; list shows it", async () => {
            const section = useOpenApi(h, format, { environments: ["Staging", "Dev"], servers: { Staging: `${h.api.origin}/v1` } });
            h.configure({ ...section, environments: { ...(section.environments as object), Dev: "dev" } });
            const result = await run("Dev");
            assert.equal(result.blocked, 'jig-core could not decide: "getOrder" cannot run in Dev: no server is mapped to it: add "Dev" to servers in the configuration of acme');
            assert.match(ok(await h.call({ action: "list", collection: "acme", text: "getOrder" })), /environments: Staging, Dev \(unavailable: no server is mapped to it: add "Dev" to servers in the configuration of acme\)/);
        });

        test("the servers differ by environment: each runs against its own host", async () => {
            useOpenApi(h, format, { environments: ["Staging", "Production"], allowProductionReads: true });
            ok(await run("Staging"));
            ok(await run("Production"));
            assert.equal(h.api.requests.length, 1);
            assert.equal(h.prod.requests.length, 1);
        });

        test("an ad-hoc call may not use the spec's collection in production", async () => {
            useOpenApi(h, format, { environments: ["Staging", "Production"], allowProductionReads: true });
            const result = await h.call({ action: "call", method: "GET", environment: "Production", collection: "acme", url: `${h.prod.origin}/v1/health` });
            assert.match(result.blocked ?? "", /call is never allowed in production/);
        });
    });
}
