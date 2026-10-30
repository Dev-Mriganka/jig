// No resend on timeout. A write whose outcome is unknown (the reply is late, the connection drops, the call is cancelled) is
// sent once and never again. The tool says that the outcome is unknown and tells the model to check with a GET. The fake API
// holds the reply past the client's timeout, and does or does not carry the write out first.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { TransportResponse } from "../../jig-core/src/contract.ts";
import { closedPort } from "./support/fake-api.ts";
import type { Reply } from "./support/fake-api.ts";
import { ok, SECRET_REFERENCE, SHORT, setupHarness } from "./support/harness.ts";
import type { CallResult, Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness({ timeoutScale: SHORT });
});
after(() => h.close());
beforeEach(() => h.reset());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** What one second of `timeoutSec` lasts in these tests. */
const SECOND_MS = 1000 * SHORT;

const UNKNOWN = "The outcome is unknown: the server may have carried it out. It was not sent again. Check with a GET before trying again.";
const WRITES = [
    { method: "POST", body: { name: "Zed" } },
    { method: "PUT", body: { name: "Zed" } },
    { method: "PATCH", body: { name: "Zed" } },
    { method: "DELETE" },
] as const;

/** A write with a one-second timeout, run without being asked, as the model would send it. */
const write = (spec: (typeof WRITES)[number], extra: Record<string, unknown> = {}) =>
    h.call({ ...spec, path: "/v1/items/7", timeoutSec: 1, ...extra }, { ask: false });

/** The error of a call that must have failed. */
function failure(result: CallResult): string {
    assert.ok(result.error, `expected a failure, got: ${result.text}`);
    return result.error.message;
}

/** Waits for a second request to show up, if the tool were going to send one. A resend would follow the failure at once. */
const settle = (): Promise<void> => sleep(0.5 * SECOND_MS);

describe("a write whose reply never comes", () => {
    for (const spec of WRITES) {
        for (const carriedOut of [true, false]) {
            test(`${spec.method}: ${carriedOut ? "carried out by the server" : "never carried out"}, the outcome is unknown, the write is sent once, and a GET tells the rest`, async () => {
                let stored = false;
                h.api.respond = (request) => {
                    if (request.method === spec.method && carriedOut) stored = true;
                    if (request.method === "GET") return { body: JSON.stringify({ stored }) };
                    return { hang: true };
                };
                const result = await write(spec);
                assert.equal(failure(result), `api call ${spec.method} /v1/items/7: no answer (timed out after 1 s). ${UNKNOWN}`);
                await settle();
                assert.equal(h.api.requests.length, 1, "sent once, and not again");
                assert.equal(h.jig.facts.size, 0, "no status, so nothing to record");
                // The model's next step, as the message tells it.
                assert.match(ok(await h.call({ method: "GET", path: "/v1/items/7" })), carriedOut ? /"stored": true/ : /"stored": false/);
                assert.equal(h.api.requests.filter((request) => request.method === spec.method).length, 1);
            });
        }
    }

    test("a reply that comes after the timeout is too late, and does not cause a second send", async () => {
        h.api.respond = () => ({ status: 201, body: '{"id":1}', delayMs: 2 * SECOND_MS });
        const message = failure(await write(WRITES[0]));
        assert.match(message, /^api call POST \/v1\/items\/7: no answer \(timed out after 1 s\)\. The outcome is unknown/);
        await sleep(2 * SECOND_MS);
        assert.equal(h.api.requests.length, 1);
        assert.equal(h.jig.facts.size, 0);
    });

    test("the message names the path and not the query or the body", async () => {
        h.api.respond = () => ({ hang: true });
        const result = await h.call({ method: "POST", path: "/v1/items?token=QUERY-SECRET", body: { password: "BODY-SECRET" }, timeoutSec: 1 }, { ask: false });
        const message = failure(result);
        assert.match(message, /^api call POST \/v1\/items: no answer/);
        for (const secret of ["QUERY-SECRET", "BODY-SECRET", "token="]) assert.ok(!message.includes(secret), secret);
    });
});

describe("a connection that drops", () => {
    for (const how of ["drop", "halfway"] as const) {
        test(`${how === "drop" ? "before any answer" : "in the middle of the answer"}: the outcome of a write is unknown, and it is not sent again`, async () => {
            h.api.respond = () => ({ [how]: true }) as Reply;
            const message = failure(await write(WRITES[1]));
            assert.equal(message, `api call PUT /v1/items/7: no answer (the connection failed (UND_ERR_SOCKET)). ${UNKNOWN}`);
            await settle();
            assert.equal(h.api.requests.length, 1);
        });
    }
});

