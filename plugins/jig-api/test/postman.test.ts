// The Postman source: a collection exported as v2.1 JSON and its environment files, read into saved requests. Nothing is sent
// and no script is run: a script is only noticed, so that the request can be refused by name.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Collection, SavedRequest } from "../src/model.ts";
import { postman } from "../src/sources/postman.ts";
import { FIXTURES } from "./support/acme.ts";

const COLLECTION = path.join(FIXTURES, "postman", "acme-orders.postman_collection.json");
const STAGING = path.join(FIXTURES, "postman", "acme-staging.postman_environment.json");
const PRODUCTION = path.join(FIXTURES, "postman", "acme-production.postman_environment.json");

/** Reads a collection from files, through the same two steps the plugin takes. */
function read(file: string, environments: Record<string, string> = {}, name = "acme"): Collection {
    const errors: string[] = [];
    const config = postman.check({ postman: file, environments }, `api.collections.${name}`, errors);
    assert.deepEqual(errors, []);
    assert.ok(config);
    return postman.load(config, name);
}

let acme: Collection;
let scratch: string;
before(() => {
    acme = read(COLLECTION, { Staging: STAGING, Production: PRODUCTION });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-postman-"));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function request(name: string, collection: Collection = acme): SavedRequest {
    const found = collection.requests.find((candidate) => candidate.name === name);
    assert.ok(found, `no request named ${name}`);
    return found;
}

/** A collection written to a file of the test's own, for the cases the fixture does not have. */
function written(content: unknown, environments: Record<string, unknown> = {}): Collection {
    const file = path.join(scratch, `c-${fs.readdirSync(scratch).length}.json`);
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    const files: Record<string, string> = {};
    for (const [name, value] of Object.entries(environments)) {
        files[name] = path.join(scratch, `e-${fs.readdirSync(scratch).length}-${name}.json`);
        fs.writeFileSync(files[name] as string, typeof value === "string" ? value : JSON.stringify(value));
    }
    return read(file, files);
}

const item = (name: string, request: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, request, ...extra });
const get = (url: unknown): Record<string, unknown> => ({ method: "GET", url });

describe("the folders and requests", () => {
    test("every request is found, with its folder path and its name, in the order of the file", () => {
        assert.equal(acme.requests.length, 25);
        assert.deepEqual(acme.requests.slice(0, 3).map((r) => [r.folder.join("/"), r.name]), [["Orders", "Get order"], ["Orders", "List orders"], ["Orders", "Create order"]]);
        const folders = [...new Set(acme.requests.map((r) => r.folder.join("/")))];
        assert.deepEqual(folders, ["Orders", "Smoke", "Admin", "Auth styles", "Reports"]);
        assert.ok(acme.requests.every((r) => r.collection === "acme"));
        assert.equal(request("Get order").origin, "acme-orders.postman_collection.json: Orders/Get order");
    });

    test("folders nest, and a request at the top has no folder", () => {
        const nested = written({ item: [item("Top", get("https://a.example.test/")), { name: "A", item: [{ name: "B", item: [item("Deep", get("https://a.example.test/"))] }] }] });
        assert.deepEqual(nested.requests.map((r) => [r.folder, r.name]), [[[], "Top"], [["A", "B"], "Deep"]]);
    });

    test("a request may be a plain address, and its method defaults to GET", () => {
        const plain = written({ item: [{ name: "Plain", request: "https://a.example.test/x" }, item("No method", { url: "https://a.example.test/y" })] });
        assert.deepEqual(plain.requests.map((r) => [r.method, r.url]), [["GET", "https://a.example.test/x"], ["GET", "https://a.example.test/y"]]);
    });

    test("the description is kept, as text or as an object", () => {
        assert.equal(request("Get order").description, "Reads one order by its id.");
        const described = written({ item: [item("A", { method: "GET", url: "https://a.example.test/", description: { content: "From an object", type: "text/markdown" } })] });
        assert.equal(described.requests[0]?.description, "From an object");
    });
});

