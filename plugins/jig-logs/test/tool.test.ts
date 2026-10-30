// The tool as a model and jig-core meet it: how a call is classified, what a search returns, how its hits are paged and
// shaped, and what a wrong call is told.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "./support/fake-search.ts";
import { searchReply } from "./support/fake-search.ts";
import { docs, ENVIRONMENTS, logsSection, NOW, ok, world } from "./support/world.ts";

const ask = { phrase: "message", environment: "staging", window: "30m" };
const lines = (text: string) => text.split("\n");

// ---- classification ---------------------------------------------------------------------------------------------

test("a search is a read in the environment jig-core knows the searched one by", async (t) => {
    const w = await world(t);
    assert.deepEqual(w.tool.declaration.classify({ phrase: "x", environment: "staging" }), {
        environment: "staging",
        effect: "read",
    });
    assert.deepEqual(w.tool.declaration.classify({ phrase: "x", environment: "prod" }), {
        environment: "production",
        effect: "read",
    });
});

test("jigEnvironment defaults to the environment's own name", async (t) => {
    const w = await world(t, {
        environments: { qa: { index: "q-*" }, live: { index: "l-*", jigEnvironment: "prod" } },
    });
    assert.equal(w.tool.declaration.classify({ phrase: "x", environment: "qa" })?.environment, "qa");
    assert.equal(w.tool.declaration.classify({ phrase: "x", environment: "live" })?.environment, "prod");
});

test("the declaration says nothing more: no action, no stricter default, no approval, and jig-core masks the result", async (t) => {
    const w = await world(t);
    const declaration = w.tool.declaration;
    assert.deepEqual(Object.keys(declaration.classify({ phrase: "x", environment: "prod" }) ?? {}).sort(), [
        "effect",
        "environment",
    ]);
    assert.equal(declaration.masksOwnResults, undefined);
    assert.equal(declaration.preview, undefined, "a read has nothing to confirm");
    assert.equal(declaration.tool, "logs");
    assert.equal(declaration.plugin, "jig-logs");
});

test("every call is a read, whatever else it holds", async (t) => {
    const w = await world(t);
    for (const input of [
        { phrase: "x", environment: "prod" },
        { query: "a AND b", environment: "prod", window: "7d", size: 200, order: "desc" },
        { phrase: "x", environment: "prod", size: 100_000, window: "forever" },
        { environment: "prod" },
        { environment: "prod", action: "delete", method: "DELETE" },
    ]) {
        assert.deepEqual(
            w.tool.declaration.classify(input),
            { environment: "production", effect: "read" },
            JSON.stringify(input),
        );
    }
});

test("an environment nobody configured is invalid input, and the TypeError names the ones that exist", async (t) => {
    const w = await world(t);
    assert.throws(
        () => w.tool.declaration.classify({ phrase: "x", environment: "uat" }),
        new TypeError('logs: unknown environment "uat"; use one of staging, prod'),
    );
    assert.throws(
        () => w.tool.declaration.classify({ phrase: "x" }),
        new TypeError("logs needs environment: one of staging, prod"),
    );
    assert.throws(
        () => w.tool.declaration.classify({ phrase: "x", environment: 5 }),
        new TypeError("logs needs environment: one of staging, prod"),
    );
    assert.throws(() => w.tool.declaration.classify({}), TypeError);
    const result = await w.call({ phrase: "x", environment: "uat" });
    assert.equal(result.cls, undefined);
    assert.ok(result.classifyError instanceof TypeError);
    assert.ok(result.error instanceof TypeError, "and a call that is run anyway is refused the same way");
    assert.equal(result.error?.message, result.classifyError?.message);
    assert.equal(w.requests.length, 0);
});

test("without a valid section the tool is not configured, and says what to add", async (t) => {
    const w = await world(t, {
        section: { backend: { url: "http://insecure", auth: { token: "env:T" } }, environments: ENVIRONMENTS },
    });
    const message =
        /^logs is not configured: add a "logs" section with "backend" and "environments" to jig\.json, or fix the errors \/jig shows for it$/;
    assert.throws(
        () => w.tool.declaration.classify({ phrase: "x", environment: "staging" }),
        (error: Error) => error instanceof TypeError && message.test(error.message),
    );
    const result = await w.call(ask);
    assert.ok(result.error instanceof TypeError && message.test(result.error.message));
    assert.equal(w.requests.length, 0);
});

