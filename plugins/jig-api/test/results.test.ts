// What the model reads: a status line, the target, a few headers and the body. A non-2xx answer is a normal result. JSON is
// re-indented with its numbers untouched, other text is cut at 200 lines, and the facts of the call's record are the status.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { prettyJson } from "../src/engine/json.ts";
import { shownHeaders } from "../src/engine/render.ts";
import { SHOWN_LINES } from "../src/engine/values.ts";
import { MAX_ANSWER_BYTES } from "../src/engine/wire.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());
beforeEach(() => h.reset());

const GET = { method: "GET", path: "/v1/x" };
const lines = (count: number, prefix = "line"): string =>
    Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");

describe("the status line", () => {
    test("names the method, the full address and the status with its words, then the request and its environment", async () => {
        h.api.respond = () => ({ status: 201, body: '{"id":7}' });
        const text = ok(await h.call({ method: "POST", path: "/v1/items?x=1", body: {} }));
        const [first, second] = text.split("\n");
        assert.equal(first, `POST ${h.api.origin}/v1/items?x=1 -> HTTP 201 Created`);
        assert.equal(second, "Request: call (base) in Staging (staging)");
    });

    test("a status without words has none", async () => {
        h.api.respond = () => ({ status: 299, body: "x", headers: { "content-type": "text/plain" } });
        assert.equal(ok(await h.call(GET)).split("\n")[0], `GET ${h.api.origin}/v1/x -> HTTP 299`);
    });

    test("the words are the standard ones, not the server's, so a server cannot put text there", async () => {
        h.api.respond = () => ({ status: 200, body: "{}" });
        assert.match(ok(await h.call(GET)), /-> HTTP 200 OK\n/);
    });
});

describe("the headers shown", () => {
    test("content-type, location and trace or request ids, at most six, and nothing else", async () => {
        h.api.respond = () => ({
            headers: {
                "content-type": "text/plain",
                location: "/elsewhere",
                traceparent: "00-abc-def-01",
                "x-amzn-trace-id": "Root=1-abc",
                "x-b3-traceid": "b3",
                "x-correlation-id": "c1",
                "x-extra-trace": "e",
                "x-request-id": "r1",
                "x-amzn-requestid": "r2",
                server: "nginx",
                "set-cookie": "s=1",
                "cache-control": "no-store",
                etag: '"abc"',
                "x-powered-by": "x",
            },
            body: "ok",
        });
        const text = ok(await h.call(GET));
        const shown = text.split("\n").filter((line) => /^[a-z0-9-]+: /.test(line));
        assert.deepEqual(shown, [
            "content-type: text/plain",
            "location: /elsewhere",
            "traceparent: 00-abc-def-01",
            "x-amzn-requestid: r2",
            "x-amzn-trace-id: Root=1-abc",
            "x-b3-traceid: b3",
        ]);
        for (const hidden of ["nginx", "s=1", "no-store", 'abc"', "x-powered-by"])
            assert.ok(!text.includes(hidden), hidden);
    });

    test("shownHeaders keeps the names in lower case, one line each, and cuts a long value", () => {
        const long = "x".repeat(300);
        assert.deepEqual(shownHeaders({ "content-type": "a", "x-request-id": long, other: "b" }), [
            "content-type: a",
            `x-request-id: ${"x".repeat(200)}`,
        ]);
        assert.deepEqual(shownHeaders({ location: "a\tb  c" }), ["location: a b c"]);
        assert.deepEqual(shownHeaders({}), []);
    });
});