describe("the address", () => {
    test("is the raw text, with a path variable given its value and a disabled query parameter left out", () => {
        assert.equal(request("Get order").url, "{{baseUrl}}/{{apiVersion}}/orders/{{orderId}}");
        assert.equal(request("List orders").url, "{{baseUrl}}/{{apiVersion}}/orders?status={{status}}&limit=10");
    });

    test("is put together from its parts when there is no raw text", () => {
        const parts = written({ item: [item("Parts", { method: "GET", url: { protocol: "https", host: ["api", "example", "test"], port: "8443", path: ["v1", "orders", ":id"], query: [{ key: "a", value: "1" }, { key: "b", value: "2", disabled: true }, { key: "c", value: null }], variable: [{ key: "id", value: "42" }] } })] });
        assert.equal(parts.requests[0]?.url, "https://api.example.test:8443/v1/orders/42?a=1&c");
    });

    test("never carries a fragment, which is not sent", () => {
        const hashed = written({ item: [item("Hash", get("https://a.example.test/x#section"))] });
        assert.equal(hashed.requests[0]?.url, "https://a.example.test/x");
    });
});

describe("headers and bodies", () => {
    test("a header is kept, a disabled one is not, and the header may be a text of lines", () => {
        const headers = written({
            item: [
                item("List", { method: "GET", url: "https://a.example.test/", header: [{ key: "X-One", value: "1" }, { key: "X-Off", value: "2", disabled: true }] }),
                item("Text", { method: "GET", url: "https://a.example.test/", header: "X-A: 1\nX-B: two words" }),
            ],
        });
        assert.deepEqual(headers.requests[0]?.headers, [["X-One", "1"]]);
        assert.deepEqual(headers.requests[1]?.headers, [["X-A", "1"], ["X-B", "two words"]]);
    });

    test("a raw JSON body is JSON, and gets the content type Postman sends for it", () => {
        const create = request("Create order");
        assert.equal(create.body?.kind, "json");
        assert.match(create.body?.kind === "json" ? create.body.text : "", /"customerId": "\{\{customerId\}\}"/);
        assert.deepEqual(create.headers.map(([name]) => name), ["Content-Type", "Idempotency-Key"], "its own Content-Type is kept, not added twice");
        assert.deepEqual(request("Search orders").headers, [["Content-Type", "application/json"]]);
    });

    test("other raw languages, a URL-encoded form, a multipart form, a file and GraphQL", () => {
        const kinds = written({
            item: [
                item("xml", { method: "POST", url: "https://a.example.test/", body: { mode: "raw", raw: "<a/>", options: { raw: { language: "xml" } } } }),
                item("text", { method: "POST", url: "https://a.example.test/", body: { mode: "raw", raw: "hello" } }),
                item("none", { method: "POST", url: "https://a.example.test/", body: { mode: "raw", raw: "x", disabled: true } }),
                item("odd", { method: "POST", url: "https://a.example.test/", body: { mode: "binary" } }),
            ],
        });
        assert.deepEqual(kinds.requests[0]?.body, { kind: "raw", text: "<a/>", language: "xml" });
        assert.deepEqual(kinds.requests[0]?.headers, [["Content-Type", "application/xml"]]);
        assert.deepEqual(kinds.requests[1]?.body, { kind: "raw", text: "hello", language: "text" });
        assert.equal(kinds.requests[2]?.body, undefined, "a disabled body is no body");
        assert.match(kinds.requests[3]?.unsupported ?? "", /the body type "binary" is not sent/);

        const form = request("Place order (form)").body;
        assert.deepEqual(form, { kind: "form", encoding: "urlencoded", fields: [{ kind: "text", name: "customer", value: "{{customerId}}" }, { kind: "text", name: "note", value: "{{note}}" }] });
        assert.deepEqual(request("Place order (form)").headers, [["Content-Type", "application/x-www-form-urlencoded"]]);

        const upload = request("Upload receipt").body;
        assert.deepEqual(upload, { kind: "form", encoding: "multipart", fields: [{ kind: "text", name: "note", value: "{{note}}" }, { kind: "file", name: "receipt", file: { path: "files/receipt.txt" } }] });
        assert.deepEqual(request("Import orders").body, { kind: "file", file: { path: "files/receipt.txt" } });
        assert.equal(request("Orders by status").body?.kind, "graphql");
        const graphql = request("Orders by status").body;
        assert.ok(graphql?.kind === "graphql" && graphql.query.startsWith("query ($status: String!)") && graphql.variables === '{"status": "{{status}}"}');
        assert.deepEqual(request("Orders by status").headers, [["Content-Type", "application/json"]]);
    });

    test("a file field without a file is left out, with a note", () => {
        const empty = written({ item: [item("Empty", { method: "POST", url: "https://a.example.test/", body: { mode: "formdata", formdata: [{ key: "f", type: "file", src: null }, { key: "t", type: "text", value: "x" }] } })] });
        assert.deepEqual(empty.requests[0]?.body, { kind: "form", encoding: "multipart", fields: [{ kind: "text", name: "t", value: "x" }] });
        assert.deepEqual(empty.requests[0]?.notes, ['the file field "f" has no file chosen, so it is left out']);
    });
});

