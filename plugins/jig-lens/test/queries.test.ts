// The figures behind each section, asked of an index built from sample records. The expected numbers are worked out
// by hand from the records in support.ts, so a query that counts the wrong rows fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    activeTicket,
    blockedOf,
    checksOf,
    costOf,
    hasRecords,
    median,
    percentile,
    summarize,
    toolsOf,
    waitOf,
} from "../src/queries.ts";
import type { Scope } from "../src/queries.ts";
import { call, indexOf, sampleDb, turn } from "./support.ts";

const second = (iso: string) => Date.parse(iso) / 1000;

/** The four days the sample covers, with room on both sides. */
const ALL: Scope = { kind: "period", from: second("2026-10-01T00:00:00Z"), to: second("2026-11-30T00:00:00Z") };
const session = (id: string): Scope => ({ kind: "session", session: id });
const ticket = (key: string): Scope => ({ kind: "ticket", ticket: key });

// ---- percentile and median ------------------------------------------------------------------------------------------

test("a percentile is the value at nearest rank: the smallest one that the share is at or below", () => {
    assert.equal(percentile([], 95), undefined);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([1, 2], 95), 2);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(twenty, 95), 19, "19 of 20 values are at or below the 95th percentile");
    assert.equal(percentile([...twenty, 21], 95), 20, "with 21 values it is the 20th");
    assert.equal(percentile(twenty, 50), 10);
    assert.equal(percentile(twenty, 100), 20);
});

test("the rank is worked out in whole numbers, so no size of list is one rank off", () => {
    for (let n = 1; n <= 400; n++) {
        const list = Array.from({ length: n }, (_, i) => i + 1);
        assert.equal(percentile(list, 95), Math.ceil((95 * n) / 100), `n = ${n}`);
    }
});

test("the median is the middle value, or the mean of the two in the middle", () => {
    assert.equal(median([]), undefined);
    assert.equal(median([5]), 5);
    assert.equal(median([1, 9]), 5);
    assert.equal(median([1, 2, 10]), 2);
    assert.equal(median([1, 2, 4, 10]), 3);
});

// ---- cost -----------------------------------------------------------------------------------------------------------

test("cost is the sum of the turns, with the tokens that were sent and the share the cache gave", async (t) => {
    const cost = costOf(await sampleDb(t), ALL);
    assert.ok(cost);
    assert.equal(cost.turns, 6);
    assert.ok(Math.abs(cost.cost - 0.46) < 1e-9);
    // New input, cache reads and cache writes: 5500 + 7000 + 10000 + 1000 + 1000 + 13000.
    assert.equal(cost.input, 37_500);
    assert.equal(cost.output, 1200);
    assert.equal(cost.cacheRead, 31_000);
});

test("cost is split by model and by agent role, the dearest first", async (t) => {
    const cost = costOf(await sampleDb(t), ALL);
    assert.deepEqual(
        cost?.byModel.map((spend) => [spend.name, Number(spend.cost.toFixed(2)), spend.turns]),
        [
            ["model-a", 0.42, 4],
            ["model-b", 0.04, 2],
        ],
    );
    assert.deepEqual(
        cost?.byRole.map((spend) => [spend.name, Number(spend.cost.toFixed(2)), spend.turns]),
        [
            ["main", 0.43, 5],
            ["reviewer", 0.03, 1],
        ],
    );
});

test("cost has no figures for a scope with no turns", async (t) => {
    const db = await sampleDb(t);
    assert.equal(costOf(db, session("nobody")), undefined);
    assert.equal(costOf(db, ticket("T-404")), undefined);
});

// ---- scopes ---------------------------------------------------------------------------------------------------------

test("a session scope holds that session's rows and no others", async (t) => {
    const db = await sampleDb(t);
    assert.equal(toolsOf(db, session("s1"))?.calls, 8);
    assert.equal(toolsOf(db, session("s2"))?.calls, 4);
    assert.equal(toolsOf(db, session("s3"))?.calls, 2);
    assert.ok(Math.abs((costOf(db, session("s1"))?.cost ?? 0) - 0.35) < 1e-9);
});

