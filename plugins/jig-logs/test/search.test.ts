import assert from "node:assert/strict";
import { test } from "node:test";
import type { Target } from "../src/config.ts";
import { RequestError } from "../src/failure.ts";
import type { LogQuery } from "../src/query.ts";
import type { Send } from "../src/request.ts";
import { MAX_REQUESTS, runSearch } from "../src/search.ts";
import { DAY_MS, HOUR_MS, iso } from "../src/time.ts";
import { errorReply, hit, onlyCounts, rangeOf, searchReply } from "./support/fake-search.ts";
import type { Answer, Json, Recorded } from "./support/fake-search.ts";

const FROM = Date.UTC(2026, 9, 13, 10, 0, 0);

const TARGET: Target = {
    index: "app-*",
    timeField: "@timestamp",
    messageField: "message",
    filter: {},
    jigEnvironment: "staging",
};

function query(span = 2 * HOUR_MS, over: Partial<LogQuery> = {}): LogQuery {
    return {
        environment: "staging",
        target: TARGET,
        kind: "phrase",
        text: "abc-123",
        size: 50,
        order: "asc",
        range: { from: FROM, to: FROM + span },
        ...over,
    };
}

type Step = (request: Recorded, number: number) => Answer | Promise<Answer>;

/** A `send` that answers from `step`, and records the bodies it was given. A step may throw, as a request may. */
function backend(step: Step) {
    const requests: Recorded[] = [];
    const send: Send = async (body) => {
        const recorded = { method: "POST", path: "/app-*/_search", index: "app-*", headers: {}, body: body as Json };
        requests.push(recorded);
        const answer = await step(recorded, requests.length);
        return { status: answer.status ?? 200, body: answer.text ?? JSON.stringify(answer.json ?? {}) };
    };
    return { send, requests };
}

async function run(step: Step, q: LogQuery = query(), extra: { now?: () => number; signal?: AbortSignal } = {}) {
    const { send, requests } = backend(step);
    const progress: string[] = [];
    const outcome = await runSearch(q, { send, progress: (text) => progress.push(text), ...extra });
    return { outcome, requests, progress };
}

/** A reply the backend gives up on after its own timeout, with the hits it had found so far. */
const timesOut: Step = () => searchReply({ timedOut: true, hits: [hit(1)], total: 1 });

test("one bucket: a single request, and an outcome that says what it covers", async () => {
    const { outcome, requests } = await run(() => searchReply({ hits: [hit(1), hit(2)], total: 2 }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.body.size, 50);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.total, { value: 2, relation: "eq" });
    assert.equal(outcome.hits.length, 2);
    assert.equal(outcome.requests, 1);
    assert.equal(outcome.splits, 0);
    assert.equal(outcome.availability, undefined);
    assert.deepEqual(
        outcome.windows.map((w) => [w.state, w.total, w.returned]),
        [["searched", 2, 2]],
    );
});

test("buckets are searched oldest first and collect up to size hits; later buckets only count", async () => {
    const { outcome, requests } = await run(
        (request) => {
            const wanted = request.body.size as number;
            return searchReply({ hits: Array.from({ length: Math.min(wanted, 4) }, (_, i) => hit(i)), total: 40 });
        },
        query(3 * DAY_MS, { size: 5 }),
    );
    assert.deepEqual(
        requests.map((r) => r.body.size),
        [5, 1, 0],
    );
    assert.deepEqual(
        requests.map((r) => rangeOf(r).from),
        [FROM, FROM + DAY_MS, FROM + 2 * DAY_MS],
    );
    assert.equal(requests[2]?.body._source, undefined);
    assert.equal(outcome.hits.length, 5);
    assert.deepEqual(outcome.total, { value: 120, relation: "eq" });
    assert.deepEqual(
        outcome.windows.map((w) => w.returned),
        [4, 1, 0],
    );
    assert.equal(outcome.status, "complete");
});