describe("the sign-in", () => {
    test("a request inherits the sign-in of its folder, else of the collection", () => {
        assert.deepEqual(request("Get order").auth, { kind: "bearer", token: "{{token}}" });
        assert.deepEqual(acme.auth, { kind: "bearer", token: "{{token}}" });
        const inherited = written({
            auth: { type: "bearer", bearer: [{ key: "token", value: "{{top}}" }] },
            item: [{ name: "F", auth: { type: "basic", basic: [{ key: "username", value: "u" }, { key: "password", value: "p" }] }, item: [item("In folder", get("https://a.example.test/")), item("Own", { ...get("https://a.example.test/"), auth: { type: "noauth" } })] }, item("Top", get("https://a.example.test/"))],
        });
        assert.deepEqual(inherited.requests.map((r) => r.auth.kind), ["basic", "none", "bearer"]);
    });

    test("noauth on a request means none, whatever the collection says", () => {
        assert.deepEqual(request("Health").auth, { kind: "none" });
        assert.deepEqual(request("Health").variables, ["baseUrl"]);
    });

    test("basic, an API key in a header, and OAuth 2.0 with client credentials", () => {
        assert.deepEqual(request("Basic status").auth, { kind: "basic", username: "{{serviceUser}}", password: "{{servicePassword}}" });
        assert.deepEqual(request("Key status").auth, { kind: "apiKey", name: "X-Api-Key", value: "{{apiKey}}" });
        assert.deepEqual(request("Partner stock").auth, {
            kind: "oauth2", grant: "client_credentials", tokenUrl: "{{authUrl}}/oauth/token", clientId: "{{clientId}}", clientSecret: "{{clientSecret}}", scope: "stock.read", clientAuth: "header",
        });
    });

    test("OAuth 2.0 with the password grant, and the client's secret in the body", () => {
        const password = written({
            item: [item("P", { ...get("https://a.example.test/"), auth: { type: "oauth2", oauth2: [
                { key: "grant_type", value: "password_credentials" }, { key: "accessTokenUrl", value: "https://a.example.test/token" }, { key: "clientId", value: "c" },
                { key: "username", value: "u" }, { key: "password", value: "p" }, { key: "client_authentication", value: "body" },
            ] } })],
        });
        assert.deepEqual(password.requests[0]?.auth, {
            kind: "oauth2", grant: "password", tokenUrl: "https://a.example.test/token", clientId: "c", username: "u", password: "p", clientAuth: "body",
        });
    });

    test("a sign-in that is not sent is refused by its name, and its request is listed all the same", () => {
        assert.match(request("Key in query").unsupported ?? "", /^an API key sent in the query string/);
        assert.match(request("Browser sign-in").unsupported ?? "", /^OAuth 2\.0 with the grant "authorization_code" \(it needs a browser/);
        assert.match(request("Signed export").unsupported ?? "", /^the sign-in type "awsv4" is not sent/);
        for (const type of ["digest", "hawk", "ntlm", "oauth1", "edgegrid"]) {
            const other = written({ item: [item("O", { ...get("https://a.example.test/"), auth: { type, [type]: [] } })] });
            assert.match(other.requests[0]?.unsupported ?? "", new RegExp(`the sign-in type "${type}" is not sent`), type);
        }
    });

    test("a collection whose own sign-in is refused says so, and its requests are refused with it", () => {
        const digest = written({ auth: { type: "digest", digest: [] }, item: [item("A", get("https://a.example.test/"))] });
        assert.match(digest.authRefused ?? "", /"digest"/);
        assert.match(digest.requests[0]?.unsupported ?? "", /"digest"/);
    });

    test("an OAuth token pasted into the export is not used, and the file is named", () => {
        const pasted = written({
            item: [item("T", { ...get("https://a.example.test/"), auth: { type: "oauth2", oauth2: [{ key: "accessToken", value: "pasted-token-123456" }, { key: "grant_type", value: "authorization_code" }] } })],
        });
        assert.ok(!JSON.stringify(pasted).includes("pasted-token-123456"), "the value is not kept");
        assert.equal(pasted.problems.length, 1);
        assert.match(pasted.problems[0]?.file ?? "", /^c-\d+\.json$/);
        assert.deepEqual([pasted.problems[0]?.key, pasted.problems[0]?.level], ["item[0].request.auth.oauth2", "warning"]);
    });

    test("an older export, where an auth block is an object and not a list, is read too", () => {
        const old = written({ item: [item("Old", { ...get("https://a.example.test/"), auth: { type: "bearer", bearer: { token: "{{t}}" } } })] });
        assert.deepEqual(old.requests[0]?.auth, { kind: "bearer", token: "{{t}}" });
    });
});

describe("the variables", () => {
    test("a request lists the variables its texts use, once each, in order, and the ones that fill its sign-in", () => {
        assert.deepEqual(request("Get order").variables, ["baseUrl", "apiVersion", "orderId", "token"]);
        assert.deepEqual(request("Get order").signsIn, ["token"]);
        assert.deepEqual(request("Create order").variables, ["baseUrl", "apiVersion", "$guid", "customerId", "sku", "quantity", "note", "token"]);
        assert.deepEqual(request("Basic status").signsIn, ["serviceUser", "servicePassword"]);
    });

    test("the variables an environment declares secret are the secrets of the requests that use them", () => {
        assert.deepEqual(request("Get order").secrets, ["token"]);
        assert.deepEqual(request("Basic status").secrets, ["servicePassword"], "serviceUser is not a secret");
        assert.deepEqual(request("Health").secrets, []);
        assert.deepEqual(request("Partner stock").secrets, ["clientSecret"]);
    });

    test("the collection's variables are its own values, and a disabled one is not", () => {
        assert.deepEqual([...acme.variables], [["apiVersion", { value: "v1", secret: false }]]);
    });

    test("variables of a folder or a request are values for the requests under them, and the inner one wins", () => {
        const scoped = written({
            item: [{ name: "F", variable: [{ key: "a", value: "folder" }, { key: "b", value: "folder" }], item: [item("R", get("https://a.example.test/"), { variable: [{ key: "b", value: "request" }] })] }],
        });
        assert.deepEqual([...(scoped.requests[0]?.defaults ?? [])], [["a", "folder"], ["b", "request"]]);
    });

    test("a variable that needs code or another request is refused by its name", () => {
        assert.match(request("Random number").unsupported ?? "", /^\{\{\$randomInt\}\} is not supported/);
        const chained = written({ item: [item("C", get("https://a.example.test/{{login.response.body.$.id}}"))] });
        assert.match(chained.requests[0]?.unsupported ?? "", /needs the answer of another request/);
    });
});

describe("the environments", () => {
    test("are read by the name the configuration gives them, with their values", () => {
        assert.deepEqual([...acme.environments.keys()], ["Staging", "Production"]);
        const staging = acme.environments.get("Staging");
        assert.equal(staging?.file, "acme-staging.postman_environment.json");
        assert.deepEqual(staging?.variables.get("baseUrl"), { value: "https://api.staging.acme.example.test", secret: false });
        assert.equal(staging?.variables.has("unused"), false, "a disabled value is not a value");
    });

    test("a variable of the type secret is a secret, with no value", () => {
        for (const name of ["token", "clientSecret", "servicePassword", "apiKey"]) {
            assert.deepEqual(acme.environments.get("Staging")?.variables.get(name), { value: "", secret: true }, name);
        }
    });

    test("a plain value for a secret is refused with a warning that names the file and the variable, and is never kept", () => {
        assert.deepEqual(acme.environments.get("Production")?.variables.get("token"), { value: "", secret: true });
        assert.ok(!JSON.stringify([...acme.environments.get("Production")?.variables ?? []]).includes("plain-prod-token-0123456789"));
        assert.deepEqual(acme.problems, [{
            file: "acme-production.postman_environment.json",
            key: "token",
            message: 'is a secret with a value in the file. The value is ignored and never sent; give the secret in api.secrets as "token"',
            level: "warning",
        }]);
        assert.ok(!JSON.stringify(acme.problems).includes("plain-prod-token-0123456789"), "the warning does not repeat the value");
    });
});

describe("scripts", () => {
    test("a pre-request script of the request itself is noticed, and its test script is ignored with a note", () => {
        const own = request("With its own script");
        assert.deepEqual(own.scripts, { prerequest: true, where: "the request" });
        assert.deepEqual(own.notes, ["its test script is ignored (scripts never run)"]);
        assert.deepEqual(request("Get order").scripts, { prerequest: false });
        assert.deepEqual(request("Get order").notes, ["its test script is ignored (scripts never run)"]);
    });

    test("a pre-request script of a folder or of the collection applies to the requests under it", () => {
        assert.deepEqual(request("Rebuild index").scripts, { prerequest: true, where: "the folder Admin" });
        const top = written({
            event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }],
            item: [{ name: "F", item: [item("Deep", get("https://a.example.test/"))] }, item("Top", get("https://a.example.test/"))],
        });
        assert.deepEqual(top.requests.map((r) => r.scripts), [{ prerequest: true, where: "the collection" }, { prerequest: true, where: "the collection" }]);
    });

    test("an empty script, a disabled one and a script of the other kind are no pre-request script", () => {
        const idle = written({
            item: [
                item("Empty", get("https://a.example.test/"), { event: [{ listen: "prerequest", script: { exec: ["", "  "] } }] }),
                item("Off", get("https://a.example.test/"), { event: [{ listen: "prerequest", disabled: true, script: { exec: ["x()"] } }] }),
                item("Test", get("https://a.example.test/"), { event: [{ listen: "test", script: { exec: ["x()"] } }] }),
                item("String", get("https://a.example.test/"), { event: [{ listen: "prerequest", script: { exec: "x()" } }] }),
                item("Source", get("https://a.example.test/"), { event: [{ listen: "prerequest", script: { src: "https://a.example.test/s.js" } }] }),
            ],
        });
        assert.deepEqual(idle.requests.map((r) => r.scripts.prerequest), [false, false, false, true, true]);
    });
});

