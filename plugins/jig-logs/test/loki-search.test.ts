// The whole tool against a fake Loki on 127.0.0.1: what a search sends, how the result reads, how buckets are cut and
// split on Loki's limits, how each error is told, and how every sign-in and the transport carry a request.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { DAY_MS, HOUR_MS } from "../src/time.ts";
import {
    fixtureResponder,
    lokiError,
    lokiReply,
    lokiSection,
    nanos,
    paramsOf,
    SELECTOR,
    stream,
} from "./support/fake-loki.ts";
import type { FakeLokiOptions, Stream } from "./support/fake-loki.ts";
import type { Answer, Recorded, Responder } from "./support/fake-search.ts";
import { NOW, ok, world } from "./support/world.ts";
import type { World, WorldOptions } from "./support/world.ts";

const base64 = (text: string) => Buffer.from(text).toString("base64");
const lines = (text: string) => text.split("\n");
/** The messages of the hit lines of a result: the text after the time. */
const messages = (text: string) =>
    lines(text)
        .filter((line) => /^2026-\d\d-\d\dT/.test(line))
        .map((line) => line.slice(line.indexOf(" ") + 1));

const labels = { app: "orders-api", env: "staging", pod: "web-1" };
const web = (count: number, over: Parameters<typeof stream>[2] = {}) => stream(labels, count, over);

/** Answers the first request with `first` and every later one with `later`. */
const afterFirst =
    (first: Answer, later: Responder): Responder =>
    (request, n) =>
        n === 1 ? first : later(request, n);

/** A world whose backend is a Loki that holds `streams`. */
function lokiWorld(t: TestContext, streams: readonly Stream[], over: WorldOptions & { loki?: FakeLokiOptions } = {}) {
    const { loki, ...options } = over;
    return world(t, { section: lokiSection(), responder: fixtureResponder(streams, loki), ...options });
}

const ask = { phrase: "message", environment: "staging", window: "30m" };

// ---- what a search sends, and what it reads -------------------------------------------------------------------------

test("a search is one GET to query_range: the selector, the phrase and the range in nanoseconds", async (t) => {
    const w = await lokiWorld(t, [web(30, { text: (n) => `request ${n} for order-${n % 3}` })]);
    const text = ok(await w.call({ phrase: "order-1", environment: "staging", window: "2h" }));
    assert.equal(w.requests.length, 1);
    const [request] = w.requests as [Recorded];
    assert.equal(request.method, "GET");
    assert.match(request.path, /^\/loki\/api\/v1\/query_range\?/);
    assert.deepEqual(paramsOf(request), {
        query: `${SELECTOR} |= "order-1"`,
        start: nanos(NOW - 2 * HOUR_MS),
        end: nanos(NOW),
        limit: "50",
        direction: "forward",
    });
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers["content-type"], undefined, "a read has no body to describe");
    assert.equal(request.headers.authorization, "Bearer token-value-1234");
    assert.match(
        lines(text)[0] as string,
        /^staging 2026-10-13T10:00:00Z\.\.2026-10-13T12:00:00Z: complete, 10 hits, 10 fetched \(oldest first\), 10 shown, 1 bucket$/,
    );
    assert.equal(lines(text).length, 11);
    assert.match(lines(text)[1] as string, /^2026-10-13T11:35:30\.000Z request 1 for order-1$/);
});

test("each environment searches its own selector, so another environment's lines do not appear", async (t) => {
    const production = stream({ app: "orders-api", env: "production" }, 4, { text: (n) => `production ${n}` });
    const w = await lokiWorld(t, [web(3, { text: (n) => `staging ${n}` }), production]);
    const text = ok(await w.call({ phrase: "production", environment: "prod", window: "30m" }));
    assert.match(paramsOf(w.requests[0] as Recorded).query as string, /^\{app="orders-api", env="production"\} /);
    assert.deepEqual(messages(text), ["production 0", "production 1", "production 2", "production 3"]);
    assert.match(ok(await w.call({ phrase: "staging", environment: "prod", window: "30m" })), /complete, 0 hits/);
});

