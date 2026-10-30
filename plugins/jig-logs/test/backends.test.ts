// How requests travel: straight to a backend over a socket, or through a transport. The same searches run both ways and
// must give the same answers, because everything above the request function is the same code.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { createLogsTool } from "../src/tool.ts";
import { errorReply, hit, PUBLIC_URL, rangeOf, searchReply } from "./support/fake-search.ts";
import type { Answer, Recorded, Responder } from "./support/fake-search.ts";
import { docs, NOW, ok, world } from "./support/world.ts";
import type { World } from "./support/world.ts";

const BACKENDS = ["direct", "transport"] as const;
/** A search that finds what `docs()` makes: its documents are in the last half hour. */
const call = { phrase: "message", environment: "staging", window: "30m" };
const base64 = (text: string) => Buffer.from(text).toString("base64");

/** Answers the first request with `first` and every later one with `later`. */
const afterFirst =
    (first: Answer, later: Responder): Responder =>
    (request, n) =>
        n === 1 ? first : later(request, n);

for (const backend of BACKENDS) {
    test(`${backend}: a search is one POST of a JSON body to the environment's index`, async (t) => {
        const w = await world(t, { backend, docs: docs(30, { message: (n) => `request ${n} for order-${n % 3}` }) });
        const text = ok(await w.call({ phrase: "order-1", environment: "staging", window: "2h" }));
        assert.equal(w.requests.length, 1);
        const [request] = w.requests as [Recorded];
        assert.equal(request.method, "POST");
        assert.equal(request.path, "/app-staging-*/_search");
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(request.headers.accept, "application/json");
        assert.deepEqual(request.body.query.bool.must, [{ match_phrase: { message: "order-1" } }]);
        assert.match(
            text.split("\n")[0] as string,
            /^staging 2026-10-13T10:00:00Z\.\.2026-10-13T12:00:00Z: complete, 10 hits, 10 fetched \(oldest first\), 10 shown, 1 bucket$/,
        );
        assert.equal(text.split("\n").length, 11);
    });

    test(`${backend}: a prod search carries its environment's filter, and the index it shares`, async (t) => {
        const w = await world(t, { backend, docs: [...docs(3, { env: "prod" }), ...docs(5, { env: "staging" })] });
        const text = ok(await w.call({ phrase: "message", environment: "prod" }));
        assert.equal(w.requests[0]?.path, "/app-*/_search");
        assert.deepEqual(w.requests[0]?.body.query.bool.filter[1], { term: { "env.keyword": "prod" } });
        assert.match(text.split("\n")[0] as string, /^prod .*: complete, 3 hits, 3 fetched/);
    });

    test(`${backend}: a long window is searched in buckets, and the totals add up`, async (t) => {
        const all = docs(90, { start: NOW - 3 * 86_400_000 + 3_600_000, stepMs: 47 * 60_000 });
        const w = await world(t, { backend, docs: all });
        const text = ok(await w.call({ ...call, window: "3d", size: 200 }));
        assert.equal(w.requests.length, 3, "day buckets");
        assert.deepEqual(
            w.requests.map((r) => rangeOf(r).to - rangeOf(r).from),
            [86_400_000, 86_400_000, 86_400_000],
        );
        assert.match(
            text.split("\n")[0] as string,
            /complete, 90 hits, 90 fetched \(oldest first\), 20 shown, 3 buckets$/,
        );
    });

    test(`${backend}: a bucket the backend gives up on is split and tried again`, async (t) => {
        const wide = (request: Recorded) => rangeOf(request).to - rangeOf(request).from > 30 * 60_000;
        const w = await world(t, {
            backend,
            responder: (request) =>
                wide(request)
                    ? searchReply({ timedOut: true, hits: [hit(1)], total: 1 })
                    : searchReply({ hits: [hit(2)], total: 5 }),
        });
        const text = ok(await w.call({ phrase: "x", environment: "staging", window: "2h" }));
        assert.equal(w.requests.length, 7, "2h, then two 1h, then four 30m");
        assert.match(
            text.split("\n")[0] as string,
            /complete, 20 hits, 4 fetched \(oldest first\), 4 shown, 4 buckets \(3 split after a timeout\)$/,
        );
    });

    test(`${backend}: a request that is never answered is cut at the request timeout, and its bucket is split`, async (t) => {
        const wide = (request: Recorded) => rangeOf(request).to - rangeOf(request).from > 30 * 60_000;
        const w = await world(t, {
            backend,
            timeoutMs: 200,
            responder: (request) => (wide(request) ? { hang: true } : searchReply({ hits: [hit(2)], total: 5 })),
        });
        const started = Date.now();
        const result = await w.call({ phrase: "x", environment: "staging", window: "2h" });
        assert.match(
            ok(result).split("\n")[0] as string,
            /complete, 20 hits, 4 fetched .* 4 buckets \(3 split after a timeout\)$/,
        );
        assert.ok(Date.now() - started < 5_000, "three stalled requests cost three timeouts, not the 30 s default");
    });

    test(`${backend}: a backend that answers nothing at all gives a failed result that lists the gaps`, async (t) => {
        const w = await world(t, { backend, timeoutMs: 20, responder: () => ({ hang: true }) });
        const result = await w.call({ phrase: "x", environment: "staging", window: "30m" });
        const text = ok(result);
        assert.match(text, /^staging .*: failed, no window could be searched$/m);
        assert.match(text, /^Gaps: .* timeout$/m);
        assert.match(text, /^Next: Narrow the window/m);
        // Counted where the requests are made: a request cut off at once may never reach the server.
        assert.equal(result.updates.length, 31, "halved to the depth limit, then given up");
    });

    test(`${backend}: a query the backend rejects is a failed result with the Lucene hint, not an error`, async (t) => {
        const w = await world(t, { backend, responder: () => errorReply(400, "query_shard_exception") });
        const result = await w.call({ query: "error AND", environment: "staging", window: "3d" });
        const text = ok(result);
        assert.equal(w.requests.length, 1);
        assert.match(text, /: failed, no window could be searched$/m);
        assert.match(text, /^Gaps: .* query_rejected; .*$/m);
        assert.match(text, /^Next: The backend rejected the query; for query check the Lucene syntax/m);
        assert.ok(!text.includes("synthetic"), "the backend's own words are not repeated");
    });

    test(`${backend}: a missing index is reported once`, async (t) => {
        const w = await world(t, { backend, responder: () => errorReply(404, "index_not_found_exception") });
        const text = ok(await w.call({ phrase: "x", environment: "staging", window: "3d" }));
        assert.equal(w.requests.length, 1);
        assert.match(text, /index_not_found/);
        assert.match(text, /^Next: The index was not found/m);
    });

    test(`${backend}: a 502 is split like a timeout, and a 429 leaves a gap`, async (t) => {
        const split = await world(t, {
            backend,
            responder: afterFirst({ status: 502, text: "bad gateway" }, () =>
                searchReply({ hits: [hit(1)], total: 1 }),
            ),
        });
        assert.match(
            ok(await split.call(call)).split("\n")[0] as string,
            /complete, 2 hits.*2 buckets \(1 split after a timeout\)$/,
        );
        const limited = await world(t, { backend, responder: () => ({ status: 429, text: "" }) });
        const text = ok(await limited.call(call));
        assert.match(text, /rate_limited/);
        assert.match(text, /^Next: The backend was unavailable or busy/m);
    });

    test(`${backend}: a reply that is not a search result is a gap, whatever it says`, async (t) => {
        const w = await world(t, {
            backend,
            responder: () => ({ text: "<html>maintenance, password=hunter2</html>" }),
        });
        const text = ok(await w.call(call));
        assert.match(text, /invalid_response/);
        assert.ok(!text.includes("hunter2") && !text.includes("maintenance"));
    });

    test(`${backend}: a reply over 16 MiB is refused, and the search goes on without it`, async (t) => {
        const w = await world(t, {
            backend,
            responder: afterFirst({ text: "x".repeat(17 * 1024 * 1024) }, () =>
                searchReply({ hits: [hit(1)], total: 1 }),
            ),
        });
        const text = ok(await w.call({ ...call, window: "3d" }));
        assert.match(text, /^Gaps: .* response_too_large$/m);
        assert.match(text, /partial, at least 2 hits/);
        assert.match(text, /^Next: Lower size or narrow the window\.$/m);
    });

    test(`${backend}: stopping the call stops the request, at once`, async (t) => {
        const w = await world(t, { backend, responder: () => ({ hang: true }) });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 60);
        const started = Date.now();
        const result = await w.call({ ...call, window: "3d" }, { signal: controller.signal });
        assert.equal(result.error?.name, "AbortError");
        assert.ok(Date.now() - started < 5_000);
        assert.equal(result.updates.length, 1, "no further bucket was tried");
    });

    test(`${backend}: the same search gives the same text either way`, async (t) => {
        const fixtures = docs(60, { message: (n) => `line ${n} ${n % 7 === 0 ? "needle" : "hay"}` });
        const texts: string[] = [];
        for (const how of BACKENDS) {
            const w = await world(t, { backend: how, docs: fixtures });
            texts.push(
                ok(
                    await w.call({
                        phrase: "needle",
                        environment: "staging",
                        window: "2h",
                        order: "desc",
                        match: ["needle"],
                        around: "needle",
                        chars: 80,
                    }),
                ),
            );
        }
        assert.equal(texts[0], texts[1]);
    });
}