test("classifying reads the configuration of the moment, touches no network, and resolves no secret", async (t) => {
    const w = await world(t);
    w.tool.declaration.classify({ phrase: "x", environment: "prod" });
    assert.equal(w.requests.length, 0);
    assert.deepEqual(w.jig.resolved, []);
    assert.deepEqual(w.jig.signedIn, []);
    w.jig.setSection("logs", logsSection({ environments: { elsewhere: { index: "e-*" } } }));
    assert.throws(() => w.tool.declaration.classify({ phrase: "x", environment: "prod" }), /use one of elsewhere$/);
    assert.equal(w.tool.declaration.classify({ phrase: "x", environment: "elsewhere" })?.environment, "elsewhere");
});

test("a production search is not masked by the plugin: that is jig-core's job", async (t) => {
    const w = await world(t, { docs: docs(5, { env: "prod", message: (n) => `user n${n}@example.com logged in` }) });
    const text = ok(await w.call({ phrase: "logged in", environment: "prod", window: "30m" }));
    assert.match(text, /n0@example\.com/, "the plugin hands the text on as the backend gave it");
    assert.deepEqual(w.jig.masked, []);
});

// ---- the shape of a call ---------------------------------------------------------------------------------------

test("a wrong call is refused before anything is sent, with a line that shows how to put it right", async (t) => {
    const w = await world(t, { docs: docs(3) });
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [
            { ...ask, limit: 5 },
            /^logs does not use limit\. Usage: logs \{phrase or query, environment, window\?, from\?, to\?, size\?, order\?, match\?, exclude\?, around\?, chars\?, offset\?\}$/,
        ],
        [{ environment: "staging" }, /^logs needs phrase or query\. Usage: /],
        [{ ...ask, query: "a" }, /^logs takes phrase or query, not both\. Usage: /],
        [{ ...ask, window: "9d" }, /^logs: window must look like 30m, 2h or 1d and be at most 7d/],
        [{ ...ask, window: undefined, from: "2026-10-01T00:00:00Z", to: "2026-10-09T00:00:00Z" }, /at most 7 days/],
        [{ ...ask, size: 201 }, /^logs: size must be an integer from 1 to 200 \(got 201\)$/],
        [{ ...ask, chars: 5 }, /^logs: chars must be an integer from 40 to 4000 \(got 5\)$/],
        [{ ...ask, match: [] }, /^logs: match must list 1 to 5 texts$/],
        [{ ...ask, order: "sideways" }, /^logs: order must be asc or desc/],
    ];
    for (const [input, pattern] of refusals) {
        const result = await w.call(input);
        assert.ok(result.error instanceof TypeError, JSON.stringify(input));
        assert.match(result.error.message, pattern);
        assert.ok(!result.error.message.includes("\n"));
        assert.equal(result.text, "");
    }
    assert.equal(w.requests.length, 0);
    assert.deepEqual(w.jig.resolved, [], "and no secret was read for them");
});

// ---- windows ----------------------------------------------------------------------------------------------

test("a 7-day window is searched in 7 day buckets, and 8 days is refused before any request", async (t) => {
    const w = await world(t, { docs: docs(10) });
    const week = ok(await w.call({ ...ask, window: "7d" }));
    assert.equal(w.requests.length, 7);
    assert.match(
        lines(week)[0] as string,
        /^staging 2026-10-06T12:00:00Z\.\.2026-10-13T12:00:00Z: complete, 10 hits, 10 fetched \(oldest first\), 10 shown, 7 buckets$/,
    );
    const before = w.requests.length;
    const eight = await w.call({ ...ask, window: "8d" });
    assert.match(eight.error?.message ?? "", /at most 7d/);
    const long = await w.call({ ...ask, window: undefined, from: "2026-10-05T11:59:59Z", to: "2026-10-12T12:00:00Z" });
    assert.match(long.error?.message ?? "", /at most 7 days/);
    assert.equal(w.requests.length, before);
});