test("several streams are merged into one list in time order, oldest first or newest first", async (t) => {
    const start = NOW - 25 * 60_000;
    const a = stream({ ...labels, pod: "a" }, 3, { start, stepMs: 60_000, text: (n) => `a${n} line` });
    const b = stream({ ...labels, pod: "b" }, 2, { start: start + 30_000, stepMs: 60_000, text: (n) => `b${n} line` });
    const w = await lokiWorld(t, [a, b]);
    const oldest = ok(await w.call({ ...ask, phrase: "line" }));
    assert.deepEqual(messages(oldest), ["a0 line", "b0 line", "a1 line", "b1 line", "a2 line"]);
    const newest = ok(await w.call({ ...ask, phrase: "line", order: "desc" }));
    assert.deepEqual(messages(newest), ["a2 line", "b1 line", "a1 line", "b0 line", "a0 line"]);
    assert.equal(paramsOf(w.requests[1] as Recorded).direction, "backward");
    assert.match(lines(newest)[0] as string, /5 hits, 5 fetched \(newest first\), 5 shown/);
});

test("the total is what Loki returned, and a lower bound when the limit was filled", async (t) => {
    const w = await lokiWorld(t, [web(80, { stepMs: 10_000 })]);
    const filled = ok(await w.call({ ...ask, size: 50 }));
    assert.match(
        lines(filled)[0] as string,
        /: complete, at least 50 hits, 50 fetched \(oldest first\), 20 shown, 1 bucket$/,
    );
    const roomy = ok(await w.call({ ...ask, size: 100 }));
    assert.match(lines(roomy)[0] as string, /: complete, 80 hits, 80 fetched \(oldest first\), 20 shown, 1 bucket$/);
});

test("once the hits are collected, a later bucket asks for one line, and the total is a lower bound", async (t) => {
    const w = await lokiWorld(t, [web(36, { start: NOW - 3 * DAY_MS, stepMs: 2 * HOUR_MS })]);
    const text = ok(await w.call({ ...ask, window: "3d", size: 5 }));
    const asked = w.requests.map(paramsOf);
    assert.deepEqual(
        asked.map((p) => p.limit),
        ["5", "1", "1"],
    );
    assert.deepEqual(
        asked.map((p) => p.start),
        [NOW - 3 * DAY_MS, NOW - 2 * DAY_MS, NOW - DAY_MS].map((ms) => nanos(ms)),
    );
    assert.match(
        lines(text)[0] as string,
        /: complete, at least 7 hits, 5 fetched \(oldest first\), 5 shown, 3 buckets$/,
    );
    assert.deepEqual(messages(text), ["message 0", "message 1", "message 2", "message 3", "message 4"]);
});

test("order desc searches the newest bucket first and fetches backward", async (t) => {
    const w = await lokiWorld(t, [web(36, { start: NOW - 3 * DAY_MS, stepMs: 2 * HOUR_MS })]);
    const text = ok(await w.call({ ...ask, window: "3d", size: 5, order: "desc" }));
    const asked = w.requests.map(paramsOf);
    assert.deepEqual(
        asked.map((p) => p.start),
        [NOW - DAY_MS, NOW - 2 * DAY_MS, NOW - 3 * DAY_MS].map((ms) => nanos(ms)),
    );
    assert.deepEqual(
        asked.map((p) => [p.limit, p.direction]),
        [
            ["5", "backward"],
            ["1", "backward"],
            ["1", "backward"],
        ],
    );
    assert.deepEqual(messages(text), ["message 35", "message 34", "message 33", "message 32", "message 31"]);
});

// ---- match and exclude ---------------------------------------------------------------------------------------------

test("match and exclude are sent as line filters, and the view applies them again, ignoring case", async (t) => {
    const w = await lokiWorld(t, [
        web(5, {
            text: (n) =>
                [
                    "Timeout talking to db",
                    "timeout talking to db",
                    "timeout talking to db: Heartbeat missed",
                    "timeout talking to db: heartbeat missed",
                    "work done",
                ][n] as string,
        }),
    ]);
    const text = ok(await w.call({ ...ask, phrase: "talking", match: ["timeout"], exclude: ["heartbeat"] }));
    assert.equal(paramsOf(w.requests[0] as Recorded).query, `${SELECTOR} |= "talking" |= "timeout" != "heartbeat"`);
    // Loki matches the case it was given, so the capital T is not fetched, and nor is the lower-case heartbeat. The
    // capital H is fetched, and the view hides it.
    assert.match(lines(text)[0] as string, /: complete, 2 hits, 2 fetched \(oldest first\), 1 shown, 1 bucket$/);
    assert.match(
        text,
        /^1 of 2 fetched hits contain all 1 match term and none of 1 exclude term \(case-insensitive, fetched hits only\)\.$/m,
    );
    assert.deepEqual(messages(text), ["timeout talking to db"]);
});

