// The `.http` source: a folder of request files in the dialect of JetBrains IDEs, the VS Code REST Client and Visual Studio,
// read into saved requests. Nothing is sent and no script is run: a script is only noticed, so that the request can be refused
// by name.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Collection, SavedRequest } from "../src/model.ts";
import { httpFile } from "../src/sources/http-file.ts";
import { FIXTURES } from "./support/acme.ts";

/** Reads a folder, through the same two steps the plugin takes. */
function read(folder: string, name = "ledger"): Collection {
    const errors: string[] = [];
    const config = httpFile.check({ http: folder }, `api.collections.${name}`, errors);
    assert.deepEqual(errors, []);
    assert.ok(config);
    return httpFile.load(config, name);
}

let ledger: Collection;
let scratch: string;
before(() => {
    ledger = read(path.join(FIXTURES, "http"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jig-api-http-"));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function request(name: string, collection: Collection = ledger): SavedRequest {
    const found = collection.requests.find((candidate) => candidate.name === name);
    assert.ok(found, `no request named ${name}`);
    return found;
}

/** A folder of the test's own, from file names to texts. */
function folder(files: Record<string, string>): Collection {
    const directory = fs.mkdtempSync(path.join(scratch, "f-"));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
        fs.writeFileSync(path.join(directory, name), content);
    }
    return read(directory);
}

/** The requests of one file, from its text. */
const requestsOf = (text: string, extra: Record<string, string> = {}): readonly SavedRequest[] =>
    folder({ "r.http": text, ...extra }).requests;

describe("the requests of a file", () => {
    test("are separated by ###, and each is a method and address, headers, a blank line and a body", () => {
        const [first, second] = requestsOf(
            'GET https://a.example.test/one\nAccept: text/plain\nX-Two: 2\n\n###\n\nPOST https://a.example.test/two\nContent-Type: application/json\n\n{"a": 1}\n',
        );
        assert.deepEqual(
            [first?.method, first?.url, first?.headers],
            [
                "GET",
                "https://a.example.test/one",
                [
                    ["Accept", "text/plain"],
                    ["X-Two", "2"],
                ],
            ],
        );
        assert.deepEqual(
            [second?.method, second?.url, second?.body],
            ["POST", "https://a.example.test/two", { kind: "json", text: '{"a": 1}' }],
        );
    });

    test("every request of the fixture is found, in the order of the files and of each file", () => {
        assert.equal(ledger.requests.length, 20);
        assert.deepEqual(
            ledger.requests.map((r) => r.folder.join("/")).filter((value, index, all) => all.indexOf(value) === index),
            ["admin.http", "orders.http", "uploads.http"],
        );
        assert.deepEqual(
            ledger.requests.filter((r) => r.folder[0] === "orders.http").map((r) => r.name),
            [
                "Get order",
                "List orders",
                "Create order",
                "Search orders",
                "orders.http#5",
                "Basic status",
                "Place order (form)",
                "Health",
            ],
        );
    });

    test("a request is named by # @name or // @name, with or without =, else by the text after ###, else by file and place", () => {
        const names = requestsOf(
            [
                "# @name First",
                "GET https://a.example.test/1",
                "###",
                "// @name Second",
                "GET https://a.example.test/2",
                "###",
                "# @name = Third",
                "GET https://a.example.test/3",
                "### Fourth",
                "GET https://a.example.test/4",
                "###",
                "GET https://a.example.test/5",
            ].join("\n"),
        ).map((r) => r.name);
        assert.deepEqual(names, ["First", "Second", "Third", "Fourth", "r.http#5"]);
    });

    test("a block of only variables and comments is no request, and does not count in the numbering", () => {
        const found = requestsOf("@a = 1\n\n###\n# just a note\n\n###\nGET https://a.example.test/\n");
        assert.deepEqual(
            found.map((r) => r.name),
            ["r.http#1"],
        );
    });

    test("the method may be left out, and an HTTP version after the address is not part of it", () => {
        const found = requestsOf("https://a.example.test/a\n\n###\nPOST https://a.example.test/b HTTP/1.1\n");
        assert.deepEqual(
            found.map((r) => [r.method, r.url]),
            [
                ["GET", "https://a.example.test/a"],
                ["POST", "https://a.example.test/b"],
            ],
        );
    });

    test("a long address goes on indented lines, or on lines that start with ? or &", () => {
        const [found] = requestsOf(
            "GET https://a.example.test\n  /api\n  /html\n  ?id=123\n  &value=content\nAccept: text/plain\n",
        );
        assert.equal(found?.url, "https://a.example.test/api/html?id=123&value=content");
        assert.deepEqual(found?.headers, [["Accept", "text/plain"]]);
        assert.equal(
            request("List orders").url,
            "{{baseUrl}}/{{apiVersion}}/orders?status={{status}}&limit={{pageSize}}",
        );
    });

    test("comments among the headers are skipped, and CRLF line ends read as one", () => {
        const [found] = requestsOf(
            "GET https://a.example.test/\r\n# a comment\r\nAccept: text/plain\r\n// another\r\nX-A: 1\r\n\r\nbody\r\n",
        );
        assert.deepEqual(found?.headers, [
            ["Accept", "text/plain"],
            ["X-A", "1"],
        ]);
        assert.deepEqual(found?.body, { kind: "raw", text: "body", language: "text" });
    });

    test("the folder of a request is its folders and then its file", () => {
        const nested = folder({
            "top.http": "GET https://a.example.test/\n",
            "smoke/health.http": "GET https://a.example.test/h\n",
            "smoke/deep/more.http": "GET https://a.example.test/m\n",
        });
        assert.deepEqual(
            nested.requests.map((r) => r.folder),
            [["smoke", "deep", "more.http"], ["smoke", "health.http"], ["top.http"]],
        );
    });

    test("files ending in .http and .rest are read; links, hidden folders and node_modules are not", () => {
        const directory = fs.mkdtempSync(path.join(scratch, "l-"));
        fs.writeFileSync(path.join(directory, "a.http"), "GET https://a.example.test/a\n");
        fs.writeFileSync(path.join(directory, "b.rest"), "GET https://a.example.test/b\n");
        fs.writeFileSync(path.join(directory, "c.txt"), "GET https://a.example.test/c\n");
        fs.mkdirSync(path.join(directory, ".git"));
        fs.writeFileSync(path.join(directory, ".git", "d.http"), "GET https://a.example.test/d\n");
        fs.mkdirSync(path.join(directory, "node_modules"));
        fs.writeFileSync(path.join(directory, "node_modules", "e.http"), "GET https://a.example.test/e\n");
        fs.symlinkSync(path.join(directory, "a.http"), path.join(directory, "link.http"));
        const collection = read(directory);
        assert.deepEqual(
            collection.requests.map((r) => r.url),
            ["https://a.example.test/a", "https://a.example.test/b"],
        );
        assert.deepEqual(
            collection.problems.map((p) => [p.file, p.message]),
            [["link.http", "is a link, and links are not followed"]],
        );
    });
});

describe("variables", () => {
    test("a request lists the variables its texts use, and the ones that fill its sign-in", () => {
        assert.deepEqual(request("Get order").variables, ["baseUrl", "apiVersion", "orderId", "token"]);
        assert.deepEqual(request("Get order").signsIn, ["token"]);
        assert.deepEqual(request("Create order").variables, [
            "baseUrl",
            "apiVersion",
            "token",
            "$uuid",
            "customerId",
            "sku",
            "quantity",
            "$isoTimestamp",
        ]);
    });

    test("@name = value lines are values for every request of the file, and may use other variables", () => {
        assert.deepEqual([...request("List orders").defaults], [["pageSize", "{{nested.page.size}}"]]);
        const files = folder({
            "a.http": "@host = a.example.test\n\n###\n@other = {{host}}/x\nGET https://{{host}}/1\n",
            "b.http": "GET https://b.example.test/\n",
        });
        assert.deepEqual(
            [...(files.requests[0]?.defaults ?? [])],
            [
                ["host", "a.example.test"],
                ["other", "{{host}}/x"],
            ],
        );
        assert.deepEqual([...(files.requests[1]?.defaults ?? [])], [], "a file's variables are that file's");
    });

    test("the dynamic variables are $uuid, $timestamp and $isoTimestamp; any other is refused by its name", () => {
        for (const name of [
            "$random.integer(1, 10)",
            "$randomInt",
            "$guid 1",
            "$env.USER",
            "$projectRoot",
            '$auth.token("x")',
            "$datetime iso8601",
        ]) {
            const [found] = requestsOf(`GET https://a.example.test/{{${name}}}\n`);
            assert.match(
                found?.unsupported ?? "",
                /is not supported \(only \$uuid, \$timestamp and \$isoTimestamp are made here\)/,
                name,
            );
        }
        const [good] = requestsOf("GET https://a.example.test/{{$uuid}}/{{$timestamp}}/{{$isoTimestamp}}\n");
        assert.equal(good?.unsupported, undefined);
    });

    test("a variable that needs another request's answer is refused", () => {
        assert.equal(
            request("Random number").unsupported?.startsWith("{{$random.integer(1, 10)}} is not supported"),
            true,
        );
        assert.match(
            request("Chained").unsupported ?? "",
            /^\{\{login\.response\.body\.\$\.orderId\}\} needs the answer of another request/,
        );
    });
});

describe("the environments", () => {
    test("are the names in http-client.env.json and in the private file, with $shared values in every one", () => {
        assert.deepEqual([...ledger.environments.keys()], ["staging", "production"]);
        const staging = ledger.environments.get("staging");
        assert.deepEqual(staging?.variables.get("apiVersion"), { value: "v1", secret: false }, "from $shared");
        assert.deepEqual(staging?.variables.get("baseUrl"), {
            value: "https://api.staging.acme.example.test",
            secret: false,
        });
        assert.deepEqual(
            staging?.variables.get("nested.page.size"),
            { value: "25", secret: false },
            "a nested object is a dotted name",
        );
        assert.equal(staging?.file, "http-client.env.json");
    });

    test("every key of the private file is a secret, with no value", () => {
        for (const name of ["token", "serviceUser", "servicePassword"]) {
            assert.deepEqual(
                ledger.environments.get("staging")?.variables.get(name),
                { value: "", secret: true },
                name,
            );
        }
        assert.deepEqual(request("Get order").secrets, ["token"]);
        assert.deepEqual(request("Basic status").secrets, ["serviceUser", "servicePassword"]);
    });

    test("a plain value in the private file is refused with a warning that names the file and the variable, and is never kept", () => {
        assert.deepEqual(ledger.environments.get("production")?.variables.get("token"), { value: "", secret: true });
        assert.deepEqual(ledger.problems, [
            {
                file: "http-client.private.env.json",
                key: "production.token",
                message:
                    'is a secret with a value in the file. The value is ignored and never sent; give the secret in api.secrets as "token"',
                level: "warning",
            },
        ]);
        assert.ok(!JSON.stringify(ledger.problems).includes("plain-prod-token-0123456789"));
    });

    test("a private file may hold an environment the public one lacks, and a secret is a secret in every environment", () => {
        const only = folder({
            "http-client.env.json": '{"dev": {"baseUrl": "https://a.example.test"}}',
            "http-client.private.env.json": '{"dev": {"token": ""}, "qa": {"token": "", "other": ""}}',
            "r.http": "GET {{baseUrl}}/x\nAuthorization: Bearer {{token}}\n",
        });
        assert.deepEqual([...only.environments.keys()], ["dev", "qa"]);
        assert.equal(only.environments.get("qa")?.file, "http-client.private.env.json");
        assert.deepEqual(only.requests[0]?.secrets, ["token"]);
    });

    test("a list is a problem, Security is not read, and a file that is not JSON is an error", () => {
        const odd = folder({
            "http-client.env.json": '{"dev": {"ids": [1, 2], "Security": {"Auth": {}}, "ok": "yes"}, "bad": 5}',
            "r.http": "GET https://a.example.test/\n",
        });
        assert.deepEqual(
            [...(odd.environments.get("dev")?.variables ?? [])].map(([key]) => key),
            ["ok"],
        );
        assert.deepEqual(odd.problems.map((p) => [p.key, p.level]).sort(), [
            ["bad", "warning"],
            ["dev.Security", "warning"],
            ["dev.ids", "warning"],
        ]);
        const broken = folder({ "http-client.env.json": "{ nope", "r.http": "GET https://a.example.test/\n" });
        assert.deepEqual(
            broken.problems.map((p) => [p.file, p.message, p.level]),
            [["http-client.env.json", "is not valid JSON", "error"]],
        );
        assert.equal(broken.requests.length, 1, "the requests still load");
    });
});

describe("scripts", () => {
    test("a pre-request script refuses the request, and a response handler is ignored with a note", () => {
        assert.deepEqual(request("Rebuild index").scripts, { prerequest: true, where: "the request" });
        assert.deepEqual(request("Get order").scripts, { prerequest: false });
        assert.deepEqual(request("Get order").notes, ["its response handler script is ignored (scripts never run)"]);
    });

    test("a script on one line, one in a file, and a response saved to a file", () => {
        const [one, handler, saved] = requestsOf(
            [
                "< {% request.variables.set('a', 'b') %}",
                "GET https://a.example.test/1",
                "###",
                "GET https://a.example.test/2",
                "",
                "> ./check.js",
                "###",
                "GET https://a.example.test/3",
                "",
                ">> out.json",
            ].join("\n"),
        );
        assert.equal(one?.scripts.prerequest, true);
        assert.deepEqual(
            [handler?.scripts.prerequest, handler?.notes],
            [false, ["its response handler script is ignored (scripts never run)"]],
        );
        assert.deepEqual(saved?.notes, ["its response is not saved to a file"]);
    });

    test("a script's lines are not read as a request", () => {
        const found = requestsOf(
            "< {%\n    GET https://not-a-request.example.test/\n%}\nGET https://a.example.test/real\n",
        );
        assert.equal(found.length, 1);
        assert.equal(found[0]?.url, "https://a.example.test/real");
    });
});

describe("protocols", () => {
    test("WEBSOCKET, GRPC and a ws:// or grpc:// address are listed and refused", () => {
        assert.match(request("Watch orders").unsupported ?? "", /^WEBSOCKET is not plain HTTP/);
        assert.match(request("Stream calls").unsupported ?? "", /^GRPC is not plain HTTP/);
        const [found] = requestsOf("GET wss://a.example.test/socket\n");
        assert.match(found?.unsupported ?? "", /^the address uses wss:\/\//);
        const [odd] = requestsOf("LOCK https://a.example.test/x\n");
        assert.match(odd?.unsupported ?? "", /^the method LOCK is not sent/);
    });

    test("GraphQL: GRAPHQL (JetBrains) and X-Request-Type: GraphQL (VS Code) are a POST of a query and its variables", () => {
        const jetbrains = request("Orders by status");
        assert.equal(jetbrains.method, "POST");
        assert.deepEqual(jetbrains.body, {
            kind: "graphql",
            query: "query ($status: String!) {\n  orders(status: $status) { id total }\n}",
            variables: '{ "status": "{{status}}" }',
        });
        assert.deepEqual(jetbrains.headers, [
            ["Authorization", "Bearer {{token}}"],
            ["Content-Type", "application/json"],
        ]);
        const vscode = request("Orders by status (VS Code)");
        assert.deepEqual(vscode.body, { kind: "graphql", query: "query { orders { id } }" });
        assert.deepEqual(
            vscode.headers.map(([name]) => name),
            ["Content-Type", "Authorization"],
            "X-Request-Type is for the editor",
        );
    });

    test("a GraphQL query with blank lines in it is not cut at the first one", () => {
        const [found] = requestsOf('GRAPHQL https://a.example.test/graphql\n\nquery {\n  a\n\n  b\n}\n\n{ "x": 1 }\n');
        assert.deepEqual(found?.body, { kind: "graphql", query: "query {\n  a\n\n  b\n}", variables: '{ "x": 1 }' });
    });
});

describe("sign-in", () => {
    test("Authorization: Basic with a user and a password in two words, or as user:password, is a sign-in the tool builds", () => {
        assert.deepEqual(request("Basic status").auth, {
            kind: "basic",
            username: "{{serviceUser}}",
            password: "{{servicePassword}}",
        });
        assert.deepEqual(request("Basic status").headers, [], "the header is not kept: the tool builds it");
        assert.deepEqual(request("Basic status").signsIn, ["serviceUser", "servicePassword"]);
        const [colon] = requestsOf("GET https://a.example.test/\nAuthorization: Basic {{u}}:{{p}}\n");
        assert.deepEqual(colon?.auth, { kind: "basic", username: "{{u}}", password: "{{p}}" });
    });

    test("a Basic header that is already encoded is kept as a header, and Bearer is a header", () => {
        const [encoded] = requestsOf("GET https://a.example.test/\nAuthorization: Basic dXNlcjpwYXNzd2Q=\n");
        assert.equal(encoded?.auth.kind, "none");
        assert.deepEqual(encoded?.headers, [["Authorization", "Basic dXNlcjpwYXNzd2Q="]]);
        assert.deepEqual(request("Get order").headers, [
            ["Accept", "application/json"],
            ["Authorization", "Bearer {{token}}"],
        ]);
    });

    test("Digest is refused by its name", () => {
        assert.equal(request("Digest status").unsupported, "Digest authentication is not sent");
    });
});

describe("bodies", () => {
    test("a body is text, JSON or XML by its content type, and a form on several lines is one line", () => {
        assert.deepEqual(request("Create order").body?.kind, "json");
        assert.deepEqual(request("Place order (form)").body, {
            kind: "raw",
            text: "customer={{customerId}}&note={{note}}",
            language: "urlencoded",
        });
        const [xml, plain] = requestsOf(
            "POST https://a.example.test/1\nContent-Type: application/xml\n\n<a/>\n###\nPOST https://a.example.test/2\n\nhello\nworld\n",
        );
        assert.deepEqual(xml?.body, { kind: "raw", text: "<a/>", language: "xml" });
        assert.deepEqual(plain?.body, { kind: "raw", text: "hello\nworld", language: "text" });
    });

    test("< ./file as the whole body is a file", () => {
        assert.deepEqual(request("Import orders").body, { kind: "file", file: { path: "./receipt.txt" } });
        const [variables] = requestsOf("POST https://a.example.test/\n\n<@ ./file.txt\n");
        assert.match(variables?.unsupported ?? "", /^`<@`/);
    });

    test("a multipart body is read into its parts, and < ./file in a part is a file", () => {
        assert.deepEqual(request("Upload receipt").body, {
            kind: "form",
            encoding: "multipart",
            boundary: "ReceiptBoundary",
            fields: [
                { kind: "text", name: "note", value: "{{note}}" },
                {
                    kind: "file",
                    name: "receipt",
                    file: { path: "./receipt.txt" },
                    filename: "receipt.txt",
                    contentType: "text/plain",
                },
            ],
        });
        const [nameless] = requestsOf(
            "POST https://a.example.test/\nContent-Type: multipart/form-data; boundary=B\n\n--B\nContent-Disposition: form-data\n\nx\n--B--\n",
        );
        assert.match(nameless?.unsupported ?? "", /has no name/);
        const [noBoundary] = requestsOf("POST https://a.example.test/\nContent-Type: multipart/form-data\n\n--B\n");
        assert.match(noBoundary?.unsupported ?? "", /names no boundary/);
    });
});

describe("a folder that cannot be read", () => {
    test("is an error with the folder named, and no request", () => {
        const missing = read(path.join(scratch, "no-such-folder"));
        assert.deepEqual(missing.requests, []);
        assert.deepEqual(
            missing.problems.map((p) => [p.file, p.message, p.level]),
            [[".", "the folder does not exist", "error"]],
        );
    });

    test("a file that is too large is an error and the others still load", () => {
        const big = folder({
            "big.http": `GET https://a.example.test/\n\n${"x".repeat(1024 * 1024)}`,
            "small.http": "GET https://a.example.test/small\n",
        });
        assert.deepEqual(
            big.requests.map((r) => r.url),
            ["https://a.example.test/small"],
        );
        assert.deepEqual(
            big.problems.map((p) => [p.file, p.message]),
            [["big.http", "is larger than 1024 KiB"]],
        );
    });
});

describe("the configuration of a folder", () => {
    test("check returns the folder, and reports a mistake with its key", () => {
        const errors: string[] = [];
        assert.deepEqual(httpFile.check({ http: "/work/http" }, "api.collections.a", errors), { folder: "/work/http" });
        assert.equal(httpFile.check({ http: "/work/http", extra: 1 }, "api.collections.a", errors), undefined);
        assert.deepEqual(errors, ["api.collections.a.extra: unknown field"]);
        assert.equal(httpFile.kind, "http");
    });
});
