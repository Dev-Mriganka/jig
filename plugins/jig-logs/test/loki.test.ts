// The Loki adapter by itself: the requests it builds, what the model's text can reach, how it reads a reply and what it
// makes of an error. No server here; loki-search.test.ts runs the whole tool against a fake Loki.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loki } from "../src/backends/loki.ts";
import { checkPipeline, literalPattern, matcherFor, quote, selectorProblem } from "../src/backends/logql.ts";
import type { Backend, LokiTarget, Target } from "../src/config.ts";
import { failureFromStatus } from "../src/failure.ts";
import { resolveQuery } from "../src/params.ts";
import type { LogQuery } from "../src/query.ts";
import { HOUR_MS } from "../src/time.ts";
import { InputError } from "../src/values.ts";
import { matchesGolden } from "./support/golden.ts";
import { bracesOutsideStrings, parseLogql, readString } from "./support/logql.ts";
import { NOW } from "./support/world.ts";

const FROM = Date.UTC(2026, 9, 13, 10, 0, 0);
const range = { from: FROM, to: FROM + 2 * HOUR_MS };
const SELECTOR = '{app="orders-api", env="staging"}';
const direct: Backend = { kind: "direct", url: "https://logs.example.com", auth: { kind: "bearer", token: "env:T" } };

const TARGET = loki.environment("staging", { selector: SELECTOR }) as LokiTarget;

function query(over: Partial<LogQuery> = {}): LogQuery {
    return {
        environment: "staging",
        target: TARGET,
        kind: "phrase",
        text: "req-7f3a9c",
        size: 50,
        order: "asc",
        range,
        ...over,
    };
}

type Params = Record<string, string>;
const search = (over: Partial<LogQuery> = {}, size = 50, bucket = range) =>
    loki.search(query(over), bucket, size) as Params;

// ---- the requests, as files -----------------------------------------------------------------------------------

test("golden: a phrase becomes one line filter after the selector", () => {
    matchesGolden("loki-phrase", search());
});

test("golden: match and exclude become line filters too, and a phrase comes first", () => {
    matchesGolden(
        "loki-match-exclude",
        search({ match: ["timeout", "orders"], exclude: ["Heartbeat"], order: "desc" }, 20),
    );
});

test("golden: a query is appended after the line filters, so Loki drops lines before it parses them", () => {
    matchesGolden(
        "loki-query",
        search({ kind: "query", text: '| json | level="error"', match: ["timeout"], exclude: ["Heartbeat"] }),
    );
});

test("golden: a bucket that only counts asks for one line, as Loki wants a limit of at least one", () => {
    matchesGolden("loki-count-only", search({}, 0));
});

test("golden: the check for data has the selector and the range, and nothing the model wrote", () => {
    matchesGolden(
        "loki-probe",
        loki.probe(query({ text: "never-sent", match: ["never-sent"], exclude: ["never-sent"] }), range),
    );
});

// ---- the filter ------------------------------------------------------------------------------------------------------

const FILTERED = loki.environment("staging", {
    selector: SELECTOR,
    filter: { namespace: ["orders", "billing"], region: "eu.west", shard: 3 },
}) as LokiTarget;

test("golden: a filter adds a matcher to the selector: = for one value, =~ for a list", () => {
    matchesGolden("loki-filter", search({ target: FILTERED, match: ["timeout"] }));
});

test("the matchers go inside the selector's braces, after its own, and the check for data has them too", () => {
    const parsed = parseLogql(search({ target: FILTERED }).query as string);
    assert.deepEqual(parsed?.matchers, [
        { label: "app", op: "=", value: "orders-api" },
        { label: "env", op: "=", value: "staging" },
        { label: "namespace", op: "=~", value: "orders|billing" },
        { label: "region", op: "=", value: "eu.west" },
        { label: "shard", op: "=", value: "3" },
    ]);
    assert.equal(parsed?.rest, "", "no line filter follows but the phrase");
    const probe = parseLogql((loki.probe(query({ target: FILTERED }), range) as Params).query as string);
    assert.deepEqual(probe?.matchers, parsed?.matchers);
    assert.equal(probe?.filters.length, 0, "and nothing the model wrote");
});

