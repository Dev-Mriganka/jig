// The text of a scope, line for line. Each scenario is an index built from sample records and the exact lines `/lens`
// shows for it, worked out by hand from the records (see queries.test.ts for the arithmetic) so that a change to the
// wording or the layout of any section is a visible change here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockFor, daysRequest, PLAIN, plain, render, sessionRequest, short, ticketRequest } from "../src/summary.ts";
import type { Block, Style } from "../src/summary.ts";
import { busyRecords, call, indexOf, NOW, sampleDb, sampleRecords, turn } from "./support.ts";

// "Today" is the user's day. These tests are written for a clock on UTC.
process.env.TZ = "UTC";

const TODAY: string[] = [
    "Today, 2026-10-30",
    "  Cost       $0.07 over 1 turn, 13.0k tokens in (92% read from cache), 200 out",
    "             by model  model-a  $0.07",
    "  Tools      3 calls, 1 failed, 1 blocked",
    "             failing  flow test    1 of 1  tool 1",
    "             slowest  flow test   p95 45s  1 call",
    "                      git push   p95 1.8s  1 call",
    "  Your time  2 questions: 1 allowed for the session, 1 dismissed",
    "             waited 9.8s in total, median 4.9s",
    "             by tool  bash       9.0s  1 question",
    "                      git push  800ms  1 question",
    "  Blocked    1 call",
    "             unknown  dismissed  1  bash 1",
    "  Checks     flow test  failed 2, ok false, passed 10  2h ago",
];

const SESSION: string[] = [
    "This session",
    "  Cost       $0.08 over 2 turns, 14.0k tokens in (86% read from cache), 400 out",
    "             by model  model-a  $0.07",
    "                       model-b  $0.01",
    "  Tools      4 calls, 2 failed, 2 blocked",
    "             failing  flow test   1 of 1  tool 1",
    "                      mystery     1 of 1  not-run 1",
    "             slowest  flow test  p95 45s  1 call",
    "  Your time  2 questions: 1 declined, 1 dismissed",
    "             waited 11s in total, median 5.3s",
    "             by tool  bash  11s  2 questions",
    "  Blocked    2 calls",
    "             unknown  declined   1  bash 1",
    "             unknown  dismissed  1  bash 1",
    "  Checks     flow test  failed 2, ok false, passed 10  2h ago",
];

const TICKET: string[] = [
    "Ticket T-1, all time",
    "  Cost       $0.35 over 3 turns, 22.5k tokens in (84% read from cache), 600 out",
    "             by model  model-a  $0.35",
    "  Tools      8 calls, 1 failed, 1 blocked",
    "             failing  bash          1 of 2  tool 1",
    "             slowest  git push    p95 2.1s  2 calls",
    "                      bash        p95 1.2s  2 calls",
    "                      git status  p95 90ms  1 call",
    "                      edit        p95 12ms  1 call",
    "                      read         p95 4ms  1 call",
    "  Your time  2 questions: 1 allowed, 1 allowed for the session",
    "             waited 3.8s in total, median 1.9s",
    "             by tool  git push  3.8s  2 questions",
    "  Blocked    1 call",
    "             floor  denied  1  http 1",
];

const DAYS7: string[] = [
    "Last 7 days, 2026-10-24 to 2026-10-30",
    "  Cost       $0.46 over 6 turns, 37.5k tokens in (83% read from cache), 1.2k out",
    "             by model  model-a   $0.42",
    "                       model-b   $0.04",
    "             by agent  main      $0.43",
    "                       reviewer  $0.03",
    "  Tools      14 calls, 3 failed, 3 blocked",
    "             failing  bash          1 of 4  tool 1",
    "                      flow test     1 of 1  tool 1",
    "                      mystery       1 of 1  not-run 1",
    "             slowest  ci watch      p95 1m  1 call",
    "                      flow test    p95 45s  1 call",
    "                      git push    p95 2.1s  2 calls",
    "                      bash        p95 1.2s  2 calls",
    "                      git status  p95 90ms  1 call",
    "  Your time  4 questions: 1 allowed, 1 allowed for the session, 1 declined, 1 dismissed",
    "             waited 14s in total, median 2.3s",
    "             by tool  bash       11s  2 questions",
    "                      git push  3.8s  2 questions",
    "  Blocked    3 calls",
    "             floor    denied     1  http 1",
    "             unknown  declined   1  bash 1",
    "             unknown  dismissed  1  bash 1",
    "  Checks     flow test  failed 2, ok false, passed 10            2h ago",
    "             ci watch   conclusion success, failed 0, passed 12  27h ago",
];

