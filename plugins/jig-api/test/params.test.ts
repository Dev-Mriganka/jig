// The checks on a call, without a network: the target, the path, the body, the headers and the timeout. Each is strict
// about what may go to the server, and each refusal says what to change.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readHttp } from "../src/config.ts";
import type { HttpSettings } from "../src/config.ts";
import { findTarget, isMethod, MAX_BODY_BYTES, METHODS, parseCall, USAGE } from "../src/params.ts";
import { InputError } from "../src/values.ts";

function settingsOf(section: Record<string, unknown>): HttpSettings {
    const read = readHttp(section);
    assert.deepEqual(read.errors, []);
    assert.ok(read.settings);
    return read.settings;
}

const settings = settingsOf({
    targets: {
        api: { baseUrl: "https://api.example.test/v1", environment: "staging", auth: { none: true }, description: "The test API" },
        live: { baseUrl: "https://live.example.test", environment: "production", auth: { none: true } },
    },
});

const base: Record<string, unknown> = { target: "api", method: "GET", path: "/accounts/123" };
const call = (extra: Record<string, unknown> = {}) => parseCall({ ...base, ...extra }, settings);

/** The call is refused with an InputError, which is a TypeError, and the message matches. */
function refuses(extra: Record<string, unknown>, pattern: RegExp): void {
    assert.throws(
        () => call(extra),
        (error: unknown) => error instanceof InputError && error instanceof TypeError && pattern.test(error.message),
        `expected a refusal matching ${pattern}`,
    );
}

describe("a minimal call", () => {
    test("gets its defaults", () => {
        const found = call();
        assert.equal(found.target.name, "api");
        assert.deepEqual(
            [found.method, found.path, found.query, found.body, found.headers, found.timeoutSec],
            ["GET", "/accounts/123", "", undefined, [], 30],
        );
    });

    test("the methods are GET, POST, PUT, PATCH and DELETE, and nothing else", () => {
        assert.deepEqual([...METHODS], ["GET", "POST", "PUT", "PATCH", "DELETE"]);
        for (const method of METHODS) assert.equal(call({ method }).method, method);
        for (const method of ["HEAD", "OPTIONS", "get", "Post", "", 5, null]) assert.equal(isMethod(method), false, String(method));
        refuses({ method: "HEAD" }, /method must be one of GET, POST, PUT, PATCH, DELETE/);
        refuses({ method: "get" }, /method must be one of/);
    });
});

describe("the shape of a call", () => {
    test("a missing parameter is refused with the usage line", () => {
        for (const missing of ["target", "method", "path"]) {
            const { [missing]: _removed, ...rest } = base;
            assert.throws(() => parseCall(rest, settings), (error: unknown) =>
                error instanceof InputError && error.message === `http needs ${missing}. ${USAGE}`);
        }
        assert.throws(() => parseCall({}, settings), /^InputError: http needs target, method, path\. Usage: http \{target, method, path, body\?, headers\?, timeoutSec\?\}$/);
    });

    test("a parameter the tool does not have is refused with the usage line; null and undefined mean unused", () => {
        refuses({ verbose: true }, /^http does not use verbose\. Usage: http \{/);
        refuses({ verbose: true, retries: 3 }, /^http does not use verbose, retries\./);
        assert.equal(call({ verbose: null, retries: undefined }).method, "GET");
        assert.equal(USAGE, "Usage: http {target, method, path, body?, headers?, timeoutSec?}");
    });
});

describe("the target", () => {
    test("an unknown one is invalid input that names the known targets, with their environments and descriptions", () => {
        assert.throws(
            () => call({ target: "nope" }),
            (error: unknown) => error instanceof InputError && error instanceof TypeError
                && error.message === 'http: no target named "nope". Known targets: api (staging: The test API), live (production)',
        );
    });

    test("a target that is not text is unknown too, and a missing one says so", () => {
        refuses({ target: 5 }, /^http: no target named 5\. Known targets:/);
        assert.throws(() => findTarget(settings, undefined), /^InputError: http needs target\. Known targets: api/);
    });

    test("a name that is only a name on an object is not a target", () => {
        for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) refuses({ target: name }, /no target named/);
    });

    test("a long list of targets is cut, so the message stays short", () => {
        const many = settingsOf({
            targets: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`target-${index}`, { baseUrl: "https://a.example.test", environment: "staging", auth: { none: true } }])),
        });
        assert.throws(() => findTarget(many, "nope"), (error: unknown) => error instanceof Error && error.message.length < 220 && /\(and \d+ more\)$/.test(error.message));
    });

    test("without settings, every call says the tool is not set up", () => {
        assert.throws(() => parseCall(base, undefined), /^InputError: http is not set up: add an "http" section/);
        assert.throws(() => findTarget(undefined, "api"), (error: unknown) => error instanceof TypeError);
    });
});