test("a selector with spaces before its brace, or in its matchers, is extended without a stray comma", () => {
    for (const selector of ['{app="orders-api" }', '{ app = "orders-api" , env != "dev" }', '{app="a,b}"}']) {
        const target = loki.environment("staging", { selector, filter: { namespace: ["a", "b"] } }) as LokiTarget;
        const text = (loki.probe(query({ target }), range) as Params).query as string;
        const parsed = parseLogql(text);
        assert.ok(parsed, text);
        assert.equal(parsed.rest, "");
        assert.deepEqual(parsed.matchers.at(-1), { label: "namespace", op: "=~", value: "a|b" });
        assert.equal(parsed.matchers.length, (parseLogql(selector)?.matchers.length ?? 0) + 1);
        assert.equal(selectorProblem(text), undefined, "the result is a selector too");
    }
});

test("a list becomes one regular expression of its values, each matched literally", () => {
    assert.equal(matcherFor("ns", ["a", "b"]), 'ns=~"a|b"');
    assert.equal(matcherFor("ns", ["only"]), 'ns=~"only"');
    assert.equal(matcherFor("ns", "one"), 'ns="one"');
    assert.equal(matcherFor("n", [1, 2.5, true]), String.raw`n=~"1|2\\.5|true"`);
    for (const values of [
        ["a.b", "c|d"],
        ["(x)", "[id]", "a+b*c?"],
        ['say "hi"', "back\\slash"],
        ["^s$", "{1}"],
    ]) {
        const read = readString(matcherFor("ns", values).slice("ns=~".length), 0);
        assert.ok(read, JSON.stringify(values));
        const pattern = new RegExp(`^(?:${read.value})$`);
        for (const value of values) assert.ok(pattern.test(value), `${value} is one of the alternatives`);
        assert.ok(!pattern.test(values.join("|")), "and the bar inside a value does not split it");
        assert.ok(!pattern.test("zzz"));
    }
    assert.ok(!new RegExp(`^(?:${literalPattern("a.b")}|c)$`).test("axb"), "a dot is a dot");
});

// ---- time, order and limit -----------------------------------------------------------------------------------------

test("start and end are nanoseconds since the epoch, exactly, and end is the end of the bucket", () => {
    const request = search();
    assert.equal(request.start, (BigInt(FROM) * 1_000_000n).toString());
    assert.equal(request.end, (BigInt(FROM + 2 * HOUR_MS) * 1_000_000n).toString());
    assert.ok(!Number.isSafeInteger(Number(request.start)), "too many digits for a number: they are built as text");
    const small = search({}, 5, { from: FROM + 5, to: FROM + 1_500 });
    assert.equal(small.start, "1791885600005000000");
    assert.equal(small.end, "1791885601500000000");
});

test("order picks the direction: asc fetches forward from the start, desc backward from the end", () => {
    assert.equal(search({ order: "asc" }).direction, "forward");
    assert.equal(search({ order: "desc" }).direction, "backward");
});

test("the limit is the hits still wanted, at least 1 and at most what Loki gives", () => {
    const limit = (size: number) => search({}, size).limit;
    assert.deepEqual([50, 200, 1, 0, -3, 5000, 5001, 100_000].map(limit), [
        "50",
        "200",
        "1",
        "1",
        "1",
        "5000",
        "5000",
        "5000",
    ]);
    assert.equal(loki.limits.maxHits, 5000);
    assert.equal(loki.limits.maxWindowMs, 721 * HOUR_MS);
});

// ---- how a request travels -------------------------------------------------------------------------------------

