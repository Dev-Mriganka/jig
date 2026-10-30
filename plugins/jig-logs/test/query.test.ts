import assert from "node:assert/strict";
import { test } from "node:test";
import type { Target } from "../src/config.ts";
import { probeBody, SEARCH_TIMEOUT, searchBody } from "../src/query.ts";
import type { LogQuery } from "../src/query.ts";
import { HOUR_MS } from "../src/time.ts";
import { problemsWith } from "./support/grammar.ts";
import { matchesGolden } from "./support/golden.ts";

const FROM = Date.UTC(2026, 9, 13, 10, 0, 0);
const range = { from: FROM, to: FROM + 2 * HOUR_MS };

const PLAIN: Target = {
    index: "app-staging-*",
    timeField: "@timestamp",
    messageField: "message",
    filter: {},
    jigEnvironment: "staging",
};

/** An index shared by environments, with fields of its own names. */
const SHARED: Target = {
    index: "logs-*,-logs-debug-*",
    timeField: "timestamp",
    messageField: "log.message",
    filter: { "env.keyword": "prod", "tier.keyword": "web", region_code: 7, canary: false },
    jigEnvironment: "production",
};

function query(over: Partial<LogQuery> = {}): LogQuery {
    return {
        environment: "staging",
        target: PLAIN,
        kind: "phrase",
        text: "abc-123",
        size: 50,
        order: "asc",
        range,
        ...over,
    };
}

test("golden: a phrase search of an index of its own", () => {
    matchesGolden("phrase", searchBody(query(), range, 50));
});

test("golden: a query, newest first, on an index shared with other environments, with its own field names", () => {
    const shared = query({
        target: SHARED,
        kind: "query",
        text: 'error AND "timed out" AND tim*',
        order: "desc",
        size: 20,
    });
    matchesGolden("query-shared", searchBody(shared, range, 20));
});

test("golden: a later bucket only counts, and asks for no hits, no sort and no fields", () => {
    matchesGolden("count-only", searchBody(query(), range, 0));
});

test("golden: the check for data has only the time range and the environment's filter", () => {
    matchesGolden("probe", probeBody(query({ target: SHARED, text: "never-sent" }), range));
});

test("the range sits on the environment's own time field, from gte to an exclusive lt", () => {
    const body = searchBody(query({ target: SHARED }), range, 5) as any;
    assert.deepEqual(body.query.bool.filter[0], {
        range: {
            timestamp: { gte: "2026-10-13T10:00:00Z", lt: "2026-10-13T12:00:00Z", format: "strict_date_optional_time" },
        },
    });
    assert.deepEqual(body.sort, [{ timestamp: { order: "asc", unmapped_type: "date" } }]);
});

test("a phrase is a match_phrase on the message field; a query is a query_string with that default field", () => {
    const phrase = searchBody(query({ text: "a b" }), range, 5) as any;
    assert.deepEqual(phrase.query.bool.must, [{ match_phrase: { message: "a b" } }]);
    const lucene = searchBody(query({ kind: "query", text: "error AND timeout" }), range, 5) as any;
    assert.deepEqual(lucene.query.bool.must, [
        { query_string: { query: "error AND timeout", default_field: "message", analyze_wildcard: true } },
    ]);
});

test("each filter entry is an exact term after the range, in the configured order", () => {
    const body = searchBody(query({ target: SHARED }), range, 5) as any;
    assert.deepEqual(body.query.bool.filter.slice(1), [
        { term: { "env.keyword": "prod" } },
        { term: { "tier.keyword": "web" } },
        { term: { region_code: 7 } },
        { term: { canary: false } },
    ]);
    assert.equal((searchBody(query(), range, 5) as any).query.bool.filter.length, 1, "no filter, no term");
});

test("a search asks for exact totals, a timeout shorter than the request's, and only the two fields it shows", () => {
    const body = searchBody(query(), range, 50) as any;
    assert.equal(body.size, 50);
    assert.equal(body.track_total_hits, true);
    assert.equal(body.timeout, SEARCH_TIMEOUT);
    assert.ok(Number.parseInt(SEARCH_TIMEOUT) < 30, "the backend gives up before the 30 s request timeout");
    assert.deepEqual(body._source, ["@timestamp", "message"]);
    assert.equal(body.from, undefined, "paging is done on the hits fetched, never with from");
});

test("order picks the sort direction", () => {
    assert.deepEqual((searchBody(query({ order: "desc" }), range, 5) as any).sort, [
        { "@timestamp": { order: "desc", unmapped_type: "date" } },
    ]);
    assert.deepEqual((searchBody(query({ order: "asc" }), range, 5) as any).sort, [
        { "@timestamp": { order: "asc", unmapped_type: "date" } },
    ]);
});

test("the check for data never carries the phrase, the query or a sort", () => {
    const body = probeBody(query({ text: "needle-xyz" }), range) as any;
    assert.equal(body.size, 0);
    assert.equal(body.query.bool.must, undefined);
    assert.ok(!JSON.stringify(body).includes("needle-xyz"));
    assert.deepEqual(Object.keys(body), ["size", "timeout", "track_total_hits", "query"]);
});

