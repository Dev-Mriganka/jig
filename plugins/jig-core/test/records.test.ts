// Records: one JSON line per call and per model turn, with every field, and never the arguments or the output.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
    callRecord, cleanFacts, cleanupRecords, formatDuration, oneLine, recordsFile, summarize, turnRecord, writeRecord,
} from "../src/records.ts";
import type { CallInput } from "../src/records.ts";
import { rawRecords, readRecords, tempState } from "./support/state.ts";

const state = tempState();
before(() => { state.start(); });
after(() => state.stop());

const NOW = new Date("2026-10-30T12:34:56.789Z");

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

describe("a call record", () => {
    test("has every field", () => {
        const record = callRecord(FULL, NOW, { JIG_PARENT_SESSION: "parent-9", JIG_AGENT_ROLE: "reviewer" });
        assert.deepEqual(Object.keys(record), [
            "id", "kind", "time", "session", "parentSession", "agentRole", "ticket",
            "tool", "action", "plugin", "environment", "environmentKind", "effect", "decision", "decisionSource",
            "approval", "answer", "waitedMs", "outcome", "errorKind", "error", "durationMs",
            "toolCallId", "parentToolCallId", "spill", "facts",
        ]);
        assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(record.kind, "call");
        assert.equal(record.time, "2026-10-30T12:34:56.789Z");
        assert.equal(record.session, "session-1");
        assert.equal(record.parentSession, "parent-9");
        assert.equal(record.agentRole, "reviewer");
        assert.equal(record.ticket, "TICKET-42");
        assert.equal(record.waitedMs, 4322, "whole milliseconds");
        assert.equal(record.durationMs, 87);
        assert.deepEqual(record.facts, { testsPassed: 12, ok: false, conclusion: "failure" });
    });

    test("every line has its own id", () => {
        const ids = new Set([callRecord(FULL, NOW, {}).id, callRecord(FULL, NOW, {}).id, turnRecord({ session: "s", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, NOW, {}).id]);
        assert.equal(ids.size, 3);
    });

    test("the role is main unless the environment says otherwise, and there is no parent session without one", () => {
        const record = callRecord(FULL, NOW, {});
        assert.equal(record.agentRole, "main");
        assert.equal("parentSession" in record, false);
        const blank = callRecord(FULL, NOW, { JIG_AGENT_ROLE: "", JIG_PARENT_SESSION: "" });
        assert.equal(blank.agentRole, "main");
        assert.equal("parentSession" in blank, false);
    });

    test("fields that do not apply are left out, not written empty", () => {
        const record = callRecord({ session: "s", tool: "read", environment: "local", environmentKind: "local", effect: "read", decision: "allow", decisionSource: "table", outcome: "ok", toolCallId: "c" }, NOW, {});
        for (const absent of ["ticket", "action", "plugin", "approval", "answer", "waitedMs", "errorKind", "error", "durationMs", "parentToolCallId", "spill", "facts", "parentSession"]) {
            assert.equal(absent in record, false, absent);
        }
    });

    test("a call that was never classified has no environment, effect or decision", () => {
        const record = callRecord({ session: "s", tool: "gone", outcome: "error", errorKind: "not-run", toolCallId: "c" }, NOW, {});
        for (const absent of ["environment", "environmentKind", "effect", "decision", "decisionSource"]) assert.equal(absent in record, false, absent);
    });

    test("empty facts are left out", () => {
        assert.equal("facts" in callRecord({ ...FULL, facts: {} }, NOW, {}), false);
    });

    test("holds no arguments and no output, even when the input carries them", () => {
        const marker = "MARKER-ARGUMENT-OR-OUTPUT-7f3a";
        const sneaky = { ...FULL, arguments: { text: marker }, args: marker, input: { x: marker }, output: marker, result: { content: [{ text: marker }] }, content: marker, details: marker } as unknown as CallInput;
        const line = JSON.stringify(callRecord(sneaky, NOW, {}));
        assert.ok(!line.includes(marker), line);
    });
});

describe("a turn record", () => {
    test("has the model, the token counts and the cost", () => {
        const record = turnRecord({ session: "session-1", ticket: "T-1", model: "claude-test-1", input: 1200, output: 300, cacheRead: 5000, cacheWrite: 700, cost: 0.0421 }, NOW, { JIG_AGENT_ROLE: "scout" });
        assert.deepEqual(Object.keys(record), ["id", "kind", "time", "session", "agentRole", "ticket", "model", "input", "output", "cacheRead", "cacheWrite", "cost"]);
        assert.equal(record.kind, "turn");
        assert.equal(record.agentRole, "scout");
        assert.deepEqual([record.model, record.input, record.output, record.cacheRead, record.cacheWrite, record.cost], ["claude-test-1", 1200, 300, 5000, 700, 0.0421]);
    });
});

describe("the error line", () => {
    test("is the first non-empty line, with white space collapsed", () => {
        assert.equal(oneLine("\n\n  remote   rejected\tthe push \nsecond line\nthird"), "remote rejected the push");
        assert.equal(oneLine(""), "");
        assert.equal(oneLine("   \n  "), "");
    });

    test("is at most 200 characters", () => {
        const line = oneLine("x".repeat(500));
        assert.equal(line.length, 200);
        assert.ok(line.endsWith("…"));
        assert.equal(oneLine("y".repeat(200)), "y".repeat(200));
    });
});

describe("facts", () => {
    const same = (text: string) => text;

    test("keep numbers, flags and short codes", () => {
        assert.deepEqual(cleanFacts({ passed: 3, failed: 0, green: true, run: "success", rate: 0.5 }, same), { passed: 3, failed: 0, green: true, run: "success", rate: 0.5 });
    });

    test("drop strings over 64 characters", () => {
        assert.deepEqual(cleanFacts({ short: "x".repeat(64), long: "x".repeat(65) }, same), { short: "x".repeat(64) });
    });

    test("drop anything that is not a number, a flag or a string", () => {
        assert.deepEqual(cleanFacts({ nested: { a: 1 }, list: [1], nothing: null, missing: undefined, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, big: 10n, fn: () => 1, ok: 1 }, same), { ok: 1 });
    });

    test("drop keys that are too long, and everything past 50", () => {
        const many = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`k${index}`, index]));
        assert.equal(Object.keys(cleanFacts(many, same) ?? {}).length, 50);
        assert.equal(cleanFacts({ ["k".repeat(65)]: 1 }, same), undefined);
    });

    test("redact string facts, in case a code is a secret", () => {
        assert.deepEqual(cleanFacts({ code: "secret-1234" }, (text) => text.replace("secret-1234", "[redacted]")), { code: "[redacted]" });
    });

    test("none left means nothing", () => {
        assert.equal(cleanFacts({}, same), undefined);
        assert.equal(cleanFacts({ x: {} }, same), undefined);
    });
});