test("a ticket scope holds the ticket's rows over all time, and a session may be on no ticket at all", async (t) => {
    const db = await sampleDb(t);
    assert.equal(toolsOf(db, ticket("T-1"))?.calls, 8);
    assert.equal(costOf(db, ticket("T-1"))?.turns, 3);
    assert.equal(toolsOf(db, ticket("t-1")), undefined, "a ticket is matched exactly as it was recorded");
});

test("a time range starts at its first second and stops before its last", async (t) => {
    const db = await sampleDb(t);
    // c05 ended at 10:01:00 on the 28th, c06 at 10:02:00.
    const range = (from: string, to: string): Scope => ({ kind: "period", from: second(from), to: second(to) });
    assert.equal(toolsOf(db, range("2026-10-28T10:01:00Z", "2026-10-28T10:02:00Z"))?.calls, 1, "from is included");
    assert.equal(toolsOf(db, range("2026-10-28T10:01:01Z", "2026-10-28T10:02:00Z")), undefined, "to is not");
    assert.equal(toolsOf(db, range("2026-10-28T10:01:00Z", "2026-10-28T10:02:01Z"))?.calls, 2);
});

test("an empty range holds nothing", async (t) => {
    const summary = summarize(await sampleDb(t), {
        kind: "period",
        from: second("2026-12-01T00:00:00Z"),
        to: second("2026-12-02T00:00:00Z"),
    });
    assert.deepEqual(summary, {
        cost: undefined,
        tools: undefined,
        yourTime: undefined,
        blocked: undefined,
        checks: [],
    });
});

// ---- tools ----------------------------------------------------------------------------------------------------------

test("tools count the calls, the failures and the calls that never ran", async (t) => {
    const tools = toolsOf(await sampleDb(t), ALL);
    assert.ok(tools);
    assert.equal(tools.calls, 14);
    assert.equal(tools.failed, 3);
    assert.equal(tools.blocked, 3);
});

test("failures are listed by tool and by why, most failures first", async (t) => {
    const tools = toolsOf(await sampleDb(t), ALL);
    assert.deepEqual(
        tools?.failing.map(({ tool, action, calls, failed, kinds }) => ({ tool, action, calls, failed, kinds })),
        [
            { tool: "bash", action: undefined, calls: 4, failed: 1, kinds: [{ kind: "tool", count: 1 }] },
            { tool: "flow", action: "test", calls: 1, failed: 1, kinds: [{ kind: "tool", count: 1 }] },
            { tool: "mystery", action: undefined, calls: 1, failed: 1, kinds: [{ kind: "not-run", count: 1 }] },
        ],
    );
    assert.deepEqual(tools?.failingElsewhere, { tools: 0, failures: 0 });
});

test("only the five tools that failed most are listed, and the rest are counted", async (t) => {
    const records = [];
    // Tool k fails k times (k = 1..7), each time for the reason `tool`, and one of them also for `withheld`.
    for (let k = 1; k <= 7; k++) {
        for (let i = 0; i < k; i++) {
            records.push(
                call(`f${k}-${i}`, "2026-10-30T09:00:00Z", "s1", `tool${k}`, { outcome: "error", errorKind: "tool" }),
            );
        }
        records.push(call(`ok${k}`, "2026-10-30T09:00:00Z", "s1", `tool${k}`));
    }
    records.push(call("w", "2026-10-30T09:00:00Z", "s1", "tool7", { outcome: "error", errorKind: "withheld" }));
    const tools = toolsOf(await indexOf(t, records), ALL);
    assert.deepEqual(
        tools?.failing.map((tool) => [tool.tool, tool.failed, tool.calls]),
        [
            ["tool7", 8, 9],
            ["tool6", 6, 7],
            ["tool5", 5, 6],
            ["tool4", 4, 5],
            ["tool3", 3, 4],
        ],
    );
    assert.deepEqual(tools?.failing[0]?.kinds, [
        { kind: "tool", count: 7 },
        { kind: "withheld", count: 1 },
    ]);
    assert.deepEqual(tools?.failingElsewhere, { tools: 2, failures: 3 }, "tool2 and tool1: 2 + 1 failures");
    assert.equal(tools?.failed, 1 + 2 + 3 + 4 + 5 + 6 + 8);
});