describe("protocols", () => {
    test("a WebSocket address, a profile that is not HTTP and a method that is not HTTP are listed and refused", () => {
        assert.match(request("Watch orders").unsupported ?? "", /^the address uses ws:\/\/, and only http and https are sent/);
        assert.match(request("Stream profile").unsupported ?? "", /^its protocol profile \(protocol\) is not plain HTTP/);
        for (const url of ["wss://a.example.test/", "grpc://a.example.test/", "mqtt://a.example.test/", "ftp://a.example.test/"]) {
            const other = written({ item: [item("O", get(url))] });
            assert.match(other.requests[0]?.unsupported ?? "", /only http and https are sent/, url);
        }
        const odd = written({ item: [item("W", { method: "WEBSOCKET", url: "https://a.example.test/" }), item("P", { method: "PROPFIND", url: "https://a.example.test/" })] });
        assert.match(odd.requests[0]?.unsupported ?? "", /^WEBSOCKET is not plain HTTP/);
        assert.match(odd.requests[1]?.unsupported ?? "", /^the method PROPFIND is not sent/);
    });

    test("a profile that only tunes HTTP is fine, with a note for what is ignored", () => {
        const tuned = written({
            protocolProfileBehavior: { followRedirects: true, strictSSL: false },
            item: [item("T", get("https://a.example.test/"), { protocolProfileBehavior: { maxRedirects: 5 } })],
        });
        assert.equal(tuned.requests[0]?.unsupported, undefined);
        assert.deepEqual(tuned.requests[0]?.notes, ["followRedirects is ignored: redirects are never followed", "strictSSL: false is ignored: certificates are always checked"]);
    });

    test("GraphQL is a POST, and works", () => {
        assert.equal(request("Orders by status").method, "POST");
        assert.equal(request("Orders by status").unsupported, undefined);
    });
});