test("exactly 7 days with from and to is allowed, and the end is exclusive", async (t) => {
    const w = await world(t, { docs: docs(4) });
    ok(await w.call({ ...ask, window: undefined, from: "2026-10-06T12:00:00Z", to: "2026-10-13T12:00:00Z" }));
    assert.equal(w.requests.length, 7);
    assert.equal(w.requests[6]?.body.query.bool.filter[0].range["@timestamp"].lt, "2026-10-13T12:00:00Z");
});

test("a window of up to 6 hours is one request, then hours, then days", async (t) => {
    const w = await world(t, { docs: docs(4) });
    const counts: Array<[string, number]> = [
        ["30m", 1],
        ["6h", 1],
        ["7h", 7],
        ["2d", 48],
        ["49h", 3],
        ["7d", 7],
    ];
    for (const [window, expected] of counts) {
        const before = w.requests.length;
        ok(await w.call({ ...ask, window }));
        assert.equal(w.requests.length - before, expected, window);
    }
});

test("the default window is the last 2 hours, and the size 50", async (t) => {
    const w = await world(t, { docs: docs(4) });
    ok(await w.call({ phrase: "message", environment: "staging" }));
    const body = w.requests[0]?.body as Json;
    assert.equal(body.query.bool.filter[0].range["@timestamp"].gte, "2026-10-13T10:00:00Z");
    assert.equal(body.size, 50);
    assert.equal(body.sort[0]["@timestamp"].order, "asc");
});

// ---- paging with offset -----------------------------------------------------------------------------------

test("offset pages through the fetched hits: each page continues where the last stopped, and nothing is searched twice for it", async (t) => {
    const w = await world(t, { docs: docs(45, { message: (n) => `row ${String(n).padStart(2, "0")}` }) });
    const search = { ...ask, phrase: "row", size: 45 };
    const first = ok(await w.call(search));
    assert.match(lines(first)[0] as string, /complete, 45 hits, 45 fetched \(oldest first\), 20 shown, 1 bucket$/);
    assert.equal(lines(first)[1], "Hits 1-20 of 45 fetched hits, 25 more: call again with offset 20:");
    const second = ok(await w.call({ ...search, offset: 20 }));
    assert.equal(lines(second)[1], "Hits 21-40 of 45 fetched hits, 5 more: call again with offset 40:");
    const third = ok(await w.call({ ...search, offset: 40 }));
    assert.equal(lines(third)[1], "Hits 41-45 of 45 fetched hits, none after these:");
    const rows = [first, second, third].flatMap((page) =>
        lines(page)
            .filter((line) => / row \d\d$/.test(line))
            .map((line) => line.slice(-6)),
    );
    assert.deepEqual(
        rows,
        Array.from({ length: 45 }, (_, n) => `row ${String(n).padStart(2, "0")}`),
        "in order, none missing, none twice",
    );
    const past = ok(await w.call({ ...search, offset: 99 }));
    assert.match(past, /^offset 99 is past the end: there are only 45 fetched hits \(offsets 0 to 44\)\.$/m);
    assert.equal(lines(past).length, 2, "the header and that line");
    // Paging happens on the hits already fetched, so every page asks the backend the same question.
    assert.equal(new Set(w.requests.map((request) => JSON.stringify(request.body))).size, 1);
});

test("order desc fetches the newest hits, and pages from the newest", async (t) => {
    const w = await world(t, { docs: docs(30, { message: (n) => `row ${String(n).padStart(2, "0")}` }) });
    const newest = ok(await w.call({ ...ask, phrase: "row", size: 25, order: "desc" }));
    assert.match(lines(newest)[0] as string, /30 hits, 25 fetched \(newest first\), 20 shown/);
    const rows = lines(newest)
        .filter((line) => / row \d\d$/.test(line))
        .map((line) => line.slice(-6));
    assert.equal(rows[0], "row 29");
    assert.equal(rows[19], "row 10");
    const next = ok(await w.call({ ...ask, phrase: "row", size: 25, order: "desc", offset: 20 }));
    assert.deepEqual(
        lines(next)
            .filter((line) => / row \d\d$/.test(line))
            .map((line) => line.slice(-6)),
        ["row 09", "row 08", "row 07", "row 06", "row 05"],
    );
    assert.equal(w.requests[0]?.body.sort[0]["@timestamp"].order, "desc");
});