test("a query is appended after the selector and the filters, and Loki runs it", async (t) => {
    const w = await lokiWorld(t, [
        web(4, { text: (n) => ["timeout: db", "Timeout: db", "heartbeat: timeout", "work done"][n] as string }),
    ]);
    const text = ok(
        await w.call({ query: '|~ "(?i)time.*out" != "heartbeat"', environment: "staging", window: "30m" }),
    );
    assert.equal(paramsOf(w.requests[0] as Recorded).query, `${SELECTOR} |~ "(?i)time.*out" != "heartbeat"`);
    assert.deepEqual(messages(text), ["timeout: db", "Timeout: db"]);
});

test("text with quotes, braces and backslashes finds exactly the line that holds it", async (t) => {
    const phrase = 'say "hi" {x} \\ and `tick`';
    const w = await lokiWorld(t, [web(3, { text: (n) => [`a ${phrase} b`, "say hi x", `say "hi" {y}`][n] as string })]);
    const text = ok(await w.call({ ...ask, phrase }));
    assert.deepEqual(messages(text), [`a ${phrase} b`]);
    assert.equal(w.requests.length, 1);
});

// ---- when nothing is found -----------------------------------------------------------------------------------------

test("no hits: a second request asks the selector alone whether the window holds any lines", async (t) => {
    const w = await lokiWorld(t, [web(8)]);
    const text = ok(await w.call({ ...ask, phrase: "needle-not-there" }));
    assert.equal(lines(text)[0], "staging 2026-10-13T11:30:00Z..2026-10-13T12:00:00Z: complete, 0 hits, 1 bucket");
    assert.match(
        text,
        /^Availability: the window holds documents in this environment without your phrase or query\. This only shows the window has data and proves nothing about retention\.$/m,
    );
    assert.equal(w.requests.length, 2);
    assert.deepEqual(paramsOf(w.requests[1] as Recorded), {
        query: SELECTOR,
        start: nanos(NOW - 30 * 60_000),
        end: nanos(NOW),
        limit: "1",
        direction: "forward",
    });
    const empty = await lokiWorld(t, []);
    assert.match(ok(await empty.call(ask)), /^Availability: no documents at all in this environment and window\./m);
});

test("the check for data keeps to the selector of the environment", async (t) => {
    const w = await lokiWorld(t, [web(8)]);
    const text = ok(await w.call({ phrase: "message", environment: "prod", window: "30m" }));
    assert.match(text, /no documents at all in this environment and window/);
    assert.match(paramsOf(w.requests[1] as Recorded).query as string, /env="production"/);
});

// ---- Loki's limits ---------------------------------------------------------------------------------------------------

test("a bucket longer than Loki's range limit is split, and the halves are searched", async (t) => {
    const all = web(144, { start: NOW - 3 * DAY_MS, stepMs: 30 * 60_000 });
    const w = await lokiWorld(t, [all], { loki: { maxRangeMs: 6 * HOUR_MS } });
    const text = ok(await w.call({ ...ask, window: "3d", size: 200 }));
    assert.equal(w.requests.length, 21, "7 for each day: the day, two halves, and four pieces of 6 hours");
    assert.match(
        lines(text)[0] as string,
        /: complete, 144 hits, 144 fetched \(oldest first\), 20 shown, 12 buckets \(9 split after a timeout\)$/,
    );
    assert.ok(!/^Gaps:/m.test(text));
});

test("a range Loki still refuses at the smallest bucket is a gap that says the window is too long", async (t) => {
    const w = await lokiWorld(t, [web(8)], { loki: { maxRangeMs: 60_000 } });
    const text = ok(await w.call({ ...ask, window: "2h" }));
    assert.equal(w.requests.length, 31, "the window, halved four times over");
    assert.match(lines(text)[0] as string, /: failed, no window could be searched$/);
    assert.match(text, /^Gaps: 2026-10-13T10:00:00Z\.\.2026-10-13T12:00:00Z window_too_long$/m);
    assert.match(
        text,
        /^Next: The backend does not search a window this long in one request; use a shorter window\.$/m,
    );
});

