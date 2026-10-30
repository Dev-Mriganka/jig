import assert from "node:assert/strict";
import { test } from "node:test";
import type { Target } from "../src/config.ts";
import type { LogQuery } from "../src/query.ts";
import type { Source } from "../src/response.ts";
import type { SearchOutcome } from "../src/search.ts";
import { summarize } from "../src/summary.ts";
import type { View } from "../src/summary.ts";

const FROM = Date.UTC(2026, 9, 13, 10, 0, 0);

const TARGET: Target = {
    index: "app-*",
    timeField: "@timestamp",
    messageField: "message",
    filter: {},
    jigEnvironment: "staging",
};
const query: LogQuery = {
    environment: "prod",
    target: TARGET,
    kind: "phrase",
    text: "abc-123",
    size: 50,
    order: "asc",
    range: { from: FROM, to: FROM + 7_200_000 },
};

/** A fetched hit: its time is `n` seconds after ten o'clock. */
function hit(n: number, over: Source = {}): Source {
    return {
        "@timestamp": `2026-10-13T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
        message: `message ${n}`,
        ...over,
    };
}

const numbered = (count: number, over: (n: number) => Source = () => ({})) =>
    Array.from({ length: count }, (_, n) => hit(n, { message: `row ${n}`, ...over(n) }));

function outcome(over: Partial<SearchOutcome> = {}): SearchOutcome {
    const hits = over.hits ?? [hit(1), hit(2)];
    return {
        status: "complete",
        total: { value: hits.length, relation: "eq" },
        windows: [
            {
                from: "2026-10-13T10:00:00Z",
                to: "2026-10-13T12:00:00Z",
                state: "searched",
                total: hits.length,
                returned: hits.length,
            },
        ],
        hits,
        splits: 0,
        requests: 1,
        ...over,
    };
}

const view = (over: Partial<View> = {}): View => ({ offset: 0, ...over });
const lines = (text: string) => text.split("\n");

test("the header names the environment, the window, the status, the hits found, fetched and shown, and the buckets", () => {
    const { text } = summarize(query, outcome(), view());
    assert.equal(
        lines(text)[0],
        "prod 2026-10-13T10:00:00Z..2026-10-13T12:00:00Z: complete, 2 hits, 2 fetched (oldest first), 2 shown, 1 bucket",
    );
});

test("newest first is named when the order is desc", () => {
    const { text } = summarize({ ...query, order: "desc" }, outcome(), view());
    assert.match(lines(text)[0] as string, /, 2 fetched \(newest first\), 2 shown, 1 bucket$/);
});

test("a lower-bound total says so, and so does a single hit", () => {
    assert.match(
        lines(summarize(query, outcome({ total: { value: 10_000, relation: "gte" } }), view()).text)[0] as string,
        /complete, at least 10000 hits,/,
    );
    const one = summarize(query, outcome({ hits: [hit(1)] }), view());
    assert.match(lines(one.text)[0] as string, /complete, 1 hit, 1 fetched \(oldest first\), 1 shown, 1 bucket$/);
});

test("no hits fetched: the header has no fetched and shown, and says how many buckets were searched", () => {
    const windows = [0, 1, 2].map((day) => ({
        from: `2026-10-1${day}T00:00:00Z`,
        to: `2026-10-1${day + 1}T00:00:00Z`,
        state: "searched" as const,
    }));
    const { text } = summarize(query, outcome({ hits: [], windows }), view());
    assert.equal(lines(text)[0], "prod 2026-10-13T10:00:00Z..2026-10-13T12:00:00Z: complete, 0 hits, 3 buckets");
});

test("a bucket that was split after a timeout is mentioned", () => {
    const { text } = summarize(query, outcome({ splits: 2 }), view());
    assert.match(lines(text)[0] as string, /, 1 bucket \(2 split after a timeout\)$/);
});

test("each hit is a line of its time and its message; up to 20 are shown and the page says where the rest starts", () => {
    const { text, details } = summarize(query, outcome({ hits: numbered(35) }), view());
    const all = lines(text);
    const start = all.indexOf("Hits 1-20 of 35 fetched hits, 15 more: call again with offset 20:");
    assert.ok(start > 0, text);
    assert.equal(all.length - start - 1, 20);
    assert.equal(all[start + 1], "2026-10-13T10:00:00.000Z row 0");
    assert.equal(details.shown, 20);
    assert.equal(details.fetched, 35);
    assert.match(all[0] as string, /35 fetched \(oldest first\), 20 shown/);
});

test("a page that shows every fetched hit has no line of its own", () => {
    const all = lines(summarize(query, outcome({ hits: numbered(3) }), view()).text);
    assert.equal(all.length, 4, "the header and three hits");
    assert.ok(all.slice(1).every((line) => /^2026-10-13T10:00:0\d\.000Z row \d$/.test(line)));
});

test("a hit without a time is its message alone", () => {
    const { text } = summarize(query, outcome({ hits: [{ message: "no time here" }] }), view());
    assert.equal(lines(text)[1], "no time here");
});

test("gaps are listed with their reason and the next step, and neighbours with one reason read as one", () => {
    const windows: SearchOutcome["windows"] = [
        { from: "2026-10-13T10:00:00Z", to: "2026-10-13T11:00:00Z", state: "searched", total: 3, returned: 3 },
        { from: "2026-10-13T11:00:00Z", to: "2026-10-13T11:30:00Z", state: "missing", reason: "timeout" },
        { from: "2026-10-13T11:30:00Z", to: "2026-10-13T12:00:00Z", state: "missing", reason: "timeout" },
        {
            from: "2026-10-13T12:00:00Z",
            to: "2026-10-13T13:00:00Z",
            state: "partial",
            total: 4,
            returned: 1,
            reason: "failed_shards",
        },
    ];
    const { text, details } = summarize(
        query,
        outcome({ status: "partial", total: { value: 7, relation: "gte" }, windows }),
        view(),
    );
    assert.match(text, /: partial, at least 7 hits/);
    assert.match(
        text,
        /^Gaps: 2026-10-13T11:00:00Z\.\.2026-10-13T12:00:00Z timeout; 2026-10-13T12:00:00Z\.\.2026-10-13T13:00:00Z failed_shards$/m,
    );
    assert.match(text, /^Next: Narrow the window/m);
    assert.match(text, /^Next: Some shards failed/m);
    assert.equal(details.buckets, 4);
});

test("no gaps, no Gaps line; many gaps are cut", () => {
    assert.ok(!summarize(query, outcome(), view()).text.includes("Gaps:"));
    const windows = Array.from({ length: 9 }, (_, i) => ({
        from: `2026-10-13T${String(i * 2).padStart(2, "0")}:00:00Z`,
        to: `2026-10-13T${String(i * 2 + 1).padStart(2, "0")}:00:00Z`,
        state: "missing" as const,
        reason: "timeout" as const,
    }));
    assert.match(summarize(query, outcome({ status: "partial", windows }), view()).text, /^Gaps: .*\(\+4 more\)$/m);
});

test("failed says that nothing was searched, and why", () => {
    const windows: SearchOutcome["windows"] = [
        { from: "2026-10-13T10:00:00Z", to: "2026-10-13T12:00:00Z", state: "missing", reason: "query_rejected" },
    ];
    const { text } = summarize(
        query,
        outcome({ status: "failed", hits: [], total: { value: 0, relation: "gte" }, windows }),
        view(),
    );
    assert.equal(
        lines(text)[0],
        "prod 2026-10-13T10:00:00Z..2026-10-13T12:00:00Z: failed, no window could be searched",
    );
    assert.match(text, /query_rejected/);
    assert.match(text, /Lucene/);
});

test("zero hits: the availability line says that the check proves nothing about retention", () => {
    const base = { hits: [], total: { value: 0, relation: "eq" as const } };
    const documents = summarize(query, outcome({ ...base, availability: { state: "documents", count: 1234 } }), view());
    assert.match(
        documents.text,
        /^Availability: the window holds 1234 documents in this environment without your phrase or query\. .*proves nothing about retention\.$/m,
    );
    assert.match(lines(documents.text)[0] as string, /complete, 0 hits, 1 bucket$/);
    const one = summarize(query, outcome({ ...base, availability: { state: "documents", count: 1 } }), view());
    assert.match(one.text, /^Availability: the window holds 1 document in this environment/m);
    const none = summarize(query, outcome({ ...base, availability: { state: "none", count: 0 } }), view());
    assert.match(
        none.text,
        /^Availability: no documents at all in this environment and window\. .*proves nothing about retention\.$/m,
    );
    const unknown = summarize(
        query,
        outcome({ ...base, availability: { state: "unknown", reason: "timeout" } }),
        view(),
    );
    assert.match(unknown.text, /^Availability: unknown \(timeout\)\. Zero hits proves nothing about retention\.$/m);
    assert.equal(lines(unknown.text).length, 2, "no hit lines");
});

test("the details carry the counts and windows and never a message", () => {
    const { details } = summarize(query, outcome({ availability: { state: "documents", count: 5 } }), view());
    assert.deepEqual(Object.keys(details).sort(), [
        "buckets",
        "fetched",
        "shown",
        "splits",
        "status",
        "total",
        "windows",
    ]);
    assert.equal(details.status, "complete");
    assert.deepEqual(details.total, { value: 2, relation: "eq" });
    assert.ok(!JSON.stringify(details).includes("message 1"));
});

// ---- choosing among the fetched hits ------------------------------------------------------------------------

test("match keeps the hits whose message contains all the texts, ignoring case, and says how many of the fetched ones did", () => {
    const hits = numbered(6, (n) => ({
        message:
            n % 2 === 0
                ? `AfterThrowing in CancelProvisions row ${n}`
                : n === 3
                  ? "afterthrowing only"
                  : `plain row ${n}`,
    }));
    const { text, details } = summarize(
        query,
        outcome({ hits }),
        view({ match: ["AfterThrowing", "cancelProvisions"] }),
    );
    const all = lines(text);
    assert.ok(
        all.includes("3 of 6 fetched hits contain all 2 match terms (case-insensitive, fetched hits only)."),
        text,
    );
    assert.ok(all.includes("Hits 1-3 of 3 matching hits, none after these:"));
    assert.deepEqual(
        all.slice(-3).map((line) => line.slice(25)),
        [
            "AfterThrowing in CancelProvisions row 0",
            "AfterThrowing in CancelProvisions row 2",
            "AfterThrowing in CancelProvisions row 4",
        ],
    );
    assert.equal(details.matched, 3);
    assert.equal(details.fetched, 6);
    assert.match(all[0] as string, /6 fetched \(oldest first\), 3 shown/);
});

test("match reads the whole message, not the characters a line keeps", () => {
    const hits = [hit(1, { message: `${"x".repeat(500)} needle-at-the-end` }), hit(2, { message: "other" })];
    const { text, details } = summarize(query, outcome({ hits }), view({ match: ["NEEDLE-at"], chars: 300 }));
    assert.match(text, /^1 of 2 fetched hits contain all 1 match term /m);
    assert.equal(details.shown, 1);
});

test("zero matches say so, and say that the rest of the window was not checked", () => {
    const { text, details } = summarize(
        query,
        outcome({ hits: numbered(5), total: { value: 900, relation: "eq" } }),
        view({ match: ["nothing like this"] }),
    );
    assert.match(
        text,
        /^0 of 5 fetched hits contain all 1 match term \(.*fetched hits only\)\. The window holds 900 hits and only 5 were fetched, so more may exist:/m,
    );
    assert.equal(lines(text).length, 2, "the header and that line");
    assert.equal(details.matched, 0);
    const lower = summarize(
        query,
        outcome({ hits: numbered(5), total: { value: 900, relation: "gte" } }),
        view({ match: ["x"] }),
    );
    assert.match(lower.text, /The window holds at least 900 hits/);
});

test("exclude drops the hits whose message contains any of the texts, and combines with match", () => {
    const hits = numbered(8, (n) => ({
        message: n % 2 === 0 ? `Heartbeat ok ${n}` : n === 5 ? "HEARTBEAT failed 5" : `real work ${n}`,
    }));
    const dropped = summarize(query, outcome({ hits }), view({ exclude: ["heartbeat"] }));
    assert.match(
        dropped.text,
        /^3 of 8 fetched hits contain none of 1 exclude term \(case-insensitive, fetched hits only\)\.$/m,
    );
    assert.deepEqual(
        lines(dropped.text)
            .slice(-3)
            .map((line) => line.slice(25)),
        ["real work 1", "real work 3", "real work 7"],
    );
    assert.equal(dropped.details.matched, 3);
    const both = summarize(query, outcome({ hits }), view({ match: ["work"], exclude: ["work 3", "WORK 7"] }));
    assert.match(both.text, /^1 of 8 fetched hits contain all 1 match term and none of 2 exclude terms /m);
    assert.equal(lines(both.text).at(-1)?.slice(25), "real work 1");
    const nothing = summarize(query, outcome({ hits: numbered(3) }), view({ exclude: ["row"] }));
    assert.match(nothing.text, /^0 of 3 fetched hits contain none of 1 exclude term /m);
    assert.equal(lines(nothing.text).length, 2);
});

test("the texts of match, exclude and around are never repeated: one that opens a JSON body would hide its line", () => {
    const terms = ['{"chargeNumber"', "[{", 'key="open'];
    const { text } = summarize(
        query,
        outcome({ hits: numbered(4) }),
        view({ match: terms, exclude: terms, around: terms[0] as string }),
    );
    for (const term of terms) assert.ok(!text.includes(term), term);
});

test("offset pages through the fetched hits: the range, how many remain, and the offset to ask for next", () => {
    const hits = numbered(45);
    const second = summarize(query, outcome({ hits }), view({ offset: 20 }));
    assert.match(second.text, /^Hits 21-40 of 45 fetched hits, 5 more: call again with offset 40:$/m);
    assert.equal(
        lines(second.text)[
            lines(second.text).indexOf("Hits 21-40 of 45 fetched hits, 5 more: call again with offset 40:") + 1
        ]?.slice(25),
        "row 20",
    );
    const last = summarize(query, outcome({ hits }), view({ offset: 40 }));
    assert.match(last.text, /^Hits 41-45 of 45 fetched hits, none after these:$/m);
    assert.equal(last.details.shown, 5);
});

test("offset pages within the matching hits, and one hit reads as 'Hit N'", () => {
    const hits = numbered(50, (n) => ({ message: n % 2 === 0 ? `hit even ${n}` : `odd ${n}` }));
    const page = summarize(query, outcome({ hits }), view({ match: ["even"], offset: 24 }));
    assert.match(page.text, /^25 of 50 fetched hits contain all 1 match term /m);
    assert.match(page.text, /^Hit 25 of 25 matching hits, none after these:$/m);
    assert.equal(lines(page.text).at(-1)?.slice(25), "hit even 48");
    const middle = summarize(query, outcome({ hits }), view({ match: ["even"], offset: 10 }));
    assert.match(middle.text, /^Hits 11-25 of 25 matching hits, none after these:$/m);
});

test("an offset past the end says how many there are, instead of showing nothing", () => {
    const result = summarize(query, outcome({ hits: numbered(30) }), view({ offset: 99 }));
    assert.match(result.text, /^offset 99 is past the end: there are only 30 fetched hits \(offsets 0 to 29\)\.$/m);
    assert.equal(result.details.shown, 0);
    const matching = summarize(query, outcome({ hits: numbered(30) }), view({ match: ["row 1"], offset: 11 }));
    assert.match(matching.text, /^offset 11 is past the end: there are only 11 matching hits \(offsets 0 to 10\)\.$/m);
});

test("around and chars shape the lines and say nothing new in the header", () => {
    const message = `${"head ".repeat(200)}the NEEDLE is here ${"tail ".repeat(200)}`;
    const { text, details } = summarize(
        query,
        outcome({ hits: [hit(1, { message })] }),
        view({ around: "needle", chars: 200 }),
    );
    const shown = lines(text)[1] as string;
    assert.ok(shown.length <= 200 + 25);
    assert.ok(shown.includes("NEEDLE"));
    assert.equal(lines(text).length, 2);
    assert.equal(details.matched, undefined, "they do not choose among the hits");
});

test("long hits shrink the page, and the text says where the rest starts", () => {
    const hits = numbered(30, (n) => ({ message: `${n} ${"long ".repeat(900)}` }));
    const result = summarize(query, outcome({ hits }), view({ chars: 4000 }));
    assert.equal(result.details.shown, 5);
    assert.match(result.text, /^Hits 1-5 of 30 fetched hits, 25 more: call again with offset 5:$/m);
    assert.ok(result.text.length < 30_000, String(result.text.length));
    const next = summarize(query, outcome({ hits }), view({ chars: 4000, offset: 5 }));
    assert.match(next.text, /^Hits 6-10 of 30 fetched hits, 20 more: call again with offset 10:$/m);
});

test("a leading timestamp that is the hit's own time is not repeated in its line", () => {
    const own = hit(1, {
        "@timestamp": "2026-10-16T10:31:12.123456",
        message: "[2026-10-16 10:31:12.123] DEBUG [pool-1] sending",
    });
    const { text } = summarize(query, outcome({ hits: [own] }), view());
    assert.match(text, /^2026-10-16T10:31:12\.123456 DEBUG \[pool-1\] sending$/m);
});

// ---- bodies cut for length ---------------------------------------------------------------------------------

const BODY = JSON.stringify({
    accountId: "8a1234",
    items: Array.from({ length: 80 }, (_, i) => ({ chargeNumber: `C-${i}`, quantity: 3 })),
});
const CUT = `{…} is a JSON body cut for length, not hidden: rerun with chars: 4000 (or around: "<term>") to see it; in production, personal values are masked and IDs are kept.`;
const cutLines = (text: string) => lines(text).filter((line) => /cut for length/.test(line));

test("a hit that shows {…} comes with one line saying it is cut for length, not hidden", () => {
    // Five hits, so the page keeps its default width (a few hits get whole lines).
    const hits = [
        hit(1, { message: `Before: previewOrder, args: ${BODY}` }),
        hit(2, { message: `other ${BODY}` }),
        ...numbered(3),
    ];
    const { text, details } = summarize(query, outcome({ hits }), view());
    assert.match(lines(text)[lines(text).length - 5] as string, /args: \{…\}$/);
    assert.deepEqual(cutLines(text), [CUT], "once, however many hits are cut");
    assert.equal(details.shown, 5);
});

test("the line comes before the hits, and only when something was closed off", () => {
    const hits = [hit(1, { message: `body ${BODY}` }), ...numbered(4)];
    const all = lines(summarize(query, outcome({ hits }), view()).text);
    assert.ok(all.indexOf(CUT) > 0 && all.indexOf(CUT) < all.findIndex((line) => line.startsWith("2026-")));
    const plain = summarize(query, outcome({ hits: [hit(1, { message: "x ".repeat(400) }), ...numbered(4)] }), view());
    assert.deepEqual(cutLines(plain.text), [], "plain text cut at the limit is not a JSON body");
    assert.deepEqual(cutLines(summarize(query, outcome(), view()).text), []);
});

test("a hit on another page does not trigger it, and a list says list", () => {
    const hits = [hit(1, { message: `body ${BODY}` }), ...numbered(24)];
    assert.deepEqual(cutLines(summarize(query, outcome({ hits }), view({ offset: 1 })).text), []);
    const list = summarize(
        query,
        outcome({ hits: [hit(1, { message: `items ${JSON.stringify(JSON.parse(BODY).items)}` }), ...numbered(4)] }),
        view(),
    );
    assert.deepEqual(cutLines(list.text), [CUT.replace("{…} is a JSON body", "[…] is a JSON list")]);
});

test("at the widest chars the line no longer offers chars, which cannot go higher", () => {
    const hits = [
        hit(1, {
            message: `body ${JSON.stringify({ items: Array.from({ length: 600 }, (_, i) => ({ chargeNumber: `C-${i}` })) })}`,
        }),
    ];
    const found = cutLines(summarize(query, outcome({ hits }), view({ chars: 4000 })).text);
    assert.equal(found.length, 1);
    assert.equal(
        found[0],
        '{…} is a JSON body longer than 4000 characters, cut for length, not hidden: use around: "<term>" for the part you need; in production, personal values are masked and IDs are kept.',
    );
});

// ---- one to three hits are read, not scanned -----------------------------------------------------------------

const LONG_BODY = (items: number) =>
    JSON.stringify({
        accountId: "8a1234",
        items: Array.from({ length: items }, (_, i) => ({ chargeNumber: `C-${i}`, quantity: 3 })),
    });
const bodyHit = (n: number, items: number) => hit(n, { message: `Before: previewOrder, args: ${LONG_BODY(items)}` });

test("one to three hits with chars unset keep up to 4000 characters, and a body that fits is shown whole", () => {
    for (const count of [1, 2, 3]) {
        const hits = Array.from({ length: count }, (_, n) => bodyHit(n, 60));
        const { text, details } = summarize(query, outcome({ hits }), view());
        assert.equal(details.shown, count);
        const shown = lines(text).slice(-count);
        for (const line of shown) assert.ok(line.endsWith(LONG_BODY(60)), `${count}: ${line.slice(-40)}`);
        assert.deepEqual(cutLines(text), [], "nothing was closed off");
    }
});

test("four or more hits keep 300 characters, and so does a chars the caller sets", () => {
    const four = summarize(query, outcome({ hits: Array.from({ length: 4 }, (_, n) => bodyHit(n, 60)) }), view());
    assert.ok(
        lines(four.text)
            .slice(-4)
            .every((line) => line.length <= 300 + 25),
    );
    assert.match(lines(four.text).at(-1) as string, /args: \{…\}$/);
    const own = summarize(query, outcome({ hits: [bodyHit(1, 60)] }), view({ chars: 100 }));
    assert.ok((lines(own.text).at(-1) as string).length <= 100 + 25);
    assert.equal(cutLines(own.text).length, 1, "and the cut is explained");
});

test("it counts the hits on the page: a filter, an offset or a last short page can bring it down to three", () => {
    const hits = [...Array.from({ length: 10 }, (_, n) => bodyHit(n, 60)), ...numbered(10)];
    const matched = summarize(query, outcome({ hits }), view({ match: ["previewOrder"], offset: 7 }));
    assert.equal(matched.details.shown, 3);
    assert.ok(
        lines(matched.text)
            .slice(-3)
            .every((line) => line.endsWith(LONG_BODY(60))),
    );
    const middle = summarize(query, outcome({ hits }), view());
    assert.equal(middle.details.shown, 20);
    assert.ok(
        lines(middle.text)
            .slice(-20)
            .every((line) => line.length <= 300 + 25),
    );
});

test("around gets the wide window too when chars is unset", () => {
    const { text } = summarize(query, outcome({ hits: [bodyHit(1, 60)] }), view({ around: "chargeNumber" }));
    assert.ok((lines(text).at(-1) as string).length > 300);
});

test("a body longer than 4000 stays cut, and the line sends the reader to around", () => {
    const { text } = summarize(query, outcome({ hits: [bodyHit(1, 400)] }), view());
    assert.match(lines(text).at(-1) as string, /args: \{…\}$/);
    assert.equal(cutLines(text).length, 1);
    assert.match(cutLines(text)[0] as string, /longer than 4000 characters/);
});

test("three whole hits fit the text cap with room to spare", () => {
    const hits = Array.from({ length: 3 }, (_, n) => hit(n, { message: `row ${n} ${"long ".repeat(900)}` }));
    assert.ok(summarize(query, outcome({ hits }), view()).text.length < 15_000);
});