test("order desc searches the newest bucket first and reports the windows in time order", async () => {
    const { outcome, requests } = await run(
        (request) => {
            const wanted = request.body.size as number;
            const day = rangeOf(request).from;
            return searchReply({
                hits: Array.from({ length: Math.min(wanted, 4) }, (_, i) => hit(i, { day })),
                total: 40,
            });
        },
        query(3 * DAY_MS, { size: 5, order: "desc" }),
    );
    assert.deepEqual(
        requests.map((r) => rangeOf(r).from),
        [FROM + 2 * DAY_MS, FROM + DAY_MS, FROM],
    );
    assert.deepEqual(
        requests.map((r) => r.body.size),
        [5, 1, 0],
    );
    assert.deepEqual(requests[0]?.body.sort, [{ "@timestamp": { order: "desc", unmapped_type: "date" } }]);
    assert.equal(requests[2]?.body.sort, undefined);
    const days = outcome.hits.map((h) => h.day);
    assert.deepEqual(days, [...Array(4).fill(FROM + 2 * DAY_MS), FROM + DAY_MS]);
    assert.deepEqual(
        outcome.windows.map((w) => w.from),
        [iso(FROM), iso(FROM + DAY_MS), iso(FROM + 2 * DAY_MS)],
    );
    assert.deepEqual(
        outcome.windows.map((w) => w.returned),
        [0, 1, 4],
    );
    assert.deepEqual(outcome.total, { value: 120, relation: "eq" });
});

test("order desc halves a failing bucket with its later half first", async () => {
    const { outcome, requests } = await run(
        (request, n) => (n === 1 ? timesOut(request, n) : searchReply({ hits: [hit(n)], total: 3 })),
        query(2 * HOUR_MS, { order: "desc" }),
    );
    assert.deepEqual(requests.map(rangeOf), [
        { from: FROM, to: FROM + 2 * HOUR_MS },
        { from: FROM + HOUR_MS, to: FROM + 2 * HOUR_MS },
        { from: FROM, to: FROM + HOUR_MS },
    ]);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(
        outcome.windows.map((w) => w.from),
        [iso(FROM), iso(FROM + HOUR_MS)],
    );
});

test("order desc: the windows left out are the oldest, and gaps are still listed in time order", async () => {
    const { outcome } = await run(
        (_request, n) => {
            if (n === 1) return searchReply({ hits: [hit(1)], total: 1 });
            throw new RequestError("timeout");
        },
        query(7 * DAY_MS, { order: "desc" }),
    );
    assert.equal(outcome.status, "partial");
    assert.deepEqual(
        outcome.windows.map((w) => w.from),
        [...outcome.windows.map((w) => w.from)].sort(),
    );
    assert.equal(outcome.windows[outcome.windows.length - 1]?.state, "searched", "the newest day answered");
});

test("a bucket that times out is halved and tried again, and its partial answer is not counted twice", async () => {
    const { outcome, requests } = await run((request, n) =>
        n === 1 ? timesOut(request, n) : searchReply({ hits: [hit(n)], total: 3 }),
    );
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(rangeOf), [
        { from: FROM, to: FROM + 2 * HOUR_MS },
        { from: FROM, to: FROM + HOUR_MS },
        { from: FROM + HOUR_MS, to: FROM + 2 * HOUR_MS },
    ]);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.total, { value: 6, relation: "eq" });
    assert.deepEqual(
        outcome.hits.map((h) => h.message),
        ["message 2", "message 3"],
    );
    assert.equal(outcome.windows.length, 2);
    assert.equal(outcome.splits, 1);
});

test("a bucket that reports failed shards is halved too", async () => {
    const { outcome, requests } = await run((_request, n) =>
        n === 1
            ? searchReply({ failedShards: 2, hits: [hit(1)], total: 1 })
            : searchReply({ hits: [hit(n)], total: 1 }),
    );
    assert.equal(requests.length, 3);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.total, { value: 2, relation: "eq" });
});

test("a bucket whose request times out is halved the same way", async () => {
    const { outcome, requests } = await run((_request, n) => {
        if (n === 1) throw new RequestError("timeout");
        return searchReply({ hits: [hit(n)], total: 1 });
    });
    assert.equal(requests.length, 3);
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.splits, 1);
});