test("every combination the builder makes stays inside the grammar", () => {
    let checked = 0;
    for (const target of [PLAIN, SHARED]) {
        for (const kind of ["phrase", "query"] as const) {
            for (const order of ["asc", "desc"] as const) {
                const q = query({
                    target,
                    kind,
                    order,
                    text: kind === "query" ? 'message:"x y" AND level:ERROR' : "needle",
                });
                for (const size of [0, 1, 50, 200]) {
                    assert.deepEqual(problemsWith(searchBody(q, range, size), target), [], `${kind} ${order} ${size}`);
                }
                assert.deepEqual(problemsWith(probeBody(q, range), target), [], "the check for data");
                checked += 1;
            }
        }
    }
    assert.equal(checked, 8);
    // The longest window and a bucket of a few milliseconds are inside it too.
    const week = { from: FROM, to: FROM + 7 * 86_400_000 };
    assert.deepEqual(problemsWith(searchBody(query(), week, 5), PLAIN), []);
    assert.deepEqual(problemsWith(searchBody(query(), { from: FROM + 5, to: FROM + 1_500 }, 5), PLAIN), []);
});

test("the model's text only ever lands in one value, however much it looks like a request", () => {
    const hostile = [
        '"}}], "script": {"source": "1"}, "x": [{"match_all": {}',
        '{"aggs": {"all": {"terms": {"field": "message"}}}}',
        '\\" ] } } , "size": 10000, "from": 5 //',
        "__proto__",
        "message:* AND NOT message:a",
    ];
    for (const text of hostile) {
        for (const kind of ["phrase", "query"] as const) {
            const body = searchBody(query({ kind, text }), range, 50) as any;
            assert.deepEqual(problemsWith(body, PLAIN), [], text);
            const must = body.query.bool.must[0];
            const value = kind === "phrase" ? must.match_phrase.message : must.query_string.query;
            assert.equal(value, text, "kept exactly, as a value");
            assert.deepEqual(JSON.parse(JSON.stringify(body)), body, "and it survives serialising");
        }
    }
});

test("the grammar helper is not vacuous: it refuses what the builder must never make", () => {
    const good = searchBody(query(), range, 50) as any;
    const mutate = (change: (body: any) => void) => {
        const body = structuredClone(good);
        change(body);
        return body;
    };
    const bad: Array<[string, unknown]> = [
        ["no time range", mutate((b) => void b.query.bool.filter.splice(0, 1))],
        [
            "a range on another field",
            mutate(
                (b) =>
                    void (b.query.bool.filter[0] = {
                        range: {
                            other: {
                                gte: "2026-10-13T10:00:00Z",
                                lt: "2026-10-13T11:00:00Z",
                                format: "strict_date_optional_time",
                            },
                        },
                    }),
            ),
        ],
        ["eight days", mutate((b) => void (b.query.bool.filter[0].range["@timestamp"].lt = "2026-10-21T10:00:01Z"))],
        [
            "an end before the start",
            mutate((b) => void (b.query.bool.filter[0].range["@timestamp"].lt = "2026-10-13T09:00:00Z")),
        ],
        ["aggs", mutate((b) => void (b.aggs = { x: { terms: { field: "message" } } }))],
        ["a script in a clause", mutate((b) => void b.query.bool.must.push({ script: { script: "1" } }))],
        ["a second must clause", mutate((b) => void b.query.bool.must.push({ match_phrase: { message: "again" } }))],
        ["a phrase on another field", mutate((b) => void (b.query.bool.must = [{ match_phrase: { other: "x" } }]))],
        ["size 201", mutate((b) => void (b.size = 201))],
        ["from", mutate((b) => void (b.from = 10))],
        ["a sort on the message", mutate((b) => void (b.sort = [{ message: "asc" }]))],
        ["two sorts", mutate((b) => void b.sort.push({ "@timestamp": { order: "asc" } }))],
        ["more fields", mutate((b) => void b._source.push("secret"))],
        ["no fields", mutate((b) => void delete b._source)],
        ["inexact totals", mutate((b) => void (b.track_total_hits = 10_000))],
        ["a long timeout", mutate((b) => void (b.timeout = "600s"))],
        ["should clauses", mutate((b) => void (b.query.bool.should = [{ term: { x: "y" } }]))],
        ["a term with two fields", mutate((b) => void b.query.bool.filter.push({ term: { a: "1", b: "2" } }))],
        ["a wildcard filter", mutate((b) => void b.query.bool.filter.push({ wildcard: { a: "*" } }))],
    ];
    for (const [name, body] of bad) assert.notDeepEqual(problemsWith(body, PLAIN), [], `must refuse: ${name}`);
    const count = searchBody(query(), range, 0) as any;
    assert.notDeepEqual(problemsWith({ ...count, sort: good.sort }, PLAIN), [], "a count with a sort");
});

test("the same query is the same bytes every time", () => {
    assert.equal(JSON.stringify(searchBody(query(), range, 50)), JSON.stringify(searchBody(query(), range, 50)));
});