// ---- the direct backend --------------------------------------------------------------------------------------

const MODES = {
    basic: {
        auth: { username: "reader", password: "env:LOGS_PASSWORD" },
        header: `Basic ${base64("reader:pa55-word-7788")}`,
        prepare: (w: World) => w.jig.secrets.set("env:LOGS_PASSWORD", "pa55-word-7788"),
    },
    apiKey: {
        auth: { apiKey: "env:LOGS_KEY" },
        header: "ApiKey a1b2c3-key-9988",
        prepare: (w: World) => w.jig.secrets.set("env:LOGS_KEY", "a1b2c3-key-9988"),
    },
    bearer: {
        auth: { token: "env:LOGS_TOKEN" },
        header: "Bearer token-value-1234",
        prepare: () => {},
    },
    signIn: {
        auth: { signIn: "corp-sso" },
        header: "Bearer sso-token-5566",
        prepare: (w: World) =>
            w.jig.signInServices.set("corp-sso", {
                headers: async () => ({ authorization: "Bearer sso-token-5566", "x-tenant": "t-1" }),
            }),
    },
} as const;

for (const [name, mode] of Object.entries(MODES)) {
    test(`direct, ${name}: the request is signed in the way the backend expects`, async (t) => {
        const w = await world(t, { auth: mode.auth, docs: docs(3) });
        mode.prepare(w);
        ok(await w.call(call));
        assert.equal(w.requests[0]?.headers.authorization, mode.header);
        assert.equal(w.requests[0]?.headers["content-type"], "application/json");
    });
}