test("a request is a GET whose address carries the parameters, with no body", () => {
    const request = search({ kind: "query", text: '|= "a b" | json' });
    const wire = loki.wire(TARGET, direct)(request);
    assert.equal(wire.method, "GET");
    assert.equal(wire.body, undefined);
    const url = new URL(wire.path, "https://logs.example.com");
    assert.equal(url.pathname, "/loki/api/v1/query_range");
    assert.deepEqual(Object.fromEntries(url.searchParams), request, "exactly the parameters, once each");
    assert.deepEqual(Object.keys(request), ["query", "start", "end", "limit", "direction"]);
});

test("the tenant is the header X-Scope-OrgID, on a request through a transport too, and only when there is one", () => {
    const request = search();
    assert.equal(loki.wire(TARGET, direct)(request).headers, undefined);
    const tenant = { ...direct, tenant: "orders" };
    assert.deepEqual(loki.wire(TARGET, tenant)(request).headers, { "X-Scope-OrgID": "orders" });
    const viaTransport: Backend = {
        kind: "transport",
        url: "https://logs.example.com",
        transport: "corp",
        tenant: "a|b",
    };
    assert.deepEqual(loki.wire(TARGET, viaTransport)(request).headers, { "X-Scope-OrgID": "a|b" });
});

// ---- what the model's text can reach -----------------------------------------------------------------------------

const HOSTILE = [
    '"} |= "',
    '" or {app="other"} |= "',
    "\\",
    '\\"',
    '\\\\"',
    "`",
    "{",
    "}",
    '{app=~".+"}',
    "line\nbreak",
    "a\u0000b",
    " ",
    "\u007f\u009f",
    "emoji \u{1F600}",
    "&limit=1&query=x",
    "%22 %7B",
    '|= "x"',
    "# a comment",
    "' OR 1=1 --",
    "\\u0022",
];

test("quote escapes the quote, the backslash and every control character, and reads back as the text", () => {
    assert.equal(quote("plain"), '"plain"');
    assert.equal(quote('a"b'), '"a\\"b"');
    assert.equal(quote("a\\b"), '"a\\\\b"');
    assert.equal(quote("a\nb"), '"a\\u000ab"');
    for (const text of HOSTILE) {
        const read = readString(quote(text), 0);
        assert.equal(read?.value, text, JSON.stringify(text));
        assert.equal(read?.end, quote(text).length, "and the string ends where quote ends it");
    }
});

test("a phrase, a match and an exclude are each the value of one line filter, however hostile", () => {
    for (const text of HOSTILE) {
        const request = search({ text, match: [text, "m"], exclude: [text] });
        const parsed = parseLogql(request.query as string);
        assert.ok(parsed, JSON.stringify(text));
        assert.equal(parsed.selector, SELECTOR);
        assert.deepEqual(parsed.filters, [
            { op: "|~", value: `(?i)${literalPattern(text)}` },
            { op: "|~", value: `(?i)${literalPattern(text)}` },
            { op: "|~", value: "(?i)m" },
            { op: "!~", value: `(?i)${literalPattern(text)}` },
        ]);
        assert.equal(parsed.rest, "", "nothing else follows");
        assert.deepEqual(
            bracesOutsideStrings(request.query as string),
            [0],
            "the only { outside a string is the selector's",
        );
        // Nor does it reach the other parameters: the address carries them as they were built.
        const url: URL = new URL(loki.wire(TARGET, direct)(request).path, "https://logs.example.com");
        assert.deepEqual(Object.fromEntries(url.searchParams), request);
        assert.deepEqual([...url.searchParams.keys()], ["query", "start", "end", "limit", "direction"]);
    }
});