describe("a JSON body", () => {
    test("is re-indented by two spaces, with numbers, strings and escapes untouched", async () => {
        const raw =
            '{"id":12345678901234567890,"price":1.50,"big":1e3,"neg":-0,"third":0.10000000000000001,"s":"a \\"b\\" {x} [y], z \\u00e9 \\\\","e":{},"l":[],"a":[1,{"k":null}],"t":true}';
        h.api.respond = () => ({ body: raw });
        const text = ok(await h.call(GET));
        const body = text.slice(text.indexOf("\n\n") + 2);
        assert.equal(
            body,
            [
                "{",
                '  "id": 12345678901234567890,',
                '  "price": 1.50,',
                '  "big": 1e3,',
                '  "neg": -0,',
                '  "third": 0.10000000000000001,',
                '  "s": "a \\"b\\" {x} [y], z \\u00e9 \\\\",',
                '  "e": {},',
                '  "l": [],',
                '  "a": [',
                "    1,",
                "    {",
                '      "k": null',
                "    }",
                "  ],",
                '  "t": true',
                "}",
            ].join("\n"),
        );
        assert.deepEqual(JSON.parse(body), JSON.parse(raw), "the same data");
    });

    test("is not cut here, however long: jig-core cuts a long result and keeps the whole text", async () => {
        const list = Array.from({ length: 500 }, (_, index) => ({ id: index }));
        h.api.respond = () => ({ body: JSON.stringify(list) });
        const body = ok(await h.call(GET))
            .split("\n\n")
            .slice(1)
            .join("\n\n");
        assert.ok(body.split("\n").length > 1500);
        assert.ok(body.includes('"id": 499'));
        assert.doesNotMatch(body, /more lines/);
    });

    test("is recognised whatever the content type says", async () => {
        h.api.respond = () => ({ body: '{"a":1}', headers: { "content-type": "text/plain" } });
        assert.match(ok(await h.call(GET)), /\n\n\{\n {2}"a": 1\n\}$/);
    });

    test("a JSON value that is not an object or a list is shown as it is", async () => {
        const cases: Array<[raw: string, shown: string]> = [
            ["42", "42"],
            ['"text"', '"text"'],
            ["true", "true"],
            ["null", "null"],
            [" [ 1 , 2 ] ", "[\n  1,\n  2\n]"],
        ];
        for (const [raw, shown] of cases) {
            h.api.respond = () => ({ body: raw });
            assert.ok(ok(await h.call(GET)).endsWith(`\n\n${shown}`), raw);
        }
    });

    test("a byte-order mark does not stop it from being read as JSON", async () => {
        h.api.respond = () => ({ body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]) });
        assert.match(ok(await h.call(GET)), /\n\n\{\n {2}"a": 1\n\}$/);
    });

    test("prettyJson re-indents nested data, keeps empty containers on one line, and refuses what is not JSON", () => {
        assert.equal(
            prettyJson('{"a":[],"b":{},"c":[{}],"d":[[]]}'),
            '{\n  "a": [],\n  "b": {},\n  "c": [\n    {}\n  ],\n  "d": [\n    []\n  ]\n}',
        );
        assert.equal(prettyJson('{ "a" : [ ] , "b" : { } }'), '{\n  "a": [],\n  "b": {}\n}');
        assert.equal(prettyJson('{"s":"[{,:}]"}'), '{\n  "s": "[{,:}]"\n}');
        assert.equal(prettyJson("42"), "42");
        assert.equal(prettyJson(" \n true \n"), "true");
        for (const text of ["not json", '{"a":', "", "{'a':1}", "[1,]", "{} {}"])
            assert.equal(prettyJson(text), undefined, text);
        assert.equal(JSON.stringify(JSON.parse(prettyJson('{"a":[1,2,{"b":null}]}') ?? "")), '{"a":[1,2,{"b":null}]}');
    });
});

describe("a text body", () => {
    test("shows the first 200 lines and counts the rest", async () => {
        h.api.respond = () => ({ body: lines(250), headers: { "content-type": "text/plain" } });
        const shown = ok(await h.call(GET)).split("\n");
        assert.equal(SHOWN_LINES, 200);
        assert.ok(shown.includes("line 200") && !shown.includes("line 201"));
        assert.equal(shown.at(-1), "[50 more lines not shown]");
    });

    test("shows 200 lines whole, and counts a single extra line", async () => {
        h.api.respond = () => ({ body: lines(200), headers: { "content-type": "text/plain" } });
        assert.ok(!ok(await h.call(GET)).includes("more lines"));
        h.api.respond = () => ({ body: lines(201), headers: { "content-type": "text/plain" } });
        assert.ok(ok(await h.call(GET)).endsWith("line 200\n[1 more lines not shown]"));
    });

    test("reads CRLF line ends", async () => {
        h.api.respond = () => ({
            body: lines(210).replaceAll("\n", "\r\n"),
            headers: { "content-type": "text/plain" },
        });
        const text = ok(await h.call(GET));
        assert.ok(text.endsWith("line 200\n[10 more lines not shown]"));
        assert.ok(!text.includes("\r"));
    });

    test("passes other text through, including non-ASCII", async () => {
        h.api.respond = () => ({
            body: "héllo wörld ✓\n<html>&amp;</html>",
            headers: { "content-type": "text/html; charset=utf-8" },
        });
        assert.ok(ok(await h.call(GET)).endsWith("\n\nhéllo wörld ✓\n<html>&amp;</html>"));
    });

    test("a byte that is not UTF-8 becomes a replacement character", async () => {
        h.api.respond = () => ({ body: Buffer.from([0x61, 0xff, 0x62]), headers: { "content-type": "text/plain" } });
        assert.ok(ok(await h.call(GET)).endsWith("\n\na�b"));
    });

    test("a compressed answer is read as text", async () => {
        h.api.respond = () => ({
            body: gzipSync(Buffer.from('{"zipped":true}')),
            headers: { "content-encoding": "gzip" },
        });
        assert.match(ok(await h.call(GET)), /\n\n\{\n {2}"zipped": true\n\}$/);
    });
});