test("direct, signIn: the service's other headers go along, and it is asked for every request", async (t) => {
    const w = await world(t, { auth: MODES.signIn.auth, docs: docs(30) });
    MODES.signIn.prepare(w);
    ok(await w.call({ ...call, window: "3d" }));
    assert.equal(w.requests.length, 3);
    assert.ok(
        w.requests.every((r) => r.headers["x-tenant"] === "t-1" && r.headers.authorization === "Bearer sso-token-5566"),
    );
    assert.equal(w.jig.signedIn.length, 3, "the service decides when a token has run out");
    assert.deepEqual(w.jig.signedIn[0], { system: "logs", url: "https://logs.test:9200/app-staging-*/_search" });
    assert.deepEqual(w.jig.resolved, [], "no secret is read when the sign-in is a service");
});

test("direct, secrets: a reference is resolved once for a search of several buckets", async (t) => {
    const w = await world(t, { docs: docs(30) });
    ok(await w.call({ ...call, window: "3d" }));
    assert.equal(w.requests.length, 3);
    assert.deepEqual(w.jig.resolved, ["env:LOGS_TOKEN"]);
    ok(await w.call(call));
    assert.deepEqual(
        w.jig.resolved,
        ["env:LOGS_TOKEN", "env:LOGS_TOKEN"],
        "and again for the next call: nothing is kept between calls",
    );
});

test("direct: a secret that cannot be resolved fails the call before any request is sent", async (t) => {
    const w = await world(t, { auth: { token: "env:NOT_THERE" } });
    const result = await w.call(call);
    assert.equal(result.error?.message, "the secret could not be resolved");
    assert.equal(w.requests.length, 0);
    const unknown = await world(t, { auth: { signIn: "nobody" } });
    assert.match((await unknown.call(call)).error?.message ?? "", /^no sign-in service is named "nobody"$/);
    assert.equal(unknown.requests.length, 0);
});

test("direct: the request timeout does not run while a secret is being unlocked", async (t) => {
    const w = await world(t, { timeoutMs: 250, docs: docs(3) });
    w.jig.secretDelayMs = 500;
    assert.match(ok(await w.call(call)), /complete, 3 hits/);
});

test("direct: stopping the call stops the wait for a secret too", async (t) => {
    const w = await world(t, { docs: docs(3) });
    w.jig.secretDelayMs = 10_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const result = await w.call(call, { signal: controller.signal });
    assert.equal(result.error?.name, "AbortError");
    assert.equal(w.requests.length, 0);
});

