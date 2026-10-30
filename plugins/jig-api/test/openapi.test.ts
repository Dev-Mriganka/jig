// The OpenAPI source: a spec read as saved requests, one for each operation with an operationId. The same spec is kept as YAML and as
// JSON, so every test of what is read runs on both. Nothing is sent. What a spec cannot say (the host of each environment) comes
// from the configuration, and a credential is a slot that api.secrets fills.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Collection, SavedRequest } from "../src/model.ts";
import { openapi } from "../src/sources/openapi.ts";
import type { OpenApiConfig } from "../src/sources/openapi.ts";
import { FIXTURES } from "./support/acme.ts";

const SERVERS = { Staging: "https://stg.example.test/v1/", Production: "https://prd.example.test/v1" };

/** Reads a spec file through the same two steps the plugin takes. */
function read(file: string, config: Record<string, unknown> = {}, name = "spec"): Collection {
    const errors: string[] = [];
    const checked = openapi.check({ openapi: file, environments: ["Staging", "Production", "Qa"], servers: SERVERS, ...config }, `api.collections.${name}`, errors);
    assert.deepEqual(errors, []);
    assert.ok(checked);
    return openapi.load(checked, name);
}

function checkErrors(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    assert.equal(openapi.check(config, "api.collections.spec", errors), undefined);
    return errors;
}

const fixtures = {} as Record<"yaml" | "json", Collection>;
let scratch: string;
before(() => {
    for (const format of ["yaml", "json"] as const) fixtures[format] = read(path.join(FIXTURES, "openapi", `acme-orders.openapi.${format}`));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-openapi-"));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function request(collection: Collection, name: string): SavedRequest {
    const found = collection.requests.find((candidate) => candidate.name === name);
    assert.ok(found, `no request named ${name}`);
    return found;
}

/** A spec written to a file of the test's own, as YAML text or as an object. */
function written(spec: unknown, file = "spec.yaml", config: Record<string, unknown> = {}): Collection {
    const target = path.join(scratch, `${fs.readdirSync(scratch).length}-${file}`);
    fs.writeFileSync(target, typeof spec === "string" ? spec : JSON.stringify(spec));
    return read(target, config);
}

const minimal = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ openapi: "3.1.0", info: { title: "T", version: "1" }, paths, ...extra });
const op = (operation: Record<string, unknown>): Record<string, unknown> => ({ operationId: "op", responses: {}, ...operation });

