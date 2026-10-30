// "Today" is a day on the user's own clock, not a UTC day: the time zone decides where it starts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastDays } from "../src/period.ts";

/** Runs `run` with the process in another time zone, and puts it back. Node reads TZ again when it is assigned. */
function inZone<T>(zone: string, run: () => T): T {
    const saved = process.env.TZ;
    process.env.TZ = zone;
    try {
        return run();
    } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
    }
}

const seconds = (iso: string) => Date.parse(iso) / 1000;

test("one day in UTC runs from midnight to midnight", () => {
    inZone("UTC", () => {
        assert.deepEqual(lastDays(new Date("2026-10-30T12:00:00Z"), 1), {
            from: seconds("2026-10-30T00:00:00Z"),
            to: seconds("2026-10-31T00:00:00Z"),
            first: "2026-10-30",
            last: "2026-10-30",
        });
    });
});

test("several days end with today and start at the midnight of the first", () => {
    inZone("UTC", () => {
        assert.deepEqual(lastDays(new Date("2026-10-30T23:59:59Z"), 7), {
            from: seconds("2026-10-24T00:00:00Z"),
            to: seconds("2026-10-31T00:00:00Z"),
            first: "2026-10-24",
            last: "2026-10-30",
        });
    });
});

test("the days go back over a month and a year", () => {
    inZone("UTC", () => {
        const range = lastDays(new Date("2027-01-02T08:00:00Z"), 5);
        assert.equal(range.first, "2026-12-29");
        assert.equal(range.last, "2027-01-02");
        assert.equal(range.from, seconds("2026-12-29T00:00:00Z"));
    });
});

test("east of UTC the date is already tomorrow's while it is still today in UTC", () => {
    // 12:00 UTC is 01:00 the next day in Auckland in October (UTC+13), so the date there is already the 31st.
    inZone("Pacific/Auckland", () => {
        assert.deepEqual(lastDays(new Date("2026-10-30T12:00:00Z"), 1), {
            from: seconds("2026-10-30T11:00:00Z"),
            to: seconds("2026-10-31T11:00:00Z"),
            first: "2026-10-31",
            last: "2026-10-31",
        });
    });
});

test("west of UTC the date is still yesterday's in the small hours of UTC", () => {
    // 05:00 UTC is 22:00 the day before in Los Angeles (UTC-7).
    inZone("America/Los_Angeles", () => {
        assert.deepEqual(lastDays(new Date("2026-10-30T05:00:00Z"), 1), {
            from: seconds("2026-10-29T07:00:00Z"),
            to: seconds("2026-10-30T07:00:00Z"),
            first: "2026-10-29",
            last: "2026-10-29",
        });
    });
});

test("the day a clock goes back has 25 hours and still starts and ends at midnight", () => {
    inZone("America/Los_Angeles", () => {
        const range = lastDays(new Date("2026-11-01T20:00:00Z"), 1);
        assert.equal(range.first, "2026-11-01");
        assert.equal((range.to - range.from) / 3600, 25);
        assert.equal(range.from, seconds("2026-11-01T07:00:00Z"), "midnight, still on summer time");
        assert.equal(range.to, seconds("2026-11-02T08:00:00Z"), "midnight, on winter time");
    });
});

test("the day a clock goes forward has 23 hours", () => {
    inZone("America/Los_Angeles", () => {
        const range = lastDays(new Date("2026-03-08T20:00:00Z"), 1);
        assert.equal(range.first, "2026-03-08");
        assert.equal((range.to - range.from) / 3600, 23);
    });
});

test("several days across a change of the clock begin at a midnight, not 24 hours times N before", () => {
    inZone("America/Los_Angeles", () => {
        const range = lastDays(new Date("2026-11-03T20:00:00Z"), 4);
        assert.equal(range.first, "2026-10-31");
        assert.equal(new Date(range.from * 1000).getHours(), 0);
        assert.equal(new Date(range.from * 1000).getMinutes(), 0);
        assert.equal(range.from, seconds("2026-10-31T07:00:00Z"));
    });
});