test("direct: a refused sign-in is an error that says so, once, and does not repeat the credential", async (t) => {
    const w = await world(t, { responder: () => ({ status: 401, json: { error: "bad token-value-1234" } }) });
    const result = await w.call({ ...call, window: "3d" });
    assert.equal(
        result.error?.message,
        "The backend did not accept the sign-in (HTTP 401): sign in again, or check backend.auth in the logs section of jig.json",
    );
    assert.equal(w.requests.length, 1, "the other buckets were not tried");
    const denied = await world(t, { responder: () => ({ status: 403, text: "{}" }) });
    assert.match(
        (await denied.call(call)).error?.message ?? "",
        /^The backend denied this sign-in access to the index \(HTTP 403\)/,
    );
});

test("direct: a redirect is an error, and the credential is not sent to where it points", async (t) => {
    const w = await world(t, {
        responder: () => ({ status: 302, headers: { location: "/elsewhere/_search" }, text: "" }),
    });
    const result = await w.call(call);
    assert.match(result.error?.message ?? "", /^The backend answered with a redirect \(HTTP 302\): set backend\.url/);
    assert.equal(w.requests.length, 1, "the redirect was not followed");
    assert.ok(w.requests.every((request) => request.path === "/app-staging-*/_search"));
});

test("direct: an address nobody listens at is an error that names the cause, not a result made of gaps", async (t) => {
    const port = await new Promise<number>((resolve) => {
        const probe = createServer().listen(0, "127.0.0.1", () => {
            const { port: free } = probe.address() as { port: number };
            probe.close(() => resolve(free));
        });
    });
    const w = await world(t);
    const closed = createLogsTool({
        now: () => NOW,
        fetch: (input, init) => fetch(String(input).replace(PUBLIC_URL, `http://127.0.0.1:${port}`), init),
    });
    await assert.rejects(
        closed.definition.execute("c", call as never, undefined, undefined, {} as never),
        new Error("cannot reach the backend (ECONNREFUSED): check backend.url, the network and the certificate"),
    );
    assert.equal(w.requests.length, 0);
});

test("direct: a connection broken while the backend works is split like a timeout", async (t) => {
    const w = await world(t, {
        responder: afterFirst({ reset: true }, () => searchReply({ hits: [hit(1)], total: 1 })),
    });
    assert.match(
        ok(await w.call(call)).split("\n")[0] as string,
        /complete, 2 hits.*2 buckets \(1 split after a timeout\)$/,
    );
    const always = await world(t, { responder: () => ({ reset: true }) });
    const text = ok(await always.call({ ...call, window: "10m" }));
    assert.match(text, /: failed, no window could be searched$/m);
    assert.match(text, /upstream_unavailable/);
});

test("direct: the backend's address may have a path, and the index is added to it", async (t) => {
    const w = await world(t, {
        section: {
            backend: { url: "https://logs.test:9200/", auth: { token: "env:LOGS_TOKEN" } },
            environments: { staging: { index: "app-*,other-*" } },
        },
        docs: docs(2),
    });
    ok(await w.call(call));
    assert.equal(w.requests[0]?.path, "/app-*,other-*/_search");
});

// ---- the transport ---------------------------------------------------------------------------------------------

test("transport: the request goes through jig-core with the system, the method, the full address, and no credential", async (t) => {
    const w = await world(t, { backend: "transport", docs: docs(3) });
    ok(await w.call(call));
    assert.equal(w.jig.sent.length, 1);
    const sent = w.jig.sent[0] as (typeof w.jig.sent)[number];
    assert.equal(sent.system, "logs");
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "https://logs.test:9200/app-staging-*/_search");
    assert.deepEqual(sent.headers, { "content-type": "application/json", accept: "application/json" });
    assert.equal(typeof sent.body, "string");
    assert.deepEqual(JSON.parse(sent.body ?? "{}").query.bool.must, [{ match_phrase: { message: "message" } }]);
    assert.deepEqual(w.jig.resolved, [], "no secret is read");
    assert.deepEqual(w.jig.signedIn, [], "and no sign-in service is asked: the transport signs in");
    assert.ok(!Object.keys(sent.headers ?? {}).some((name) => /auth|cookie|token/i.test(name)));
});

test("transport: a name nobody registered is an error from jig-core, and nothing is sent", async (t) => {
    const w = await world(t, {
        backend: "transport",
        section: {
            backend: { transport: "elsewhere", url: "https://logs.test:9200" },
            environments: { staging: { index: "a-*" } },
        },
    });
    assert.equal((await w.call(call)).error?.message, 'no transport named "elsewhere"');
});