test("more lines than Loki gives in one query stops the search at once, and says to lower the size", async (t) => {
    const w = await lokiWorld(t, [web(8)], { loki: { maxEntries: 100 } });
    const text = ok(await w.call({ ...ask, window: "3d", size: 200 }));
    assert.equal(w.requests.length, 1);
    assert.match(lines(text)[0] as string, /: failed, no window could be searched$/);
    assert.match(text, /^Gaps: .* response_too_large; .* not_run$/m);
    assert.match(text, /^Next: Lower size or narrow the window\.$/m);
    // A size that fits is searched.
    assert.match(ok(await w.call({ ...ask, size: 100 })), /: complete, 8 hits/);
});

// ---- the other errors ------------------------------------------------------------------------------------------------

test("a query Loki cannot read is a failed result with the LogQL hint, and its words are not repeated", async (t) => {
    const echo: Responder = (request) =>
        lokiError(
            400,
            `parse error at line 1, col 20: syntax error: unexpected IDENTIFIER near ${paramsOf(request).query}`,
        );
    const w = await lokiWorld(t, [], { responder: echo });
    const text = ok(await w.call({ ...ask, phrase: "customer-secret-phrase", window: "3d" }));
    assert.equal(w.requests.length, 1);
    assert.match(lines(text)[0] as string, /: failed, no window could be searched$/);
    assert.match(text, /^Gaps: .* query_rejected; .* not_run$/m, "the windows that were skipped read as one");
    assert.match(text, /^Next: The backend rejected the query; for query check the LogQL syntax \(it starts with \|/m);
    assert.ok(!/unexpected IDENTIFIER|customer-secret-phrase|orders-api/.test(text));
});

test("a rate limit leaves a gap and the search goes on; a 404 says the address may be wrong", async (t) => {
    const limited = await lokiWorld(t, [web(8)], {
        responder: (request, n) =>
            n === 2 ? lokiError(429, "too many outstanding requests") : fixtureResponder([web(8)])(request, n),
    });
    const text = ok(await limited.call({ ...ask, window: "3d" }));
    assert.match(text, /^Gaps: .* rate_limited$/m);
    assert.match(text, /^Next: The backend was unavailable or busy/m);
    assert.equal(limited.requests.length, 3);
    const missing = await lokiWorld(t, [], { responder: () => lokiError(404, "404 page not found") });
    const gone = ok(await missing.call({ ...ask, window: "3d" }));
    assert.equal(missing.requests.length, 1);
    assert.match(gone, /index_not_found/);
    assert.match(gone, /^Next: The backend answered 404: backend\.url in the logs section of jig\.json may be wrong/m);
});

test("a timeout is split like any backend's, and so is a connection that breaks", async (t) => {
    for (const first of [
        lokiError(504, "context deadline exceeded"),
        lokiError(503, "index not ready"),
        { reset: true },
    ]) {
        const w = await lokiWorld(t, [], { responder: afterFirst(first, () => lokiReply([web(1)])) });
        assert.match(
            lines(ok(await w.call(ask)))[0] as string,
            /: complete, 2 hits.*2 buckets \(1 split after a timeout\)$/,
            JSON.stringify(first),
        );
    }
});

test("a reply that is not log lines is a gap, whatever it says", async (t) => {
    const replies: Answer[] = [
        { text: "<html>maintenance, password=hunter2</html>" },
        { json: { status: "success", data: { resultType: "matrix", result: [] } } },
        { json: { status: "error", error: "hunter2" } },
    ];
    for (const reply of replies) {
        const w = await lokiWorld(t, [], { responder: () => reply });
        const text = ok(await w.call(ask));
        assert.match(text, /invalid_response/);
        assert.ok(!text.includes("hunter2") && !text.includes("maintenance"));
    }
});

test("a sign-in Loki does not accept is an error: a missing tenant is named, and the credential is not repeated", async (t) => {
    const w = await lokiWorld(t, [], { responder: () => lokiError(401, "no org id token-value-1234") });
    const result = await w.call({ ...ask, window: "3d" });
    assert.equal(
        result.error?.message,
        "The backend did not accept the sign-in (HTTP 401): sign in again, or check backend.auth and backend.tenant in the logs section of jig.json",
    );
    assert.equal(w.requests.length, 1, "the other buckets were not tried");
    const denied = await lokiWorld(t, [], { responder: () => lokiError(403, "forbidden") });
    assert.match(
        (await denied.call(ask)).error?.message ?? "",
        /^The backend denied this sign-in access to the logs \(HTTP 403\): signing in again will not help/,
    );
});

// ---- the tenant ------------------------------------------------------------------------------------------------------

test("the tenant is sent as X-Scope-OrgID on every request, and not at all without one", async (t) => {
    const streams = [web(36, { start: NOW - 3 * DAY_MS, stepMs: 2 * HOUR_MS })];
    const withTenant = await lokiWorld(t, streams, { section: lokiSection({ backend: { tenant: "orders" } }) });
    ok(await withTenant.call({ ...ask, window: "3d" }));
    assert.equal(withTenant.requests.length, 3);
    assert.ok(withTenant.requests.every((request) => request.headers["x-scope-orgid"] === "orders"));
    const without = await lokiWorld(t, streams);
    ok(await without.call({ ...ask, window: "3d" }));
    assert.ok(without.requests.every((request) => !("x-scope-orgid" in request.headers)));
});

// ---- the sign-in -----------------------------------------------------------------------------------------------------

const MODES = {
    basic: {
        // Grafana Cloud: the instance id is the user name and an API token is the password.
        auth: { username: "12345", password: "env:LOGS_PASSWORD" },
        header: `Basic ${base64("12345:pa55-word-7788")}`,
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
        const w = await lokiWorld(t, [web(3)], { section: lokiSection({ backend: { auth: mode.auth } }) });
        mode.prepare(w);
        assert.match(ok(await w.call(ask)), /complete, 3 hits/);
        assert.equal(w.requests[0]?.headers.authorization, mode.header);
    });
}

