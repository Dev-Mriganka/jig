// One line of a record file, as a row: which field goes to which column, and which lines are not records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callRecord, turnRecord } from "../../jig-core/src/records.ts";
import type { CallInput } from "../../jig-core/src/records.ts";
import { CALL, TURN } from "../src/fields.ts";
import { parseLine } from "../src/parse.ts";

const WHEN = new Date("2026-10-30T12:34:56.789Z");

/** A call that has every field a record can hold. */
const FULL: CallInput = {
    session: "session-1",
    ticket: "TICKET-42",
    tool: "git",
    action: "push",
    plugin: "jig-git",
    environment: "external",
    environmentKind: "external",
    effect: "write",
    decision: "ask",
    decisionSource: "table",
    approval: "review",
    answer: "allow",
    waitedMs: 4321.6,
    outcome: "error",
    errorKind: "tool",
    error: "remote rejected the push",
    durationMs: 87.4,
    toolCallId: "call_1/2",
    parentToolCallId: "call_1",
    spill: "/state/spill/s/call_1_2.txt",
    facts: { testsPassed: 12, ok: false, conclusion: "failure" },
};

const line = (record: object) => JSON.stringify(record);

test("every field of a call record becomes the column of the same name", () => {
    const record = callRecord(FULL, WHEN, {
        JIG_PARENT_SESSION: "parent-9",
        JIG_AGENT_ROLE: "reviewer",
        JIG_CONDITION: "baseline",
    });
    const row = parseLine(line(record));
    assert.ok(row);
    assert.equal(row.table, "call");
    const columns = Object.fromEntries(CALL.map((field, i) => [field.name, row.values[i]]));
    assert.deepEqual(columns, {
        id: record.id,
        time: Date.parse("2026-10-30T12:34:56.789Z") / 1000,
        session: "session-1",
        parentSession: "parent-9",
        agentRole: "reviewer",
        condition: "baseline",
        ticket: "TICKET-42",
        tool: "git",
        action: "push",
        plugin: "jig-git",
        environment: "external",
        environmentKind: "external",
        effect: "write",
        decision: "ask",
        decisionSource: "table",
        approval: "review",
        answer: "allow",
        waitedMs: 4322,
        outcome: "error",
        errorKind: "tool",
        error: "remote rejected the push",
        durationMs: 87,
        toolCallId: "call_1/2",
        parentToolCallId: "call_1",
        spill: "/state/spill/s/call_1_2.txt",
        facts: '{"testsPassed":12,"ok":false,"conclusion":"failure"}',
    });
});

test("every field of a turn record becomes the column of the same name", () => {
    const record = turnRecord(
        {
            session: "session-1",
            ticket: "TICKET-42",
            model: "model-a",
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 2,
            cost: 0.0123,
        },
        WHEN,
        { JIG_CONDITION: "with-tool-x" },
    );
    const row = parseLine(line(record));
    assert.ok(row);
    assert.equal(row.table, "turn");
    assert.deepEqual(Object.fromEntries(TURN.map((field, i) => [field.name, row.values[i]])), {
        id: record.id,
        time: Date.parse("2026-10-30T12:34:56.789Z") / 1000,
        session: "session-1",
        parentSession: null,
        agentRole: "main",
        condition: "with-tool-x",
        ticket: "TICKET-42",
        model: "model-a",
        input: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 2,
        cost: 0.0123,
    });
});

test("the fields of a call are the fields of jig-core's record, in its order", () => {
    const record = callRecord(FULL, WHEN, { JIG_PARENT_SESSION: "p", JIG_CONDITION: "c" });
    const names = Object.keys(record).filter((name) => name !== "kind");
    assert.deepEqual(
        CALL.map((field) => field.name),
        names,
    );
});

test("the fields of a turn are the fields of jig-core's record, in its order", () => {
    const record = turnRecord(
        { session: "s", ticket: "T", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
        WHEN,
        { JIG_PARENT_SESSION: "p", JIG_CONDITION: "c" },
    );
    const names = Object.keys(record).filter((name) => name !== "kind");
    assert.deepEqual(
        TURN.map((field) => field.name),
        names,
    );
});

test("a field that does not apply is null, and a call that never ran has no classification", () => {
    const record = callRecord(
        { session: "s", tool: "mystery", outcome: "error", errorKind: "not-run", toolCallId: "c" },
        WHEN,
        {},
    );
    const row = parseLine(line(record));
    assert.ok(row);
    const columns = Object.fromEntries(CALL.map((field, i) => [field.name, row.values[i]]));
    assert.equal(columns.environment, null);
    assert.equal(columns.condition, null, "a line without a condition has none");
    assert.equal(columns.decision, null);
    assert.equal(columns.waitedMs, null);
    assert.equal(columns.facts, null);
    assert.equal(columns.errorKind, "not-run");
});

test("empty facts are no facts", () => {
    const record = { ...callRecord(FULL, WHEN, {}), facts: {} };
    const row = parseLine(line(record));
    assert.ok(row);
    assert.equal(row.values[CALL.findIndex((field) => field.name === "facts")], null);
});

test("a field that jig-core adds later is ignored", () => {
    const record = { ...callRecord(FULL, WHEN, {}), somethingNew: [1, 2, 3] };
    assert.ok(parseLine(line(record)));
});

test("text that is not a record has no row", () => {
    const good = callRecord(FULL, WHEN, {});
    const cases: Record<string, string> = {
        "not JSON": "this is not json",
        "half a line": line(good).slice(0, 40),
        "an array": "[1, 2]",
        "a number": "42",
        null: "null",
        "an unknown kind": line({ ...good, kind: "watch" }),
        "no kind": line({ ...good, kind: undefined }),
        "no id": line({ ...good, id: undefined }),
        "no session": line({ ...good, session: undefined }),
        "no tool": line({ ...good, tool: undefined }),
        "no outcome": line({ ...good, outcome: undefined }),
        "no time": line({ ...good, time: undefined }),
        "a time that is not a time": line({ ...good, time: "yesterday" }),
        "a time that is a number": line({ ...good, time: 1793363696 }),
        "a text id": line({ ...good, id: 7 }),
        "a text where a number belongs": line({ ...good, waitedMs: "4322" }),
        "a number that is not finite": '{"kind":"call","waitedMs":1e999}',
        "facts that are not an object": line({ ...good, facts: "ok" }),
        "facts that are a list": line({ ...good, facts: [1] }),
        "a text where text belongs": line({ ...good, error: { nested: true } }),
    };
    for (const [why, text] of Object.entries(cases)) assert.equal(parseLine(text), undefined, why);
});

test("a turn without its numbers is not a turn", () => {
    const turn = turnRecord(
        { session: "s", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1 },
        WHEN,
        {},
    );
    for (const name of ["model", "input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
        assert.equal(parseLine(line({ ...turn, [name]: undefined })), undefined, name);
    }
    assert.equal(parseLine(line({ ...turn, cost: "1.5" })), undefined);
});