test("halving stops at depth 4: 31 requests for one hour, and the leaves keep their partial hits and are flagged", async () => {
    const { outcome, requests } = await run(timesOut, query(HOUR_MS));
    assert.equal(requests.length, 31);
    const spans = new Set(requests.map((r) => rangeOf(r).to - rangeOf(r).from));
    assert.deepEqual(
        [...spans].sort((a, b) => b - a),
        [HOUR_MS, HOUR_MS / 2, HOUR_MS / 4, HOUR_MS / 8, HOUR_MS / 16],
    );
    assert.equal(outcome.windows.length, 16);
    assert.ok(outcome.windows.every((w) => w.state === "partial" && w.reason === "search_timeout" && w.returned === 1));
    assert.equal(outcome.hits.length, 16);
    assert.equal(outcome.status, "partial");
    assert.deepEqual(outcome.total, { value: 16, relation: "gte" });
    assert.equal(outcome.splits, 15);
    assert.deepEqual(
        outcome.windows.map((w) => w.from),
        [...outcome.windows.map((w) => w.from)].sort(),
    );
});

test("request timeouts on every bucket make the call failed, with every missing window listed", async () => {
    const { outcome, requests } = await run(() => {
        throw new RequestError("timeout");
    }, query(HOUR_MS));
    assert.equal(requests.length, 31);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.windows.length, 16);
    assert.ok(outcome.windows.every((w) => w.state === "missing" && w.reason === "timeout"));
    assert.deepEqual(outcome.total, { value: 0, relation: "gte" });
    assert.equal(outcome.availability, undefined, "nothing was searched, so there is no check for data");
});

test("a connection lost mid-request, and 502, 503 and 504 replies, halve the bucket too", async () => {
    const lost = await run((_request, n) => {
        if (n === 1) throw new RequestError("connection_lost");
        return searchReply({ hits: [hit(n)], total: 1 });
    });
    assert.equal(lost.requests.length, 3);
    assert.equal(lost.outcome.status, "complete");
    for (const status of [502, 503, 504]) {
        const { outcome, requests } = await run((_request, n) =>
            n === 1 ? { status, text: "bad gateway" } : searchReply({ hits: [hit(n)], total: 1 }),
        );
        assert.equal(requests.length, 3, String(status));
        assert.equal(outcome.status, "complete", String(status));
    }
});

test("a 7-day window is 7 day buckets, one request each when nothing goes wrong", async () => {
    const { outcome, requests } = await run(
        (request) => searchReply({ hits: onlyCounts(request) ? [] : [hit(1)], total: 2 }),
        query(7 * DAY_MS),
    );
    assert.equal(requests.length, 7);
    assert.deepEqual(
        requests.map((r) => rangeOf(r).from),
        Array.from({ length: 7 }, (_, day) => FROM + day * DAY_MS),
    );
    assert.ok(requests.every((r) => rangeOf(r).to - rangeOf(r).from === DAY_MS));
    assert.equal(outcome.windows.length, 7);
    assert.deepEqual(outcome.total, { value: 14, relation: "eq" });
});

test("at most 64 requests per call: what the budget leaves out is missing, never silently dropped", async () => {
    const { outcome, requests } = await run(
        (_request, n) => {
            if (n === 1) return searchReply({ hits: [hit(1)], total: 1 });
            throw new RequestError("timeout");
        },
        query(7 * DAY_MS),
    );
    assert.ok(requests.length <= MAX_REQUESTS);
    assert.equal(requests.length, 63);
    assert.equal(outcome.requests, 63);
    assert.equal(outcome.status, "partial");
    assert.equal(outcome.total.relation, "gte");
    const reasons = new Set(outcome.windows.map((w) => w.reason));
    assert.ok(reasons.has("timeout") && reasons.has("request_budget"));
    // Every day is accounted for, oldest first, with no overlap.
    const covered = outcome.windows.reduce((sum, w) => sum + (Date.parse(w.to) - Date.parse(w.from)), 0);
    assert.equal(covered, 7 * DAY_MS);
});

test("the 64th request is kept for the check for data", async () => {
    const { outcome, requests } = await run(
        (request, n) => {
            if (request.body.query.bool.must === undefined) return searchReply({ total: 9 });
            if (n === 1) return searchReply();
            throw new RequestError("timeout");
        },
        query(7 * DAY_MS),
    );
    assert.equal(requests.length, 64);
    assert.equal(requests[63]?.body.query.bool.must, undefined, "the last one is the check");
    assert.deepEqual(outcome.availability, { state: "documents", count: 9 });
    assert.equal(outcome.status, "partial");
});

