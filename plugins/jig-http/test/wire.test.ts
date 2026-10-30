// One exchange, with `fetch` stubbed so that every kind of failure can be made exactly: which failures mean nothing was sent
// and which leave the outcome unknown, what is refused before a request is made, and that a redirect is handed back and not
// followed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import { exchange, LostReplyError, MAX_ANSWER_BYTES, NotSentError } from "../src/wire.ts";
import type { Wire } from "../src/wire.ts";

const wire = (extra: Partial<Wire> = {}): Wire => ({
    system: "http:api",
    method: "GET",
    url: "https://api.example.test/v1/x",
    headers: { Accept: "application/json" },
    allowPlainLocal: false,
    ...extra,
});
const signal = (): AbortSignal => new AbortController().signal;

type Behaviour = (url: string, init: RequestInit) => Promise<Response>;

interface Stub {
    /** What `fetch` was asked, in order. */
    seen: Array<{ url: string; init: RequestInit }>;
    /** What `fetch` does from now on. */
    will(behave: Behaviour): void;
}

/** Replaces `fetch` for the test, once. Replacing it twice in one test would leave the first stub behind. */
function stubFetch(t: TestContext, behave: Behaviour = async () => new Response("{}")): Stub {
    const stub: Stub = { seen: [], will: (next) => void (behave = next) };
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        stub.seen.push({ url, init });
        return behave(url, init);
    });
    return stub;
}

/** The failure `fetch` gives: `fetch failed`, with the reason in the cause. */
const failing = (code?: string, message = "connect failed"): TypeError =>
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), code === undefined ? {} : { code }) });

async function failureOf(work: Promise<unknown>): Promise<Error> {
    try {
        await work;
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    throw new Error("expected the exchange to fail");
}

describe("what means nothing was sent", () => {
    const beforeSending = ["ERR_INVALID_URL", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"];
    for (const code of beforeSending) {
        test(`${code}: the server could not have read the request`, async (t) => {
            stubFetch(t, async () => { throw failing(code); });
            const error = await failureOf(exchange(wire({ method: "POST", body: "{}" }), signal()));
            assert.ok(error instanceof NotSentError, String(error));
            assert.equal(error.message, `could not connect (${code})`);
        });
    }

    test("the code is found in a cause of a cause, and in the errors of an aggregate", async (t) => {
        const stub = stubFetch(t);
        stub.will(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { cause: { code: "ENOTFOUND" } } }); });
        assert.ok((await failureOf(exchange(wire(), signal()))) instanceof NotSentError);
        stub.will(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([{ code: "ECONNREFUSED" }]) }); });
        assert.ok((await failureOf(exchange(wire(), signal()))) instanceof NotSentError);
    });

    test("a certificate that is not accepted is a failure before the request, and certificate checks stay on", async (t) => {
        const stub = stubFetch(t);
        for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_NOT_YET_VALID"]) {
            stub.will(async () => { throw failing(code); });
            const error = await failureOf(exchange(wire({ method: "PUT", body: "{}" }), signal()));
            assert.ok(error instanceof NotSentError, code);
            assert.equal(error.message, `the TLS certificate was not accepted (${code}); certificate checks are never turned off`);
        }
    });

    test("a port that fetch does not connect to is refused before the request, for any method", async () => {
        const error = await failureOf(exchange(wire({ method: "POST", body: "{}", url: "http://127.0.0.1:1/x", allowPlainLocal: true }), signal()));
        assert.ok(error instanceof NotSentError, String(error));
        assert.equal(error.message, "the port is one that fetch does not connect to");
    });
});