test("a tool with several actions is several tools, as in the dashboards", async (t) => {
    const records = [
        call("a", "2026-10-30T09:00:00Z", "s1", "git", {
            action: "push",
            outcome: "error",
            errorKind: "tool",
            durationMs: 100,
        }),
        call("b", "2026-10-30T09:00:00Z", "s1", "git", { action: "status", durationMs: 5 }),
        call("c", "2026-10-30T09:00:00Z", "s1", "git", { durationMs: 9 }),
    ];
    const tools = toolsOf(await indexOf(t, records), ALL);
    assert.deepEqual(
        tools?.slowest.map((tool) => [tool.tool, tool.action, tool.p95Ms]),
        [
            ["git", "push", 100],
            ["git", undefined, 9],
            ["git", "status", 5],
        ],
    );
    assert.deepEqual(
        tools?.failing.map((tool) => [tool.tool, tool.action]),
        [["git", "push"]],
    );
});

test("the slowest tools are ranked by the 95th percentile of duration, not the average or the worst", async (t) => {
    const records = [];
    // `steady` takes 100 ms 19 times and once 9 s: its p95 is 100 ms (the 19th of 20), its worst is 9 s.
    for (let i = 0; i < 19; i++)
        records.push(call(`s${i}`, "2026-10-30T09:00:00Z", "s1", "steady", { durationMs: 100 }));
    records.push(call("s19", "2026-10-30T09:00:00Z", "s1", "steady", { durationMs: 9000 }));
    // `slow` takes 500 ms every time.
    for (let i = 0; i < 4; i++) records.push(call(`l${i}`, "2026-10-30T09:00:00Z", "s1", "slow", { durationMs: 500 }));
    const tools = toolsOf(await indexOf(t, records), ALL);
    assert.deepEqual(
        tools?.slowest.map((tool) => [tool.tool, tool.calls, tool.p95Ms]),
        [
            ["slow", 4, 500],
            ["steady", 20, 100],
        ],
    );
});

test("at most five tools are listed as the slowest, and calls with no duration are not counted in them", async (t) => {
    const records = [];
    for (let k = 1; k <= 7; k++)
        records.push(call(`d${k}`, "2026-10-30T09:00:00Z", "s1", `tool${k}`, { durationMs: k * 10 }));
    records.push(call("blocked", "2026-10-30T09:00:00Z", "s1", "tool8", { outcome: "blocked", errorKind: "denied" }));
    const tools = toolsOf(await indexOf(t, records), ALL);
    assert.deepEqual(
        tools?.slowest.map((tool) => tool.tool),
        ["tool7", "tool6", "tool5", "tool4", "tool3"],
    );
    assert.equal(tools?.calls, 8);
});

// ---- your time ------------------------------------------------------------------------------------------------------

test("the questions are counted by answer, with a closed question told apart from a decline", async (t) => {
    const wait = waitOf(await sampleDb(t), ALL);
    assert.ok(wait);
    assert.equal(wait.questions, 4);
    assert.equal(wait.allowed, 1);
    assert.equal(wait.allowedForSession, 1);
    assert.equal(wait.declined, 1, "c08: the user said no");
    assert.equal(wait.dismissed, 1, "c13: the question was closed, which is recorded as a decline too");
});

test("the wait is added up, and its median is the middle of the waits", async (t) => {
    const wait = waitOf(await sampleDb(t), ALL);
    assert.equal(wait?.totalMs, 3000 + 800 + 1500 + 9000);
    assert.equal(wait?.medianMs, (1500 + 3000) / 2, "800, 1500, 3000, 9000");
});

