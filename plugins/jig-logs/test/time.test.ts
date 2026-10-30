import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DAY_MS,
    HOUR_MS,
    MAX_DEPTH,
    MAX_RANGE_MS,
    MINUTE_MS,
    halve,
    iso,
    parseInstant,
    parseWindow,
    planBuckets,
    resolveRange,
} from "../src/time.ts";

const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

/** Fails unless the call is refused as invalid input, with one line. */
function refused(call: () => unknown, pattern: RegExp, label?: string): void {
    assert.throws(
        call,
        (error: Error) => error instanceof TypeError && pattern.test(error.message) && !error.message.includes("\n"),
        label,
    );
}

test("a window is minutes, hours or days, up to 7 days", () => {
    assert.equal(parseWindow("30m"), 30 * MINUTE_MS);
    assert.equal(parseWindow("2h"), 2 * HOUR_MS);
    assert.equal(parseWindow("1d"), DAY_MS);
    assert.equal(parseWindow("7d"), 7 * DAY_MS);
    assert.equal(parseWindow("168h"), 7 * DAY_MS);
    assert.equal(parseWindow("10080m"), 7 * DAY_MS);
    assert.equal(MAX_RANGE_MS, 7 * DAY_MS);
});

test("anything else is refused with one line that shows the right form", () => {
    for (const bad of ["8d", "169h", "10081m", "0h", "02h", "2", "h", "1w", " 2h", "2h ", "-1h", "1.5h", ""]) {
        refused(() => parseWindow(bad), /^logs: window must look like 30m, 2h or 1d and be at most 7d/, bad);
    }
    refused(() => parseWindow("9d"), /\(got "9d"\)$/);
});

test("instants need a timezone and a real calendar date", () => {
    assert.equal(parseInstant("2026-10-13T12:00:00Z", "from"), T0);
    assert.equal(parseInstant("2026-10-13T17:30:00+05:30", "from"), T0);
    assert.equal(parseInstant("2026-10-13T12:00:00.250Z", "from"), T0 + 250);
    assert.equal(parseInstant("2026-10-13T12:00:00.123456Z", "to"), T0 + 123);
    const bad = [
        "2026-10-13",
        "2026-10-13T12:00:00",
        "2026-10-13T12:00Z",
        "2026-02-30T10:00:00Z",
        "2026-13-01T10:00:00Z",
        "2026-10-13T24:00:00Z",
        "2026-10-13T12:60:00Z",
        "2026-10-13T12:00:00+24:00",
        "yesterday",
        "0050-01-01T00:00:00Z",
    ];
    for (const text of bad)
        refused(() => parseInstant(text, "from"), /^logs: from must be ISO 8601 with a timezone/, text);
    refused(() => parseInstant("tomorrow", "to"), /^logs: to must be ISO 8601/);
});

test("a relative window ends now, and the default applies when nothing is given", () => {
    assert.deepEqual(resolveRange({ window: "30m" }, "2h", T0), { from: T0 - 30 * MINUTE_MS, to: T0 });
    assert.deepEqual(resolveRange({}, "2h", T0), { from: T0 - 2 * HOUR_MS, to: T0 });
    assert.deepEqual(resolveRange({}, "1d", T0), { from: T0 - DAY_MS, to: T0 });
});

test("an explicit range needs both ends, excludes its end and spans at most 7 days", () => {
    const hour = { from: "2026-10-13T10:00:00Z", to: "2026-10-13T11:00:00Z" };
    assert.deepEqual(resolveRange(hour, "2h", T0), { from: T0 - 2 * HOUR_MS, to: T0 - HOUR_MS });
    const week = { from: "2026-10-06T12:00:00Z", to: "2026-10-13T12:00:00Z" };
    assert.deepEqual(resolveRange(week, "2h", T0), { from: T0 - 7 * DAY_MS, to: T0 });
    refused(() => resolveRange({ from: hour.from }, "2h", T0), /from and to must be given together/);
    refused(() => resolveRange({ to: hour.to }, "2h", T0), /from and to must be given together/);
    refused(() => resolveRange({ window: "1h", ...hour }, "2h", T0), /either window or from and to, not both/);
    refused(() => resolveRange({ from: hour.to, to: hour.to }, "2h", T0), /to must be after from/);
    refused(() => resolveRange({ from: hour.to, to: hour.from }, "2h", T0), /to must be after from/);
    const tooLong = { from: "2026-10-06T11:59:59Z", to: "2026-10-13T12:00:00Z" };
    refused(() => resolveRange(tooLong, "2h", T0), /at most 7 days/);
});

test("iso drops zero milliseconds and keeps the others", () => {
    assert.equal(iso(T0), "2026-10-13T12:00:00Z");
    assert.equal(iso(T0 + 5), "2026-10-13T12:00:00.005Z");
});

test("buckets: one up to 6 hours, hour buckets up to 2 days, day buckets above", () => {
    const count = (span: number) => planBuckets({ from: T0, to: T0 + span }).length;
    assert.equal(count(30 * MINUTE_MS), 1);
    assert.equal(count(6 * HOUR_MS), 1);
    assert.equal(count(6 * HOUR_MS + MINUTE_MS), 7);
    assert.equal(count(2 * DAY_MS), 48);
    assert.equal(count(2 * DAY_MS + 1), 3);
    assert.equal(count(7 * DAY_MS), 7);
});

test("buckets are contiguous and ascending, and cover the range", () => {
    const span = 3 * DAY_MS + 5 * HOUR_MS;
    const buckets = planBuckets({ from: T0, to: T0 + span });
    assert.equal(buckets.length, 4);
    assert.equal(buckets[0]?.from, T0);
    assert.equal(buckets[3]?.to, T0 + span);
    assert.equal((buckets[3]?.to ?? 0) - (buckets[3]?.from ?? 0), 5 * HOUR_MS, "the last one is what is left");
    buckets.slice(1).forEach((bucket, i) => assert.equal(bucket.from, buckets[i]?.to));
    assert.ok(buckets.every((bucket) => bucket.depth === 0));
});

test("no window needs more than 48 buckets", () => {
    for (const span of [7 * DAY_MS, 7 * DAY_MS - 1, 2 * DAY_MS, 2 * DAY_MS + 1, 6 * HOUR_MS + 1]) {
        assert.ok(planBuckets({ from: T0, to: T0 + span }).length <= 48, String(span));
    }
});

test("halving splits a bucket exactly in two, one level deeper, until the depth or size limit", () => {
    let bucket = { from: T0, to: T0 + HOUR_MS, depth: 0 };
    const [left, right] = halve(bucket) ?? [];
    assert.deepEqual(left, { from: T0, to: T0 + HOUR_MS / 2, depth: 1 });
    assert.deepEqual(right, { from: T0 + HOUR_MS / 2, to: T0 + HOUR_MS, depth: 1 });
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) bucket = (halve(bucket) as [typeof bucket, typeof bucket])[0];
    assert.equal(bucket.depth, MAX_DEPTH);
    assert.equal(halve(bucket), undefined);
    assert.equal(halve({ from: T0, to: T0 + 1_999, depth: 0 }), undefined);
    const odd = halve({ from: T0, to: T0 + 3_001, depth: 0 }) as [{ to: number }, { from: number; to: number }];
    assert.equal(odd[0].to, odd[1].from);
    assert.equal(odd[1].to, T0 + 3_001);
});