describe("the configuration", () => {
    test("a spec file, the environments it may run in, and the server of each", () => {
        const config: OpenApiConfig | undefined = openapi.check({ openapi: "/work/spec.yaml", environments: ["Staging", "Qa"], servers: { Staging: "https://stg.example.test/v1/" }, allowProductionReads: true }, "api.collections.s", []);
        assert.deepEqual(config && { ...config, servers: [...config.servers] }, {
            file: "/work/spec.yaml", environments: ["Staging", "Qa"], servers: [["Staging", "https://stg.example.test/v1"]], allowProductionReads: true,
        });
    });

    test("the list of environments is required: the spec is opt-in", () => {
        assert.deepEqual(checkErrors({ openapi: "/work/spec.yaml" }), ['api.collections.spec.environments: required, the list of environments this spec may run in, such as ["Staging"]']);
        assert.deepEqual(checkErrors({ openapi: "/work/spec.yaml", environments: [] }), ['api.collections.spec.environments: required, the list of environments this spec may run in, such as ["Staging"]']);
        assert.deepEqual(checkErrors({ openapi: "/work/spec.yaml", environments: ["A", "A"] }), ['api.collections.spec.environments: "A" is listed twice']);
        assert.deepEqual(checkErrors({ openapi: "/work/spec.yaml", environments: ["A\n"] }), ["api.collections.spec.environments: an environment name is text of 1 to 60 characters with no control characters"]);
    });

    test("a server is one address with no {variables}, and belongs to an environment of the list", () => {
        const base = { openapi: "/work/spec.yaml", environments: ["Staging"] };
        assert.deepEqual(checkErrors({ ...base, servers: { Prod: "https://p.example.test" } }), ["api.collections.spec.servers.Prod: is not in environments, so the spec never runs there"]);
        assert.deepEqual(checkErrors({ ...base, servers: { Staging: "https://{region}.example.test" } }), ["api.collections.spec.servers.Staging: must be one address with no {variables}: a host is not filled in from a call"]);
        assert.deepEqual(checkErrors({ ...base, servers: { Staging: "ftp://x.example.test" } }), ["api.collections.spec.servers.Staging: must start with https:// (plain http is only for this machine, and needs allowPlainLocal)"]);
        assert.deepEqual(checkErrors({ ...base, servers: { Staging: "https://u:p@x.example.test" } }), ["api.collections.spec.servers.Staging: must be a host and a base path only, with no user, query or fragment"]);
        assert.deepEqual(checkErrors({ ...base, servers: { Staging: "https://x.example.test/?a=1" } }), ["api.collections.spec.servers.Staging: must be a host and a base path only, with no user, query or fragment"]);
        assert.deepEqual(checkErrors({ ...base, servers: { Staging: "not an address" } }), ["api.collections.spec.servers.Staging: must be the address of a server, such as https://api.staging.example.com/v1"]);
        assert.deepEqual(checkErrors({ ...base, servers: ["https://x.example.test"] }), ["api.collections.spec.servers: must be an object that maps an environment name to the address of its server"]);
    });

    test("a path, the switch, and unknown fields", () => {
        assert.deepEqual(checkErrors({ openapi: "spec.yaml", environments: ["A"] }), ["api.collections.spec.openapi: must be an absolute path or start with ~/"]);
        assert.deepEqual(checkErrors({ openapi: 3, environments: ["A"] }), ["api.collections.spec.openapi: must be the path of an OpenAPI file, JSON or YAML"]);
        assert.deepEqual(checkErrors({ openapi: "/w/s.yaml", environments: ["A"], allowProductionReads: "yes" }), ["api.collections.spec.allowProductionReads: must be true or false"]);
        assert.deepEqual(checkErrors({ openapi: "/w/s.yaml", environments: ["A"], environment: ["B"] }), ["api.collections.spec.environment: unknown field"]);
    });
});