test("size is how many hits are fetched, and the rest of the window is only counted", async (t) => {
    const w = await world(t, { docs: docs(100, { start: NOW - 3 * 86_400_000 + 3_600_000, stepMs: 43 * 60_000 }) });
    const text = ok(await w.call({ ...ask, window: "3d", size: 5 }));
    assert.deepEqual(
        w.requests.map((r) => r.body.size),
        [5, 0, 0].map((size, i) => (i === 0 ? 5 : size)).slice(0, w.requests.length),
    );
    assert.match(lines(text)[0] as string, /complete, 100 hits, 5 fetched \(oldest first\), 5 shown, 3 buckets$/);
});

// ---- choosing and shaping the hits ----------------------------------------------------------------------------

test("match, exclude, around, chars and offset change what is shown, never what is asked", async (t) => {
    const fixtures = docs(30, { message: (n) => (n % 3 === 0 ? `event AfterThrowing cancel ${n}` : `event ok ${n}`) });
    const plain = await world(t, { docs: fixtures });
    ok(await plain.call({ ...ask, phrase: "event" }));
    const shaped = await world(t, { docs: fixtures });
    const text = ok(
        await shaped.call({
            ...ask,
            phrase: "event",
            match: ["afterthrowing"],
            exclude: ["cancel 9"],
            around: "cancel",
            chars: 60,
            offset: 2,
        }),
    );
    assert.deepEqual(
        shaped.requests.map((r) => r.body),
        plain.requests.map((r) => r.body),
    );
    assert.match(lines(text)[0] as string, /complete, 30 hits, 30 fetched \(oldest first\), 7 shown, 1 bucket$/);
    assert.match(text, /^9 of 30 fetched hits contain all 1 match term and none of 1 exclude term /m);
    assert.match(text, /^Hits 3-9 of 9 matching hits, none after these:$/m);
});

test("match keeps the hits that contain every text; the rest of the window is not looked at", async (t) => {
    const w = await world(t, {
        docs: docs(30, {
            message: (n) => (n % 3 === 0 ? `event AfterThrowing cancelProvisions ${n}` : `event ok ${n}`),
        }),
    });
    const text = ok(await w.call({ ...ask, phrase: "event", match: ["afterthrowing"], offset: 5 }));
    assert.match(text, /^10 of 30 fetched hits contain all 1 match term /m);
    assert.match(text, /^Hits 6-10 of 10 matching hits, none after these:$/m);
    assert.match(text, /AfterThrowing cancelProvisions 27$/m);
});

test("exclude looks past a noisy line", async (t) => {
    const w = await world(t, {
        docs: docs(20, { message: (n) => (n % 2 === 0 ? `event Heartbeat ${n}` : `event work ${n}`) }),
    });
    const text = ok(await w.call({ ...ask, phrase: "event", exclude: ["heartbeat"] }));
    assert.match(text, /^10 of 20 fetched hits contain none of 1 exclude term/m);
    assert.ok(!/Heartbeat/.test(text));
    assert.equal(lines(text).filter((line) => /event work/.test(line)).length, 10);
});

test("around shows each hit as a window around the term, and chars is how wide", async (t) => {
    const message = `${"head ".repeat(120)}the NEEDLE is here ${"tail ".repeat(120)}`;
    const w = await world(t, { docs: docs(6, { message: () => message }) });
    const wide = ok(await w.call({ ...ask, phrase: "needle", around: "needle", chars: 120 }));
    const hitLines = lines(wide).filter((line) => line.startsWith("2026-"));
    assert.equal(hitLines.length, 6);
    for (const line of hitLines) {
        assert.ok(line.includes("NEEDLE"));
        assert.ok(line.length <= 120 + 25);
        assert.match(line.slice(25), /^….*…$/);
    }
    const plain = ok(await w.call({ ...ask, phrase: "needle" }));
    assert.ok(
        !lines(plain).some((line) => line.includes("NEEDLE")),
        "the first characters of a message do not reach the term",
    );
});