test("direct, signIn: the service is asked for the full address of every request, and its other headers go along", async (t) => {
    const w = await lokiWorld(t, [web(36, { start: NOW - 3 * DAY_MS, stepMs: 2 * HOUR_MS })], {
        section: lokiSection({ backend: { auth: MODES.signIn.auth, tenant: "orders" } }),
    });
    MODES.signIn.prepare(w);
    ok(await w.call({ ...ask, window: "3d" }));
    assert.equal(w.jig.signedIn.length, 3);
    assert.ok(
        w.jig.signedIn.every(
            (request) =>
                request.system === "logs" &&
                request.url.startsWith("https://logs.test:9200/loki/api/v1/query_range?query="),
        ),
    );
    assert.ok(w.requests.every((r) => r.headers["x-tenant"] === "t-1" && r.headers["x-scope-orgid"] === "orders"));
    assert.deepEqual(w.jig.resolved, [], "no secret is read when the sign-in is a service");
});

test("direct: a secret is resolved once for a search of several buckets", async (t) => {
    const w = await lokiWorld(t, [web(36, { start: NOW - 3 * DAY_MS, stepMs: 2 * HOUR_MS })]);
    ok(await w.call({ ...ask, window: "3d" }));
    assert.equal(w.requests.length, 3);
    assert.deepEqual(w.jig.resolved, ["env:LOGS_TOKEN"]);
});

// ---- the transport ---------------------------------------------------------------------------------------------------

test("transport: the request goes through jig-core as a GET with the full address, the tenant and no credential", async (t) => {
    const w = await world(t, {
        backend: "transport",
        section: lokiSection({ via: "transport", backend: { tenant: "orders" } }),
        responder: () => lokiReply([web(3)]),
    });
    assert.match(ok(await w.call(ask)), /: complete, 3 hits/);
    assert.equal(w.jig.sent.length, 1);
    const sent = w.jig.sent[0] as (typeof w.jig.sent)[number];
    assert.equal(sent.system, "logs");
    assert.equal(sent.method, "GET");
    assert.ok(sent.url.startsWith("https://logs.test:9200/loki/api/v1/query_range?query="));
    assert.equal(new URL(sent.url).searchParams.get("query"), `${SELECTOR} |= "message"`);
    assert.deepEqual(sent.headers, { accept: "application/json", "X-Scope-OrgID": "orders" });
    assert.equal(sent.body, undefined);
    assert.deepEqual(w.jig.resolved, [], "no secret is read");
    assert.deepEqual(w.jig.signedIn, [], "and no sign-in service is asked: the transport signs in");
});