test("a value cannot leave its string or its matcher, however hostile", () => {
    for (const text of HOSTILE) {
        for (const setting of [text, [text, "x"]]) {
            const target = loki.environment("staging", { selector: SELECTOR, filter: { namespace: setting } });
            const request = loki.search(query({ target: target as LokiTarget }), range, 5) as Params;
            const parsed = parseLogql(request.query as string);
            assert.ok(parsed, JSON.stringify(text));
            assert.equal(parsed.matchers.length, 3, "the two of the selector and the one of the filter");
            assert.equal(parsed.rest, "", "nothing else follows");
            assert.deepEqual(bracesOutsideStrings(request.query as string), [0]);
        }
    }
});

test("the selector is the configuration's, whatever the model writes", () => {
    const other = loki.environment("prod", { selector: '{app="orders-api", env="production"}' }) as LokiTarget;
    const request = loki.search(query({ target: other, text: `${SELECTOR} |= "x"` }), range, 5) as Params;
    assert.equal(parseLogql(request.query as string)?.selector, '{app="orders-api", env="production"}');
    assert.equal((loki.probe(query({ target: other }), range) as Params).query, other.selector);
});

// ---- the model's query ---------------------------------------------------------------------------------------------

test("a query is a pipeline: it starts with |, and can hold { only inside a string", () => {
    const fine = [
        '|= "timeout"',
        '  |= "timeout"  ',
        '| json | level="error"',
        '|~ "time.*out" != "heartbeat"',
        '| line_format "{{.msg}}"',
        '| json | msg=~"a{2}"',
        "|= `{`",
        '|= "\\"" | json',
        '|= "a\\\\" | json',
        "| logfmt | duration > 10s",
        '|= "# not a comment"',
    ];
    for (const text of fine) assert.equal(checkPipeline(text), text.trim(), text);
    const refused: Array<[string, RegExp]> = [
        ['!= "x"', /must start with \|/],
        ['{app="other"}', /must start with \|/],
        [', env="production"}', /must start with \|/],
        ["", /must start with \|/],
        ["   ", /must start with \|/],
        ["json", /must start with \|/],
        ['|= "a" or {app="other"}', /cannot hold \{ outside quotes/],
        ['|= "a" {app="other"}', /cannot hold \{ outside quotes/],
        ["| json {", /cannot hold \{ outside quotes/],
        ['|= "a\\\\" {x="y"}', /cannot hold \{ outside quotes/],
        ["|= `a` {x=`y`}", /cannot hold \{ outside quotes/],
        ['|= "a" # {x="y"}', /cannot hold \{ outside quotes/],
        ['|= "a', /never closed/],
        ['|= "a\\"', /never closed/],
        ["|= `a", /never closed/],
        ['|= "a"\n{x="y"}', /one line/],
        ['|= "a"\u0000', /one line/],
    ];
    for (const [text, why] of refused) {
        assert.throws(
            () => checkPipeline(text),
            (error: Error) => error instanceof InputError && why.test(error.message) && !error.message.includes("\n"),
            JSON.stringify(text),
        );
    }
});

test("a refused query is an InputError: a TypeError that jig-core blocks without asking", () => {
    assert.throws(
        () => loki.checkQuery?.('{app=~".+"}'),
        (error: Error) => error instanceof TypeError && error.name === "TypeError" && /^logs: /.test(error.message),
    );
    // The request builder looks again, so a request is never made from a query nobody checked.
    assert.throws(() => search({ kind: "query", text: '|= "a" {x="y"}' }), InputError);
});

test("the checks of a call refuse such a query before anything is built, and only for a backend that needs it", () => {
    const resolve = (input: Record<string, unknown>, target: Target = TARGET) =>
        resolveQuery({ environment: "staging", ...input }, "staging", target, NOW);
    for (const query of ['{app="other"}', '|= "a" {x="y"}', "", '|= "a']) {
        assert.throws(() => resolve({ query }), InputError, JSON.stringify(query));
    }
    assert.equal(resolve({ query: '| json | level="error"' }).text, '| json | level="error"');
    assert.equal(resolve({ phrase: '{app="other"} |= "a"' }).kind, "phrase", "a phrase may hold anything");
    // Elasticsearch has nothing to refuse: its query text only ever lands in one value.
    const elastic = {
        index: "app-*",
        timeField: "@timestamp",
        messageField: "message",
        filter: {},
        jigEnvironment: "x",
    };
    assert.equal(resolve({ query: '{app="other"}' }, elastic).text, '{app="other"}');
});

test("match and exclude reach the query for a backend that wants them, and are absent when not given", () => {
    const resolve = (input: Record<string, unknown>) =>
        resolveQuery({ phrase: "x", environment: "staging", ...input }, "staging", TARGET, NOW);
    assert.deepEqual(
        [resolve({ match: ["a", "b"], exclude: ["c"] }).match, resolve({ match: ["a", "b"], exclude: ["c"] }).exclude],
        [["a", "b"], ["c"]],
    );
    const plain = resolve({});
    assert.ok(!("match" in plain) && !("exclude" in plain));
    assert.throws(
        () => resolve({ match: [] }),
        (error: Error) => error instanceof TypeError && error.message === "logs: match must list 1 to 5 texts",
    );
});

test("a query is sent as written, without the spaces around it", () => {
    const request = search({ kind: "query", text: '  | json | level="error"  ' });
    assert.equal(request.query, `${SELECTOR} | json | level="error"`);
});

// ---- the selector of an environment ---------------------------------------------------------------------------------

test("a selector is matchers in braces; at least one is = or =~ with a value", () => {
    const fine = [
        '{app="orders-api"}',
        '{app="orders-api", env="staging"}',
        '{ app = "orders-api" , env != "dev" }',
        '{app=~"orders-.+"}',
        "{app=`orders-api`}",
        '{app="orders-api",env="a,b}"}',
        '{app="a\\"b"}',
        '{_x1="y", env!~"dev|qa", app="z"}',
        '  {app="orders-api"}  ',
    ];
    for (const text of fine) assert.equal(selectorProblem(text), undefined, text);
    const malformed = [
        undefined,
        7,
        "",
        "app=orders-api",
        "{}",
        '{app="orders-api"',
        '{app="orders-api"} |= "x"',
        '{app="orders-api"}{env="x"}',
        '{app="orders-api",}',
        "{app=orders-api}",
        "{app='orders-api'}",
        '{1app="x"}',
        '{service.name="x"}',
        '{app=="x"}',
        '{app="x"\n}',
        `{app="${"x".repeat(1000)}"}`,
    ];
    for (const text of malformed) assert.equal(selectorProblem(text), "form", String(text));
    for (const text of ['{app!="x"}', '{app!~"x", env!="y"}', '{app=""}', "{app=``}", '{app="", env!="y"}']) {
        assert.equal(selectorProblem(text), "positive", text);
    }
});

// ---- reading a reply -----------------------------------------------------------------------------------------------

const ns = (seconds: number, nanos = 0) => (BigInt(FROM + seconds * 1000) * 1_000_000n + BigInt(nanos)).toString();
const reply = (...result: unknown[]) => JSON.stringify({ status: "success", data: { resultType: "streams", result } });
const parse = (text: string, over: Record<string, string> = {}) =>
    loki.parse(text, { direction: "forward", limit: "50", ...over });

test("several streams are merged into one list of hits, sorted by time in the direction asked", () => {
    const text = reply(
        {
            stream: { pod: "a" },
            values: [
                [ns(3), "a3"],
                [ns(1), "a1"],
            ],
        },
        {
            stream: { pod: "b" },
            values: [
                [ns(2), "b2"],
                [ns(0), "b0"],
            ],
        },
    );
    const lines = (page: ReturnType<typeof parse>) => page?.hits.map((hit) => hit.message);
    assert.deepEqual(lines(parse(text)), ["b0", "a1", "b2", "a3"]);
    assert.deepEqual(lines(parse(text, { direction: "backward" })), ["a3", "b2", "a1", "b0"]);
});

test("lines with the same time keep the order Loki sent their streams in, whichever the direction", () => {
    const text = reply(
        { stream: { pod: "a" }, values: [[ns(1), "from a"]] },
        { stream: { pod: "b" }, values: [[ns(1), "from b"]] },
    );
    assert.deepEqual(
        parse(text)?.hits.map((hit) => hit.message),
        ["from a", "from b"],
    );
    assert.deepEqual(
        parse(text, { direction: "backward" })?.hits.map((hit) => hit.message),
        ["from a", "from b"],
    );
});

test("a hit has its time, its line and the labels of its stream, and the labels never replace the first two", () => {
    const page = parse(
        reply({ stream: { pod: "a", message: "label", "@timestamp": "label" }, values: [[ns(1), "line"]] }),
    );
    assert.deepEqual(page?.hits, [{ pod: "a", message: "line", "@timestamp": "2026-10-13T10:00:01.000Z" }]);
});

test("the time keeps as many digits as the stamp has: 3, 6 or 9", () => {
    const times = [ns(1), ns(1, 123_000_000), ns(1, 123_456_000), ns(1, 123_456_789), ns(1, 100)];
    const page = parse(reply({ stream: {}, values: times.map((stamp) => [stamp, "x"]) }));
    assert.deepEqual(
        page?.hits.map((hit) => hit["@timestamp"]),
        [
            "2026-10-13T10:00:01.000Z",
            "2026-10-13T10:00:01.000000100Z",
            "2026-10-13T10:00:01.123Z",
            "2026-10-13T10:00:01.123456Z",
            "2026-10-13T10:00:01.123456789Z",
        ],
    );
});

test("the total is the lines returned, and a lower bound when the limit was filled", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, n) => [ns(n), `l${n}`]);
    assert.deepEqual(parse(reply({ stream: {}, values: lines(2) }), { limit: "3" })?.total, 2);
    assert.equal(parse(reply({ stream: {}, values: lines(2) }), { limit: "3" })?.relation, "eq");
    assert.equal(parse(reply({ stream: {}, values: lines(3) }), { limit: "3" })?.relation, "gte");
    assert.equal(parse(reply({ stream: {}, values: lines(1) }), { limit: "1" })?.relation, "gte");
    const none = parse(reply());
    assert.deepEqual([none?.total, none?.relation, none?.hits], [0, "eq", []]);
    assert.equal(parse(reply({ stream: {}, values: lines(2) }))?.incomplete, undefined);
});

test("a line may carry structured metadata as a third part, which is not read", () => {
    const page = parse(reply({ stream: {}, values: [[ns(1), "line", { structuredMetadata: { trace: "t1" } }]] }));
    assert.equal(page?.hits[0]?.message, "line");
});

test("a reply that is not a result of log lines is not read, whole: no hit is dropped quietly", () => {
    const good = { stream: {}, values: [[ns(1), "ok"]] };
    const wrong: unknown[] = [
        "",
        "<html>gateway</html>",
        "[]",
        "null",
        "{}",
        '{"hits":{"hits":[]}}',
        JSON.stringify({ status: "error", data: { resultType: "streams", result: [] } }),
        JSON.stringify({ data: { resultType: "streams", result: [] } }),
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } }),
        JSON.stringify({ status: "success", data: { resultType: "streams", result: {} } }),
        JSON.stringify({ status: "success", data: "streams" }),
        reply({ stream: {} }),
        reply({ stream: {}, values: "x" }),
        reply(7),
        reply(good, { stream: {}, values: [[ns(1), 7]] }),
        reply(good, { stream: {}, values: [[1, "x"]] }),
        reply(good, { stream: {}, values: [["abc", "x"]] }),
        reply(good, { stream: {}, values: [["-5", "x"]] }),
        reply(good, { stream: {}, values: [["1.5", "x"]] }),
        reply(good, { stream: {}, values: [[ns(1)]] }),
        reply(good, { stream: {}, values: ["x"] }),
    ];
    for (const text of wrong) assert.equal(parse(text as string), undefined, String(text).slice(0, 60));
});