for (const format of ["yaml", "json"] as const) {
    const acme = (): Collection => fixtures[format];

    describe(`operations (${format})`, () => {
        test("each operation with an operationId is a request named by it, in the folder of its first tag", () => {
            const names = acme().requests.map((r) => [r.folder.join("/"), r.name, r.method]);
            assert.deepEqual(names.slice(0, 6), [
                ["Orders", "listOrders", "GET"], ["Orders", "createOrder", "POST"], ["Orders", "getOrder", "GET"], ["Orders", "cancelOrder", "DELETE"],
                ["Orders", "searchOrders", "POST"], ["Orders", "uploadReceipt", "POST"],
            ]);
            assert.equal(acme().requests.length, 19);
            assert.equal(request(acme(), "getHealth").folder[0], "Smoke");
            assert.equal(request(acme(), "getOrder").origin, `acme-orders.openapi.${format}: GET /orders/{orderId}`);
        });

        test("an operation without an operationId is listed by its method and path, refused, with a note", () => {
            const ping = request(acme(), "GET /legacy/ping");
            assert.equal(ping.unsupported, "it has no operationId, so it has no name to run it by: add one to the spec");
            assert.deepEqual(ping.notes, ["it has no operationId, so it is named by its method and path"]);
            assert.deepEqual(ping.folder, []);
        });

        test("the summary and the description are the docs, and a deprecated operation says so", () => {
            assert.equal(request(acme(), "listOrders").description, "List orders\n\nNewest first.");
            assert.deepEqual(request(acme(), "cancelOrder").notes, ["the spec marks it deprecated"]);
        });

        test("an operationId used twice refuses the later one, with a problem", () => {
            const twice = written(minimal({ "/a": { get: op({ operationId: "same" }) }, "/b": { get: op({ operationId: "same" }) } }));
            assert.equal(twice.requests[0]?.unsupported, undefined);
            assert.equal(twice.requests[1]?.unsupported, "its operationId same is used by another operation too");
            assert.equal(twice.problems[0]?.key, "paths./b.get.operationId");
        });

        test("a method that is not sent is refused by name", () => {
            const traced = written(minimal({ "/a": { trace: op({ operationId: "trace" }) } }));
            assert.match(traced.requests[0]?.unsupported ?? "", /the method TRACE is not sent/);
        });

        test("a spec that is not OpenAPI 3.0 or 3.1 is a problem and has no requests", () => {
            const swagger = written({ swagger: "2.0", paths: {} });
            assert.deepEqual(swagger.requests, []);
            assert.deepEqual(swagger.problems[0], { file: swagger.problems[0]?.file, key: "swagger", message: "is a Swagger 2.0 document: only OpenAPI 3.0 and 3.1 are read", level: "error" });
            assert.equal(written({ openapi: "4.0.0", paths: {} }).problems[0]?.message, "is 4.0.0: only OpenAPI 3.0 and 3.1 are read");
            assert.equal(written({ paths: {} }).problems[0]?.message, "is missing: this is not an OpenAPI document");
            assert.match(written("openapi: 3.0.3\npaths: [unclosed\n").problems[0]?.message ?? "", /^is not valid YAML \(\w+\)$/);
            assert.equal(written("{ not json", "bad.json").problems[0]?.message, "is not valid JSON");
        });

        test("3.0 specs are read like 3.1", () => {
            const three = written(minimal({ "/a/{id}": { get: op({ operationId: "get", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] }) } }, { openapi: "3.0.3" }));
            assert.equal(three.requests[0]?.url, "{{serverUrl}}/a/{{id}}");
        });

        test("a reference to another file is a problem, not followed", () => {
            const outside = written(minimal({ "/a": { get: op({ operationId: "get", parameters: [{ $ref: "other.yaml#/components/parameters/Id" }] }) } }));
            assert.deepEqual(outside.requests[0]?.variables, ["serverUrl"]);
            assert.match(outside.problems[0]?.message ?? "", /is a reference outside the document, which is not followed/);
        });
    });

    describe(`parameters (${format})`, () => {
        test("path parameters, from the path item or the operation, are required and are in the address", () => {
            const get = request(acme(), "getOrder");
            assert.equal(get.url, "{{serverUrl}}/orders/{{orderId}}");
            assert.deepEqual(get.optional, []);
            assert.equal(get.variableDocs?.get("orderId"), "path parameter, string; The order's id.");
        });

        test("query parameters are optional unless the spec requires them, and a query name keeps its brackets", () => {
            const list = request(acme(), "listOrders");
            assert.equal(list.url, "{{serverUrl}}/orders?status={{status}}&limit={{limit}}&filter[customer]={{filter[customer]}}");
            assert.deepEqual(list.optional, ["status", "limit", "filter[customer]", "X-Request-Id"]);
            assert.equal(list.variableDocs?.get("status"), "query parameter, string, one of open | shipped | cancelled; Only orders in this status.");
            assert.equal(list.variableDocs?.get("limit"), "query parameter, integer");
            const required = written(minimal({ "/a": { get: op({ parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] }) } }));
            assert.deepEqual(required.requests[0]?.optional, []);
        });

        test("a header parameter is a header of the request, filled by the agent", () => {
            assert.deepEqual(request(acme(), "listOrders").headers, [["X-Request-Id", "{{X-Request-Id}}"]]);
        });

        test("a parameter that is a list cannot be a variable: optional is left out with a note, required refuses the operation", () => {
            assert.ok(request(acme(), "listOrders").notes.includes("the optional query parameter labels is left out: it is a list, and cannot be filled from a variable"));
            const required = written(minimal({ "/a": { get: op({ parameters: [{ name: "ids", in: "query", required: true, schema: { type: "array", items: { type: "string" } } }] }) } }));
            assert.equal(required.requests[0]?.unsupported, "it needs the query parameter ids, which is a list and cannot be filled from a variable");
        });

        test("a header parameter that carries a credential is never the agent's: it is ignored or refuses the operation", () => {
            const items = request(acme(), "listItems");
            assert.equal(items.unsupported, "it needs the header X-Api-Key, which carries a credential: declare it as a security scheme so that it comes from api.secrets");
            assert.ok(items.notes.includes("the header parameter Authorization is ignored: a credential or a header the tool sets comes from the sign-in"));
            assert.ok(items.notes.includes("the header parameter Accept is ignored: a credential or a header the tool sets comes from the sign-in"));
            assert.deepEqual(items.headers, []);
            assert.doesNotMatch(JSON.stringify([...acme().requests, acme().problems]), /sk-live-EXAMPLE/, "an example value in the spec is never used");
        });

        test("a header parameter named like the key that the sign-in sends is the sign-in's", () => {
            const spec = minimal({ "/a": { get: op({ security: [{ key: [] }], parameters: [{ name: "X-Api-Key", in: "header", required: true, schema: { type: "string" } }] }) } }, {
                components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
            });
            const signed = written(spec);
            assert.equal(signed.requests[0]?.unsupported, undefined);
            assert.deepEqual(signed.requests[0]?.headers, []);
            assert.deepEqual(signed.requests[0]?.auth, { kind: "apiKey", name: "X-Api-Key", value: "{{key}}" });
        });

        test("a cookie parameter is left out when optional and refuses the operation when required", () => {
            assert.ok(request(acme(), "listItems").notes.includes("the optional cookie session is left out: no cookies are sent"));
            const cookie = written(minimal({ "/a": { get: op({ parameters: [{ name: "sid", in: "cookie", required: true, schema: { type: "string" } }] }) } }));
            assert.equal(cookie.requests[0]?.unsupported, "it needs the cookie sid, and no cookies are sent");
        });

        test("two parameters of one name are told apart by where they are, and so is a name the environment uses", () => {
            const add = request(acme(), "addNote");
            assert.equal(add.url, "{{serverUrl}}/customers/{{path.id}}/notes");
            assert.deepEqual(add.variables.slice(0, 3), ["serverUrl", "path.id", "body.id"]);
            const reserved = written(minimal({ "/a/{serverUrl}": { get: op({ parameters: [{ name: "serverUrl", in: "path", required: true, schema: { type: "string" } }] }) } }));
            assert.equal(reserved.requests[0]?.url, "{{serverUrl}}/a/{{path.serverUrl}}", "the agent can never give the variable that holds the host");
        });

        test("a name that could not stand in a {{variable}} is left out, in a parameter and in a body", () => {
            const braces = written(minimal({
                "/a": { post: op({
                    parameters: [{ name: "a{b}", in: "query", schema: { type: "string" } }],
                    requestBody: { content: { "application/json": { schema: { type: "object", properties: { "x}": { type: "string" }, ok: { type: "string" } } } } } },
                }) },
            }));
            assert.equal(braces.requests[0]?.url, "{{serverUrl}}/a");
            assert.deepEqual(braces.requests[0]?.variables, ["serverUrl", "ok"]);
            assert.ok(braces.requests[0]?.notes.includes("the optional property x} is left out: its name cannot be a variable"));
            assert.equal(braces.problems[0]?.message, "has no name that can be a variable, and is left out");
        });

        test("a path with a placeholder that no parameter describes refuses the operation", () => {
            const missing = written(minimal({ "/a/{id}": { get: op({}) } }));
            assert.equal(missing.requests[0]?.unsupported, "its path has {id}, which no path parameter describes");
        });

        test("a parameter described by content and not schema is read by its first media type", () => {
            const content = written(minimal({ "/a": { get: op({ parameters: [{ name: "n", in: "query", content: { "application/json": { schema: { type: "integer" } } } }] }) } }));
            assert.equal(content.requests[0]?.variableDocs?.get("n"), "query parameter, integer");
        });

        test("an operation's parameter replaces a path item's of the same name and place", () => {
            const both = written(minimal({
                "/a": { parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }], get: op({ parameters: [{ name: "q", in: "query", schema: { type: "integer" } }] }) },
            }));
            assert.deepEqual(both.requests[0]?.optional, ["q"]);
            assert.equal(both.requests[0]?.variableDocs?.get("q"), "query parameter, integer");
        });
    });

    describe(`the JSON body (${format})`, () => {
        test("each property is a variable, one to a line: strings in quotes, numbers and flags bare, objects nested", () => {
            const create = request(acme(), "createOrder");
            assert.equal(create.body?.kind, "json");
            assert.equal(create.body?.kind === "json" ? create.body.text : "", [
                "{",
                '  "customerId": "{{customerId}}",',
                '  "sku": "{{sku}}",',
                '  "quantity": {{quantity}},',
                '  "gift": {{gift}},',
                '  "note": "{{note}}",',
                '  "address": {',
                '    "street": "{{address.street}}",',
                '    "city": "{{address.city}}"',
                "  }",
                "}",
            ].join("\n"));
            assert.deepEqual(create.headers, [["Content-Type", "application/json"]]);
        });

        test("the properties the schema requires are required, and the rest are optional, objects included", () => {
            const create = request(acme(), "createOrder");
            assert.deepEqual(create.optional, ["gift", "note", "address.street", "address.city"]);
            assert.equal(create.variableDocs?.get("sku"), "body property sku, string; Stock keeping unit.");
            assert.equal(create.variableDocs?.get("quantity"), "body property quantity, integer");
        });

        test("a property that is a list is left out with a note when optional, and refuses the body when required", () => {
            assert.ok(request(acme(), "createOrder").notes.includes("the optional property lines is left out: it is a list, and cannot be filled from a variable"));
            const list = written(minimal({ "/a": { post: op({ requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } } } } } }) } }));
            assert.equal(list.requests[0]?.unsupported, "its JSON body needs the property items, which is a list and cannot be filled from a variable");
        });

        test("allOf is merged, a type list with null reads as its first type, and objects deeper than two levels are not followed", () => {
            const schema = {
                allOf: [{ type: "object", required: ["a"], properties: { a: { type: "string" } } }, { properties: { b: { type: ["integer", "null"] }, c: { properties: { d: { properties: { e: { properties: { f: { type: "string" } } } } } } } } }],
            };
            const merged = written(minimal({ "/a": { post: op({ requestBody: { content: { "application/json": { schema } } } }) } }));
            const text = merged.requests[0]?.body?.kind === "json" ? merged.requests[0].body.text : "";
            assert.equal(text, '{\n  "a": "{{a}}",\n  "b": {{b}}\n}', "c.d.e is three levels down, so nothing of c can be filled and c is left out");
            assert.ok(merged.requests[0]?.notes.some((note) => /the optional property c\.d\.e is left out: it is an object nested too deep/.test(note)), JSON.stringify(merged.requests[0]?.notes));
        });

        test("a body that is not an object with properties cannot be filled", () => {
            const required = written(minimal({ "/a": { post: op({ requestBody: { required: true, content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } } }) } }));
            assert.match(required.requests[0]?.unsupported ?? "", /^its JSON body has no properties to fill/);
            const optional = written(minimal({ "/a": { post: op({ requestBody: { content: { "application/json": { schema: { type: "object" } } } } }) } }));
            assert.equal(optional.requests[0]?.unsupported, undefined);
            assert.equal(optional.requests[0]?.body, undefined);
        });

        test("a vendor JSON type is JSON, and another type refuses a required body and is left out of an optional one", () => {
            const vendor = written(minimal({ "/a": { post: op({ requestBody: { content: { "application/vnd.acme+json": { schema: { type: "object", properties: { x: { type: "string" } } } } } } }) } }));
            assert.equal(vendor.requests[0]?.body?.kind, "json");
            assert.equal(request(acme(), "uploadReceipt").unsupported, "its request body is multipart/form-data, and only JSON bodies are filled from a spec");
            assert.equal(request(acme(), "importOrders").unsupported, "its request body is text/csv, and only JSON bodies are filled from a spec");
            const optional = written(minimal({ "/a": { post: op({ requestBody: { content: { "text/plain": { schema: { type: "string" } } } } }) } }));
            assert.equal(optional.requests[0]?.unsupported, undefined);
            assert.deepEqual(optional.requests[0]?.notes, ["its optional request body (text/plain) is left out: only JSON bodies are filled from a spec"]);
        });
    });

    describe(`sign-in (${format})`, () => {
        test("the spec's security applies to every operation that names none, and an empty list means none", () => {
            assert.deepEqual(request(acme(), "getOrder").auth, { kind: "bearer", token: "{{bearerAuth}}" });
            assert.deepEqual(acme().auth, { kind: "bearer", token: "{{bearerAuth}}" });
            assert.deepEqual(request(acme(), "getHealth").auth, { kind: "none" });
            assert.deepEqual(request(acme(), "getHealth").secrets, []);
        });

        test("every scheme is a slot named for it, declared secret in every environment, filled from api.secrets only", () => {
            assert.deepEqual(request(acme(), "getOrder").secrets, ["bearerAuth"]);
            assert.deepEqual(request(acme(), "getOrder").signsIn, ["bearerAuth"]);
            assert.deepEqual(request(acme(), "getPartnerStatus").auth, { kind: "basic", username: "{{basicAuth.username}}", password: "{{basicAuth.password}}" });
            assert.deepEqual(request(acme(), "getPartnerStatus").secrets, ["basicAuth.username", "basicAuth.password"]);
            assert.deepEqual(request(acme(), "getKeyStatus").auth, { kind: "apiKey", name: "X-Api-Key", value: "{{apiKeyAuth}}" });
            for (const environment of acme().environments.values()) {
                for (const slot of ["bearerAuth", "basicAuth.username", "apiKeyAuth", "clientCredentials.clientSecret", "passwordFlow.password"]) {
                    assert.deepEqual(environment.variables.get(slot), { value: "", secret: true }, slot);
                }
            }
        });

        test("OAuth 2.0 client credentials and password are sent, with the scopes of the requirement and a token address on the server", () => {
            assert.deepEqual(request(acme(), "getPartnerStock").auth, {
                kind: "oauth2", grant: "client_credentials", tokenUrl: "{{serverOrigin}}/oauth/token", clientId: "{{clientCredentials.clientId}}",
                clientSecret: "{{clientCredentials.clientSecret}}", scope: "stock.read", clientAuth: "header",
            });
            const password = request(acme(), "getPasswordStock").auth;
            assert.equal(password.kind === "oauth2" ? password.tokenUrl : "", "{{serverOrigin}}/v1/oauth/password-token", "an address on one of the spec's own servers follows the environment's server");
            assert.equal(password.kind === "oauth2" ? password.grant : "", "password");
        });

        test("a key in the query string, a flow that needs a browser and a token address on another host are refused, by name", () => {
            assert.match(request(acme(), "getKeyInQuery").unsupported ?? "", /^the security scheme queryKeyAuth: an API key sent in the query string/);
            assert.match(request(acme(), "getBrowserStock").unsupported ?? "", /^the security scheme browserFlow: OAuth 2\.0 with the flows authorizationCode \(they need a browser/);
            assert.match(request(acme(), "getOffsiteStock").unsupported ?? "", /^the security scheme offsiteToken: OAuth 2\.0 with its token address on auth\.other\.example\.test, which is not one of the servers of the spec/);
        });

        test("of several alternatives, the first that can be sent is used", () => {
            assert.deepEqual(request(acme(), "getEitherStock").auth, { kind: "apiKey", name: "X-Api-Key", value: "{{apiKeyAuth}}" });
        });

        test("two schemes needed at once, an unknown scheme and other types are refused, and an empty alternative means none", () => {
            const schemes = { a: { type: "http", scheme: "bearer" }, b: { type: "http", scheme: "digest" }, c: { type: "openIdConnect", openIdConnectUrl: "https://x.example.test/.well-known" }, d: { type: "mutualTLS" } };
            const spec = (security: unknown): Collection => written(minimal({ "/a": { get: op({ security }) } }, { components: { securitySchemes: schemes } }));
            assert.equal(spec([{ a: [], b: [] }]).requests[0]?.unsupported, "it needs several security schemes at once (a, b), and only one can be sent");
            assert.equal(spec([{ missing: [] }]).requests[0]?.unsupported, "it names the security scheme missing, which the spec does not define");
            assert.equal(spec([{ b: [] }]).requests[0]?.unsupported, 'the security scheme b: the HTTP scheme "digest" is not sent (bearer and basic are)');
            assert.equal(spec([{ c: [] }]).requests[0]?.unsupported, "the security scheme c: OpenID Connect is not sent (it needs a browser)");
            assert.equal(spec([{ d: [] }]).requests[0]?.unsupported, "the security scheme d: mutual TLS is not sent");
            assert.deepEqual(spec([{}, { b: [] }]).requests[0]?.auth, { kind: "none" });
            assert.equal(spec([{}, { b: [] }]).requests[0]?.unsupported, undefined);
        });
    });

    describe(`environments and servers (${format})`, () => {
        test("only the listed environments exist, each with the server mapped to it and its origin", () => {
            assert.deepEqual([...acme().environments.keys()], ["Staging", "Production", "Qa"]);
            const staging = acme().environments.get("Staging");
            assert.deepEqual([staging?.variables.get("serverUrl"), staging?.variables.get("serverOrigin")], [{ value: "https://stg.example.test/v1", secret: false }, { value: "https://stg.example.test", secret: false }]);
            assert.equal(staging?.unavailable, undefined);
        });

        test("an environment with no server is listed, has no host, and says what to add", () => {
            const qa = acme().environments.get("Qa");
            assert.equal(qa?.unavailable, 'no server is mapped to it: add "Qa" to servers in the configuration of spec');
            assert.deepEqual(qa?.variables.get("serverUrl"), { value: "", secret: false });
        });

        test("the spec's own servers are not hosts: only the configuration's are", () => {
            const hosts = JSON.stringify([...acme().environments.values()].map((e) => [...e.variables]));
            assert.doesNotMatch(hosts, /api\.acme|api\.staging/);
        });

        test("production reads are off unless the configuration allows them", () => {
            assert.equal(acme().productionReads, false);
            assert.equal(read(path.join(FIXTURES, "openapi", `acme-orders.openapi.${format}`), { allowProductionReads: true }).productionReads, true);
        });

        test("a spec that cannot be read leaves a collection with no requests and a problem, never a crash", () => {
            const missing = read(path.join(scratch, "nowhere.yaml"));
            assert.deepEqual(missing.requests, []);
            assert.deepEqual(missing.problems, [{ file: "nowhere.yaml", key: "", message: "no such file", level: "error" }]);
            assert.equal(missing.productionReads, false);
        });
    });
}
