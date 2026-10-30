// The health check by address: one GET on the https address the catalog gives, with no redirect, ten seconds to answer, and
// the status and the first part of the body back. A fake `fetch` stands in for the network; the tests never use it.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { BODY_BYTES, HEALTH_TIMEOUT_MS, shownAddress, urlHealth } from "../src/runtime/health.ts";
import { list, pod } from "./support/fixtures.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { withEnvironment } from "./support/section.ts";

type Fetch = typeof fetch;
const ADDRESS = "https://api.example.com/orders/health";
const PRODUCTION = { action: "health", service: "orders-api", environment: "production" };

let h: Harness | undefined;
afterEach(() => h?.close());

/** A harness whose health checks use `answer` as their network. `requests` records what was asked. */
function withNetwork(answer: Fetch, more: { healthTimeoutMs?: number } = {}) {
    const requests: Array<{ address: string; init: RequestInit }> = [];
    const network: Fetch = async (address, init) => {
        requests.push({ address: String(address), init: init ?? {} });
        return answer(address, init);
    };
    h = setupHarness({ fetch: network, ...more });
    return { harness: h, requests };
}

const reply =
    (body: string | null, status = 200, headers: Record<string, string> = {}) =>
    async () =>
        new Response(body, { status, headers });

describe("what is asked", () => {
    test("one GET on the catalog's address, with no redirect followed, a signal for the time limit, and no credential", async () => {
        const { harness, requests } = withNetwork(reply('{"status":"UP"}'));
        const result = await harness.runtime.call(PRODUCTION);
        assert.equal(ok(result), `GET ${ADDRESS} -> HTTP 200\n{"status":"UP"}`);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.address, ADDRESS);
        const init = requests[0]?.init as RequestInit;
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "manual");
        assert.ok(init.signal instanceof AbortSignal);
        assert.deepEqual(init.headers, { accept: "*/*", "user-agent": "jig-ops" });
        assert.equal(init.body, undefined);
        assert.deepEqual(harness.cluster.calls(), [], "no program was started");
        assert.deepEqual(harness.jig.started, []);
    });

    test("it is a read in the environment the address belongs to, which production allows and masks", async () => {
        const { harness } = withNetwork(reply("UP"));
        const result = await harness.runtime.call(PRODUCTION);
        assert.deepEqual(result.cls, { action: "health", environment: "production", effect: "read" });
        assert.deepEqual(harness.jig.facts.get(result.id), [{ status: 200, cut: false }]);
        assert.deepEqual(result.details, { status: 200, bytes: 2, cut: false, redirect: false });
    });

    test("the address wins over a check in a pod, and no pod is asked", async () => {
        const { harness } = withNetwork(reply("UP"));
        harness.configure(
            withEnvironment("orders-api", "staging", { health: "https://orders.staging.example.com/health" }),
        );
        harness.cluster.answer({ pods: list(pod("orders-api-0")) });
        assert.match(
            ok(await harness.runtime.call({ action: "health", service: "orders-api", environment: "staging" })),
            /^GET https:\/\/orders\.staging\.example\.com\/health -> HTTP 200/,
        );
        assert.deepEqual(harness.cluster.calls(), []);
    });

    test("the query of an address is never put in a message: it can hold a token", async () => {
        const { harness, requests } = withNetwork(reply("UP"));
        harness.configure(
            withEnvironment("billing", "staging", {
                health: "https://billing.example.test/health?token=TOKEN-CANARY-91ac7&full=1",
            }),
        );
        const text = ok(await harness.runtime.call({ action: "health", service: "billing", environment: "staging" }));
        assert.equal(text, "GET https://billing.example.test/health?… -> HTTP 200\nUP");
        assert.equal(
            requests[0]?.address,
            "https://billing.example.test/health?token=TOKEN-CANARY-91ac7&full=1",
            "the whole address is what is requested",
        );
        assert.equal(
            shownAddress("https://billing.example.test:8443/a/b?x=1"),
            "https://billing.example.test:8443/a/b?…",
        );
        assert.equal(shownAddress("https://billing.example.test/a"), "https://billing.example.test/a");
    });
});

