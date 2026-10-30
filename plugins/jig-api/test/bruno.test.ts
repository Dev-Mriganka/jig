// The Bruno source: a collection folder in either of Bruno's formats, read into saved requests. The two fixtures describe the
// same example orders API, one in OpenCollection YAML and one in `.bru`, so every test of what is read runs on both. Nothing is
// sent and no script is run: a script is only noticed, so that the request can be refused by name.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Collection, SavedRequest } from "../src/model.ts";
import { bruno } from "../src/sources/bruno.ts";
import { FIXTURES } from "./support/acme.ts";

const FORMATS = ["yaml", "bru"] as const;
type Format = (typeof FORMATS)[number];

/** Reads a collection folder through the same two steps the plugin takes. */
function read(folder: string, name = "acme"): Collection {
    const errors: string[] = [];
    const config = bruno.check({ bruno: folder }, `api.collections.${name}`, errors);
    assert.deepEqual(errors, []);
    assert.ok(config);
    return bruno.load(config, name);
}

const fixtures = {} as Record<Format, Collection>;
let scratch: string;
before(() => {
    for (const format of FORMATS) fixtures[format] = read(path.join(FIXTURES, `bruno-${format}`));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-bruno-"));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function request(collection: Collection, name: string): SavedRequest {
    const found = collection.requests.find((candidate) => candidate.name === name);
    assert.ok(found, `no request named ${name}`);
    return found;
}

/** A collection written to a folder of the test's own: the files by path, with the root file of the format added. */
function written(format: Format, files: Record<string, string>): Collection {
    const folder = fs.mkdtempSync(path.join(scratch, "c-"));
    const root = format === "yaml" ? { "opencollection.yml": "opencollection: 1.0.0\ninfo:\n  name: T\n" } : { "bruno.json": '{"name":"T","type":"collection"}' };
    for (const [file, content] of Object.entries({ ...root, ...files })) {
        fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
        fs.writeFileSync(path.join(folder, file), content);
    }
    return read(folder, "t");
}

/** A request file in either format, from the same few facts. */
function requestFile(format: Format, parts: { name?: string; method?: string; url: string; auth?: string; body?: string; extra?: string }): { file: string; text: string } {
    const name = parts.name ?? "R";
    const method = parts.method ?? "GET";
    if (format === "yaml") {
        const body = parts.body === undefined ? "" : `  body:\n    type: json\n    data: ${JSON.stringify(parts.body)}\n`;
        return { file: `${name}.yml`, text: `info:\n  name: ${name}\n  type: http\nhttp:\n  method: ${method}\n  url: ${JSON.stringify(parts.url)}\n${parts.auth === undefined ? "" : `  auth: ${parts.auth}\n`}${body}${parts.extra ?? ""}` };
    }
    const body = parts.body === undefined ? "" : `\nbody:json {\n  ${parts.body}\n}\n`;
    return { file: `${name}.bru`, text: `meta {\n  name: ${name}\n  type: http\n}\n\n${method.toLowerCase()} {\n  url: ${parts.url}\n  body: ${parts.body === undefined ? "none" : "json"}\n  auth: ${parts.auth ?? "none"}\n}\n${body}${parts.extra ?? ""}` };
}

describe("which format a folder is in", () => {
    test("opencollection.yml is YAML and bruno.json is .bru; a folder with neither is a problem and has no requests", () => {
        assert.equal(fixtures.yaml.requests.length, 28);
        assert.equal(fixtures.bru.requests.length, 28);
        const neither = fs.mkdtempSync(path.join(scratch, "neither-"));
        fs.writeFileSync(path.join(neither, "get.bru"), "get {\n  url: https://a.example.test/\n}\n");
        const collection = read(neither);
        assert.deepEqual(collection.requests, []);
        assert.deepEqual(collection.problems, [{ file: ".", key: "", message: "is not a Bruno collection: it has neither opencollection.yml nor bruno.json", level: "error" }]);
    });

    test("a folder that does not exist is a problem, not a crash", () => {
        const collection = read(path.join(scratch, "missing"));
        assert.deepEqual(collection.problems, [{ file: ".", key: "", message: "the folder does not exist", level: "error" }]);
    });

    test("only the format of the root file is read, and a path is absolute or starts with ~/", () => {
        const mixed = written("yaml", {
            "a.yml": requestFile("yaml", { name: "In YAML", url: "https://a.example.test/" }).text,
            "b.bru": requestFile("bru", { name: "In bru", url: "https://a.example.test/" }).text,
        });
        assert.deepEqual(mixed.requests.map((r) => r.name), ["In YAML"]);
        const errors: string[] = [];
        assert.equal(bruno.check({ bruno: "work/bruno" }, "api.collections.t", errors), undefined);
        assert.equal(bruno.check({ bruno: "/work/bruno", extra: 1 }, "api.collections.t", errors), undefined);
        assert.deepEqual(errors, ["api.collections.t.bruno: must be an absolute path or start with ~/", "api.collections.t.extra: unknown field"]);
    });
});

for (const format of FORMATS) {
    const acme = (): Collection => fixtures[format];

    describe(`folders and requests (${format})`, () => {
        test("every request is found with its folder path and name, in Bruno's order: by seq, then by name", () => {
            const paths = acme().requests.map((r) => [...r.folder, r.name].join("/"));
            assert.deepEqual(paths.slice(0, 4), ["Orders/Get order", "Orders/List orders", "Orders/Create order", "Orders/Search orders"]);
            assert.deepEqual([...new Set(acme().requests.map((r) => r.folder.join("/")))], ["Orders", "Smoke", "Partner/Nested", "Partner", "Admin", "Auth styles", "Reports"]);
            assert.ok(acme().requests.every((r) => r.collection === "acme"));
        });

        test("a folder is named by its file, not its directory, and nests", () => {
            assert.deepEqual(request(acme(), "Deep status").folder, ["Partner", "Nested"]);
            assert.deepEqual(request(acme(), "Key status").folder, ["Auth styles"]);
            const ext = format === "yaml" ? "yml" : "bru";
            assert.equal(request(acme(), "Get order").origin, `orders/get-order.${ext}`);
        });

        test("documentation is kept, and the declared asserts are listed, not run", () => {
            const get = request(acme(), "Get order");
            assert.equal(get.description, "Reads one order by its id.");
            assert.deepEqual(get.assertions, ["res.status eq 200", "res.body.id isDefined"]);
            assert.equal(request(acme(), "Health").assertions, undefined);
        });

        test("the method defaults sensibly: GraphQL is a POST", () => {
            assert.equal(request(acme(), "Orders by status").method, "POST");
            assert.equal(request(acme(), "Cancel order").method, "DELETE");
        });
    });

    describe(`the address (${format})`, () => {
        test("a path parameter with no value becomes a variable of its name, and the query string stays as written", () => {
            assert.equal(request(acme(), "Get order").url, "{{baseUrl}}/{{apiVersion}}/orders/{{orderId}}");
            assert.deepEqual(request(acme(), "Get order").variables, ["baseUrl", "apiVersion", "orderId", "token"]);
            assert.equal(request(acme(), "List orders").url, "{{baseUrl}}/{{apiVersion}}/orders?status={{status}}&limit=10");
        });

        test("a path parameter with a value takes it, and a colon in the port is not a parameter", () => {
            const collection = written(format, {
                ...(format === "yaml"
                    ? { "p.yml": "info:\n  name: P\n  type: http\nhttp:\n  method: GET\n  url: https://h.example.test:8443/users/:id/items/:item\n  params:\n    - name: id\n      value: '42'\n      type: path\n    - name: item\n      value: '{{itemId}}'\n      type: path\n" }
                    : { "p.bru": "meta {\n  name: P\n}\n\nget {\n  url: https://h.example.test:8443/users/:id/items/:item\n}\n\nparams:path {\n  id: 42\n  item: {{itemId}}\n}\n" }),
            });
            assert.equal(collection.requests[0]?.url, "https://h.example.test:8443/users/42/items/{{itemId}}");
        });

        test("never carries a fragment, which is not sent", () => {
            const collection = written(format, { [requestFile(format, { url: "https://a.example.test/x#top" }).file]: requestFile(format, { url: "https://a.example.test/x#top" }).text });
            assert.equal(collection.requests[0]?.url, "https://a.example.test/x");
        });
    });

    describe(`headers, bodies and variables (${format})`, () => {
        test("the collection's headers, the folder's and the request's are merged, and the request's replaces the same header of the others", () => {
            const names = (name: string): string[] => request(acme(), name).headers.map(([header]) => header);
            assert.deepEqual(names("Get order"), ["X-Acme-Client", "Accept"]);
            assert.deepEqual(names("Create order"), ["X-Acme-Client", "Accept", "Idempotency-Key", "Content-Type"]);
            assert.deepEqual(names("Health"), ["X-Acme-Client"], "a folder's header does not reach another folder");
        });

        test("a header of the request replaces one of the same name above it, whatever the case", () => {
            const collection = written(format, {
                ...(format === "yaml"
                    ? { "opencollection.yml": "opencollection: 1.0.0\nrequest:\n  headers:\n    - name: X-Team\n      value: collection\n", "r.yml": "info:\n  name: R\n  type: http\nhttp:\n  method: GET\n  url: https://a.example.test/\n  headers:\n    - name: x-team\n      value: request\n" }
                    : { "collection.bru": "headers {\n  X-Team: collection\n}\n", "r.bru": "meta {\n  name: R\n}\n\nget {\n  url: https://a.example.test/\n}\n\nheaders {\n  x-team: request\n  ~X-Off: no\n}\n" }),
            });
            assert.deepEqual(collection.requests[0]?.headers, [["x-team", "request"]]);
        });

        test("a JSON body is JSON and gets the content type Bruno sends; its variables are listed with the generated ones", () => {
            const create = request(acme(), "Create order");
            assert.equal(create.body?.kind, "json");
            assert.match(create.body?.kind === "json" ? create.body.text : "", /"customerId": "\{\{customerId\}\}"/);
            assert.deepEqual(create.headers.at(-1), ["Content-Type", "application/json"]);
            assert.deepEqual(create.variables, ["baseUrl", "apiVersion", "$guid", "customerId", "sku", "quantity", "$isoTimestamp", "token"]);
        });

        test("a URL-encoded form leaves out a field that is switched off", () => {
            const form = request(acme(), "Place order (form)").body;
            assert.equal(form?.kind, "form");
            if (form?.kind !== "form") return;
            assert.equal(form.encoding, "urlencoded");
            assert.deepEqual(form.fields.map((field) => [field.name, field.kind === "text" ? field.value : ""]), [["customer", "{{customerId}}"], ["note", "{{note}}"]]);
        });

        test("a multipart form has text and file fields, and a file keeps its content type", () => {
            const form = request(acme(), "Upload receipt").body;
            assert.equal(form?.kind, "form");
            if (form?.kind !== "form") return;
            assert.equal(form.encoding, "multipart");
            assert.deepEqual(form.fields, [
                { kind: "text", name: "note", value: "{{note}}" },
                { kind: "file", name: "receipt", file: { path: "files/receipt.txt" }, contentType: "text/plain" },
            ]);
            assert.equal(request(acme(), "Upload receipt").headers.some(([name]) => name === "Content-Type"), false, "the boundary is added when it is sent");
        });

        test("a whole body can be a file, with its content type", () => {
            const imported = request(acme(), "Import orders");
            assert.deepEqual(imported.body, { kind: "file", file: { path: "files/receipt.txt" } });
            assert.deepEqual(imported.headers.at(-1), ["Content-Type", "text/csv"]);
        });

        test("a GraphQL request is a POST of its query and its variables", () => {
            const graphql = request(acme(), "Orders by status");
            assert.equal(graphql.body?.kind, "graphql");
            if (graphql.body?.kind !== "graphql") return;
            assert.match(graphql.body.query, /^query Orders\(\$status: String!\) \{\n {2}orders\(status: \$status\) \{ id total \}\n\}$/);
            assert.deepEqual(JSON.parse(graphql.body.variables ?? ""), { status: "{{status}}" });
            assert.deepEqual(graphql.headers.at(-1), ["Content-Type", "application/json"]);
        });

        test("text and XML bodies are raw text with their content types", () => {
            const bodies = written(format, format === "yaml"
                ? {
                    "t.yml": "info:\n  name: T\n  type: http\nhttp:\n  method: POST\n  url: https://a.example.test/t\n  body:\n    type: text\n    data: hello {{name}}\n",
                    "x.yml": "info:\n  name: X\n  type: http\nhttp:\n  method: POST\n  url: https://a.example.test/x\n  body:\n    type: xml\n    data: <a>{{name}}</a>\n",
                }
                : {
                    "t.bru": "meta {\n  name: T\n}\n\npost {\n  url: https://a.example.test/t\n  body: text\n}\n\nbody:text {\n  hello {{name}}\n}\n",
                    "x.bru": "meta {\n  name: X\n}\n\npost {\n  url: https://a.example.test/x\n  body: xml\n}\n\nbody:xml {\n  <a>{{name}}</a>\n}\n",
                });
            assert.deepEqual(request(bodies, "T").body, { kind: "raw", text: "hello {{name}}", language: "text" });
            assert.deepEqual(request(bodies, "X").body, { kind: "raw", text: "<a>{{name}}</a>", language: "xml" });
            assert.deepEqual(request(bodies, "X").headers, [["Content-Type", "application/xml"]]);
        });

        test("a body type that is not sent refuses the request by name", () => {
            const sparql = written(format, format === "yaml"
                ? { "s.yml": "info:\n  name: S\n  type: http\nhttp:\n  method: POST\n  url: https://a.example.test/s\n  body:\n    type: sparql\n    data: SELECT 1\n" }
                : { "s.bru": "meta {\n  name: S\n}\n\npost {\n  url: https://a.example.test/s\n  body: sparql\n}\n\nbody:sparql {\n  SELECT 1\n}\n" });
            assert.match(request(sparql, "S").unsupported ?? "", /the body type "sparql" is not sent/);
        });

        test("variables of the collection are the weakest values, and a switched-off variable is not a value", () => {
            assert.deepEqual([...acme().variables], [["apiVersion", { value: "v1", secret: false }]]);
        });

        test("variables of a folder and of a request are the request's own values; a local variable loses its @", () => {
            const collection = written(format, format === "yaml"
                ? {
                    "f/folder.yml": "info:\n  name: F\n  type: folder\nrequest:\n  variables:\n    - name: region\n      value: eu\n",
                    "f/r.yml": "info:\n  name: R\n  type: http\nhttp:\n  method: GET\n  url: https://a.example.test/{{region}}/{{id}}\nruntime:\n  variables:\n    - name: id\n      value: '7'\n    - name: off\n      value: x\n      disabled: true\n",
                }
                : {
                    "f/folder.bru": "meta {\n  name: F\n}\n\nvars:pre-request {\n  region: eu\n}\n",
                    "f/r.bru": "meta {\n  name: R\n}\n\nget {\n  url: https://a.example.test/{{region}}/{{id}}\n}\n\nvars:pre-request {\n  @id: 7\n  ~off: x\n}\n",
                });
            assert.deepEqual([...(collection.requests[0]?.defaults ?? [])], [["region", "eu"], ["id", "7"]]);
        });
    });

    describe(`sign-in (${format})`, () => {
        test("a request that inherits takes the collection's sign-in; a folder's own sign-in replaces it, and a request can have none", () => {
            assert.deepEqual(request(acme(), "Get order").auth, { kind: "bearer", token: "{{token}}" });
            assert.deepEqual(request(acme(), "Latest orders").auth, { kind: "bearer", token: "{{token}}" });
            assert.deepEqual(request(acme(), "Partner status").auth, { kind: "basic", username: "{{serviceUser}}", password: "{{servicePassword}}" });
            assert.deepEqual(request(acme(), "Health").auth, { kind: "none" });
        });

        test("a folder inside a folder inherits from the nearest folder that sets one", () => {
            assert.deepEqual(request(acme(), "Deep status").auth, { kind: "basic", username: "{{serviceUser}}", password: "{{servicePassword}}" });
        });

        test("the variables of a sign-in fill it: the agent never gives them", () => {
            assert.deepEqual(request(acme(), "Get order").signsIn, ["token"]);
            assert.deepEqual(request(acme(), "Partner status").signsIn, ["serviceUser", "servicePassword"]);
            assert.deepEqual(request(acme(), "Health").signsIn, []);
        });

        test("an API key goes in a header", () => {
            assert.deepEqual(request(acme(), "Key status").auth, { kind: "apiKey", name: "X-Api-Key", value: "{{apiKey}}" });
        });

        test("OAuth 2.0 with client credentials or a password is sent, with Bruno's own place for the client's credentials", () => {
            assert.deepEqual(request(acme(), "Partner stock").auth, {
                kind: "oauth2", grant: "client_credentials", tokenUrl: "{{authUrl}}/oauth/token", clientId: "{{clientId}}", clientSecret: "{{clientSecret}}",
                scope: "stock.read", clientAuth: "header",
            });
            assert.deepEqual(request(acme(), "Password stock").auth, {
                kind: "oauth2", grant: "password", tokenUrl: "{{authUrl}}/oauth/token", clientId: "{{clientId}}", clientSecret: "{{clientSecret}}",
                username: "{{serviceUser}}", password: "{{servicePassword}}", scope: "stock.read", clientAuth: "body",
            });
        });

        test("every other sign-in is refused, by name", () => {
            assert.match(request(acme(), "Key in query").unsupported ?? "", /^an API key sent in the query string \(an address ends up in logs/);
            assert.match(request(acme(), "Browser sign-in").unsupported ?? "", /^OAuth 2\.0 with the grant "authorization_code" \(it needs a browser/);
            assert.match(request(acme(), "Signed export").unsupported ?? "", /^the sign-in type AWS Signature v4 is not sent/);
            assert.match(request(acme(), "Digest status").unsupported ?? "", /^the sign-in type Digest authentication is not sent/);
        });

        test("a refused sign-in of a folder refuses only the requests that inherit it", () => {
            const collection = written(format, format === "yaml"
                ? {
                    "f/folder.yml": "info:\n  name: F\n  type: folder\nrequest:\n  auth:\n    type: ntlm\n",
                    "f/inherits.yml": requestFile("yaml", { name: "Inherits", url: "https://a.example.test/", auth: "inherit" }).text,
                    "f/own.yml": requestFile("yaml", { name: "Own", url: "https://a.example.test/", auth: "none" }).text,
                }
                : {
                    "f/folder.bru": "meta {\n  name: F\n}\n\nauth {\n  mode: ntlm\n}\n",
                    "f/inherits.bru": requestFile("bru", { name: "Inherits", url: "https://a.example.test/", auth: "inherit" }).text,
                    "f/own.bru": requestFile("bru", { name: "Own", url: "https://a.example.test/", auth: "none" }).text,
                });
            assert.match(request(collection, "Inherits").unsupported ?? "", /the sign-in type NTLM authentication is not sent/);
            assert.equal(request(collection, "Own").unsupported, undefined);
        });

        test("OAuth 2.0 with the token in the query string, or a header prefix other than Bearer, is refused", () => {
            const odd = written(format, format === "yaml"
                ? {
                    "q.yml": "info:\n  name: Q\n  type: http\nhttp:\n  method: GET\n  url: https://a.example.test/\n  auth:\n    type: oauth2\n    flow: client_credentials\n    accessTokenUrl: https://t.example.test/token\n    tokenConfig:\n      placement:\n        query: access_token\n",
                    "p.yml": "info:\n  name: P\n  type: http\nhttp:\n  method: GET\n  url: https://a.example.test/\n  auth:\n    type: oauth2\n    flow: client_credentials\n    accessTokenUrl: https://t.example.test/token\n    tokenConfig:\n      placement:\n        header: Token\n",
                }
                : {
                    "q.bru": "meta {\n  name: Q\n}\n\nget {\n  url: https://a.example.test/\n  auth: oauth2\n}\n\nauth:oauth2 {\n  grant_type: client_credentials\n  access_token_url: https://t.example.test/token\n  token_placement: url\n}\n",
                    "p.bru": "meta {\n  name: P\n}\n\nget {\n  url: https://a.example.test/\n  auth: oauth2\n}\n\nauth:oauth2 {\n  grant_type: client_credentials\n  access_token_url: https://t.example.test/token\n  token_placement: header\n  token_header_prefix: Token\n}\n",
                });
            assert.match(request(odd, "Q").unsupported ?? "", /the token in the query string/);
            assert.match(request(odd, "P").unsupported ?? "", /the header prefix "Token" \(only Bearer is sent\)/);
        });
    });

    describe(`scripts, protocols and what is ignored (${format})`, () => {
        test("a pre-request script refuses the request, and says whose it is: the request's own or a folder's", () => {
            assert.deepEqual(request(acme(), "With its own script").scripts, { prerequest: true, where: "the request" });
            assert.deepEqual(request(acme(), "Rebuild index").scripts, { prerequest: true, where: "the folder Admin" });
            assert.deepEqual(request(acme(), "Get order").scripts, { prerequest: false });
        });

        test("the collection's pre-request script refuses every request", () => {
            const collection = written(format, format === "yaml"
                ? { "opencollection.yml": "opencollection: 1.0.0\nrequest:\n  scripts:\n    - type: before-request\n      code: 'bru.setVar(\"a\", 1)'\n", "r.yml": requestFile("yaml", { url: "https://a.example.test/" }).text }
                : { "collection.bru": "script:pre-request {\n  bru.setVar(\"a\", 1)\n}\n", "r.bru": requestFile("bru", { url: "https://a.example.test/" }).text });
            assert.deepEqual(collection.requests[0]?.scripts, { prerequest: true, where: "the collection" });
        });

        test("a script with nothing in it is no script", () => {
            const blank = written(format, format === "yaml"
                ? { "r.yml": requestFile("yaml", { url: "https://a.example.test/", extra: "runtime:\n  scripts:\n    - type: before-request\n      code: ' '\n" }).text }
                : { "r.bru": requestFile("bru", { url: "https://a.example.test/", extra: "\nscript:pre-request {\n  \n}\n" }).text });
            assert.equal(blank.requests[0]?.scripts.prerequest, false);
        });

        test("tests and post-response scripts and variables are ignored, with a note", () => {
            assert.deepEqual(request(acme(), "Get order").notes, ["its tests are ignored (scripts never run)"]);
            const after = written(format, format === "yaml"
                ? { "r.yml": requestFile("yaml", { url: "https://a.example.test/", extra: "runtime:\n  scripts:\n    - type: after-response\n      code: bru.setVar('a', 1)\n  actions:\n    - type: set-variable\n      phase: after-response\n      selector:\n        expression: res.body.id\n        method: jsonq\n      variable:\n        name: id\n        scope: runtime\nsettings:\n  followRedirects: true\n" }).text }
                : { "r.bru": requestFile("bru", { url: "https://a.example.test/", extra: "\nvars:post-response {\n  id: res.body.id\n}\n\nscript:post-response {\n  bru.setVar('a', 1)\n}\n\nsettings {\n  followRedirects: true\n}\n" }).text });
            assert.deepEqual(after.requests[0]?.notes, [
                "its post-response script is ignored (scripts never run)",
                "its post-response variables are not set (nothing reads the answer)",
                "followRedirects is ignored: redirects are never followed",
            ]);
            assert.equal(after.requests[0]?.scripts.prerequest, false);
        });

        test("WebSocket and gRPC requests are listed and refused as unsupported, not skipped", () => {
            assert.equal(request(acme(), "Watch orders").method, "WEBSOCKET");
            assert.equal(request(acme(), "Watch orders").unsupported, "WEBSOCKET is not plain HTTP, and only HTTP is sent");
            assert.equal(request(acme(), "Stream profile").unsupported, "GRPC is not plain HTTP, and only HTTP is sent");
        });

        test("a method that is not sent, and a variable that needs code, are refused by name", () => {
            const traced = written(format, { [requestFile(format, { method: "TRACE", url: "https://a.example.test/" }).file]: requestFile(format, { method: "TRACE", url: "https://a.example.test/" }).text });
            assert.equal(traced.requests[0]?.unsupported, "the method TRACE is not sent (GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE are)");
            assert.equal(request(acme(), "Random number").unsupported, "{{$randomInt}} is not supported (only $uuid, $timestamp and $isoTimestamp are made here)");
        });
    });

    describe(`secrets and environments (${format})`, () => {
        test("the environments are found by name, with a switched-off variable left out", () => {
            assert.deepEqual([...acme().environments.keys()].sort(), ["Production", "Staging"]);
            const staging = acme().environments.get("Staging");
            assert.equal(staging?.variables.get("baseUrl")?.value, "https://api.staging.acme.example.test");
            assert.equal(staging?.variables.has("unused"), false);
        });

        test("a secret has no value; the requests that use one list it", () => {
            const staging = acme().environments.get("Staging");
            for (const name of ["token", "clientSecret", "servicePassword", "apiKey"]) assert.deepEqual(staging?.variables.get(name), { value: "", secret: true }, name);
            assert.deepEqual(request(acme(), "Get order").secrets, ["token"]);
            assert.deepEqual(request(acme(), "Key status").secrets, ["apiKey"]);
            assert.deepEqual(request(acme(), "Health").secrets, []);
        });

        test("a plain value for a secret is refused: it is not kept, and a warning names the file and the variable", () => {
            const production = acme().environments.get("Production");
            assert.deepEqual(production?.variables.get("token"), { value: "", secret: true });
            const ext = format === "yaml" ? "yml" : "bru";
            assert.deepEqual(acme().problems, [{
                file: `environments/Production.${ext}`,
                key: "token",
                message: 'is a secret with a value in the file. The value is ignored and never sent; give the secret in api.secrets as "token"',
                level: "warning",
            }]);
            assert.doesNotMatch(JSON.stringify([...acme().environments.values()].map((e) => [...e.variables])), /plain-prod-token/);
            assert.doesNotMatch(JSON.stringify(acme().problems), /plain-prod-token/, "the warning never repeats the value");
        });

        test("{{process.env.NAME}} is a secret, in the request and in every environment, and no .env file is read", () => {
            const report = request(acme(), "Report with a key");
            assert.deepEqual(report.secrets, ["process.env.ACME_REPORT_KEY"]);
            assert.deepEqual(report.signsIn, [], "an X-Report-Key header is not a sign-in");
            for (const environment of acme().environments.values()) assert.deepEqual(environment.variables.get("process.env.ACME_REPORT_KEY"), { value: "", secret: true });
            const hidden = written(format, format === "yaml"
                ? { ".env": "ACME_REPORT_KEY=from-the-dot-env-file\n", "r.yml": requestFile("yaml", { url: "https://a.example.test/{{process.env.ACME_REPORT_KEY}}" }).text }
                : { ".env": "ACME_REPORT_KEY=from-the-dot-env-file\n", "r.bru": requestFile("bru", { url: "https://a.example.test/{{process.env.ACME_REPORT_KEY}}" }).text });
            assert.doesNotMatch(JSON.stringify([hidden.requests, [...hidden.variables]]), /from-the-dot-env-file/);
        });

        test("{{process.env.NAME}} inside the value of an environment variable makes the name a secret too", () => {
            const indirect = written(format, format === "yaml"
                ? { "environments/E.yml": "name: E\nvariables:\n  - name: token\n    value: '{{process.env.TOKEN}}'\n", "r.yml": requestFile("yaml", { url: "https://a.example.test/", auth: "none" }).text }
                : { "environments/E.bru": "vars {\n  token: {{process.env.TOKEN}}\n}\n", "r.bru": requestFile("bru", { url: "https://a.example.test/" }).text });
            assert.deepEqual(indirect.environments.get("E")?.variables.get("process.env.TOKEN"), { value: "", secret: true });
        });

        test("an environment extends another: the parent's variables first, the child's after, and a secret stays a secret", () => {
            const extended = written(format, format === "yaml"
                ? {
                    "environments/Base.yml": "name: Base\nvariables:\n  - name: baseUrl\n    value: https://base.example.test\n  - name: token\n    secret: true\n  - name: region\n    value: eu\n",
                    "environments/Child.yml": "name: Child\nextends: Base\nvariables:\n  - name: region\n    value: us\n",
                    "r.yml": requestFile("yaml", { url: "https://a.example.test/" }).text,
                }
                : {
                    "environments/Base.bru": "vars {\n  baseUrl: https://base.example.test\n  region: eu\n}\nvars:secret [\n  token\n]\n",
                    "environments/Child.bru": "extends: Base\nvars {\n  region: us\n}\n",
                    "r.bru": requestFile("bru", { url: "https://a.example.test/" }).text,
                });
            const child = extended.environments.get("Child");
            assert.equal(child?.variables.get("baseUrl")?.value, "https://base.example.test");
            assert.equal(child?.variables.get("region")?.value, "us");
            assert.deepEqual(child?.variables.get("token"), { value: "", secret: true });
        });

        test("an environment that extends a missing one, or itself in a circle, is a warning", () => {
            const bad = written(format, format === "yaml"
                ? { "environments/A.yml": "name: A\nextends: B\n", "environments/B.yml": "name: B\nextends: A\n", "environments/C.yml": "name: C\nextends: Nope\n" }
                : { "environments/A.bru": "extends: B\nvars {\n}\n", "environments/B.bru": "extends: A\nvars {\n}\n", "environments/C.bru": "extends: Nope\nvars {\n}\n" });
            const messages = bad.problems.map((problem) => problem.message);
            assert.ok(messages.includes("names the environment Nope, which does not exist"));
            assert.ok(messages.some((message) => /extends it back/.test(message)));
        });

        test("a secret from a secret manager is a secret, and says it is not read", () => {
            const vault = written(format, format === "yaml"
                ? { "environments/E.yml": "name: E\nexternalSecrets:\n  type: aws-secrets-manager\n  variables:\n    - name: dbPassword\n      secretName: prod/db\n", "r.yml": requestFile("yaml", { url: "https://a.example.test/" }).text }
                : { "environments/E.bru": "vars:externalsecrets:aws-secrets-manager {\n  dbPassword: prod/db\n}\n", "r.bru": requestFile("bru", { url: "https://a.example.test/" }).text });
            assert.deepEqual(vault.environments.get("E")?.variables.get("dbPassword"), { value: "", secret: true });
            assert.equal(vault.problems[0]?.message, 'comes from aws-secrets-manager, which is not read: give the secret in api.secrets as "dbPassword"');
        });
    });

    describe(`files that cannot be read (${format})`, () => {
        test("a broken request file is a problem with its file and key, and the rest of the collection loads", () => {
            const broken = written(format, format === "yaml"
                ? { "bad.yml": "info:\n  name: Bad\n  type: http\nhttp: [unclosed\n", "good.yml": requestFile("yaml", { name: "Good", url: "https://a.example.test/" }).text }
                : { "bad.bru": "meta {\n  name: Bad\n}\n\nget {\n  url: https://a.example.test/\n", "good.bru": requestFile("bru", { name: "Good", url: "https://a.example.test/" }).text });
            assert.deepEqual(broken.requests.map((r) => r.name), ["Good"]);
            const [problem] = broken.problems;
            assert.equal(problem?.file, format === "yaml" ? "bad.yml" : "bad.bru");
            assert.equal(problem?.level, "error");
            assert.match(problem?.key ?? "", /^line \d+$/);
        });

        test("a message about a file never quotes its text: a line of an environment may hold a secret", () => {
            const secret = "s3cr3t-value-CANARY-99";
            const broken = written(format, format === "yaml"
                ? { "environments/E.yml": `name: E\nvariables:\n  - name: token\n    value: ${secret}\n  bad: [unclosed ${secret}\n` }
                : { "environments/E.bru": `vars {\n  token: ${secret}\n` });
            assert.ok(broken.problems.length > 0);
            assert.doesNotMatch(JSON.stringify(broken.problems), new RegExp(secret));
        });

        test("a file over the limit is refused, not cut", () => {
            const big = written(format, { [format === "yaml" ? "big.yml" : "big.bru"]: `# ${"x".repeat(1024 * 1024 + 10)}\n` });
            assert.deepEqual(big.requests, []);
            assert.equal(big.problems[0]?.message, "is larger than 1024 KiB");
        });

        test("a link is not followed, and a request without a request in it is a warning", () => {
            const folder = fs.mkdtempSync(path.join(scratch, "link-"));
            const outside = fs.mkdtempSync(path.join(scratch, "outside-"));
            fs.writeFileSync(path.join(outside, "x.txt"), "x");
            fs.writeFileSync(path.join(folder, format === "yaml" ? "opencollection.yml" : "bruno.json"), format === "yaml" ? "opencollection: 1.0.0\n" : "{}");
            fs.symlinkSync(outside, path.join(folder, "linked"));
            fs.writeFileSync(path.join(folder, format === "yaml" ? "empty.yml" : "empty.bru"), format === "yaml" ? "info:\n  name: E\n" : "meta {\n  name: E\n}\n");
            const collection = read(folder);
            assert.deepEqual(collection.requests, []);
            assert.ok(collection.problems.some((problem) => problem.file === "linked" && /is a link/.test(problem.message)));
            assert.ok(collection.problems.some((problem) => /empty\./.test(problem.file) && problem.level === "warning"));
        });

        test("hidden folders, node_modules and the folders bruno.json or the collection file ignore are not read", () => {
            const files: Record<string, string> = {};
            for (const dir of [".git", "node_modules", "kept", "skipped"]) {
                const made = requestFile(format, { name: dir.replace(/\W/g, ""), url: "https://a.example.test/" });
                files[`${dir}/${made.file}`] = made.text;
            }
            const collection = written(format, format === "yaml" ? { ...files, "opencollection.yml": "opencollection: 1.0.0\nextensions:\n  bruno:\n    ignore:\n      - skipped\n" } : { ...files, "bruno.json": '{"ignore":["skipped"]}' });
            assert.deepEqual(collection.requests.map((r) => r.name), ["kept"]);
        });
    });
}

describe("a bundled collection", () => {
    test("items inside opencollection.yml are folders and requests like those in files", () => {
        const bundled = written("yaml", {
            "opencollection.yml": [
                "opencollection: 1.0.0",
                "items:",
                "  - info: { name: Orders, type: folder, seq: 1 }",
                "    items:",
                "      - info: { name: Get, type: http, seq: 1 }",
                "        http: { method: GET, url: 'https://a.example.test/orders' }",
                "  - info: { name: Ping, type: http, seq: 2 }",
                "    http: { method: GET, url: 'https://a.example.test/ping' }",
                "",
            ].join("\n"),
        });
        assert.deepEqual(bundled.requests.map((r) => [r.folder.join("/"), r.name, r.url]), [["Orders", "Get", "https://a.example.test/orders"], ["", "Ping", "https://a.example.test/ping"]]);
    });
});

describe("the .bru language", () => {
    const one = (text: string): SavedRequest => {
        const collection = written("bru", { "r.bru": text });
        const found = collection.requests[0];
        assert.ok(found, JSON.stringify(collection.problems));
        return found;
    };

    test("a value may run over several lines in ''' with four spaces of indent, and an annotation before a pair is skipped", () => {
        const found = one([
            "meta {", "  name: R", "}", "", "post {", "  url: https://a.example.test/", "  body: formUrlEncoded", "}", "",
            "body:form-urlencoded {",
            "  @description('''The note''')",
            "  note: '''",
            "      first",
            "      second",
            "      '''",
            "  @description('''",
            "      A long description",
            "      ''')",
            "  other: two",
            "}", "",
        ].join("\n"));
        const form = found.body;
        assert.equal(form?.kind, "form");
        if (form?.kind !== "form") return;
        assert.deepEqual(form.fields.map((field) => [field.name, field.kind === "text" ? field.value : ""]), [["note", "first\n  second"], ["other", "two"]]);
    });

    test("a quoted key may hold spaces, ~ before it switches the line off, and a value may hold a colon", () => {
        const found = one("meta {\n  name: R\n}\n\nget {\n  url: https://a.example.test:8443/x\n}\n\nheaders {\n  \"X Spaced\": a:b\n  ~\"X Off\": no\n  X-Url: http://c.example.test\n}\n");
        assert.deepEqual(found.headers, [["X Spaced", "a:b"], ["X-Url", "http://c.example.test"]]);
        assert.equal(found.url, "https://a.example.test:8443/x");
    });

    test("a text block ends at the first } in the first column, and its indent of two spaces is removed", () => {
        const found = one("meta {\n  name: R\n}\n\npost {\n  url: https://a.example.test/\n  body: json\n}\n\nbody:json {\n  {\n    \"a\": 1\n  }\n}\n");
        assert.deepEqual(found.body, { kind: "json", text: '{\n  "a": 1\n}' });
    });

    test("a block that never closes is an error, and what came before it is still read", () => {
        const collection = written("bru", { "r.bru": "meta {\n  name: R\n}\n\nget {\n  url: https://a.example.test/\n}\n\nheaders {\n  X-A: 1\n" });
        assert.equal(collection.requests[0]?.url, "https://a.example.test/");
        assert.equal(collection.problems[0]?.message, "the block headers is never closed, so the rest of the file is skipped");
    });

    test("a line that is no block is a warning with its line, and the rest is read", () => {
        const collection = written("bru", { "r.bru": "this is not bru\nmeta {\n  name: R\n}\n\nget {\n  url: https://a.example.test/\n}\n" });
        assert.equal(collection.requests[0]?.name, "R");
        assert.deepEqual(collection.problems[0], { file: "r.bru", key: "line 1", message: "is not a block of a .bru file, and is skipped", level: "warning" });
    });

    test("a name in vars:secret that is switched off, or is an annotation, is not a variable", () => {
        const collection = written("bru", { "environments/E.bru": "vars:secret [\n  token,\n  ~old,\n  @description('x')\n]\n", "r.bru": "get {\n  url: https://a.example.test/\n}\n" });
        assert.deepEqual([...(collection.environments.get("E")?.variables.keys() ?? [])], ["token"]);
    });

    test("a custom method is a request of that method, and its name is the file's when meta has none", () => {
        const collection = written("bru", { "folder/my-request.bru": "http {\n  method: PROPFIND\n  url: https://a.example.test/\n}\n" });
        assert.deepEqual([collection.requests[0]?.name, collection.requests[0]?.method], ["my-request", "PROPFIND"]);
        assert.match(collection.requests[0]?.unsupported ?? "", /the method PROPFIND is not sent/);
    });
});