describe("the path", () => {
    test("allows the documented characters, one optional query, and splits at the ?", () => {
        const found = call({ path: "/v1/a-b_c.d~e/!$&'()*+,;=:@%20x?x=1&y=%2F&z='1'" });
        assert.equal(found.path, "/v1/a-b_c.d~e/!$&'()*+,;=:@%20x");
        assert.equal(found.query, "?x=1&y=%2F&z='1'");
        assert.equal(call({ path: "/" }).path, "/");
        assert.equal(call({ path: "/x?" }).query, "?");
        assert.equal(call({ path: "/a//b" }).path, "/a//b");
    });

    test("paths outside the documented characters are refused", () => {
        const paths = [
            "v1/a", "", "/a b", "/a#frag", "/a\\b", "/a?b?c", "/a[0]", "/a{b}", "/a|b", "/a\nb", "/a\r\nHost: x", "/a\u0000b", "/é",
            "/a\tb", "https://other.test/x", "?x=1", `/${"a".repeat(401)}`, `/a?${"b".repeat(401)}`,
        ];
        for (const path of paths) refuses({ path }, /path/);
        assert.equal(call({ path: `/${"a".repeat(400)}` }).path.length, 401);
        assert.equal(call({ path: `/a?${"b".repeat(400)}` }).query.length, 401);
    });

    test("a path that is not text is refused", () => {
        for (const path of [5, {}, ["/a"], true]) refuses({ path }, /path/);
    });

    test("parent-directory segments are refused", () => {
        for (const path of ["/a/../b", "/..", "/a/..", "/a/..;/b", "/a?x=..", "/a/.../b", "/a..b"]) refuses({ path }, /path/);
        assert.equal(call({ path: "/a/b.c/.d" }).path, "/a/b.c/.d");
        assert.equal(call({ path: "/a/b.c/d." }).path, "/a/b.c/d.");
    });

    test("parent-directory segments are refused when percent-encoded, in any case and mixture", () => {
        for (const path of ["/a/%2e%2e/b", "/a/%2E%2E/b", "/a/.%2e/b", "/a/%2e./b", "/a/.%2E/b", "/a/%2E./b", "/a/%2e%2e", "/a?x=%2e%2e"]) {
            refuses({ path }, /path/);
        }
    });

    test("parent-directory segments are refused when encoded twice or more, as a proxy that decodes again would read them", () => {
        for (const path of ["/a/%252e%252e/b", "/a/%252E%252E/b", "/a/.%252e/b", "/a/%252e./b", "/a/%25252e%25252e/b", "/a/%2525252e%2525252e/b"]) {
            refuses({ path }, /path/);
        }
    });

    test("text that keeps changing as it is decoded is refused", () => {
        refuses({ path: `/a/${"%25".repeat(12)}2e%${"25".repeat(12)}2e` }, /path/);
    });

    test("a single encoded dot, and encoded text that is not dots, are fine", () => {
        assert.equal(call({ path: "/a/%2e/b" }).path, "/a/%2e/b");
        assert.equal(call({ path: "/a/%252e/b" }).path, "/a/%252e/b");
        assert.equal(call({ path: "/files/100%25" }).path, "/files/100%25");
        assert.equal(call({ path: "/files/50%25off" }).path, "/files/50%25off");
        assert.equal(call({ path: "/q/%zz/%2" }).path, "/q/%zz/%2");
    });

    test("the refusal quotes the path cut short and says what is allowed", () => {
        assert.throws(() => call({ path: `/${"x".repeat(500)} y` }), (error: unknown) =>
            error instanceof Error && /must start with \/ and hold only letters, digits/.test(error.message) && error.message.length < 400);
    });
});

describe("the body", () => {
    test("a GET takes no body; null and undefined mean none", () => {
        refuses({ body: { a: 1 } }, /a GET has no body/);
        refuses({ body: {} }, /a GET has no body/);
        refuses({ body: "" }, /a GET has no body/);
        refuses({ body: 0 }, /a GET has no body/);
        assert.equal(call({ body: null }).body, undefined);
        assert.equal(call({ body: undefined }).body, undefined);
        assert.equal(call({ method: "POST", body: null }).body, undefined);
    });

    test("any JSON value is serialized once and compactly", () => {
        assert.equal(call({ method: "POST", body: { a: [1, "ü"] } }).body, '{"a":[1,"ü"]}');
        assert.equal(call({ method: "PUT", body: "text" }).body, '"text"');
        assert.equal(call({ method: "PATCH", body: 0 }).body, "0");
        assert.equal(call({ method: "POST", body: false }).body, "false");
        assert.equal(call({ method: "DELETE", body: [] }).body, "[]");
        assert.equal(call({ method: "POST", body: "" }).body, '""');
    });

    test("the limit is 256 KiB of bytes, not of characters", () => {
        assert.equal(MAX_BODY_BYTES, 262_144);
        const exactly = call({ method: "POST", body: { s: "a".repeat(MAX_BODY_BYTES - '{"s":""}'.length) } }).body;
        assert.equal(Buffer.byteLength(exactly ?? ""), MAX_BODY_BYTES);
        refuses({ method: "POST", body: { s: "a".repeat(MAX_BODY_BYTES - '{"s":""}'.length + 1) } }, /body is larger than 256 KiB/);
        refuses({ method: "POST", body: { s: "ü".repeat(140_000) } }, /body is larger than 256 KiB/);
    });

    test("what is not JSON is refused", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        refuses({ method: "POST", body: cyclic }, /body must be a JSON value/);
        refuses({ method: "POST", body: () => 1 }, /body must be a JSON value/);
        refuses({ method: "POST", body: Symbol("x") }, /body must be a JSON value/);
        refuses({ method: "POST", body: 10n }, /body must be a JSON value/);
    });
});

