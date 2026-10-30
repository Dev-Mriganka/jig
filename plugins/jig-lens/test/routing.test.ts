// What each `/lens` command does when it runs in a session: the summaries, the two viewers, rebuild and status, and the
// words that are not commands. The pieces are tested on their own elsewhere; this is that the right one runs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { SummaryEntry } from "../src/display.ts";
import { appendLines, rig, text, writeSample } from "./support.ts";
import type { Notice } from "./support.ts";

// "Today" is the user's day. These tests are written for a clock on UTC.
process.env.TZ = "UTC";

const USAGE = "Usage: /lens [ticket KEY | session [id] | days N | grafana | datasette | rebuild | status]";

/** Runs a command in a session of a terminal, with the sample records written and the viewers stopped. */
async function run(t: Parameters<typeof rig>[0], args: string) {
    const r = rig(t, { session: "s1", answers: ["stopped", "running"] });
    writeSample(r.state);
    const notices = await r.pi.lens(args);
    const titles = r.pi.entries.flatMap((entry) => (entry.data as SummaryEntry).blocks.map((block) => block.title));
    return { r, notices, titles };
}

// ---- the summaries --------------------------------------------------------------------------------------------------

test("/lens shows today, this session and its ticket, and starts and opens nothing", async (t) => {
    const { r, notices, titles } = await run(t, "");
    assert.deepEqual(titles, ["Today, 2026-10-30", "This session", "Ticket T-1, all time"]);
    assert.deepEqual(notices, []);
    assert.deepEqual([r.spawned, r.opened, r.probes], [[], [], []]);
});

test("/lens ticket KEY shows that ticket over all time", async (t) => {
    const { r, titles, notices } = await run(t, "ticket T-1");
    assert.deepEqual(titles, ["Ticket T-1, all time"]);
    assert.deepEqual([notices, r.spawned, r.opened, r.probes], [[], [], [], []]);
});

test("/lens session shows this session, and /lens session ID shows that one", async (t) => {
    assert.deepEqual((await run(t, "session")).titles, ["This session"]);
    assert.deepEqual((await run(t, "session s3")).titles, ["Session s3"]);
    assert.deepEqual((await run(t, "session s1")).titles, ["This session"], "its own id is still this session");
});

test("/lens days N shows the last N days", async (t) => {
    assert.deepEqual((await run(t, "days 1")).titles, ["Today, 2026-10-30"]);
    assert.deepEqual((await run(t, "days 7")).titles, ["Last 7 days, 2026-10-24 to 2026-10-30"]);
    assert.deepEqual((await run(t, "days 90")).titles, ["Last 90 days, 2026-08-02 to 2026-10-30"]);
});

test("a ticket or a session nobody has records for is said so, not refused", async (t) => {
    const ticket = await run(t, "ticket T-404");
    assert.deepEqual(ticket.titles, ["Ticket T-404, all time"]);
    const block = (ticket.r.pi.entries[0]?.data as SummaryEntry).blocks[0];
    assert.equal(block?.empty, "no records");
    assert.deepEqual(ticket.notices, []);
});

test("every summary imports first, so the records written since the last run are in it", async (t) => {
    const r = rig(t, { session: "s1" });
    await r.pi.lens("days 7");
    const first = (r.pi.entries[0]?.data as SummaryEntry).blocks;
    assert.equal(first[0]?.title, "No records yet. jig-core writes them as tools run and model turns end.");

    writeSample(r.state);
    await r.pi.lens("days 7");
    const second = (r.pi.entries[1]?.data as SummaryEntry).blocks;
    assert.equal(second[0]?.title, "Last 7 days, 2026-10-24 to 2026-10-30");
    assert.match(second[0]?.sections[0]?.lines[0] ?? "", /^\$0\.46 over 6 turns/);
});

test("when Pi cannot say which session this is, /lens shows today, and /lens session asks for an id", async (t) => {
    const r = rig(t, { session: undefined });
    writeSample(r.state);
    assert.deepEqual(await r.pi.lens(""), []);
    assert.deepEqual(
        (r.pi.entries[0]?.data as SummaryEntry).blocks.map((block) => block.title),
        ["Today, 2026-10-30"],
    );
    const notices = await r.pi.lens("session");
    assert.deepEqual(notices, [
        { level: "warning", text: "Pi cannot say which session this is. Give an id: /lens session ID" },
    ]);
    assert.equal(r.pi.entries.length, 1);
    assert.deepEqual(await r.pi.lens("session s3"), []);
    assert.equal(r.pi.entries.length, 2);
});

// ---- when the import has something to say ---------------------------------------------------------------------------

test("lines that are not records are told after the summary, not before it", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    appendLines(r.state, "2026-10-30", ["garbage"]);
    const notices = await r.pi.lens("days 7");
    assert.equal(r.pi.entries.length, 1, "the summary is shown");
    assert.deepEqual(notices, [
        { level: "warning", text: "Imported 14 new calls and 6 new turns. Skipped 1 line that is not a record." },
    ]);
});