test("transport: a transport that fails is an error that names it, not a gap", async (t) => {
    const w = await world(t, {
        backend: "transport",
        section: lokiSection({ via: "transport" }),
        responder: () => ({ reset: true }),
    });
    assert.equal(
        (await w.call({ ...ask, window: "3d" })).error?.message,
        'transport "corp" failed: the connection was reset',
    );
    assert.equal(w.requests.length, 1);
});

// ---- no credential anywhere ----------------------------------------------------------------------------------------------

const echoing: Responder = (request) =>
    lokiError(500, `bad credentials: ${request.headers.authorization ?? ""} ${request.headers["x-tenant"] ?? ""}`);

for (const [name, mode] of Object.entries(MODES)) {
    test(`direct, ${name}: no credential reaches an error, a result, its details or its progress`, async (t) => {
        const scenarios: Array<[string, Responder]> = [
            ["a success", () => lokiReply([web(1)])],
            ["a 500 that repeats the headers", echoing],
            ["a 400 that repeats the headers", (r) => lokiError(400, String(r.headers.authorization))],
            ["a 401 that repeats the headers", (r) => lokiError(401, String(r.headers.authorization))],
            ["a 403", () => lokiError(403, "forbidden")],
            ["a reply that is not JSON", (r) => ({ text: `oops ${r.headers.authorization}` })],
            ["a broken connection", () => ({ reset: true })],
            ["a timeout", () => ({ hang: true })],
        ];
        for (const [scenario, responder] of scenarios) {
            const w = await world(t, {
                section: lokiSection({ backend: { auth: mode.auth } }),
                responder,
                timeoutMs: 30,
            });
            mode.prepare(w);
            const result = await w.call({ ...ask, window: "10m" });
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
                base64("12345:pa55-word-7788"),
            ];
            assert.ok(w.jig.issued.size > 0, `${scenario}: the credential was in play`);
            for (const secret of secrets)
                assert.ok(!everything.includes(secret), `${name}, ${scenario}: ${secret.slice(0, 6)}`);
        }
    });
}

// ---- classification ----------------------------------------------------------------------------------------------------

test("a search is classified as before: a read in the environment jig-core knows the searched one by", async (t) => {
    const w = await lokiWorld(t, []);
    assert.deepEqual(w.tool.declaration.classify({ phrase: "x", environment: "staging" }), {
        environment: "staging",
        effect: "read",
    });
    assert.deepEqual(w.tool.declaration.classify({ query: '|= "x" | json', environment: "prod" }), {
        environment: "production",
        effect: "read",
    });
    assert.deepEqual(w.tool.declaration.classify({ environment: "prod", size: 100_000, window: "forever" }), {
        environment: "production",
        effect: "read",
    });
    assert.throws(
        () => w.tool.declaration.classify({ phrase: "x", environment: "uat" }),
        new TypeError('logs: unknown environment "uat"; use one of staging, prod'),
    );
});

test("a query that could reach beyond the selector is blocked when the call is classified, and nothing is sent", async (t) => {
    const w = await lokiWorld(t, [web(3)]);
    for (const query of ['|= "a" or {app="other"}', '{app="other"} |= "a"', '!= "a"', '|= "a', "| json {", ""]) {
        const result = await w.call({ query, environment: "staging" });
        assert.ok(result.classifyError instanceof TypeError, JSON.stringify(query));
        assert.equal(result.cls, undefined);
        assert.ok(result.error instanceof TypeError, "and a call that is run anyway is refused the same way");
        assert.match(result.classifyError.message, /^logs: /);
        assert.ok(!result.classifyError.message.includes("\n"));
    }
    assert.equal(w.requests.length, 0);
    assert.deepEqual(w.jig.resolved, [], "and no secret was read for them");
    assert.deepEqual(w.jig.signedIn, []);
    // A phrase may hold anything: it is a value.
    const phrase = await w.call({ phrase: '{app="other"} |= "a"', environment: "staging", window: "30m" });
    assert.equal(phrase.classifyError, undefined);
    assert.equal(phrase.error, undefined);
});

test("the record's facts are the same for Loki", async (t) => {
    const w = await lokiWorld(t, [web(10)]);
    ok(await w.call(ask));
    assert.deepEqual([...w.jig.facts.values()].flat()[0], {
        status: "complete",
        hits: 10,
        atLeast: false,
        fetched: 10,
        requests: 1,
    });
});