test("the tools that waited longest come first, with their questions", async (t) => {
    const wait = waitOf(await sampleDb(t), ALL);
    assert.deepEqual(
        wait?.byTool.map((tool) => [tool.tool, tool.action, tool.questions, tool.waitedMs]),
        [
            ["bash", undefined, 2, 10_500],
            ["git", "push", 2, 3800],
        ],
    );
});

test("only three tools are listed for the wait", async (t) => {
    const records = [];
    for (let k = 1; k <= 5; k++) {
        records.push(
            call(`q${k}`, "2026-10-30T09:00:00Z", "s1", `tool${k}`, {
                decision: "ask",
                approval: "dialog",
                answer: "allow",
                waitedMs: k * 1000,
            }),
        );
    }
    const wait = waitOf(await indexOf(t, records), ALL);
    assert.deepEqual(
        wait?.byTool.map((tool) => tool.tool),
        ["tool5", "tool4", "tool3"],
    );
    assert.equal(wait?.questions, 5);
});

test("a scope where nobody was asked has no figures for the wait", async (t) => {
    const db = await sampleDb(t);
    assert.equal(waitOf(db, session("s3")), undefined);
});

// ---- blocked --------------------------------------------------------------------------------------------------------

test("blocked calls are grouped by who decided and why, with the tools that were stopped", async (t) => {
    const blocked = blockedOf(await sampleDb(t), ALL);
    assert.deepEqual(blocked?.total, 3);
    assert.deepEqual(
        blocked?.groups.map((group) => [
            group.source,
            group.kind,
            group.count,
            group.tools.map((tool) => `${tool.tool}:${tool.count}`),
        ]),
        [
            ["floor", "denied", 1, ["http:1"]],
            ["unknown", "declined", 1, ["bash:1"]],
            ["unknown", "dismissed", 1, ["bash:1"]],
        ],
    );
});

test("the groups are ordered by size, and a group names its most often blocked tools first", async (t) => {
    const records = [
        call("a", "2026-10-30T09:00:00Z", "s1", "http", {
            outcome: "blocked",
            errorKind: "denied",
            decisionSource: "rule",
        }),
        call("b", "2026-10-30T09:00:00Z", "s1", "http", {
            outcome: "blocked",
            errorKind: "denied",
            decisionSource: "rule",
        }),
        call("c", "2026-10-30T09:00:00Z", "s1", "git", {
            action: "push",
            outcome: "blocked",
            errorKind: "denied",
            decisionSource: "rule",
        }),
        call("d", "2026-10-30T09:00:00Z", "s1", "bash", {
            outcome: "blocked",
            errorKind: "no-screen",
            decisionSource: "floor",
        }),
        call("e", "2026-10-30T09:00:00Z", "s1", "git", {
            action: "push",
            outcome: "blocked",
            errorKind: "invalid",
            decisionSource: "table",
        }),
        call("f", "2026-10-30T09:00:00Z", "s1", "git", {
            action: "push",
            outcome: "blocked",
            errorKind: "invalid",
            decisionSource: "table",
        }),
        call("g", "2026-10-30T09:00:00Z", "s1", "read"),
    ];
    const blocked = blockedOf(await indexOf(t, records), ALL);
    assert.equal(blocked?.total, 6);
    assert.deepEqual(
        blocked?.groups.map((group) => [group.source, group.kind, group.count]),
        [
            ["rule", "denied", 3],
            ["table", "invalid", 2],
            ["floor", "no-screen", 1],
        ],
    );
    assert.deepEqual(
        blocked?.groups[0]?.tools.map((tool) => [tool.tool, tool.action, tool.count]),
        [
            ["http", undefined, 2],
            ["git", "push", 1],
        ],
    );
});

test("no blocked calls means no figures", async (t) => {
    assert.equal(blockedOf(await sampleDb(t), session("s3")), undefined);
});

// ---- checks ---------------------------------------------------------------------------------------------------------