describe("the headers", () => {
    test("up to 10 are kept in the order given", () => {
        assert.deepEqual(call({ headers: { "X-Request-Id": "t1", lob: "VBC" } }).headers, [["X-Request-Id", "t1"], ["lob", "VBC"]]);
        const ten = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`X-H${index}`, "v"]));
        assert.equal(call({ headers: ten }).headers.length, 10);
        refuses({ headers: { ...ten, "X-H10": "v" } }, /at most 10 headers \(got 11\)/);
        assert.deepEqual(call({ headers: {} }).headers, []);
        assert.deepEqual(call({ headers: null }).headers, []);
    });

    test("the headers that carry a sign-in or control the connection are refused, in any case", () => {
        const names = [
            "Authorization", "Host", "Cookie", "Content-Length", "Transfer-Encoding", "Connection", "Upgrade", "Proxy-Authorization",
            "TE", "Expect",
        ];
        for (const name of names) {
            for (const spelled of [name, name.toLowerCase(), name.toUpperCase()]) {
                refuses({ headers: { [spelled]: "v" } }, /is set by the tool or controls the connection, so it cannot be given/);
            }
        }
    });

    test("so are the headers that ask a server to treat the request as another method, which would turn a GET into a write", () => {
        for (const name of ["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override", "x-http-method-override"]) {
            refuses({ headers: { [name]: "DELETE" } }, /cannot be given/);
        }
    });

    test("names are plain: letters, digits and - starting with a letter, at most 41 characters", () => {
        for (const name of ["1abc", "-x", "a b", "a:b", "a_b", "", "a".repeat(42), "é", "a\nb"]) refuses({ headers: { [name]: "v" } }, /header name/);
        assert.equal(call({ headers: { ["a".repeat(41)]: "v" } }).headers.length, 1);
    });

    test("values are 1 to 1000 printable ASCII characters", () => {
        for (const value of ["line\nbreak", "tab\tchar", "", "é", "a\u007f", "a".repeat(1001), 5, null, {}, ["a"]]) {
            refuses({ headers: { "X-A": value } }, /header X-A must be 1 to 1000 printable ASCII characters/);
        }
        assert.equal(call({ headers: { "X-A": "a".repeat(1000) } }).headers.length, 1);
        assert.equal(call({ headers: { "X-A": " spaced value ~" } }).headers[0]?.[1], " spaced value ~");
    });

    test("a name given twice, in any case, is refused", () => {
        refuses({ headers: { "X-A": "1", "x-a": "2" } }, /header x-a is given twice/);
    });

    test("headers that are not an object of name to value are refused", () => {
        refuses({ headers: ["a"] }, /headers must be an object of name to value/);
        refuses({ headers: "X-A: 1" }, /headers must be an object/);
        refuses({ headers: 5 }, /headers must be an object/);
    });

    test("a Content-Type or Accept the caller gives is allowed: it replaces the tool's", () => {
        assert.equal(call({ method: "POST", headers: { "Content-Type": "application/merge-patch+json" } }).headers[0]?.[1], "application/merge-patch+json");
        assert.equal(call({ headers: { Accept: "text/csv" } }).headers[0]?.[1], "text/csv");
    });
});

describe("the timeout", () => {
    test("is a whole number of seconds from 1 to 120, 30 by default", () => {
        assert.equal(call().timeoutSec, 30);
        assert.equal(call({ timeoutSec: 1 }).timeoutSec, 1);
        assert.equal(call({ timeoutSec: 120 }).timeoutSec, 120);
        assert.equal(call({ timeoutSec: null }).timeoutSec, 30);
        for (const timeoutSec of [0, 121, 1.5, "30", -1, Number.NaN, Infinity, true, 2 ** 53]) refuses({ timeoutSec }, /timeoutSec must be a whole number from 1 to 120/);
    });
});