test("transport: a transport that fails is an error that names it, not a gap", async (t) => {
    const w = await world(t, { backend: "transport", responder: () => ({ reset: true }) });
    const result = await w.call({ ...call, window: "3d" });
    assert.equal(result.error?.message, 'transport "corp" failed: the connection was reset');
    assert.equal(w.requests.length, 1);
});

test("transport: one that ignores its signal still cannot hold the call past the request timeout", async (t) => {
    const w = await world(t, {
        backend: "transport",
        ignoreSignal: true,
        timeoutMs: 150,
        responder: afterFirst({ hang: true }, () => searchReply({ hits: [hit(1)], total: 1 })),
    });
    const started = Date.now();
    assert.match(
        ok(await w.call(call)).split("\n")[0] as string,
        /complete, 2 hits.*2 buckets \(1 split after a timeout\)$/,
    );
    assert.ok(Date.now() - started < 5_000);
});

test("transport: stopping the call does not wait for a transport that ignores its signal", async (t) => {
    const w = await world(t, { backend: "transport", ignoreSignal: true, responder: () => ({ hang: true }) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    assert.equal((await w.call(call, { signal: controller.signal })).error?.name, "AbortError");
    assert.ok(Date.now() - started < 5_000);
});

// ---- no credential anywhere ----------------------------------------------------------------------------------

/** What a hostile or careless backend could say: each reply repeats the credentials it was sent. */
const echoing: Responder = (request) => {
    const sent = `${request.headers.authorization ?? ""} ${request.headers["x-tenant"] ?? ""}`;
    return { status: 500, json: { error: { type: "echo", reason: `bad credentials: ${sent}` } } };
};

for (const [name, mode] of Object.entries(MODES)) {
    test(`direct, ${name}: no credential reaches an error, a result, its details or its progress`, async (t) => {
        const scenarios: Array<[string, Responder]> = [
            ["a success", () => searchReply({ hits: [hit(1)], total: 1 })],
            ["a 500 that repeats the headers", echoing],
            [
                "a 400 that repeats the headers",
                (request) => ({
                    status: 400,
                    json: { error: { type: "q", reason: String(request.headers.authorization) } },
                }),
            ],
            [
                "a 401 that repeats the headers",
                (request) => ({ status: 401, text: String(request.headers.authorization) }),
            ],
            ["a 403", () => ({ status: 403, text: "{}" })],
            ["a reply that is not JSON", (request) => ({ text: `oops ${request.headers.authorization}` })],
            ["a redirect", () => ({ status: 307, text: "" })],
            ["a broken connection", () => ({ reset: true })],
            ["a timeout", () => ({ hang: true })],
        ];
        let w!: World;
        for (const [scenario, responder] of scenarios) {
            w = await world(t, { auth: mode.auth, responder, timeoutMs: 30 });
            mode.prepare(w);
            const result = await w.call({ ...call, window: "10m" });
            const everything = [
                result.text,
                result.error?.message ?? "",
                JSON.stringify(result.details ?? {}),
                result.updates.join("\n"),
            ].join("\n");
            const secrets = [
                ...w.jig.issued,
                mode.header,
                mode.header.replace(/^\w+ /, ""),
                base64("reader:pa55-word-7788"),
            ];
            assert.ok(w.jig.issued.size > 0, `${scenario}: the credential was in play`);
            for (const secret of secrets)
                assert.ok(
                    !everything.includes(secret),
                    `${name}, ${scenario}: ${secret.slice(0, 6)}... appears in the output`,
                );
        }
    });
}

test("transport: nothing the transport says about itself is lost, and the request is never repeated in the error", async (t) => {
    const w = await world(t, { backend: "transport", responder: () => ({ reset: true }) });
    const result = await w.call({ phrase: "customer-secret-phrase", environment: "staging" });
    assert.ok(result.error);
    assert.ok(!result.error.message.includes("customer-secret-phrase"));
    assert.ok(!result.error.message.includes("app-staging"));
});

test("the progress notes name the environment and a count, and never what was searched for", async (t) => {
    const w = await world(t, { docs: docs(3) });
    // Nothing matches, so after the three day buckets there is the check for data.
    const result = await w.call({ phrase: "needle-xyz", environment: "staging", window: "3d" });
    assert.deepEqual(
        result.updates,
        [1, 2, 3, 4].map((n) => `searching staging logs, request ${n}`),
    );
});