describe("a body that is not text, empty or too long", () => {
    test("an empty body, and one of white space only, say so", async () => {
        h.api.respond = () => ({ status: 204, body: "" });
        assert.ok(ok(await h.call({ method: "DELETE", path: "/v1/x" }, { ask: false })).endsWith("\n\n(empty body)"));
        h.api.respond = () => ({ body: " \n\t " });
        assert.ok(ok(await h.call(GET)).endsWith("\n\n(empty body)"));
    });

    test("a body with a NUL byte is binary: its size is shown and not its bytes", async () => {
        h.api.respond = () => ({
            body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]),
            headers: { "content-type": "image/png" },
        });
        const text = ok(await h.call(GET));
        assert.ok(text.endsWith("\n\n(binary body, 8 bytes)"), text);
        assert.match(text, /\ncontent-type: image\/png\n/);
    });

    test("a body over 2 MiB is cut there, and the result says so", async () => {
        const text = `${lines(250_000)}\n`;
        assert.ok(Buffer.byteLength(text) > MAX_ANSWER_BYTES);
        h.api.respond = () => ({ body: text, headers: { "content-type": "text/plain" } });
        const result = ok(await h.call(GET));
        assert.ok(result.endsWith(`[the answer was cut at ${MAX_ANSWER_BYTES} bytes]`));
        assert.ok(result.length < 10_000, "and the lines are cut at 200 as well");
    });

    test("a JSON body that is cut is shown as text, because it is no longer JSON", async () => {
        const json = JSON.stringify({ list: Array.from({ length: 400_000 }, (_, index) => index) });
        assert.ok(json.length > MAX_ANSWER_BYTES);
        h.api.respond = () => ({ body: json });
        const result = ok(await h.call(GET));
        assert.ok(result.endsWith(`[the answer was cut at ${MAX_ANSWER_BYTES} bytes]`));
        assert.doesNotMatch(result, /\n {2}"list": \[\n/);
    });
});

describe("an answer that is not a success", () => {
    for (const [status, words] of [
        [400, "Bad Request"],
        [401, "Unauthorized"],
        [403, "Forbidden"],
        [404, "Not Found"],
        [409, "Conflict"],
        [422, "Unprocessable Entity"],
        [429, "Too Many Requests"],
        [500, "Internal Server Error"],
    ] as const) {
        test(`${status} is a result with its body, not an error`, async () => {
            h.api.respond = () => ({ status, body: JSON.stringify({ message: `it is ${status}` }) });
            const result = await h.call(GET);
            assert.equal(result.error, undefined);
            assert.match(result.text, new RegExp(`-> HTTP ${status} ${words}\\n`));
            assert.match(result.text, new RegExp(`"message": "it is ${status}"`));
            assert.deepEqual(h.jig.facts.get(result.id), [{ status }]);
        });
    }

    test("a redirect is a result too: it says where the server points, and that it was not followed", async () => {
        h.api.respond = () => ({ status: 301, headers: { location: "https://elsewhere.example.test/new" }, body: "" });
        const text = ok(await h.call(GET));
        assert.match(
            text,
            /-> HTTP 301 Moved Permanently\nRequest: call \(base\) in Staging \(staging\)\nRedirects are not followed: the location header says where the server points\.\ncontent-type: application\/json\nlocation: https:\/\/elsewhere\.example\.test\/new\n/,
        );
        h.api.respond = () => ({ status: 304, body: "" });
        assert.doesNotMatch(ok(await h.call(GET)), /Redirects are not followed/, "a 304 has no place to go");
    });
});

describe("what the call's record carries", () => {
    test("the status, as a fact, and the request, the method and the status in the details", async () => {
        h.api.respond = () => ({ status: 201, body: "{}" });
        const result = await h.call({ method: "POST", path: "/v1/items", body: {} });
        ok(result);
        assert.deepEqual(h.jig.facts.get(result.id), [{ status: 201 }]);
        assert.deepEqual(result.details, { request: "call", method: "POST", status: 201 });
    });

    test("nothing, when there was no answer to take a status from", async () => {
        h.configure(h.section({ transport: "company-proxy" }));
        const result = await h.call(GET);
        assert.ok(result.error);
        assert.equal(h.jig.facts.size, 0);
    });
});

describe("an answer through a transport", () => {
    test("is rendered the same way, and a long text is cut at 200 lines", async () => {
        h.configure(h.section({ transport: "company-proxy" }));
        h.jig.transports.set("company-proxy", {
            request: async () => ({ status: 200, headers: { "Content-Type": "text/plain" }, body: lines(210) }),
        });
        const text = ok(await h.call(GET));
        assert.match(
            text,
            /^GET \S+ -> HTTP 200 OK\nRequest: call \(base\) in Staging \(staging\)\ncontent-type: text\/plain\n\nline 1\n/,
        );
        assert.ok(text.endsWith("line 200\n[10 more lines not shown]"));
    });

    test("a body with a NUL character is binary", async () => {
        h.configure(h.section({ transport: "company-proxy" }));
        h.jig.transports.set("company-proxy", {
            request: async () => ({ status: 200, headers: {}, body: "ab\u0000cd" }),
        });
        assert.ok(ok(await h.call(GET)).endsWith("\n\n(binary body, 5 bytes)"));
    });
});