describe("a file that cannot be read", () => {
    test("is reported with its file and its key, and the rest still loads", () => {
        const missing = read(path.join(scratch, "no-such.json"), { Staging: path.join(scratch, "no-such-env.json") });
        assert.deepEqual(missing.requests, []);
        assert.deepEqual(missing.problems.map((p) => [p.file, p.key, p.message, p.level]), [
            ["no-such-env.json", "", "no such file", "error"],
            ["no-such.json", "", "no such file", "error"],
        ]);
        const broken = written("{ not json");
        assert.deepEqual(broken.problems.map((p) => [p.key, p.message]), [["", "is not valid JSON"]]);
        const notACollection = written({ info: {} });
        assert.deepEqual(notACollection.problems.map((p) => [p.key, p.message]), [["item", "is missing: this is not an exported collection"]]);
        const notAnEnvironment = written({ item: [] }, { Staging: { name: "x" } });
        assert.deepEqual(notAnEnvironment.problems.map((p) => [p.key, p.message]), [["values", "is missing: this is not an exported environment"]]);
    });

    test("a broken environment does not stop the collection, and a folder or a request that is not one is a problem", () => {
        const partial = written({ item: [item("Fine", get("https://a.example.test/")), 5, { name: "Nothing" }] }, { Staging: "nope" });
        assert.deepEqual(partial.requests.map((r) => r.name), ["Fine"]);
        assert.deepEqual(partial.problems.map((p) => p.key).sort(), ["", "item[1]", "item[2]"]);
    });

    test("a collection of another format is read with a warning", () => {
        const v1 = written({ info: { schema: "https://schema.getpostman.com/json/collection/v1.0.0/collection.json" }, item: [item("A", get("https://a.example.test/"))] });
        assert.equal(v1.requests.length, 1);
        assert.match(v1.problems[0]?.message ?? "", /only collection format v2\.0 and v2\.1 are read/);
        const v20 = written({ info: { schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json" }, item: [] });
        assert.deepEqual(v20.problems, []);
    });
});

describe("the configuration of a Postman collection", () => {
    test("check returns the file and the environments, and reports a mistake with its key", () => {
        const errors: string[] = [];
        const config = postman.check({ postman: COLLECTION, environments: { Staging: STAGING } }, "api.collections.acme", errors);
        assert.deepEqual(errors, []);
        assert.deepEqual(config, { file: COLLECTION, environments: [["Staging", STAGING]] });
        assert.equal(postman.check({ postman: 5 }, "api.collections.acme", errors), undefined);
        assert.deepEqual(errors, ["api.collections.acme.postman: must be a path"]);
    });

    test("a source is a kind, a check and a load", () => {
        assert.equal(postman.kind, "postman");
        assert.equal(typeof postman.check, "function");
        assert.equal(typeof postman.load, "function");
    });
});
