// `/lens compare`: the figures per condition from sample records, how they are worded, and the command in a session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/command.ts";
import { compareBlock } from "../src/compare-format.ts";
import { compareOf, NONE } from "../src/compare.ts";
import type { SummaryEntry } from "../src/display.ts";
import { lastDays } from "../src/period.ts";
import { compareFor } from "../src/scopes.ts";
import { plain } from "../src/summary.ts";
import { call, indexOf, NOW, rig, turn, writeRecords } from "./support.ts";
import type { RecordLine } from "../../jig-core/src/records.ts";

// "Today" is the user's day. These tests are written for a clock on UTC.
process.env.TZ = "UTC";

/**
 * `count` main sessions under `condition` (none when undefined), one a day from the 20th of October. Each has one turn
 * that costs `0.1 * (i + 1)`, and `bash` calls of which one fails, `reads` read calls, over two minutes.
 */
function sessions(prefix: string, count: number, condition: string | undefined, reads: number): RecordLine[] {
    const env = condition === undefined ? {} : { JIG_CONDITION: condition };
    const records: RecordLine[] = [];
    for (let i = 0; i < count; i++) {
        const id = `${prefix}${i}`;
        const day = `2026-10-${20 + i}`;
        records.push(turn(`${id}-t`, `${day}T09:00:00Z`, id, "model-a", 0.1 * (i + 1), { cacheRead: 3000 }, env));
        records.push(call(`${id}-c1`, `${day}T09:01:00Z`, id, "bash", {}, env));
        records.push(call(`${id}-c2`, `${day}T09:02:00Z`, id, "bash", { outcome: "error", errorKind: "tool" }, env));
        for (let r = 0; r < reads; r++) records.push(call(`${id}-r${r}`, `${day}T09:01:30Z`, id, "read", {}, env));
    }
    return records;
}

/** Five sessions of each of two conditions; the first baseline one has a child and there is one side call. */
function twoConditions(): RecordLine[] {
    const child = { JIG_AGENT_ROLE: "reviewer", JIG_PARENT_SESSION: "base0", JIG_CONDITION: "baseline" };
    const side = { JIG_AGENT_ROLE: "judge", JIG_CONDITION: "baseline" };
    return [
        ...sessions("base", 5, "baseline", 0),
        ...sessions("tool", 5, "with-x", 3),
        // The child works half an hour after its parent's last line and costs a dollar.
        turn("child-t", "2026-10-20T09:32:00Z", "child-1", "model-a", 1, {}, child),
        call("child-c", "2026-10-20T09:32:30Z", "child-1", "read", {}, child),
        // A child whose parent has no line in the period is not a session and counts toward none.
        turn(
            "lost-t",
            "2026-10-21T09:00:00Z",
            "lost-1",
            "model-a",
            9,
            {},
            {
                JIG_AGENT_ROLE: "reviewer",
                JIG_PARENT_SESSION: "gone",
                JIG_CONDITION: "baseline",
            },
        ),
        // A side call has a role that is not main and no parent: its cost counts, but it is not a session.
        turn("side-t", "2026-10-22T10:00:00Z", "judge-1", "model-j", 0.5, {}, side),
        call("side-c", "2026-10-22T10:00:10Z", "judge-1", "judge", {}, side),
    ];
}

const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

test("each condition is a group of main sessions, with their figures per session", async (t) => {
    const db = await indexOf(t, twoConditions());
    const range = lastDays(NOW, 30);
    const { groups } = compareOf(db, range.from, range.to);
    assert.deepEqual(
        groups.map((group) => [group.condition, group.sessions]),
        [
            ["baseline", 5],
            ["with-x", 5],
        ],
        "a child and a side call are not sessions",
    );
    const [base, tool] = groups;
    assert.ok(base && tool);
    // The first baseline session also holds the child's turn, and costs 0.1 + 1.
    near(base.cost.median, 0.4, "median cost");
    near(base.cost.mean, (1.1 + 0.2 + 0.3 + 0.4 + 0.5) / 5, "mean cost");
    assert.deepEqual([base.turns.median, base.turns.mean], [1, 6 / 5]);
    assert.deepEqual([base.calls.median, base.calls.mean], [2, 11 / 5], "the child's call counts for its parent");
    assert.deepEqual([base.totalCalls, base.failed, base.blocked], [11, 5, 0]);
    near(base.input.median, 3000 + 1000, "input is new input and cache reads");
    near(base.output.median, 200, "output");
    near(base.cacheShare?.median ?? 0, 0.75, "cache read share");
    // From 09:00 to the child's call at 09:32:30 for the first, two minutes for the others.
    assert.deepEqual([base.wallMs.median, base.wallMs.mean], [120_000, (1_950_000 + 4 * 120_000) / 5]);
    assert.deepEqual([tool.calls.median, tool.totalCalls, tool.failed], [5, 25, 5]);
});