test("zero hits: one check without the phrase says whether the window has any documents", async () => {
    const q = query(2 * HOUR_MS, { text: "needle-xyz" });
    const { outcome, requests } = await run(
        (request) => searchReply({ total: request.body.query.bool.must === undefined ? 1234 : 0 }),
        q,
    );
    assert.equal(requests.length, 2);
    const check = requests[1] as Recorded;
    assert.deepEqual(Object.keys(check.body), ["size", "timeout", "track_total_hits", "query"]);
    assert.equal(check.body.size, 0);
    assert.deepEqual(rangeOf(check), q.range);
    for (const absent of ["needle-xyz", "match_phrase", "query_string", "must"])
        assert.ok(!JSON.stringify(check.body).includes(absent), absent);
    assert.deepEqual(outcome.availability, { state: "documents", count: 1234 });
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.total, { value: 0, relation: "eq" });
    assert.equal(outcome.requests, 2);
});

test("zero hits across several buckets still makes one check, over the whole window", async () => {
    const { requests, outcome } = await run(() => searchReply({ total: 0 }), query(3 * DAY_MS));
    assert.equal(requests.filter((r) => r.body.query.bool.must === undefined).length, 1);
    assert.deepEqual(rangeOf(requests[3] as Recorded), { from: FROM, to: FROM + 3 * DAY_MS });
    assert.deepEqual(outcome.availability, { state: "none", count: 0 });
});

test("availability is unknown, not guessed, when the check fails or loses shards; the search result stands", async () => {
    const isCheck = (request: Recorded) => request.body.query.bool.must === undefined;
    const failing = await run((request) => {
        if (isCheck(request)) throw new RequestError("timeout");
        return searchReply();
    });
    assert.deepEqual(failing.outcome.availability, { state: "unknown", reason: "timeout" });
    assert.equal(failing.outcome.status, "complete");
    const shards = await run((request) => (isCheck(request) ? searchReply({ failedShards: 1 }) : searchReply()));
    assert.deepEqual(shards.outcome.availability, { state: "unknown", reason: "failed_shards" });
    const slow = await run((request) => (isCheck(request) ? searchReply({ timedOut: true }) : searchReply()));
    assert.deepEqual(slow.outcome.availability, { state: "unknown", reason: "search_timeout" });
    const garbage = await run((request) => (isCheck(request) ? { text: "not json" } : searchReply()));
    assert.deepEqual(garbage.outcome.availability, { state: "unknown", reason: "invalid_response" });
});

test("hits found means no check", async () => {
    const { requests } = await run(() => searchReply({ hits: [hit(1)], total: 1 }));
    assert.equal(requests.length, 1);
});

test("a rejected query (HTTP 400) stops at once: failed, the rest not run", async () => {
    const { outcome, requests } = await run(() => errorReply(400, "query_shard_exception"), query(3 * DAY_MS));
    assert.equal(requests.length, 1);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(
        outcome.windows.map((w) => w.reason),
        ["query_rejected", "not_run", "not_run"],
    );
});

test("a missing index is reported as such, and stops", async () => {
    for (const reply of [
        errorReply(404, "index_not_found_exception"),
        { status: 404, text: "" },
        errorReply(400, "index_not_found_exception"),
    ]) {
        const { outcome, requests } = await run(() => reply, query(3 * DAY_MS));
        assert.equal(requests.length, 1);
        assert.equal(outcome.windows[0]?.reason, "index_not_found");
        assert.equal(outcome.status, "failed");
    }
});

test("a rate limit does not stop the search, and is not halved", async () => {
    const { outcome, requests } = await run(
        (_request, n) => (n === 2 ? { status: 429, text: "" } : searchReply({ hits: [hit(n)], total: 1 })),
        query(3 * DAY_MS),
    );
    assert.equal(requests.length, 3);
    assert.deepEqual(
        outcome.windows.map((w) => w.state),
        ["searched", "missing", "searched"],
    );
    assert.equal(outcome.windows[1]?.reason, "rate_limited");
    assert.equal(outcome.status, "partial");
});

