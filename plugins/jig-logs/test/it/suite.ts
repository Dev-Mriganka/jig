// The tests every real backend must pass, written once. A test file (elasticsearch, opensearch, loki) seeds its backend with
// `dataset()`, says how its environments are configured, and calls `commonTests`. What differs between backends is in the
// `Flavor`: the language of `query`, and whether the backend counts exactly.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createMasker } from "../../../jig-core/src/mask/index.ts";
import { DAY, HOUR, MINUTE } from "../support/dataset.ts";
import type { RealWorld } from "../support/real.ts";

export interface WorldOptions {
    /** The instant a relative window ends. */
    now?: number;
    /** More environments, or others in place of the standard ones, as jig.json writes them. */
    environments?: Record<string, unknown>;
    /** Fields of `logs.backend` to replace, such as a wrong password. */
    backend?: Record<string, unknown>;
}

export interface Flavor {
    /** The backend's own name, for messages. */
    name: string;
    /** The moment the seeded data starts. */
    base: number;
    /**
     * Makes the tool for a test, with the environments `staging` (every line of the staging environment), `listed`
     * (the services `orders-api` and `billing-api` only) and `prod` (the production environment, classified as such).
     */
    world(t: TestContext, options?: WorldOptions): RealWorld;
    /** A `query` that matches the first two `payment timeout` lines and not the third. */
    twoAttemptsQuery: string;
    /** A `query` that matches the lines that say `created` or `accepted`. */
    anyOfQuery: string;
    /** A `query` the backend rejects as malformed. */
    malformedQuery: string;
    /** Loki cannot count: a bucket that filled its limit says "at least". */
    exactCounts: boolean;
}

/** The time as the header of a result writes it: no fraction. */
export const headerTime = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
/** The time as a hit line writes it. */
export const lineTime = (ms: number): string => new Date(ms).toISOString();

/** The text of a call that must have worked. */
export function textOf(result: { text: string; error?: Error | undefined }): string {
    if (result.error !== undefined) assert.fail(`the call failed: ${result.error.message}`);
    return result.text;
}

/** The hit lines of a result: the ones that start with a time. */
export function hitLines(text: string): string[] {
    return text.split("\n").filter((line) => /^\d{4}-\d\d-\d\dT/.test(line));
}

/** A throwaway password for a user made for the run: random, and not shaped like any real credential. */
export function throwawayPassword(): string {
    return `pw-${randomBytes(9).toString("hex")}`;
}

const exact = (flavor: Flavor, count: number): RegExp =>
    flavor.exactCounts ? new RegExp(`complete, ${count} hits?,`) : new RegExp(`complete, (at least )?${count} hits?,`);