test("an index that cannot be read is told with what to do, and nothing is shown", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    mkdirSync(r.where.lens, { recursive: true });
    writeFileSync(
        r.where.index,
        "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
    );
    const notices = await r.pi.lens("");
    assert.equal(r.pi.entries.length, 0);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "warning");
    const lines = notices[0]?.text.split("\n") ?? [];
    assert.match(lines[0] ?? "", /^The import failed: .*\. \/lens rebuild makes the index again\.$/);
    assert.match(lines[1] ?? "", /^The index cannot be read \(.*\)\. \/lens rebuild makes it again\.$/);
    // And /lens rebuild mends it, after which the summary works.
    await r.pi.lens("rebuild");
    assert.deepEqual(await r.pi.lens("days 7"), []);
    assert.equal(r.pi.entries.length, 1);
});

// ---- the viewers ----------------------------------------------------------------------------------------------------

test("/lens grafana starts Grafana and opens its dashboard, and shows no summary", async (t) => {
    const { r, notices } = await run(t, "grafana");
    assert.equal(r.pi.entries.length, 0);
    assert.deepEqual(
        r.probes,
        [
            ["grafana", 3300],
            ["grafana", 3300],
        ],
        "before it starts and while it comes up",
    );
    assert.equal(r.spawned.length, 1);
    assert.match(r.spawned[0]?.file ?? "", /grafana$/);
    assert.deepEqual(r.opened, ["http://127.0.0.1:3300/d/jig-overview"]);
    assert.match(text(notices), /Grafana started/);
});

test("/lens datasette starts Datasette and opens its page, and shows no summary", async (t) => {
    const { r, notices } = await run(t, "datasette");
    assert.equal(r.pi.entries.length, 0);
    assert.deepEqual(r.probes, [
        ["datasette", 3300],
        ["datasette", 3300],
    ]);
    assert.match(r.spawned[0]?.file ?? "", /datasette$/);
    assert.deepEqual(r.opened, ["http://127.0.0.1:3300/index"]);
    assert.match(text(notices), /Datasette started/);
});

test("a viewer that is running is opened and not started again", async (t) => {
    for (const viewer of ["grafana", "datasette"]) {
        const r = rig(t, { answers: ["running"] });
        const notices = await r.pi.lens(viewer);
        assert.deepEqual(r.spawned, [], viewer);
        assert.equal(r.opened.length, 1, viewer);
        assert.equal(notices[0]?.level, "info");
    }
});

// ---- the rest -------------------------------------------------------------------------------------------------------

test("/lens rebuild makes the index again and touches no viewer", async (t) => {
    const { r, notices } = await run(t, "rebuild");
    assert.deepEqual(notices, [
        { level: "info", text: "Rebuilt the index from 4 record files: 14 calls and 6 turns." },
    ]);
    assert.deepEqual([r.pi.entries, r.spawned, r.opened, r.probes], [[], [], [], []]);
});

test("/lens status reports and shows no summary", async (t) => {
    const { r, notices } = await run(t, "status");
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.text ?? "", /^Viewer: none running at http:\/\/127\.0\.0\.1:3300/);
    assert.equal(r.pi.entries.length, 0);
    assert.deepEqual([r.spawned, r.opened], [[], []]);
});

// ---- bad arguments --------------------------------------------------------------------------------------------------

test("a word that is not a command shows the usage line and does nothing else", async (t) => {
    for (const args of ["restart", "Status", "tickets T-1", "7"]) {
        const { r, notices } = await run(t, args);
        assert.deepEqual(notices, [{ level: "warning", text: USAGE }], args);
        assert.deepEqual([r.pi.entries, r.spawned, r.opened, r.probes], [[], [], [], []], args);
        assert.equal(existsSync(r.where.index), false, `${args}: not even the import ran`);
    }
});

test("a command with the wrong arguments says what is wrong, then shows the usage line", async (t) => {
    const cases: Array<[string, string]> = [
        ["ticket", "/lens ticket needs a ticket key."],
        ["ticket A B", "/lens ticket takes one ticket key."],
        ["session a b", "/lens session takes one session id."],
        ["days", "/lens days takes a whole number from 1 to 90."],
        ["days 0", "/lens days takes a whole number from 1 to 90."],
        ["days 91", "/lens days takes a whole number from 1 to 90."],
        ["days 3.5", "/lens days takes a whole number from 1 to 90."],
        ["days many", "/lens days takes a whole number from 1 to 90."],
        ["grafana now", "/lens grafana takes no arguments."],
        ["datasette now", "/lens datasette takes no arguments."],
        ["rebuild all", "/lens rebuild takes no arguments."],
        ["status -v", "/lens status takes no arguments."],
    ];
    for (const [args, problem] of cases) {
        const { r, notices, titles } = await run(t, args);
        assert.deepEqual(notices, [{ level: "warning", text: `${problem}\n${USAGE}` } satisfies Notice], args);
        assert.deepEqual([titles, r.spawned, r.opened, r.probes], [[], [], [], []], args);
    }
});

test("white space around and between the words does not matter", async (t) => {
    assert.deepEqual((await run(t, "  days   7  ")).titles, ["Last 7 days, 2026-10-24 to 2026-10-30"]);
    assert.deepEqual((await run(t, "\tticket \t T-1")).titles, ["Ticket T-1, all time"]);
});