// ---- what an error means ---------------------------------------------------------------------------------------------

test("the range limit is a failure a shorter bucket gets past; the limit on lines stops the search", () => {
    const range = loki.classify(
        400,
        "the query time range exceeds the limit (query length: 744h0m0s, limit: 721h0m0s)",
    );
    assert.deepEqual(range, { reason: "window_too_long", split: true, fatal: false });
    assert.deepEqual(loki.classify(400, "max query length exceeded"), range);
    const lines = loki.classify(400, "max entries limit per query exceeded, limit > max_entries_limit (6000 > 5000)");
    assert.deepEqual(lines, { reason: "response_too_large", split: false, fatal: true });
    assert.deepEqual(loki.classify(413, "response larger than the max message size"), {
        reason: "response_too_large",
        split: false,
        fatal: false,
    });
});

test("any other answer is left to the HTTP rules, which give the same failures as for every backend", () => {
    const reasons = (status: number, text = "") => {
        const failure = failureFromStatus(status, text, loki);
        return failure === undefined ? undefined : [failure.reason, failure.split, failure.fatal];
    };
    assert.equal(loki.classify(400, "parse error at line 1, col 5: syntax error: unexpected IDENTIFIER"), undefined);
    assert.deepEqual(reasons(400, "parse error at line 1, col 5: syntax error"), ["query_rejected", false, true]);
    assert.deepEqual(reasons(400, "queries require at least one regexp or equality matcher"), [
        "query_rejected",
        false,
        true,
    ]);
    assert.deepEqual(reasons(404, "404 page not found"), ["index_not_found", false, true]);
    assert.deepEqual(reasons(408), ["timeout", true, false]);
    assert.deepEqual(reasons(504, "context deadline exceeded"), ["timeout", true, false]);
    assert.deepEqual(reasons(429, "too many outstanding requests"), ["rate_limited", false, false]);
    assert.deepEqual(reasons(500, "failed to load chunk"), ["upstream_unavailable", true, false]);
    assert.deepEqual(reasons(503, "index not ready"), ["upstream_unavailable", true, false]);
    assert.deepEqual(reasons(400, "the query time range exceeds the limit"), ["window_too_long", true, false]);
    assert.deepEqual(reasons(413), ["response_too_large", false, false]);
    assert.equal(reasons(200), undefined);
    // The words of a limit only count on a 400: a gateway's 502 that quotes one is a gateway.
    assert.deepEqual(reasons(502, "max entries limit per query exceeded"), ["upstream_unavailable", true, false]);
});

test("a problem with the sign-in names the settings of Loki, and none of them repeats the reply", () => {
    assert.throws(() => failureFromStatus(401, "no org id", loki), {
        message:
            "The backend did not accept the sign-in (HTTP 401): sign in again, or check backend.auth and backend.tenant in the logs section of jig.json",
    });
    assert.throws(
        () => failureFromStatus(403, "secret-reply", loki),
        (error: Error) => /access to the logs \(HTTP 403\)/.test(error.message) && !error.message.includes("secret"),
    );
    assert.throws(() => failureFromStatus(302, "", loki), /redirect \(HTTP 302\)/);
});

test("a literal pattern matches its text exactly, whatever regular-expression characters it holds", () => {
    for (const text of ["a.b", "(x)", "a+b*c?", "[id] {1}", "^start$", "back\\slash", "pipe|or"]) {
        const pattern = new RegExp(`^${literalPattern(text)}$`, "i");
        assert.ok(pattern.test(text), text);
        assert.ok(pattern.test(text.toUpperCase()), `${text}, ignoring case`);
    }
    assert.ok(!new RegExp(`^${literalPattern("a.b")}$`).test("axb"), "a dot is a dot, not any character");
});