describe("a read that gets no answer", () => {
    test("is not an unknown outcome: a GET changes nothing, and the message says it can be sent again", async () => {
        h.api.respond = () => ({ hang: true });
        const message = failure(await h.call({ method: "GET", path: "/v1/items/7", timeoutSec: 1 }));
        assert.equal(message, "api call GET /v1/items/7: no answer (timed out after 1 s). A GET changes nothing, so it can be sent again.");
        assert.doesNotMatch(message, /unknown/);
        h.api.respond = () => ({ drop: true });
        assert.equal(
            failure(await h.call({ method: "GET", path: "/v1/items/7", timeoutSec: 1 })),
            "api call GET /v1/items/7: no answer (the connection failed (UND_ERR_SOCKET)). A GET changes nothing, so it can be sent again.",
        );
        assert.equal(h.api.requests.length, 2, "the tool itself did not send either again");
    });

    test("the tool works for the next call", async () => {
        h.api.respond = (_request, index) => (index === 0 ? { hang: true } : { body: '{"ok":true}' });
        failure(await h.call({ method: "GET", path: "/v1/x", timeoutSec: 1 }));
        assert.match(ok(await h.call({ method: "GET", path: "/v1/x" })), /-> HTTP 200 OK/);
    });
});

describe("an error status is an answer", () => {
    for (const status of [500, 502, 503, 504, 408]) {
        test(`${status} to a write is a result with a note, and the write is not sent again`, async () => {
            h.api.respond = () => ({ status, body: "upstream trouble", headers: { "content-type": "text/plain" } });
            const result = await write(WRITES[0]);
            const text = ok(result);
            assert.match(text, new RegExp(`^POST \\S+/v1/items/7 -> HTTP ${status} `));
            assert.match(text, /\nThe server reported an error, but a write may still have been carried out: check with a GET before sending it again\.\n/);
            assert.match(text, /\nupstream trouble$/);
            assert.deepEqual(h.jig.facts.get(result.id), [{ status }]);
            await settle();
            assert.equal(h.api.requests.length, 1);
        });
    }

    test("a GET with a server error has no such note, and neither does a write the server turned down", async () => {
        h.api.respond = () => ({ status: 503, body: "busy" });
        assert.doesNotMatch(ok(await h.call({ method: "GET", path: "/v1/x" })), /may still have been carried out/);
        for (const status of [400, 401, 403, 404, 409, 422, 429]) {
            h.api.respond = () => ({ status, body: "no" });
            assert.doesNotMatch(ok(await write(WRITES[0])), /may still have been carried out/, String(status));
        }
    });
});

describe("a call that is cancelled", () => {
    test("while a write is in flight, the outcome is unknown, and it is not sent again", async () => {
        h.api.respond = () => ({ hang: true });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 0.25 * SECOND_MS);
        const message = failure(await h.call({ method: "POST", path: "/v1/items/7", body: {}, timeoutSec: 30 }, { ask: false, signal: controller.signal }));
        assert.equal(message, `api call POST /v1/items/7: no answer (cancelled). ${UNKNOWN}`);
        await settle();
        assert.equal(h.api.requests.length, 1);
    });

    test("while a read is in flight, the read can be sent again", async () => {
        h.api.respond = () => ({ hang: true });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 0.25 * SECOND_MS);
        const message = failure(await h.call({ method: "GET", path: "/v1/x", timeoutSec: 30 }, { signal: controller.signal }));
        assert.equal(message, "api call GET /v1/x: no answer (cancelled). A GET changes nothing, so it can be sent again.");
    });

    test("before it starts, nothing is sent", async () => {
        const controller = new AbortController();
        controller.abort();
        const message = failure(await h.call({ method: "POST", path: "/v1/x", body: {} }, { ask: false, signal: controller.signal }));
        assert.equal(message, "api call POST /v1/x: it was cancelled before it was sent. Nothing was sent.");
        assert.equal(h.api.requests.length, 0);
    });
});

describe("a connection that is refused", () => {
    test("a write says that nothing was sent when the connection was refused; where a local forwarder resets it, the outcome is unknown", async () => {
        const origin = `http://127.0.0.1:${await closedPort()}`;
        h.configure(h.section({ none: true }, { baseUrl: origin }));
        const message = failure(await write(WRITES[0], { origin }));
        // ECONNREFUSED is the kernel's answer; ECONNRESET is what a forwarder in front of the port may make of it.
        assert.match(message, /^api call POST \/v1\/items\/7: (could not connect \(ECONNREFUSED\)\. Nothing was sent\.|no answer \(the connection failed \(ECONNRESET\)\)\. The outcome is unknown)/);
    });
});