const OTHER_SESSION: string[] = [
    "Session s3",
    "  Cost       $0.03 over 1 turn, 1.0k tokens in (0% read from cache), 200 out",
    "             by model  model-b   $0.03",
    "             by agent  reviewer  $0.03",
    "  Tools      2 calls, none failed",
    "             slowest  ci watch   p95 1m  1 call",
    "                      read      p95 6ms  1 call",
    "  Checks     ci watch  conclusion success, failed 0, passed 12  27h ago",
];

const TURN_ONLY: string[] = [
    "Ticket T-7, all time",
    "  Cost       $0.25 over 1 turn, 4.0k tokens in (75% read from cache), 200 out",
    "             by model  model-a  $0.25",
];

const CALLS_ONLY: string[] = [
    "This session",
    "  Tools      3 calls, none failed",
    "             slowest  grep  p95 40ms  1 call",
    "                      read   p95 7ms  2 calls",
];

const BUSY: string[] = [
    "Today, 2026-10-30",
    "  Cost       $5.35 over 7 turns, 35.0k tokens in (80% read from cache), 1.4k out",
    "             by model  claude-sonnet-5-5                           $3.20",
    "                       claude-opus-5                               $1.50",
    "                       anthropic.claude-haiku-4-5-20251001-v1:…    $0.40",
    "                       gpt-5.2                                     $0.20",
    "                       gemini-3                                    $0.05",
    "                       2 more models                             $0.0040",
    "             by agent  main                                        $4.70",
    "                       reviewer                                    $0.40",
    "                       scout                                       $0.20",
    "                       planner                                     $0.05",
    "                       2 more agents                             $0.0040",
    "  Tools      87 calls, 28 failed, 41 blocked",
    "             failing  tool7            7 of 8  tool 5, not-run 2",
    "                      tool6            6 of 7  tool 4, not-run 2",
    "                      tool5            5 of 6  tool 4, not-run 1",
    "                      tool4            4 of 5  tool 3, not-run 1",
    "                      tool3            3 of 4  tool 2, not-run 1",
    "                      2 more tools   3 failed",
    "             slowest  tool7         p95 706ms  8 calls",
    "                      tool6         p95 605ms  7 calls",
    "                      tool5         p95 504ms  6 calls",
    "                      tool4         p95 403ms  5 calls",
    "                      tool3         p95 302ms  4 calls",
    "  Your time  4 questions: 3 allowed, 1 declined",
    "             waited 30s in total, median 6.5s",
    "             by tool  git a4   16s  1 question",
    "                      git a3  9.0s  1 question",
    "                      git a2  4.0s  1 question",
    "  Blocked    41 calls",
    "             floor          denied      5  blk-a 1, blk-b 1, blk-c 1, 2 more",
    "             floor          no-screen   5  blk-a 1, blk-b 1, blk-c 1, 2 more",
    "             rule           denied      5  blk-a 1, blk-b 1, blk-c 1, 2 more",
    "             rule           no-screen   5  blk-a 1, blk-b 1, blk-c 1, 2 more",
    "             table          denied      5  blk-a 1, blk-b 1, blk-c 1, 2 more",
    "             table          invalid     5  blk-a 1, blk-b 1, blk-c 1, 2 more",
    "             3 more groups             11",
    "  Checks     evil?[2Jtool  k? v?txt                                 1h ago",
    "             check7        long xxxxxxxxxxxxxxxxxxxxxxx…, passed 7  1h ago",
    "             check6        long xxxxxxxxxxxxxxxxxxxxxxx…, passed 6  1h ago",
    "             check5        long xxxxxxxxxxxxxxxxxxxxxxx…, passed 5  1h ago",
    "             check4        long xxxxxxxxxxxxxxxxxxxxxxx…, passed 4  1h ago",
    "             3 more tools",
];

// ---- each scope -----------------------------------------------------------------------------------------------------

test("today: the sections of one local day, each as short as it can be", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render([blockFor(db, daysRequest(NOW, 1), NOW)]), TODAY);
});

test("this session: another day's calls are in, the session's other days are too", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render([blockFor(db, sessionRequest("s2", true), NOW)]), SESSION);
});

