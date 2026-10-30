// Which scopes each command shows, and what an index with nothing in it says. The text of each scope is in
// summary.test.ts; here the blocks are put together, as `/lens` shows them, and the README is held to the code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SummaryCommand } from "../src/command.ts";
import { NO_RECORDS, requestsFor, summaryFor } from "../src/scopes.ts";
import { blockFor, plain, render, short, ticketRequest } from "../src/summary.ts";
import { call, exampleRecords, indexOf, NOW, sampleDb, turn } from "./support.ts";

// "Today" is the user's day. These tests are written for a clock on UTC.
process.env.TZ = "UTC";

const DEFAULT_S1: string[] = [
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
    "",
    "This session",
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
    "",
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

const DEFAULT_S2: string[] = [
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
    "",
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

const DEFAULT_NO_SESSION: string[] = [
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

const UNKNOWN_TICKET: string[] = ["Ticket T-9, all time: no records"];

const EMPTY: string[] = ["No records yet. jig-core writes them as tools run and model turns end."];

// ---- what each command asks for -------------------------------------------------------------------------------------

test("/lens alone shows today, this session and the ticket the session is on", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render(summaryFor({ kind: "summary" }, db, NOW, "s1")), DEFAULT_S1);
});

test("/lens in a session on no ticket shows two blocks", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render(summaryFor({ kind: "summary" }, db, NOW, "s2")), DEFAULT_S2);
});

test("/lens where Pi cannot say which session this is shows today alone", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render(summaryFor({ kind: "summary" }, db, NOW, undefined)), DEFAULT_NO_SESSION);
});

test("the scopes of each command", async (t) => {
    const db = await sampleDb(t);
    const titles = (command: SummaryCommand, session: string | undefined) =>
        requestsFor(command, db, NOW, session).map((request) => request.title);
    assert.deepEqual(titles({ kind: "summary" }, "s1"), ["Today, 2026-10-30", "This session", "Ticket T-1, all time"]);
    assert.deepEqual(titles({ kind: "summary" }, "s2"), ["Today, 2026-10-30", "This session"]);
    assert.deepEqual(titles({ kind: "summary" }, undefined), ["Today, 2026-10-30"]);
    assert.deepEqual(titles({ kind: "ticket", ticket: "T-1" }, "s1"), ["Ticket T-1, all time"]);
    assert.deepEqual(titles({ kind: "session" }, "s1"), ["This session"]);
    assert.deepEqual(titles({ kind: "session" }, undefined), [], "no session to show, and the command says so");
    assert.deepEqual(
        titles({ kind: "session", session: "s1" }, "s1"),
        ["This session"],
        "asked by id, but it is this one",
    );
    assert.deepEqual(titles({ kind: "session", session: "s3" }, "s1"), ["Session s3"]);
    assert.deepEqual(titles({ kind: "session", session: "s3" }, undefined), ["Session s3"]);
    assert.deepEqual(titles({ kind: "days", days: 1 }, "s1"), ["Today, 2026-10-30"]);
    assert.deepEqual(titles({ kind: "days", days: 30 }, "s1"), ["Last 30 days, 2026-10-01 to 2026-10-30"]);
});

test("a ticket and a session are read by what the records say, whatever session the user is in", async (t) => {
    const db = await sampleDb(t);
    for (const command of [
        { kind: "ticket", ticket: "T-1" },
        { kind: "session", session: "s3" },
    ] as const) {
        const fromS1 = render(summaryFor(command, db, NOW, "s1"));
        assert.deepEqual(render(summaryFor(command, db, NOW, "s2")), fromS1, command.kind);
        assert.deepEqual(render(summaryFor(command, db, NOW, undefined)), fromS1, command.kind);
    }
    const [title] = render(summaryFor({ kind: "ticket", ticket: "T-1" }, db, NOW, "s2"));
    assert.equal(title, "Ticket T-1, all time");
});

// ---- nothing to show ------------------------------------------------------------------------------------------------

test("an empty index says there are no records yet, whatever was asked", async (t) => {
    const db = await indexOf(t, []);
    const commands: SummaryCommand[] = [
        { kind: "summary" },
        { kind: "ticket", ticket: "T-1" },
        { kind: "session" },
        { kind: "days", days: 7 },
    ];
    for (const command of commands) assert.deepEqual(render(summaryFor(command, db, NOW, "s1")), EMPTY, command.kind);
    assert.deepEqual(summaryFor({ kind: "summary" }, db, NOW, "s1"), [NO_RECORDS]);
    assert.equal(short([NO_RECORDS]), NO_RECORDS.title);
});

test("a ticket nobody has worked on says there are no records for it", async (t) => {
    const db = await sampleDb(t);
    assert.deepEqual(render(summaryFor({ kind: "ticket", ticket: "T-9" }, db, NOW, "s1")), UNKNOWN_TICKET);
});

test("in the default view a block with nothing in it is one line among the others", async (t) => {
    const db = await indexOf(t, [
        turn("a", "2026-10-20T09:00:00Z", "fresh-1", "model-a", 0.5),
        call("b", "2026-10-30T10:00:00Z", "other", "bash"),
    ]);
    assert.deepEqual(render(summaryFor({ kind: "summary" }, db, NOW, "fresh-1")), [
        "Today, 2026-10-30",
        "  Tools      1 call, none failed",
        "",
        "This session",
        "  Cost       $0.50 over 1 turn, 1.0k tokens in (0% read from cache), 200 out",
        "             by model  model-a  $0.50",
    ]);
    assert.deepEqual(render(summaryFor({ kind: "summary" }, db, NOW, "brand-new")), [
        "Today, 2026-10-30",
        "  Tools      1 call, none failed",
        "",
        "This session: no records",
    ]);
});

// ---- the README ---------------------------------------------------------------------------------------------------

test("the example in the README is what /lens prints for the example records: it cannot drift", async (t) => {
    const readme = readFileSync(path.join(import.meta.dirname, "../README.md"), "utf8");
    const shown = /```text\n(Ticket PROJ-123, all time\n[\s\S]*?)\n```/.exec(readme)?.[1];
    assert.ok(shown, "the README shows a summary");
    const db = await indexOf(t, exampleRecords());
    assert.equal(shown, plain([blockFor(db, ticketRequest("PROJ-123"), NOW)]));
});