test("one to three hits are shown whole when chars is not given", async (t) => {
    const body = JSON.stringify({
        account: "a-1",
        items: Array.from({ length: 60 }, (_, i) => ({ id: `C-${i}`, qty: 3 })),
    });
    const w = await world(t, { docs: docs(2, { message: () => `request body ${body}` }) });
    const text = ok(await w.call({ ...ask, phrase: "request body" }));
    assert.ok(
        lines(text)
            .slice(-2)
            .every((line) => line.endsWith(body)),
    );
    assert.ok(!/cut for length/.test(text));
});

test("a body that does not fit is closed off and the line says it is cut, not hidden", async (t) => {
    const body = JSON.stringify({ items: Array.from({ length: 600 }, (_, i) => ({ id: `C-${i}` })) });
    const w = await world(t, { docs: docs(5, { message: () => `request body ${body}` }) });
    const text = ok(await w.call({ ...ask, phrase: "request body" }));
    assert.match(text, /^\{…\} is a JSON body cut for length, not hidden: rerun with chars: 4000/m);
    assert.ok(
        lines(text)
            .filter((line) => line.startsWith("2026-"))
            .every((line) => line.endsWith("request body {…}")),
    );
});

// ---- empty and partial answers -----------------------------------------------------------------------------------

test("no hits: the check for data says whether the window has any documents at all", async (t) => {
    const w = await world(t, { docs: docs(8) });
    const text = ok(await w.call({ ...ask, phrase: "needle-not-there" }));
    assert.equal(lines(text)[0], "staging 2026-10-13T11:30:00Z..2026-10-13T12:00:00Z: complete, 0 hits, 1 bucket");
    assert.match(
        text,
        /^Availability: the window holds 8 documents in this environment without your phrase or query\. This only shows the window has data and proves nothing about retention\.$/m,
    );
    assert.equal(w.requests.length, 2);
    assert.equal(w.requests[1]?.body.query.bool.must, undefined);
    const empty = await world(t, { docs: [] });
    assert.match(ok(await empty.call(ask)), /^Availability: no documents at all in this environment and window\./m);
});

test("the check for data keeps to the environment's filter, so another environment's documents do not count", async (t) => {
    const w = await world(t, { docs: docs(8, { env: "staging" }) });
    const text = ok(await w.call({ phrase: "message", environment: "prod", window: "30m" }));
    assert.match(text, /complete, 0 hits/);
    assert.match(text, /no documents at all in this environment and window/);
    assert.deepEqual(w.requests[1]?.body.query.bool.filter[1], { term: { "env.keyword": "prod" } });
});

test("the result is one block of plain text, with a few counts in its details and in the record's facts", async (t) => {
    const w = await world(t, { docs: docs(6) });
    const result = await w.call(ask);
    assert.equal(typeof result.text, "string");
    assert.deepEqual(Object.keys(result.details).sort(), [
        "buckets",
        "fetched",
        "shown",
        "splits",
        "status",
        "total",
        "windows",
    ]);
    const [facts] = [...w.jig.facts.values()].flat();
    assert.deepEqual(facts, { status: "complete", hits: 6, atLeast: false, fetched: 6, requests: 1 });
    assert.ok(
        Object.values(facts ?? {}).every(
            (value) =>
                typeof value === "number" ||
                typeof value === "boolean" ||
                (typeof value === "string" && value.length <= 64),
        ),
    );
});

test("a refused call adds nothing to the record", async (t) => {
    const w = await world(t);
    await w.call({ ...ask, size: 0 });
    assert.equal(w.jig.facts.size, 0);
});

test("a partial answer says what is missing and what to do", async (t) => {
    const w = await world(t, {
        responder: (_request, n) =>
            n === 2
                ? { status: 429, text: "" }
                : searchReply({
                      hits: [{ _source: { "@timestamp": "2026-10-12T12:00:00Z", message: `m${n}` } }],
                      total: 1,
                  }),
    });
    const text = ok(await w.call({ ...ask, window: "3d" }));
    assert.match(lines(text)[0] as string, /: partial, at least 2 hits, 2 fetched/);
    assert.match(text, /^Gaps: 2026-10-11T12:00:00Z\.\.2026-10-12T12:00:00Z rate_limited$/m);
    assert.match(text, /^Next: The backend was unavailable or busy; retry once/m);
    assert.deepEqual([...w.jig.facts.values()].flat()[0], {
        status: "partial",
        hits: 2,
        atLeast: true,
        fetched: 2,
        requests: 3,
    });
});