test("a ticket: over all time, with the sessions that worked on it together", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render([blockFor(db, ticketRequest("T-1"), NOW)]), TICKET);
});

test("the last days: several days at once, with every role that took part", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render([blockFor(db, daysRequest(NOW, 7), NOW)]), DAYS7);
});

test("another session than this one is titled with its id, and a child agent's role is shown", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render([blockFor(db, sessionRequest("s3", false), NOW)]), OTHER_SESSION);
});

test("the titles: one day is today, and a ticket or a session id with control characters is cleaned", () => {
    assert.equal(daysRequest(NOW, 1).title, "Today, 2026-10-30");
    assert.equal(daysRequest(NOW, 30).title, "Last 30 days, 2026-10-01 to 2026-10-30");
    assert.equal(sessionRequest("s1", true).title, "This session");
    assert.equal(sessionRequest("s1", false).title, "Session s1");
    assert.equal(ticketRequest("T-\u001b[2J1").title, "Ticket T-?[2J1, all time");
    assert.equal(sessionRequest("s\u202e1", false).title, "Session s?1");
    assert.equal(ticketRequest("T".repeat(60)).title, `Ticket ${"T".repeat(39)}…, all time`);
});

// ---- nothing to show ------------------------------------------------------------------------------------------------

test("a day, a session or a ticket with no rows is one line under its title", async (t) => {
    const db = await sampleDb(t);
    const later = new Date("2026-12-24T12:00:00Z");
    assert.deepEqual(render([blockFor(db, daysRequest(later, 1), NOW)]), ["Today, 2026-12-24: no records"]);
    assert.deepEqual(render([blockFor(db, sessionRequest("later", true), NOW)]), ["This session: no records"]);
    assert.deepEqual(render([blockFor(db, ticketRequest("T-9"), NOW)]), ["Ticket T-9, all time: no records"]);
});

// ---- sections leave themselves out ----------------------------------------------------------------------------------

test("a ticket with turns and no calls shows only its cost", async (t) => {
    const db = await indexOf(t, [
        turn("a", "2026-10-30T09:00:00Z", "s9", "model-a", 0.25, { ticket: "T-7", cacheRead: 3000 }),
    ]);
    assert.deepEqual(render([blockFor(db, ticketRequest("T-7"), NOW)]), TURN_ONLY);
});

test("a session with calls and no turns shows only its tools, and no section that has nothing in it", async (t) => {
    const db = await indexOf(t, [
        call("a", "2026-10-30T09:00:00Z", "s8", "read", { durationMs: 5 }),
        call("b", "2026-10-30T09:01:00Z", "s8", "read", { durationMs: 7 }),
        call("c", "2026-10-30T09:02:00Z", "s8", "grep", { durationMs: 40 }),
    ]);
    assert.deepEqual(render([blockFor(db, sessionRequest("s8", true), NOW)]), CALLS_ONLY);
});

test("each section is left out when the scope has nothing for it", async (t) => {
    const names = (block: Block) => block.sections.map((section) => section.name);
    const at = "2026-10-30T09:00:00Z";
    const cases: Array<[string, Parameters<typeof indexOf>[1], string[]]> = [
        ["cost needs a turn", [turn("a", at, "s", "m", 1)], ["Cost"]],
        ["tools need a call", [call("a", at, "s", "bash")], ["Tools"]],
        [
            "your time needs a question",
            [call("a", at, "s", "bash", { decision: "ask", answer: "allow", waitedMs: 5 })],
            ["Tools", "Your time"],
        ],
        [
            "blocked needs a blocked call",
            [call("a", at, "s", "bash", { outcome: "blocked", errorKind: "denied", decisionSource: "rule" })],
            ["Tools", "Blocked"],
        ],
        ["checks need facts", [call("a", at, "s", "bash", { facts: { passed: 1 } })], ["Tools", "Checks"]],
    ];
    for (const [what, records, expected] of cases) {
        const db = await indexOf(t, records);
        assert.deepEqual(names(blockFor(db, sessionRequest("s", true), NOW)), expected, what);
    }
});