describe("what leaves the outcome unknown", () => {
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "HPE_INVALID_CONSTANT", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
        test(`${code}: the request may have arrived`, async (t) => {
            stubFetch(t, async () => { throw failing(code); });
            const error = await failureOf(exchange(wire({ method: "POST", body: "{}" }), signal()));
            assert.ok(error instanceof LostReplyError, String(error));
            assert.equal(error.reason, "failed");
            assert.equal(error.message, `the connection failed (${code})`);
        });
    }

    test("a failure without a code is unknown too, and Node's own words are never repeated", async (t) => {
        stubFetch(t, async () => { throw failing(undefined, "connect to https://user:secret-token-123@api.example.test failed"); });
        const error = await failureOf(exchange(wire({ method: "DELETE" }), signal()));
        assert.ok(error instanceof LostReplyError);
        assert.equal(error.message, "the connection failed");
        assert.ok(!error.message.includes("secret-token-123"));
        assert.ok(!String(error.cause ?? "").includes("secret-token-123"));
    });

    test("a body that breaks off after the status is a lost reply too", async (t) => {
        stubFetch(t, async () => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
                controller.error(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } }));
            },
        })));
        const error = await failureOf(exchange(wire({ method: "POST", body: "{}" }), signal()));
        assert.ok(error instanceof LostReplyError);
        assert.equal(error.message, "the connection failed (UND_ERR_SOCKET)");
    });
});

describe("what is refused before a request is made", () => {
    test("an address that is not https is never called, whatever the settings say", async (t) => {
        const { seen } = stubFetch(t);
        for (const url of ["http://api.example.test/x", "ftp://api.example.test/x", "http://127.0.0.1.example.test/x", "http://10.0.0.1/x", "file:///etc/hosts", "not a url"]) {
            for (const allowPlainLocal of [false, true]) {
                const error = await failureOf(exchange(wire({ url, allowPlainLocal }), signal()));
                assert.ok(error instanceof NotSentError, url);
                assert.match(error.message, /^the address is refused \(/);
            }
        }
        assert.deepEqual(seen, []);
    });

    test("plain http to this machine needs the flag, and is then called", async (t) => {
        const { seen } = stubFetch(t);
        const refused = await failureOf(exchange(wire({ url: "http://127.0.0.1:8080/x" }), signal()));
        assert.match(refused.message, /needs "allowPlainLocal": true/);
        assert.deepEqual(seen, []);
        const answer = await exchange(wire({ url: "http://127.0.0.1:8080/x", allowPlainLocal: true }), signal());
        assert.equal(answer.status, 200);
        assert.equal(seen.length, 1);
    });

    test("a header the platform cannot send is refused without repeating its value", async (t) => {
        const { seen } = stubFetch(t);
        const error = await failureOf(exchange(wire({ headers: { Authorization: "Bearer abc\r\nX-Injected: yes" } }), signal()));
        assert.ok(error instanceof NotSentError);
        assert.equal(error.message, "a header holds a character that cannot be sent");
        assert.deepEqual(seen, []);
    });

    test("a signal that has already fired means nothing was sent", async (t) => {
        const { seen } = stubFetch(t);
        const cancelled = new AbortController();
        cancelled.abort();
        const first = await failureOf(exchange(wire({ method: "POST" }), cancelled.signal));
        assert.ok(first instanceof NotSentError);
        assert.equal(first.message, "it was cancelled before it was sent");
        const late = await failureOf(exchange(wire({ method: "POST" }), AbortSignal.abort(new DOMException("too slow", "TimeoutError"))));
        assert.ok(late instanceof NotSentError);
        assert.equal(late.message, "the time ran out before it was sent");
        assert.deepEqual(seen, []);
    });
});

describe("the request that is made", () => {
    test("a redirect is asked to be handed back, never followed", async (t) => {
        const { seen } = stubFetch(t, async () => new Response("", { status: 302, headers: { location: "http://plain.example.test/login" } }));
        const answer = await exchange(wire(), signal());
        assert.equal(seen[0]?.init.redirect, "manual");
        assert.equal(answer.status, 302);
        assert.equal(answer.headers.location, "http://plain.example.test/login");
        assert.equal(seen.length, 1);
    });

    test("the method, the headers, the body and the signal go to fetch as given, and a read has no body", async (t) => {
        const { seen } = stubFetch(t);
        await exchange(wire({ method: "PATCH", body: '{"a":1}', headers: { "Content-Type": "application/json", "X-A": "1" } }), signal());
        await exchange(wire(), signal());
        const [write, read] = seen;
        assert.equal(write?.url, "https://api.example.test/v1/x");
        assert.equal(write?.init.method, "PATCH");
        assert.equal(write?.init.body, '{"a":1}');
        assert.equal(new Headers(write?.init.headers).get("x-a"), "1");
        assert.ok(write?.init.signal instanceof AbortSignal);
        assert.equal(read?.init.method, "GET");
        assert.equal("body" in (read?.init ?? {}), false);
    });

    test("the headers of the answer have lower-case names", async (t) => {
        stubFetch(t, async () => new Response("{}", { headers: { "Content-Type": "application/json", "X-Request-Id": "r1" } }));
        const answer = await exchange(wire(), signal());
        assert.deepEqual(answer.headers, { "content-type": "application/json", "x-request-id": "r1" });
    });
});

describe("time and cancellation", () => {
    test("a reply that never comes is a lost reply when the time runs out, even when fetch ignores the signal", async (t) => {
        stubFetch(t, () => new Promise<Response>(() => {}));
        const error = await failureOf(exchange(wire({ method: "POST", body: "{}" }), AbortSignal.timeout(30)));
        assert.ok(error instanceof LostReplyError);
        assert.equal(error.reason, "timeout");
        assert.equal(error.message, "timed out");
    });

    test("a call that is cancelled in flight is a lost reply too, and says so", async (t) => {
        stubFetch(t, () => new Promise<Response>(() => {}));
        const controller = new AbortController();
        const pending = failureOf(exchange(wire({ method: "POST", body: "{}" }), controller.signal));
        controller.abort();
        const error = await pending;
        assert.ok(error instanceof LostReplyError);
        assert.equal(error.reason, "cancelled");
        assert.equal(error.message, "cancelled");
    });

    test("a body that never finishes is cut off by the time too", async (t) => {
        stubFetch(t, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("a")); } })));
        const error = await failureOf(exchange(wire(), AbortSignal.timeout(30)));
        assert.ok(error instanceof LostReplyError);
        assert.equal(error.reason, "timeout");
    });
});