describe("the files", () => {
    test("a line is appended to the UTC day's file, which is private", () => {
        const record = callRecord(FULL, NOW, {});
        writeRecord(record, NOW);
        writeRecord(callRecord({ ...FULL, toolCallId: "second" }, NOW, {}), NOW);
        const file = path.join(state.dir, "records", "2026-10-30.jsonl");
        assert.equal(recordsFile(NOW), file);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
        const lines = readFileSync(file, "utf8").split("\n");
        assert.equal(lines.length, 3, "two lines and the final newline");
        assert.equal((JSON.parse(lines[0] as string) as { id: string }).id, record.id);
        assert.equal((JSON.parse(lines[1] as string) as { toolCallId: string }).toolCallId, "second");
    });

    test("the day is the UTC date, whatever the local time zone", () => {
        assert.equal(path.basename(recordsFile(new Date("2026-01-01T00:00:00.000Z"))), "2026-01-01.jsonl");
        assert.equal(path.basename(recordsFile(new Date("2026-01-01T23:59:59.999Z"))), "2026-01-01.jsonl");
        assert.equal(path.basename(recordsFile(new Date("2026-01-02T00:00:00.000Z"))), "2026-01-02.jsonl");
    });

    test("old files are deleted by the day in their name, and other files are left alone", () => {
        const dir = path.join(state.dir, "records");
        mkdirSync(dir, { recursive: true });
        for (const name of ["2026-07-01.jsonl", "2026-07-31.jsonl", "2026-08-01.jsonl", "2026-10-29.jsonl", "notes.txt", "2026-7-1.jsonl"]) writeFileSync(path.join(dir, name), "{}\n");
        // 90 days before 2026-10-30 is 2026-08-01: that day is kept, the days before it are not.
        assert.equal(cleanupRecords(90, NOW), 2);
        assert.equal(existsSync(path.join(dir, "2026-07-01.jsonl")), false);
        assert.equal(existsSync(path.join(dir, "2026-07-31.jsonl")), false);
        assert.equal(existsSync(path.join(dir, "2026-08-01.jsonl")), true);
        assert.equal(existsSync(path.join(dir, "2026-10-29.jsonl")), true);
        assert.equal(existsSync(path.join(dir, "notes.txt")), true);
        assert.equal(existsSync(path.join(dir, "2026-7-1.jsonl")), true);
    });
});

describe("the summary", () => {
    test("counts calls, errors, blocked calls, questions asked, time waited and turns", () => {
        const day = new Date("2026-11-05T10:00:00.000Z");
        const call = (extra: Partial<CallInput>) => writeRecord(callRecord({ ...FULL, answer: undefined, waitedMs: undefined, approval: undefined, outcome: "ok", ...extra }, day, {}), day);
        call({});
        call({ outcome: "error" });
        call({ outcome: "blocked" });
        call({ approval: "dialog", answer: "allow", waitedMs: 1500 });
        call({ approval: "review", answer: "decline", waitedMs: 2500, outcome: "blocked" });
        writeRecord(turnRecord({ session: "s", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, day, {}), day);
        appendTruncatedLine(recordsFile(day));
        const summary = summarize(day);
        assert.equal(summary.exists, true);
        assert.deepEqual(
            [summary.calls, summary.errors, summary.blocked, summary.questions, summary.waitedMs, summary.turns],
            [5, 1, 2, 2, 4000, 1],
        );
    });

    test("a day with no records says so", () => {
        const summary = summarize(new Date("2030-01-01T00:00:00.000Z"));
        assert.equal(summary.exists, false);
        assert.equal(summary.calls, 0);
    });

    test("durations are written the way a person reads them", () => {
        assert.equal(formatDuration(850), "850 ms");
        assert.equal(formatDuration(4200), "4.2 s");
        assert.equal(formatDuration(185_000), "3 min 5 s");
        assert.equal(formatDuration(0), "0 ms");
    });
});

/** A line cut off in the middle, as a writer that was stopped would leave it. */
function appendTruncatedLine(file: string): void {
    writeFileSync(file, `${readFileSync(file, "utf8")}{"kind":"call","outc`);
}

test("the state folder holds no record text before anything is written", () => {
    assert.equal(rawRecords(path.join(state.dir, "nowhere")), "");
    assert.deepEqual(readRecords(path.join(state.dir, "nowhere")), []);
});