describe("what comes back", () => {
    test("a status that is not 2xx is a result, with its body", async () => {
        const { harness } = withNetwork(reply('{"status":"DOWN"}', 503));
        assert.equal(ok(await harness.runtime.call(PRODUCTION)), `GET ${ADDRESS} -> HTTP 503\n{"status":"DOWN"}`);
    });

    test("a redirect is not followed: it is a result that says where it points", async () => {
        const { harness, requests } = withNetwork(
            reply(null, 302, { location: "https://login.example.test/sso?next=orders" }),
        );
        const result = await harness.runtime.call(PRODUCTION);
        assert.equal(
            ok(result),
            `GET ${ADDRESS} -> HTTP 302 (a redirect, not followed; it points to https://login.example.test/sso?next=orders)\n(empty body)`,
        );
        assert.equal(requests.length, 1, "nothing else was requested");
        assert.equal((result.details as { redirect: boolean }).redirect, true);
    });

    test("an empty body says so", async () => {
        const { harness } = withNetwork(reply(null, 204));
        assert.equal(ok(await harness.runtime.call(PRODUCTION)), `GET ${ADDRESS} -> HTTP 204\n(empty body)`);
    });

    test("terminal sequences and control characters in the body, and in a redirect's address, do not get through", async () => {
        const { harness } = withNetwork(
            reply("\u001b[31mred\u001b[0m\u0007end", 302, { location: "https://x.test/\u001b[2Jgo" }),
        );
        const text = ok(await harness.runtime.call(PRODUCTION));
        assert.equal(text.split("\n")[1], "red?end");
        assert.ok(!text.includes("\u001b"));
    });

    test("only the first part of a long body is read and shown, and the rest is said to be there", async () => {
        const { harness } = withNetwork(reply("a".repeat(BODY_BYTES + 5000)));
        const result = await harness.runtime.call(PRODUCTION);
        const lines = ok(result).split("\n");
        assert.equal(lines[1]?.length, BODY_BYTES);
        assert.equal(lines[2], `[the body goes on; only the first ${BODY_BYTES} bytes are shown]`);
        assert.deepEqual(harness.jig.facts.get(result.id), [{ status: 200, cut: true }]);
    });

    test("a body that is exactly as long as the limit is not said to go on", async () => {
        const { harness } = withNetwork(reply("a".repeat(BODY_BYTES)));
        assert.ok(!ok(await harness.runtime.call(PRODUCTION)).includes("goes on"));
    });

    test("a body that never ends is read only as far as the limit, and the stream is cancelled", async () => {
        let cancelled = false;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024).fill(120));
            },
            cancel() {
                cancelled = true;
            },
        });
        const { harness } = withNetwork(async () => new Response(endless, { status: 200 }));
        const text = ok(await harness.runtime.call(PRODUCTION));
        assert.match(text, /goes on/);
        assert.equal(cancelled, true);
    });

    test("a body that is not text is not shown", async () => {
        const { harness } = withNetwork(
            async () => new Response(new Uint8Array([137, 80, 78, 71, 0, 1, 2]), { status: 200 }),
        );
        assert.equal(
            ok(await harness.runtime.call(PRODUCTION)),
            `GET ${ADDRESS} -> HTTP 200\n(not text: 7 bytes read)`,
        );
    });
});

describe("when there is no answer", () => {
    test("the time limit is ten seconds", () => {
        assert.equal(HEALTH_TIMEOUT_MS, 10_000);
    });

    test("a service that does not answer in time is an error that says how long was waited, even if fetch ignores its signal", async () => {
        const { harness } = withNetwork(() => new Promise<Response>(() => {}), { healthTimeoutMs: 60 });
        const result = await harness.runtime.call(PRODUCTION);
        assert.equal(result.error?.message, `GET ${ADDRESS}: no answer within 0.06 s`);
    });

    test("a body that stops half way is held to the same limit", async () => {
        const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
        const { harness } = withNetwork(async () => new Response(stalled, { status: 200 }), { healthTimeoutMs: 60 });
        assert.equal(
            (await harness.runtime.call(PRODUCTION)).error?.message,
            `GET ${ADDRESS}: no answer within 0.06 s`,
        );
    });

    test("a call the user stops is cancelled at once, and says so", async () => {
        const controller = new AbortController();
        const { harness } = withNetwork(() => new Promise<Response>(() => {}));
        const running = harness.runtime.call(PRODUCTION, { signal: controller.signal });
        setTimeout(() => controller.abort(), 30);
        assert.equal((await running).error?.message, `GET ${ADDRESS}: the check was cancelled`);
    });

    test("a failure to connect is told by its code, in this plugin's words and never Node's", async () => {
        const cases: Array<[unknown, string]> = [
            [
                Object.assign(new TypeError("fetch failed"), {
                    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.example.com secret-host" },
                }),
                "the name does not resolve (ENOTFOUND)",
            ],
            [
                Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } }),
                "the name does not resolve (EAI_AGAIN)",
            ],
            [
                Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
                "the connection was refused (ECONNREFUSED)",
            ],
            [
                Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ECONNREFUSED" }] } }),
                "the connection was refused (ECONNREFUSED)",
            ],
            [
                Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
                "the TLS certificate was not accepted (CERT_HAS_EXPIRED); certificate checks are never turned off",
            ],
            [
                Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }),
                "the connection failed (UND_ERR_SOCKET)",
            ],
            [
                new TypeError("fetch failed https://api.example.com/orders/health?token=SECRET-CANARY"),
                "the connection failed",
            ],
        ];
        for (const [failure, words] of cases) {
            const { harness } = withNetwork(async () => {
                throw failure;
            });
            const result = await harness.runtime.call(PRODUCTION);
            assert.equal(result.error?.message, `GET ${ADDRESS}: ${words}`);
            assert.ok(!(result.error?.message ?? "").includes("SECRET-CANARY"));
            h?.close();
            h = undefined;
        }
    });

    test("is never retried: a failed request is asked once", async () => {
        const { harness, requests } = withNetwork(async () => {
            throw new TypeError("fetch failed");
        });
        await harness.runtime.call(PRODUCTION);
        assert.equal(requests.length, 1);
    });
});

describe("the address is checked again for every request", () => {
    const deps = (asked: string[]) => ({
        fetch: (async (address: string) => (asked.push(String(address)), new Response("UP"))) as unknown as Fetch,
        timeoutMs: 1000,
    });

    test("a plain http address, a user name and a fragment are refused before anything is sent", async () => {
        const asked: string[] = [];
        for (const address of [
            "http://api.example.com/h",
            "https://u:p@api.example.com/h",
            "https://api.example.com/h#x",
            "https:///h",
            "ftp://api.example.com/h",
        ]) {
            await assert.rejects(
                urlHealth(address, undefined, deps(asked)),
                /^Error: The health address is refused \(it .+\)\. Nothing was sent$/,
                address,
            );
        }
        assert.deepEqual(asked, []);
    });

    test("a good address is sent as it is", async () => {
        const asked: string[] = [];
        const outcome = await urlHealth(ADDRESS, undefined, deps(asked));
        assert.equal(outcome.text, `GET ${ADDRESS} -> HTTP 200\nUP`);
        assert.deepEqual(asked, [ADDRESS]);
    });
});