describe("the answer", () => {
    test("a body longer than the limit is cut at it, and the rest is not read", async (t) => {
        let pulled = 0;
        stubFetch(t, async () => new Response(new ReadableStream({
            pull(controller) {
                pulled++;
                controller.enqueue(new Uint8Array(512 * 1024).fill(97));
                if (pulled > 100) controller.close();
            },
        })));
        const answer = await exchange(wire(), signal());
        assert.equal(answer.bytes, MAX_ANSWER_BYTES);
        assert.equal(answer.cut, true);
        assert.equal(answer.text.length, MAX_ANSWER_BYTES);
        assert.ok(pulled < 20, `read ${pulled} chunks`);
    });

    test("a body of exactly the limit is not cut", async (t) => {
        stubFetch(t, async () => new Response(new Uint8Array(MAX_ANSWER_BYTES).fill(97)));
        const answer = await exchange(wire(), signal());
        assert.equal(answer.cut, false);
        assert.equal(answer.bytes, MAX_ANSWER_BYTES);
    });

    test("the limit can be set for a call, as the token endpoint's is", async (t) => {
        stubFetch(t, async () => new Response("x".repeat(100)));
        const answer = await exchange(wire({ maxBytes: 64 }), signal());
        assert.deepEqual([answer.bytes, answer.cut, answer.text.length], [64, true, 64]);
    });

    test("a body with a NUL byte is binary and its text is not kept; a byte-order mark is dropped from text", async (t) => {
        const stub = stubFetch(t, async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1])));
        const binary = await exchange(wire(), signal());
        assert.deepEqual([binary.binary, binary.text, binary.bytes], [true, "", 7]);
        stub.will(async () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])));
        const text = await exchange(wire(), signal());
        assert.deepEqual([text.binary, text.text], [false, "{}"]);
    });

    test("an invalid UTF-8 byte becomes a replacement character and does not fail", async (t) => {
        stubFetch(t, async () => new Response(new Uint8Array([0x61, 0xff, 0x62])));
        assert.equal((await exchange(wire(), signal())).text, "a�b");
    });

    test("a response without a body is an empty answer", async (t) => {
        stubFetch(t, async () => new Response(null, { status: 204 }));
        const answer = await exchange(wire({ method: "DELETE" }), signal());
        assert.deepEqual([answer.status, answer.text, answer.bytes, answer.cut, answer.binary], [204, "", 0, false, false]);
    });
});