describe("a transport that gets no answer", () => {
    beforeEach(() => h.configure(h.section({ transport: "company-proxy" })));

    test("one that never answers times out, even though it ignores the signal, and a write is not sent again", async () => {
        h.jig.transports.set("company-proxy", { request: () => new Promise<TransportResponse>(() => {}) });
        const message = failure(await write(WRITES[0]));
        assert.equal(message, `api call POST /v1/items/7: no answer (timed out after 1 s). ${UNKNOWN}`);
        await settle();
        assert.equal(h.jig.transportCalls.length, 1);
    });

    test("one that answers after the timeout is too late", async () => {
        h.jig.transports.set("company-proxy", { request: () => new Promise<TransportResponse>((resolve) => setTimeout(() => resolve({ status: 200, headers: {}, body: "{}" }), 2 * SECOND_MS).unref()) });
        assert.match(failure(await write(WRITES[2])), /^api call PATCH \/v1\/items\/7: no answer \(timed out after 1 s\)\. The outcome is unknown/);
        await sleep(2 * SECOND_MS);
        assert.equal(h.jig.transportCalls.length, 1);
    });

    test("one that fails leaves the outcome of a write unknown", async () => {
        h.jig.transports.set("company-proxy", { request: async () => { throw new Error("the connection was reset"); } });
        assert.equal(
            failure(await write(WRITES[3])),
            `api call DELETE /v1/items/7: no answer (transport "company-proxy" failed: the connection was reset). ${UNKNOWN}`,
        );
        assert.equal(h.jig.transportCalls.length, 1);
    });

    test("one that is cancelled in flight says so", async () => {
        h.jig.transports.set("company-proxy", { request: () => new Promise<TransportResponse>(() => {}) });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 0.25 * SECOND_MS);
        assert.equal(
            failure(await h.call({ method: "PUT", path: "/v1/x", body: {}, timeoutSec: 30 }, { ask: false, signal: controller.signal })),
            `api call PUT /v1/x: no answer (cancelled). ${UNKNOWN}`,
        );
    });
});

describe("a sign-in that gets no answer", () => {
    test("a token endpoint that never answers means nothing was sent to the API, for a write too", async () => {
        h.configure(h.section({ oauthPassword: h.oauth() }));
        h.auth.respond = () => ({ hang: true });
        const message = failure(await write(WRITES[0]));
        assert.equal(message, "api call POST /v1/items/7: could not sign in (the token request got no answer: timed out). Nothing was sent.");
        assert.equal(h.api.requests.length, 0);
        assert.doesNotMatch(message, /unknown/);
    });

    test("one deadline covers the token request and the call together", async () => {
        h.configure(h.section({ oauthPassword: h.oauth() }));
        // The token takes 60% of the time allowed. A deadline that started again for the call would let it wait 160%.
        h.auth.respond = () => ({ delayMs: 3 * SECOND_MS, body: JSON.stringify({ access_token: "token-after-a-wait", expires_in: 3600 }) });
        h.api.respond = () => ({ hang: true });
        const allowed = 5 * SECOND_MS;
        const started = Date.now();
        const message = failure(await h.call({ method: "GET", path: "/v1/x", timeoutSec: 5 }));
        const took = Date.now() - started;
        assert.match(message, /^api call GET \/v1\/x: no answer \(timed out after 5 s\)/);
        assert.equal(h.api.requests.length, 1, "the token arrived, and the call was sent");
        assert.ok(took >= allowed - 100 && took < 1.4 * allowed, `took ${took} ms for a deadline of ${allowed} ms`);
    });
});

describe("the clock", () => {
    // These calls wait longer for a secret or a sign-in than their whole timeout, and still work: the clock is the API's.
    const slowFor = 1.5 * SECOND_MS;
    const GET = { method: "GET", path: "/v1/x", timeoutSec: 1 };

    test("does not run while a secret is read, because a store may wait for the user to unlock it", async () => {
        h.configure(h.section({ bearer: SECRET_REFERENCE }));
        const real = h.jig.api.secrets.resolve;
        h.jig.api.secrets.resolve = async (reference, signal) => {
            await sleep(slowFor);
            return real(reference, signal);
        };
        try {
            assert.match(ok(await h.call(GET)), /-> HTTP 200 OK/);
        } finally {
            h.jig.api.secrets.resolve = real;
        }
    });

    test("does not run while a sign-in service works", async () => {
        h.configure(h.section({ signIn: "company-sso" }));
        h.jig.signIn.set("company-sso", async () => {
            await sleep(slowFor);
            return { "X-Sso-Session": "sess-4711-abcdef" };
        });
        assert.match(ok(await h.call(GET)), /-> HTTP 200 OK/);
    });

    test("does not run while the OAuth secrets are read, but it runs for the token request and the call together", async () => {
        h.configure(h.section({ oauthPassword: h.oauth() }));
        const real = h.jig.api.secrets.resolve;
        h.jig.api.secrets.resolve = async (reference, signal) => {
            await sleep(slowFor);
            return real(reference, signal);
        };
        try {
            assert.match(ok(await h.call(GET)), /-> HTTP 200 OK/);
        } finally {
            h.jig.api.secrets.resolve = real;
        }
    });
});