test("a reply too large, or not a search result, makes that window missing without halving", async () => {
    const tooLarge = await run(
        () => {
            throw new RequestError("response_too_large");
        },
        query(2 * DAY_MS + HOUR_MS),
    );
    assert.equal(tooLarge.requests.length, 3);
    assert.ok(tooLarge.outcome.windows.every((w) => w.reason === "response_too_large"));
    const invalid = await run(
        (_request, n) =>
            n === 1 ? { text: JSON.stringify({ hits: "nope" }) } : searchReply({ hits: [hit(n)], total: 1 }),
        query(3 * DAY_MS),
    );
    assert.equal(invalid.requests.length, 3);
    assert.equal(invalid.outcome.status, "partial");
    assert.deepEqual(
        invalid.outcome.windows.map((w) => w.reason),
        ["invalid_response", undefined, undefined],
    );
    const html = await run(() => ({ text: "<html>gateway</html>" }));
    assert.equal(html.outcome.windows[0]?.reason, "invalid_response");
});

test("a refused sign-in, an address nobody answers, and a stop by the user are thrown, not turned into gaps", async () => {
    await assert.rejects(
        run(() => ({ status: 401, text: "{}" })),
        /did not accept the sign-in \(HTTP 401\)/,
    );
    await assert.rejects(
        run(() => ({ status: 403, text: "{}" })),
        /denied this sign-in access to the index \(HTTP 403\)/,
    );
    await assert.rejects(
        run(() => ({ status: 302, text: "" })),
        /redirect \(HTTP 302\)/,
    );
    const unreachable = new Error("cannot reach the backend (ECONNREFUSED): check backend.url");
    await assert.rejects(
        run(() => {
            throw unreachable;
        }),
        (thrown) => thrown === unreachable,
    );

    const controller = new AbortController();
    controller.abort();
    const { send, requests } = backend(() => searchReply());
    await assert.rejects(
        runSearch(query(), { send, signal: controller.signal }),
        (error: Error) => error.name === "AbortError",
    );
    assert.equal(requests.length, 0);
});

test("a stop in the middle of a long search stops it between buckets", async () => {
    const controller = new AbortController();
    const { send, requests } = backend((_request, n) => {
        if (n === 2) controller.abort();
        return searchReply({ hits: [hit(n)], total: 1 });
    });
    await assert.rejects(
        runSearch(query(3 * DAY_MS), { send, signal: controller.signal }),
        (error: Error) => error.name === "AbortError",
    );
    assert.equal(requests.length, 2);
});

test("totals are taken as reported: a lower bound stays a lower bound", async () => {
    const { outcome } = await run(() => searchReply({ hits: [hit(1)], total: 10_000, relation: "gte" }));
    assert.deepEqual(outcome.total, { value: 10_000, relation: "gte" });
    assert.equal(outcome.status, "complete");
});

test("a total may arrive as a bare number, the older form", async () => {
    const { outcome } = await run(() => ({ json: { hits: { total: 7, hits: [hit(1)] } } }));
    assert.deepEqual(outcome.total, { value: 7, relation: "eq" });
    assert.equal(outcome.hits.length, 1);
});

test("the time budget stops new requests and reports the rest as missing", async () => {
    let requestsSoFar = 0;
    const { outcome, requests } = await run(
        () => {
            requestsSoFar += 1;
            return searchReply({ hits: [hit(requestsSoFar)], total: 1 });
        },
        query(4 * DAY_MS),
        { now: () => FROM + requestsSoFar * 100_000 },
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(
        outcome.windows.map((w) => w.state),
        ["searched", "searched", "missing", "missing"],
    );
    assert.equal(outcome.windows[3]?.reason, "time_budget");
    assert.equal(outcome.status, "partial");
});

test("progress is reported once per request, with the environment and never the searched text", async () => {
    const { progress, requests } = await run(() => searchReply({ total: 0 }), query(HOUR_MS, { text: "needle-xyz" }));
    assert.equal(progress.length, requests.length);
    assert.deepEqual(progress, ["searching staging logs, request 1", "searching staging logs, request 2"]);
    assert.ok(progress.every((line) => !line.includes("needle-xyz")));
});