export function commonTests(flavor: Flavor): void {
    const { base } = flavor;
    const range = (from: number, to: number) => ({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
    });
    /** The first hour of the data. */
    const hour = range(base, base + HOUR);

    test("a phrase finds its lines, with their times", async (t) => {
        const w = flavor.world(t);
        const text = textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour }));
        assert.match(text, new RegExp(`^staging ${headerTime(base)}..${headerTime(base + HOUR)}: complete, 3 hits, `));
        assert.match(text, /3 fetched \(oldest first\), 3 shown, 1 bucket/);
        assert.deepEqual(
            hitLines(text),
            [1, 2, 3].map((n) => `${lineTime(base + (24 + n) * MINUTE)} payment timeout req-7f3a9c attempt ${n} of 3`),
        );
        const facts = w.jig.facts.get("call-1") ?? [];
        assert.equal(facts[0]?.status, "complete");
        assert.equal(facts[0]?.hits, 3);
    });

    test("a phrase is the words in that order, and case does not matter", async (t) => {
        const w = flavor.world(t);
        const found = textOf(await w.call({ phrase: "PAYMENT Timeout", environment: "staging", ...hour }));
        assert.match(found, /complete, 3 hits,/);
        const reversed = textOf(await w.call({ phrase: "timeout payment", environment: "staging", ...hour }));
        assert.match(reversed, /complete, 0 hits,/);
        assert.deepEqual(hitLines(reversed), []);
    });

    test("a query in the backend's own language narrows the search", async (t) => {
        const w = flavor.world(t);
        const text = textOf(await w.call({ query: flavor.twoAttemptsQuery, environment: "staging", ...hour }));
        assert.match(text, /complete, 2 hits,/);
        assert.deepEqual(
            hitLines(text).map((line) => line.slice(25)),
            ["payment timeout req-7f3a9c attempt 1 of 3", "payment timeout req-7f3a9c attempt 2 of 3"],
        );
    });

    test("a window starts at `from` and stops before `to`", async (t) => {
        const w = flavor.world(t);
        const first = textOf(
            await w.call({
                phrase: "req-7f3a9c",
                environment: "staging",
                ...range(base + 25 * MINUTE, base + 26 * MINUTE),
            }),
        );
        assert.match(first, /complete, 1 hit,/);
        const two = textOf(
            await w.call({
                phrase: "req-7f3a9c",
                environment: "staging",
                ...range(base + 25 * MINUTE, base + 27 * MINUTE),
            }),
        );
        assert.match(two, /complete, 2 hits,/);
        const last = textOf(
            await w.call({
                phrase: "req-7f3a9c",
                environment: "staging",
                ...range(base + 26 * MINUTE + 1, base + 28 * MINUTE),
            }),
        );
        assert.match(last, /complete, 1 hit,/);
        assert.match(hitLines(last).join("\n"), /attempt 3 of 3/);
    });

    test("a relative window ends now", async (t) => {
        const w = flavor.world(t, { now: base + 30 * MINUTE });
        const text = textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", window: "30m" }));
        assert.match(
            text,
            new RegExp(`^staging ${headerTime(base)}..${headerTime(base + 30 * MINUTE)}: complete, 3 hits,`),
        );
        const narrow = textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", window: "2m" }));
        assert.match(narrow, /complete, 0 hits,/);
    });

    test("a window over six hours is searched in hour buckets, and the hits of every bucket come back in time order", async (t) => {
        const w = flavor.world(t);
        const from = base - 30 * HOUR;
        const text = textOf(
            await w.call({ phrase: "nightly export", environment: "staging", ...range(from, base + HOUR) }),
        );
        assert.match(text, /complete, 1 hit, 1 fetched \(oldest first\), 1 shown, 31 buckets/);
        assert.deepEqual(hitLines(text), [`${lineTime(base - 26 * HOUR)} nightly export finished rows=1200`]);
        const details = (
            await w.call({ phrase: "nightly export", environment: "staging", ...range(from, base + HOUR) })
        ).details;
        assert.equal(details.windows.length, 31);
        assert.ok(
            details.windows.every(
                (window: { to: string; from: string }) => Date.parse(window.to) - Date.parse(window.from) === HOUR,
            ),
        );
    });

    test("a window over two days is searched in day buckets, from either end", async (t) => {
        const w = flavor.world(t);
        const window = range(base - 80 * HOUR, base + HOUR);
        const oldest = textOf(await w.call({ phrase: "nightly export", environment: "staging", ...window }));
        assert.match(oldest, /complete, 3 hits, 3 fetched \(oldest first\), 3 shown, 4 buckets/);
        assert.deepEqual(
            hitLines(oldest).map((line) => line.slice(25)),
            [
                "nightly export finished rows=1175",
                "nightly export finished rows=1180",
                "nightly export finished rows=1200",
            ],
        );
        const newest = textOf(
            await w.call({ phrase: "nightly export", environment: "staging", order: "desc", ...window }),
        );
        assert.match(newest, /3 fetched \(newest first\), 3 shown, 4 buckets/);
        assert.deepEqual(
            hitLines(newest).map((line) => line.slice(25)),
            [
                "nightly export finished rows=1200",
                "nightly export finished rows=1180",
                "nightly export finished rows=1175",
            ],
        );
        assert.equal(w.jig.facts.get("call-1")?.[0]?.requests, 4);
    });

    test("size and offset page through the hits, oldest or newest first", async (t) => {
        const w = flavor.world(t);
        const ask = { phrase: "order accepted", environment: "staging", size: 40, ...hour };
        const first = textOf(await w.call(ask));
        assert.match(first, exact(flavor, 40));
        assert.match(first, /Hits 1-20 of 40 fetched hits, 20 more: call again with offset 20:/);
        assert.equal(hitLines(first).length, 20);
        assert.match(hitLines(first)[0] ?? "", /id=ord-0000 total=10\.50$/);
        const second = textOf(await w.call({ ...ask, offset: 20 }));
        assert.match(second, /Hits 21-40 of 40 fetched hits, none after these:/);
        assert.match(hitLines(second)[0] ?? "", /id=ord-0020 /);
        assert.match(hitLines(second).at(-1) ?? "", /id=ord-0039 /);
        const past = textOf(await w.call({ ...ask, offset: 99 }));
        assert.match(past, /offset 99 is past the end: there are only 40 fetched hits/);

        const newest = textOf(await w.call({ ...ask, size: 5, order: "desc" }));
        assert.match(newest, /5 fetched \(newest first\), 5 shown/);
        assert.deepEqual(
            hitLines(newest).map((line) => /id=(ord-\d+)/.exec(line)?.[1]),
            ["ord-0039", "ord-0038", "ord-0037", "ord-0036", "ord-0035"],
        );
        const oldest = textOf(await w.call({ ...ask, size: 3 }));
        assert.deepEqual(
            hitLines(oldest).map((line) => /id=(ord-\d+)/.exec(line)?.[1]),
            ["ord-0000", "ord-0001", "ord-0002"],
        );
        assert.match(oldest, /3 fetched \(oldest first\)/);
        if (flavor.exactCounts)
            assert.match(oldest, /complete, 40 hits, 3 fetched/, "the total counts what was not fetched");
    });

    test("match, exclude, around and chars choose and shape the fetched hits", async (t) => {
        const w = flavor.world(t);
        const ask = { phrase: "order accepted", environment: "staging", size: 40, ...hour };
        const some = textOf(await w.call({ ...ask, match: ["ORD-001"], exclude: ["ord-0015"] }));
        assert.match(some, /contain all 1 match term and none of 1 exclude term/);
        assert.deepEqual(
            hitLines(some).map((line) => /id=(ord-\d+)/.exec(line)?.[1]),
            [
                "ord-0010",
                "ord-0011",
                "ord-0012",
                "ord-0013",
                "ord-0014",
                "ord-0016",
                "ord-0017",
                "ord-0018",
                "ord-0019",
            ],
        );
        const around = textOf(await w.call({ ...ask, match: ["ord-0021"], around: "total=3", chars: 40 }));
        const line = hitLines(around)[0] ?? "";
        assert.match(line, /…?total=31\.50/);
        assert.ok(line.length < 100, line);
        const short = textOf(await w.call({ phrase: "payment timeout", environment: "staging", chars: 40, ...hour }));
        assert.match(hitLines(short)[0] ?? "", /…$/, "a message cut at the limit ends in an ellipsis");
    });

    test("a long JSON body is cut for length and said to be cut, not hidden", async (t) => {
        const w = flavor.world(t);
        // Up to three hits are read in full unless `chars` says otherwise.
        const text = textOf(await w.call({ phrase: "order batch", environment: "staging", chars: 300, ...hour }));
        assert.match(text, /\{…\} is a JSON body cut for length, not hidden/);
        assert.match(hitLines(text)[0] ?? "", /order batch \{…\}$/);
        const full = textOf(await w.call({ phrase: "order batch", environment: "staging", chars: 4000, ...hour }));
        assert.match(hitLines(full)[0] ?? "", /"sku":"sku-29","quantity":30,"price":19\.99\}\]\}$/);
    });

    test("a list filter keeps the lines of any of its values", async (t) => {
        const w = flavor.world(t);
        const listed = textOf(await w.call({ phrase: "declined", environment: "listed", ...hour }));
        assert.match(listed, /complete, 0 hits,/);
        // 40 orders and 5 invoices; the 5 declined charges of the third service are not among them.
        const both = textOf(await w.call({ query: flavor.anyOfQuery, environment: "listed", size: 200, ...hour }));
        assert.match(both, exact(flavor, 45));
        // The lines of two services come back as one list in time order, page after page.
        const pages: string[] = [];
        for (const offset of [0, 20, 40]) {
            const page = textOf(
                await w.call({ query: flavor.anyOfQuery, environment: "listed", size: 200, offset, ...hour }),
            );
            pages.push(...hitLines(page));
        }
        assert.equal(pages.length, 45);
        const times = pages.map((line) => line.slice(0, 24));
        assert.deepEqual(times, [...times].sort(), "ISO times sort as time does");
        assert.ok(pages.some((line) => line.includes("invoice created")));
        const invoices = textOf(
            await w.call({ query: flavor.anyOfQuery, environment: "listed", size: 200, match: ["created"], ...hour }),
        );
        assert.equal(hitLines(invoices).length, 5);
        assert.match(invoices, /invoice created inv-100/);
        const every = textOf(await w.call({ phrase: "declined", environment: "staging", ...hour }));
        assert.match(every, /complete, 5 hits,/);
    });

    test("a window with no hit says whether the environment has data at all", async (t) => {
        const w = flavor.world(t);
        const noMatch = textOf(await w.call({ phrase: "no such thing anywhere", environment: "staging", ...hour }));
        assert.match(
            noMatch,
            flavor.exactCounts
                ? /complete, 0 hits, 1 bucket\nAvailability: the window holds 54 documents in this environment/
                : /complete, 0 hits, 1 bucket\nAvailability: the window holds documents in this environment/,
        );
        const empty = textOf(
            await w.call({ phrase: "order", environment: "staging", ...range(base + 2 * HOUR, base + 3 * HOUR) }),
        );
        assert.match(empty, /Availability: no documents at all in this environment and window\./);
    });

    test("a production environment is a read, and jig-core's masker works on what comes back", async (t) => {
        const w = flavor.world(t);
        const cls = w.tool.declaration.classify({ phrase: "logged in", environment: "prod" });
        assert.deepEqual(cls, { environment: "production", effect: "read" });
        assert.equal(w.jig.api.environments.kindOf(cls.environment), "production");

        const ask = { environment: "prod", ...hour };
        const raw = textOf(await w.call({ phrase: "logged in", ...ask }));
        assert.match(
            raw,
            /user jane\.doe@example\.com logged in from 203\.0\.113\.9/,
            "the plugin hands the text on as it is",
        );

        // What jig-core does with a production result: every line goes through its masker.
        const masker = createMasker(randomBytes(32));
        const masked = masker.text(raw);
        assert.doesNotMatch(masked, /jane\.doe@example\.com/);
        assert.match(masked, /user email#[0-9a-f]{6} logged in/);

        const cut = textOf(await w.call({ phrase: "callback requested", ...ask }));
        const maskedCut = masker.text(cut);
        assert.doesNotMatch(maskedCut, /\+14155550123/);
        assert.doesNotMatch(maskedCut, /removed:unparseable/);

        // A long JSON body is cut so that no object is left open, and the masker then does not withhold the line.
        const batch = textOf(await w.call({ phrase: "customer export", chars: 300, ...ask }));
        assert.match(batch, /\{…\}/);
        const maskedBatch = masker.text(batch);
        assert.doesNotMatch(maskedBatch, /removed:unparseable/);
        assert.match(maskedBatch, /customer export/);

        // Identifiers stay, so a ticket stays debuggable.
        const identifiers = masker.text(textOf(await w.call({ phrase: "order accepted", ...ask })));
        assert.match(identifiers, /id=ord-0777/);
    });

    test("no secret reaches a result, and the call leaves its facts", async (t) => {
        const w = flavor.world(t);
        const results = [
            textOf(await w.call({ phrase: "req-7f3a9c", environment: "staging", ...hour })),
            (await w.call({ phrase: "x", environment: "staging", ...range(base, base + HOUR), size: 0 })).error
                ?.message ?? "",
        ];
        for (const secret of w.jig.issued)
            for (const text of results) assert.ok(!text.includes(secret), "a credential leaked");
        const facts = w.jig.facts.get("call-1")?.[0];
        assert.equal(facts?.status, "complete");
        assert.equal(facts?.fetched, 3);
        assert.equal(facts?.requests, 1);
    });

    test("a malformed query is rejected, and the result says so without repeating it", async (t) => {
        const w = flavor.world(t);
        const result = await w.call({ query: flavor.malformedQuery, environment: "staging", ...hour });
        const text = result.error?.message ?? result.text;
        assert.match(text, /failed, no window could be searched|query_rejected/);
        assert.match(text, /query_rejected/);
        assert.doesNotMatch(text, new RegExp(flavor.malformedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
}

/** The tests for Elasticsearch and OpenSearch, which speak the same search API. */
export function elasticTests(flavor: Flavor, other: { index: string }): void {
    const { base } = flavor;
    const hour = { from: new Date(base).toISOString(), to: new Date(base + HOUR).toISOString() };

    test("an index that does not exist is named as missing, and the Next line says what to fix", async (t) => {
        const w = flavor.world(t, { environments: { gone: { index: `${other.index}-gone` } } });
        const text = textOf(await w.call({ phrase: "x", environment: "gone", ...hour }));
        assert.match(text, /failed, no window could be searched/);
        assert.match(text, /index_not_found/);
        assert.match(
            text,
            /Next: The index was not found: the environment's index in the logs section of jig\.json may be wrong\./,
        );
    });

    test("fields named in the configuration are the ones read, and a time stored as epoch milliseconds is shown as an instant", async (t) => {
        const w = flavor.world(t, {
            environments: { alt: { index: other.index, timeField: "ts", messageField: "msg" } },
        });
        const text = textOf(await w.call({ phrase: "req-7f3a9c", environment: "alt", ...hour }));
        assert.match(text, /complete, 3 hits,/);
        assert.deepEqual(
            hitLines(text).map((line) => line.slice(25)),
            [1, 2, 3].map((n) => `payment timeout req-7f3a9c attempt ${n} of 3`),
        );
        assert.match(hitLines(text)[0] ?? "", new RegExp(`^${lineTime(base + 25 * MINUTE)} `));
    });

    test("a wildcard in a Lucene query is analyzed, so the case of the text does not matter", async (t) => {
        const w = flavor.world(t);
        const text = textOf(await w.call({ query: "message:Timeo*", environment: "staging", ...hour }));
        assert.match(text, /complete, 3 hits,/);
    });

    test("a Lucene query can name a field of the document, and a list filter is a terms filter", async (t) => {
        const w = flavor.world(t);
        const text = textOf(
            await w.call({ query: "service:billing-api AND message:invoice", environment: "listed", ...hour }),
        );
        assert.match(text, /complete, 5 hits,/);
        const none = textOf(await w.call({ query: "service:payments-api", environment: "listed", ...hour }));
        assert.match(none, /complete, 0 hits,/);
    });
}

export { DAY };