test("a side call adds its cost to the condition without being a session", async (t) => {
    const db = await indexOf(t, twoConditions());
    const range = lastDays(NOW, 30);
    const [base, tool] = compareOf(db, range.from, range.to).groups;
    assert.ok(base && tool);
    assert.deepEqual([base.sideCalls, base.sideCost], [1, 0.5]);
    near(base.costWithSide, (1.1 + 0.2 + 0.3 + 0.4 + 0.5 + 0.5) / 5, "cost incl. side calls");
    assert.deepEqual([tool.sideCalls, tool.sideCost], [0, 0]);
    near(tool.costWithSide, (0.1 + 0.2 + 0.3 + 0.4 + 0.5) / 5, "no side calls, the plain mean");
    const text = plain([compareBlock(compareOf(db, range.from, range.to), NOW, 30)]);
    assert.match(text, /side calls\s+1, \$0\.50\s+0, \$0\.00/);
    assert.match(text, /cost incl\. side calls\s+\$0\.60\s+\$0\.30/);
});

test("the tools that differ most in calls per session are listed, largest difference first", async (t) => {
    const db = await indexOf(t, twoConditions());
    const range = lastDays(NOW, 30);
    const { tools } = compareOf(db, range.from, range.to);
    assert.deepEqual(
        tools.map((tool) => [tool.tool, tool.perSession]),
        [["read", [1 / 5, 3]]],
        "bash has the same rate in both and is not a difference, and a side call's tool is in no session",
    );
});

test("only the eight largest differences are listed", async (t) => {
    const records = [
        ...sessions("a", 5, "one", 0),
        ...sessions("b", 5, "two", 0),
        ...Array.from({ length: 12 }, (_, k) =>
            call(
                `x${k}`,
                "2026-10-20T09:03:00Z",
                "b0",
                `tool${String(k).padStart(2, "0")}`,
                {},
                { JIG_CONDITION: "two" },
            ),
        ),
    ];
    const range = lastDays(NOW, 30);
    const { tools } = compareOf(await indexOf(t, records), range.from, range.to);
    assert.equal(tools.length, 8);
});

test("sessions without a condition are grouped as (none), last", async (t) => {
    const records = [
        ...sessions("n", 2, undefined, 0),
        ...sessions("a", 6, "alpha", 0),
        ...sessions("z", 6, "zulu", 0),
    ];
    const range = lastDays(NOW, 30);
    const { groups } = compareOf(await indexOf(t, records), range.from, range.to);
    assert.deepEqual(
        groups.map((group) => [group.condition, group.sessions]),
        [
            ["alpha", 6],
            ["zulu", 6],
            [NONE, 2],
        ],
    );
});

test("a group of fewer than five sessions is flagged above the table, and the table is still shown", async (t) => {
    const records = [...sessions("a", 5, "alpha", 0), ...sessions("b", 3, "beta", 0)];
    const block = compareFor(await indexOf(t, records), NOW, 30);
    assert.deepEqual(
        block.sections.map((section) => section.name),
        ["Note", "Sessions", "Caution"],
        "no tool differs, so no tools section",
    );
    assert.match(block.sections[0]?.lines[0] ?? "", /^too few sessions to compare/);
    assert.match(plain([block]), /sessions\s+5\s+3/);
    assert.match(
        block.sections.at(-1)?.lines[0] ?? "",
        /not a test of significance\. The smallest group has 3 sessions\.$/,
    );
});

test("with enough sessions in every group there is no note, and the caution names the smallest group", async (t) => {
    const block = compareFor(await indexOf(t, twoConditions()), NOW, 30);
    assert.deepEqual(
        block.sections.map((section) => section.name),
        ["Sessions", "Tools", "Caution"],
    );
    assert.equal(block.title, "Conditions compared, last 30 days, 2026-10-01 to 2026-10-30");
    assert.doesNotMatch(plain([block]), /too few/);
    assert.match(block.sections[2]?.lines[0] ?? "", /smallest group has 5 sessions/);
});

