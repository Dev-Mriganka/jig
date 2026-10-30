// The checks on a call, without a network. The shape of each action; and, for the one request the agent writes itself (`call`),
// the address, the body, the headers and the timeout. Each is strict about what may go to the server, and each refusal says
// what to change.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkBody, checkHeaders, checkTimeout, checkUrl, climbs, MAX_BODY_BYTES } from "../src/ad-hoc.ts";
import { InputError } from "../src/engine/values.ts";
import { ACTION_NAMES, ACTIONS, isAction, parseCall, usage } from "../src/params.ts";

/** The call is refused with an InputError, which is a TypeError, and the message matches. */
function refuses(work: () => unknown, pattern: RegExp): void {
    assert.throws(
        work,
        (error: unknown) => error instanceof InputError && error instanceof TypeError && pattern.test(error.message),
        `expected a refusal matching ${pattern}`,
    );
}

describe("the actions", () => {
    test("are list, show, run, run-folder and call, and each says what it needs", () => {
        assert.deepEqual([...ACTION_NAMES], ["list", "show", "run", "run-folder", "call"]);
        assert.equal(usage("list"), "Usage: api list {collection?, folder?, text?}");
        assert.equal(usage("show"), "Usage: api show {request, collection?, folder?, environment?}");
        assert.equal(
            usage("run"),
            "Usage: api run {request, environment, collection?, folder?, variables?, timeoutSec?}",
        );
        assert.equal(
            usage("run-folder"),
            "Usage: api run-folder {folder, environment, collection?, variables?, timeoutSec?}",
        );
        assert.equal(
            usage("call"),
            "Usage: api call {environment, method, url, collection?, body?, headers?, timeoutSec?}",
        );
        assert.ok(isAction("run-folder"));
        for (const name of ["constructor", "__proto__", "toString", "Run", "", 5, undefined])
            assert.equal(isAction(name), false, String(name));
        assert.deepEqual(Object.keys(ACTIONS), [...ACTION_NAMES]);
    });

    test("a call keeps the parameters it uses, and leaves out the ones that are null or missing", () => {
        assert.deepEqual(parseCall({ action: "list", collection: "orders", folder: null, text: undefined }), {
            action: "list",
            collection: "orders",
        });
        assert.deepEqual(
            parseCall({ action: "run", request: "Get order", environment: "Staging", variables: { orderId: "1" } }),
            {
                action: "run",
                request: "Get order",
                environment: "Staging",
                variables: { orderId: "1" },
            },
        );
    });

    test("an unknown action is refused with the actions there are", () => {
        refuses(
            () => parseCall({ action: "fly" }),
            /^api: unknown action "fly"; use one of list, show, run, run-folder, call$/,
        );
        refuses(() => parseCall({}), /^api: unknown action undefined;/);
        refuses(() => parseCall({ action: "constructor" }), /unknown action/);
    });

    test("a missing parameter is refused with the usage line", () => {
        refuses(
            () => parseCall({ action: "run", request: "R" }),
            /^api run needs environment\. Usage: api run \{request, environment, /,
        );
        refuses(() => parseCall({ action: "call" }), /^api call needs environment, method, url\. Usage: api call \{/);
        refuses(
            () => parseCall({ action: "run-folder", environment: "Staging" }),
            /^api run-folder needs folder\. Usage: api run-folder \{/,
        );
        refuses(() => parseCall({ action: "show" }), /^api show needs request\./);
    });

    test("a parameter the action does not use is refused with the usage line; null means unused", () => {
        refuses(
            () => parseCall({ action: "list", request: "R" }),
            /^api list does not use request\. Usage: api list \{/,
        );
        refuses(
            () => parseCall({ action: "run", request: "R", environment: "S", url: "x", body: {} }),
            /^api run does not use url, body\. Usage: api run \{/,
        );
        refuses(
            () => parseCall({ action: "call", environment: "S", method: "GET", url: "x", variables: {} }),
            /^api call does not use variables\./,
        );
        assert.deepEqual(parseCall({ action: "list", request: null, url: undefined }), { action: "list" });
    });

    test("names and texts must be text, and variables an object", () => {
        refuses(() => parseCall({ action: "list", collection: 5 }), /^api list: collection must be text \(got 5\)$/);
        refuses(() => parseCall({ action: "list", text: ["a"] }), /text must be text/);
        refuses(
            () => parseCall({ action: "run", request: "R", environment: "S", variables: "orderId=1" }),
            /variables must be an object of name to value/,
        );
        refuses(
            () => parseCall({ action: "run", request: "R", environment: "S", variables: [1] }),
            /variables must be an object/,
        );
    });
});

describe("the address of a call", () => {
    const rest = (url: string): string => checkUrl(url).rest;

    test("is a whole address: the host is kept, and the path and the query are checked", () => {
        assert.deepEqual(checkUrl("https://api.staging.example.test/v1/orders/1?x=2"), {
            origin: "https://api.staging.example.test",
            rest: "/v1/orders/1?x=2",
        });
        assert.deepEqual(checkUrl("http://127.0.0.1:8080"), { origin: "http://127.0.0.1:8080", rest: "/" });
        assert.deepEqual(checkUrl("  https://a.example.test/x  "), { origin: "https://a.example.test", rest: "/x" });
        assert.equal(checkUrl("HTTPS://A.Example.Test/Path").origin, "HTTPS://A.Example.Test");
    });

    test("allows the documented characters, one optional query, and no fragment", () => {
        assert.equal(
            rest("https://a.example.test/v1/a-b_c.d~e/!$&'()*+,;=:@%20x?x=1&y=%2F&z='1'"),
            "/v1/a-b_c.d~e/!$&'()*+,;=:@%20x?x=1&y=%2F&z='1'",
        );
        assert.equal(rest("https://a.example.test/a//b"), "/a//b");
        assert.equal(rest("https://a.example.test/x?"), "/x?");
    });

    test("anything else in the path is refused", () => {
        const paths = [
            "/a b",
            "/a#frag",
            "/a\\b",
            "/a?b?c",
            "/a[0]",
            "/a{b}",
            "/a|b",
            "/é",
            `/${"a".repeat(401)}`,
            `/a?${"b".repeat(401)}`,
            "?x=1",
        ];
        for (const path of paths)
            refuses(() => checkUrl(`https://a.example.test${path}`), /the path must hold only letters, digits/);
        assert.equal(rest(`https://a.example.test/${"a".repeat(400)}`).length, 401);
    });

    test("something that is not a whole web address is refused", () => {
        for (const url of [
            "",
            "  ",
            "/v1/orders",
            "api.example.test/v1",
            "//api.example.test/x",
            5,
            null,
            undefined,
            {},
        ]) {
            refuses(() => checkUrl(url), /^api call: url (?:is required|must be a whole address)/);
        }
        refuses(
            () => checkUrl("ws://a.example.test/x"),
            /^api call: the address uses ws:\/\/, and only http and https are sent \(not WebSocket, gRPC or MQTT\)$/,
        );
        refuses(() => checkUrl("grpc://a.example.test"), /the address uses grpc:\/\//);
        refuses(() => checkUrl("ftp://a.example.test/x"), /the address uses ftp:\/\//);
    });

    test("a user name or password in the address is refused, without being repeated", () => {
        assert.throws(
            () => checkUrl("https://jane:s3cret-pass@a.example.test/x"),
            (error: unknown) =>
                error instanceof InputError &&
                /must not contain a user name or password/.test(error.message) &&
                !error.message.includes("s3cret-pass"),
        );
    });

    test("parent-directory segments are refused, plain, encoded once or more, and in any case and mixture", () => {
        const paths = [
            "/a/../b",
            "/..",
            "/a/..",
            "/a/..;/b",
            "/a?x=..",
            "/a/.../b",
            "/a..b",
            "/a/%2e%2e/b",
            "/a/%2E%2E/b",
            "/a/.%2e/b",
            "/a/%2e./b",
            "/a/%2e%2e",
            "/a?x=%2e%2e",
            "/a/%252e%252e/b",
            "/a/%252E%252E/b",
            "/a/%25252e%25252e/b",
            "/a/%2525252e%2525252e/b",
        ];
        for (const path of paths)
            refuses(() => checkUrl(`https://a.example.test${path}`), /the path must hold only letters/);
    });

    test("text that keeps changing as it is decoded is refused", () => {
        assert.equal(climbs(`/a/${"%25".repeat(12)}2e%${"25".repeat(12)}2e`), true);
        refuses(
            () => checkUrl(`https://a.example.test/a/${"%25".repeat(12)}2e%${"25".repeat(12)}2e`),
            /the path must hold only letters/,
        );
    });

    test("a single encoded dot, and encoded text that is not dots, are fine", () => {
        for (const path of [
            "/a/%2e/b",
            "/a/%252e/b",
            "/files/100%25",
            "/files/50%25off",
            "/q/%zz/%2",
            "/a/b.c/.d",
            "/a/b.c/d.",
        ])
            assert.equal(rest(`https://a.example.test${path}`), path, path);
    });

    test("the refusal quotes the path cut short and says what is allowed", () => {
        assert.throws(
            () => checkUrl(`https://a.example.test/${"x".repeat(500)} y`),
            (error: unknown) =>
                error instanceof Error &&
                /the path must hold only letters, digits/.test(error.message) &&
                error.message.length < 400,
        );
    });
});

describe("the body of a call", () => {
    test("a GET, HEAD or OPTIONS takes no body; null and undefined mean none", () => {
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
            refuses(() => checkBody(method, { a: 1 }), new RegExp(`a ${method} has no body`));
            refuses(() => checkBody(method, ""), /has no body/);
            refuses(() => checkBody(method, 0), /has no body/);
            assert.equal(checkBody(method, null), undefined);
            assert.equal(checkBody(method, undefined), undefined);
        }
        assert.equal(checkBody("POST", null), undefined);
    });

    test("any JSON value is serialized once and compactly", () => {
        assert.equal(checkBody("POST", { a: [1, "ü"] }), '{"a":[1,"ü"]}');
        assert.equal(checkBody("PUT", "text"), '"text"');
        assert.equal(checkBody("PATCH", 0), "0");
        assert.equal(checkBody("POST", false), "false");
        assert.equal(checkBody("DELETE", []), "[]");
        assert.equal(checkBody("POST", ""), '""');
    });

    test("the limit is 256 KiB of bytes, not of characters", () => {
        assert.equal(MAX_BODY_BYTES, 262_144);
        const exactly = checkBody("POST", { s: "a".repeat(MAX_BODY_BYTES - '{"s":""}'.length) });
        assert.equal(Buffer.byteLength(exactly ?? ""), MAX_BODY_BYTES);
        refuses(
            () => checkBody("POST", { s: "a".repeat(MAX_BODY_BYTES - '{"s":""}'.length + 1) }),
            /body is larger than 256 KiB/,
        );
        refuses(() => checkBody("POST", { s: "ü".repeat(140_000) }), /body is larger than 256 KiB/);
    });

    test("what is not JSON is refused", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        for (const body of [cyclic, () => 1, Symbol("x"), 10n])
            refuses(() => checkBody("POST", body), /body must be a JSON value/);
    });
});

describe("the headers of a call", () => {
    test("up to 10 are kept in the order given", () => {
        assert.deepEqual(checkHeaders({ "X-Request-Id": "t1", lob: "VBC" }), [
            ["X-Request-Id", "t1"],
            ["lob", "VBC"],
        ]);
        const ten = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`X-H${index}`, "v"]));
        assert.equal(checkHeaders(ten).length, 10);
        refuses(() => checkHeaders({ ...ten, "X-H10": "v" }), /at most 10 headers \(got 11\)/);
        assert.deepEqual(checkHeaders({}), []);
        assert.deepEqual(checkHeaders(null), []);
    });

    test("the headers that carry a sign-in or control the connection are refused, in any case", () => {
        for (const name of [
            "Authorization",
            "Host",
            "Cookie",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            "Upgrade",
            "Proxy-Authorization",
            "TE",
            "Expect",
        ]) {
            for (const spelled of [name, name.toLowerCase(), name.toUpperCase()]) {
                refuses(
                    () => checkHeaders({ [spelled]: "v" }),
                    /is set by the tool or controls the connection, so it cannot be given/,
                );
            }
        }
    });

    test("so are the headers that ask a server to treat the request as another method, which would turn a GET into a write", () => {
        for (const name of ["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override", "x-http-method-override"])
            refuses(() => checkHeaders({ [name]: "DELETE" }), /cannot be given/);
    });

    test("names are plain: letters, digits and - starting with a letter, at most 41 characters", () => {
        for (const name of ["1abc", "-x", "a b", "a:b", "a_b", "", "a".repeat(42), "é", "a\nb"])
            refuses(() => checkHeaders({ [name]: "v" }), /header name/);
        assert.equal(checkHeaders({ ["a".repeat(41)]: "v" }).length, 1);
    });

    test("values are 1 to 1000 printable ASCII characters", () => {
        for (const value of ["line\nbreak", "tab\tchar", "", "é", "a\u007f", "a".repeat(1001), 5, null, {}, ["a"]]) {
            refuses(() => checkHeaders({ "X-A": value }), /header X-A must be 1 to 1000 printable ASCII characters/);
        }
        assert.equal(checkHeaders({ "X-A": "a".repeat(1000) }).length, 1);
        assert.equal(checkHeaders({ "X-A": " spaced value ~" })[0]?.[1], " spaced value ~");
    });

    test("a name given twice, in any case, is refused; and headers that are not an object are refused", () => {
        refuses(() => checkHeaders({ "X-A": "1", "x-a": "2" }), /header x-a is given twice/);
        for (const headers of [["a"], "X-A: 1", 5])
            refuses(() => checkHeaders(headers), /headers must be an object of name to value/);
    });

    test("a Content-Type or Accept the caller gives is allowed: it replaces the tool's", () => {
        assert.equal(
            checkHeaders({ "Content-Type": "application/merge-patch+json" })[0]?.[1],
            "application/merge-patch+json",
        );
        assert.equal(checkHeaders({ Accept: "text/csv" })[0]?.[1], "text/csv");
    });
});

describe("the timeout", () => {
    test("is a whole number of seconds from 1 to 120, and the configured one by default", () => {
        assert.equal(checkTimeout(undefined), 30);
        assert.equal(checkTimeout(undefined, 45), 45);
        assert.equal(checkTimeout(null, 45), 45);
        assert.equal(checkTimeout(1), 1);
        assert.equal(checkTimeout(120), 120);
        for (const value of [0, 121, 1.5, "30", -1, Number.NaN, Infinity, true, 2 ** 53])
            refuses(() => checkTimeout(value), /timeoutSec must be a whole number from 1 to 120/);
    });
});