test("a single agent called main is not worth a line, any other is", async (t) => {
    const request = sessionRequest("s", true);
    const onlyMain = await indexOf(t, [turn("a", "2026-10-30T09:00:00Z", "s", "m", 1)]);
    assert.deepEqual(
        render([blockFor(onlyMain, request, NOW)]).filter((line) => line.includes("by agent")),
        [],
    );
    const child = await indexOf(t, [turn("a", "2026-10-30T09:00:00Z", "s", "m", 1, {}, { JIG_AGENT_ROLE: "scout" })]);
    assert.equal(render([blockFor(child, request, NOW)]).filter((line) => line.includes("by agent  scout")).length, 1);
});

// ---- more than a section shows --------------------------------------------------------------------------------------

test("a busy day: lists stop at their limit, and what is left over is added up", async (t) => {
    const db = await indexOf(t, busyRecords());
    assert.deepEqual(render([blockFor(db, daysRequest(NOW, 1), NOW)]), BUSY);
});

test("names from the records are clean: no control character reaches the screen, and long names are cut", async (t) => {
    const db = await indexOf(t, busyRecords());
    const text = plain([blockFor(db, daysRequest(NOW, 1), NOW)]);
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/u);
    assert.match(text, /evil\?\[2Jtool/);
    assert.match(text, /anthropic\.claude-haiku-4-5-20251001-v1:…/);
});

test("no line is wider than a terminal of 100 columns, however busy the day", async (t) => {
    const sample = await sampleDb(t);
    const blocks = [
        blockFor(sample, daysRequest(NOW, 1), NOW),
        blockFor(sample, daysRequest(NOW, 7), NOW),
        blockFor(await indexOf(t, busyRecords()), daysRequest(NOW, 1), NOW),
    ];
    for (const line of render(blocks)) assert.ok(line.length <= 100, `${line.length}: ${line}`);
});

// ---- the lines ------------------------------------------------------------------------------------------------------

test("a style dresses the title, the section names and the notes, and nothing else", async (t) => {
    const db = await sampleDb(t);
    const style: Style = {
        title: (text) => `<t>${text}</t>`,
        label: (text) => `<l>${text}</l>`,
        dim: (text) => `<d>${text}</d>`,
    };
    const blocks = [blockFor(db, sessionRequest("s3", false), NOW), blockFor(db, ticketRequest("T-9"), NOW)];
    const lines = render(blocks, style);
    assert.equal(lines[0], "<t>Session s3</t>");
    assert.equal(lines[1], "  <l>Cost     </l>  $0.03 over 1 turn, 1.0k tokens in (0% read from cache), 200 out");
    assert.equal(lines[2], "             by model  model-b   $0.03", "the lines under a name are not dressed");
    assert.equal(lines.at(-1), "<t>Ticket T-9, all time</t><d>: no records</d>");
    assert.equal(lines.at(-2), "");
    assert.deepEqual(render([blocks[0] as Block], PLAIN), OTHER_SESSION);
});

test("the shortened summary is each section's first line", async (t) => {
    const db = await sampleDb(t);
    assert.equal(
        short([blockFor(db, daysRequest(NOW, 1), NOW), blockFor(db, sessionRequest("s2", true), NOW)]),
        [
            "Today, 2026-10-30",
            "  Cost       $0.07 over 1 turn, 13.0k tokens in (92% read from cache), 200 out",
            "  Tools      3 calls, 1 failed, 1 blocked",
            "  Your time  2 questions: 1 allowed for the session, 1 dismissed",
            "  Blocked    1 call",
            "  Checks     flow test  failed 2, ok false, passed 10  2h ago",
            "",
            "This session",
            "  Cost       $0.08 over 2 turns, 14.0k tokens in (86% read from cache), 400 out",
            "  Tools      4 calls, 2 failed, 2 blocked",
            "  Your time  2 questions: 1 declined, 1 dismissed",
            "  Blocked    2 calls",
            "  Checks     flow test  failed 2, ok false, passed 10  2h ago",
        ].join("\n"),
    );
});

test("the plain text is the lines, one to a row", async (t) => {
    const db = await sampleDb(t);
    const blocks = [blockFor(db, daysRequest(NOW, 1), NOW), blockFor(db, ticketRequest("T-1"), NOW)];
    assert.equal(plain(blocks), render(blocks).join("\n"));
    assert.ok(!plain(blocks).endsWith("\n"));
});

test("the records of the sample are what the texts above are worked out from", () => {
    assert.equal(sampleRecords().filter((record) => record.kind === "call").length, 14);
    assert.equal(sampleRecords().filter((record) => record.kind === "turn").length, 6);
});