test("the table has a column for each condition and the rows are aligned", async (t) => {
    const block = compareFor(await indexOf(t, twoConditions()), NOW, 30);
    const lines = block.sections[0]?.lines ?? [];
    assert.match(lines[0] ?? "", /^per session: median \/ mean\s+baseline\s+with-x$/);
    assert.match(lines[1] ?? "", /^sessions\s+5\s+5$/);
    assert.match(lines[2] ?? "", /^cost\s+\$0\.40 \/ \$0\.50\s+\$0\.30 \/ \$0\.30$/);
    assert.match(lines.join("\n"), /failed calls\s+45\.5% of 11\s+20\.0% of 25/);
    assert.match(lines.join("\n"), /blocked calls\s+0\.0% of 11\s+0\.0% of 25/);
    assert.match(lines.join("\n"), /wall time\s+2m \/ 8m 6s/);
    const widths = new Set(lines.filter((line) => line !== "").map((line) => line.length));
    assert.equal(widths.size, 1, "right-aligned columns end at the same place");
});

test("a period with no session says so", async (t) => {
    const block = compareFor(await indexOf(t, sessions("old", 5, "baseline", 0)), NOW, 3);
    assert.deepEqual([block.sections, block.empty], [[], "no sessions"]);
    assert.equal(block.title, "Conditions compared, last 3 days, 2026-10-28 to 2026-10-30");
});

test("one condition alone says there is nothing to set it against", async (t) => {
    const block = compareFor(await indexOf(t, sessions("a", 6, "alpha", 2)), NOW, 30);
    assert.match(block.sections[0]?.lines.join("\n") ?? "", /only one condition/);
    assert.ok(!block.sections.some((section) => section.name === "Tools"));
});

// ---- the command ----------------------------------------------------------------------------------------------------

test("/lens compare takes nothing, or days N from 1 to 90", () => {
    assert.deepEqual(parseCommand("compare"), { kind: "compare", days: 30 });
    assert.deepEqual(parseCommand("  compare   days   7 "), { kind: "compare", days: 7 });
    assert.deepEqual(parseCommand("compare days 90"), { kind: "compare", days: 90 });
    const problem = "/lens compare takes days N, a whole number from 1 to 90, or nothing.";
    for (const args of [
        "compare 7",
        "compare days",
        "compare days 0",
        "compare days 91",
        "compare days x",
        "compare days 7 8",
        "compare week",
    ]) {
        assert.deepEqual(parseCommand(args), { kind: "usage", problem }, args);
    }
});

test("/lens compare in a terminal leaves an entry, 30 days by default", async (t) => {
    const r = rig(t, { session: "s1" });
    writeRecords(r.state, twoConditions());
    assert.deepEqual(await r.pi.lens("compare"), []);
    const [entry] = r.pi.entries;
    const blocks = (entry!.data as SummaryEntry).blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.title, "Conditions compared, last 30 days, 2026-10-01 to 2026-10-30");
    await r.pi.lens("compare days 2");
    assert.equal((r.pi.entries[1]!.data as SummaryEntry).blocks[0]?.empty, "no sessions");
});

test("/lens compare over RPC is a short notification", async (t) => {
    const r = rig(t, { mode: "rpc", session: "s1" });
    writeRecords(r.state, [...sessions("a", 5, "alpha", 0), ...sessions("b", 2, "beta", 0)]);
    const [notice] = await r.pi.lens("compare days 14");
    assert.equal(notice?.level, "info");
    const lines = (notice?.text ?? "").split("\n");
    assert.equal(lines[0], "Conditions compared, last 14 days, 2026-10-17 to 2026-10-30");
    assert.match(lines[1] ?? "", /too few sessions to compare/);
    assert.ok(
        lines.some((line) => /^ {13}cost\s+\$/.test(line)),
        "the top of the table",
    );
    assert.ok(lines.some((line) => /not a test of significance/.test(line)));
    assert.ok(lines.length <= 8, "short");
    assert.deepEqual(r.pi.entries, []);
});

test("/lens compare with no screen shows nothing, and with a bad argument shows the usage", async (t) => {
    const quiet = rig(t, { mode: "print", session: "s1" });
    writeRecords(quiet.state, twoConditions());
    assert.deepEqual(await quiet.pi.lens("compare"), []);
    assert.deepEqual([quiet.pi.entries, quiet.pi.sent], [[], []]);

    const r = rig(t, { session: "s1" });
    const [notice] = await r.pi.lens("compare days 91");
    assert.match(
        notice?.text ?? "",
        /^\/lens compare takes days N, a whole number from 1 to 90, or nothing\.\nUsage: .*compare \[days N\]/,
    );
    assert.deepEqual(r.pi.entries, []);
});

test("/lens compare with no records says so", async (t) => {
    const r = rig(t, { session: "s1" });
    await r.pi.lens("compare");
    const blocks = (r.pi.entries[0]!.data as SummaryEntry).blocks;
    assert.match(blocks[0]?.title ?? "", /^No records yet/);
});