test("checks are the facts of each tool's latest call that has any, the most recent tool first", async (t) => {
    const checks = checksOf(await sampleDb(t), ALL);
    assert.deepEqual(
        checks.map((check) => [check.tool, check.action, check.at, check.facts]),
        [
            [
                "flow",
                "test",
                second("2026-10-30T09:01:00Z"),
                [
                    { name: "failed", value: 2 },
                    { name: "ok", value: false },
                    { name: "passed", value: 10 },
                ],
            ],
            [
                "checks",
                "watch",
                second("2026-10-29T08:02:00Z"),
                [
                    { name: "conclusion", value: "success" },
                    { name: "failed", value: 0 },
                    { name: "passed", value: 12 },
                ],
            ],
        ],
    );
});

test("only the latest call's facts count, and they keep their types: numbers, flags and words", async (t) => {
    const records = [
        call("old", "2026-10-30T08:00:00Z", "s1", "checks", {
            action: "watch",
            facts: { conclusion: "failure", passed: 1 },
        }),
        call("new", "2026-10-30T09:00:00Z", "s1", "checks", {
            action: "watch",
            facts: { conclusion: "success", flaky: true, ratio: 0.5 },
        }),
        call("other", "2026-10-30T07:00:00Z", "s1", "release", { facts: { ready: false } }),
    ];
    const checks = checksOf(await indexOf(t, records), ALL);
    assert.deepEqual(
        checks.map((check) => check.tool),
        ["checks", "release"],
    );
    assert.deepEqual(checks[0]?.facts, [
        { name: "conclusion", value: "success" },
        { name: "flaky", value: true },
        { name: "ratio", value: 0.5 },
    ]);
    assert.deepEqual(checks[1]?.facts, [{ name: "ready", value: false }]);
});

test("calls with no facts give no checks", async (t) => {
    assert.deepEqual(checksOf(await sampleDb(t), session("s1")), []);
});

// ---- the session's ticket, and whether there is anything ------------------------------------------------------------

test("the active ticket is the one on the session's latest record", async (t) => {
    const db = await sampleDb(t);
    assert.equal(activeTicket(db, "s1"), "T-1");
    assert.equal(activeTicket(db, "s2"), undefined, "a session on no ticket");
    assert.equal(activeTicket(db, "s3"), undefined);
    assert.equal(activeTicket(db, "nobody"), undefined);
});

test("a session that moved to another ticket is on the new one, and one that left its ticket is on none", async (t) => {
    const records = [
        turn("m1", "2026-10-30T08:00:00Z", "moved", "model-a", 0.1, { ticket: "T-1" }),
        call("m2", "2026-10-30T09:00:00Z", "moved", "bash", { ticket: "T-1" }),
        call("m3", "2026-10-30T10:00:00Z", "moved", "bash", { ticket: "T-2" }),
        call("l1", "2026-10-30T08:00:00Z", "left", "bash", { ticket: "T-1" }),
        call("l2", "2026-10-30T09:00:00Z", "left", "bash"),
    ];
    const db = await indexOf(t, records);
    assert.equal(activeTicket(db, "moved"), "T-2");
    assert.equal(activeTicket(db, "left"), undefined);
});

test("the latest record may be a turn: it settles which ticket the session is on", async (t) => {
    const records = [
        call("c", "2026-10-30T09:00:00Z", "s", "bash", { ticket: "T-1" }),
        turn("t", "2026-10-30T10:00:00Z", "s", "model-a", 0.1, { ticket: "T-2" }),
    ];
    assert.equal(activeTicket(await indexOf(t, records), "s"), "T-2");
});

test("there are records when there is a call or a turn, and none in an empty index", async (t) => {
    assert.equal(hasRecords(await indexOf(t, [])), false);
    assert.equal(hasRecords(await indexOf(t, [call("c", "2026-10-30T09:00:00Z", "s", "bash")])), true);
    assert.equal(hasRecords(await indexOf(t, [turn("t", "2026-10-30T09:00:00Z", "s", "model-a", 0.1)])), true);
});
