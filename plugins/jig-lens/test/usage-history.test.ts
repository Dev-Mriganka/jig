// The usage in Pi's session files, collected and added up: forks, models, unknown prices, local days, and which files are read.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { collectHistory, periodRange, summarizeHistory } from "../src/usage-history.ts";

const stamp = "2026-10-08T06:30:00.000Z";

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "jig-lens-sessions-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return {
        root,
        async write(name: string, entries: unknown[]) {
            await mkdir(join(root, "project"), { recursive: true });
            await writeFile(join(root, "project", `${name}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));
        },
    };
}

interface Entry {
    type: string;
    id: string;
    timestamp: string;
    message: { role: string; timestamp: number; provider: string; model: string; responseModel: string; usage: Record<string, unknown> };
}

function assistant(id: string, input: number, cost: number, provider = "provider-a"): Entry {
    return {
        type: "message",
        id,
        timestamp: stamp,
        message: { role: "assistant", timestamp: Date.parse(stamp), provider, model: "logical", responseModel: "physical", usage: { input, cost: { total: cost } } },
    };
}

test("a scan that is cancelled gives nothing, and one after a file changed sees the change", async (t) => {
    const f = await fixture(t);
    await f.write("first", [assistant("a", 10, 0.01)]);
    await f.write("second", [assistant("b", 20, 0.02)]);
    const controller = new AbortController();
    await assert.rejects(collectHistory({ sessionsDir: f.root, signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
    const first = await collectHistory({ sessionsDir: f.root });
    assert.equal(summarizeHistory(first.records, "all", new Date(stamp)).tokens, 30);
    await f.write("first", [assistant("a", 100, 0.1)]);
    const second = await collectHistory({ sessionsDir: f.root });
    assert.equal(summarizeHistory(second.records, "all", new Date(stamp)).tokens, 120);
});

test("a scan that is already aborted reads nothing", async (t) => {
    const f = await fixture(t);
    await f.write("first", [assistant("a", 10, 0.01)]);
    await assert.rejects(collectHistory({ sessionsDir: f.root, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("native accounting is counted once across copied forks and model switches", async (t) => {
    const f = await fixture(t);
    const first = assistant("a", 100, 0.01);
    const prefix = [
        { ...first, message: { ...first.message, usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 8, cost: { total: 0.01 } } } },
        { type: "usage", id: "u", timestamp: stamp, provider: "provider-a", model: "physical", usage: { cacheRead: 50, cost: { total: 0.02 } } },
        { type: "compaction", id: "c", timestamp: stamp, usage: { output: 5, cost: { total: 0.03 } } },
        { type: "branch_summary", id: "s", timestamp: stamp, usage: { output: 7, cost: { total: 0.04 } } },
    ];
    await f.write("first", [{ type: "session", id: "first" }, ...prefix]);
    await f.write("fork", [{ type: "session", id: "fork" }, ...prefix.map((entry) => ({ ...entry, parentId: "rewritten" })), assistant("b", 200, 0.05, "provider-b")]);
    const history = await collectHistory({ sessionsDir: f.root });
    const summary = summarizeHistory(history.records, "all", new Date(stamp));
    assert.equal(summary.tokens, 422);
    assert.ok(Math.abs(summary.cost - 0.15) < 1e-10);
    assert.equal(summary.unknownCosts, 0);
    assert.equal(summary.records, 5);
    assert.equal(summary.models.find((model) => model.provider === "provider-b")?.model, "physical");
    assert.equal(summary.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), summary.tokens);
    assert.ok(Math.abs(summary.models.reduce((sum, model) => sum + model.cost, 0) - summary.cost) < 1e-10);
});

test("distinct requests, unknown prices and the user's own midnight are kept", async (t) => {
    const f = await fixture(t);
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Calcutta";
    t.after(() => {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    });
    const at = (entry: Entry, date: string): Entry => ({ ...entry, timestamp: date, message: { ...entry.message, timestamp: Date.parse(date) } });
    const unpaid = at(assistant("unknown", 10, 0), "2026-10-07T18:40:00Z");
    delete unpaid.message.usage.cost;
    await f.write("dates", [
        at(assistant("yesterday", 1000, 1), "2026-10-07T18:20:00Z"),
        at(assistant("same-a", 20, 0), "2026-10-07T18:35:00Z"),
        at(assistant("same-b", 20, 0.02, "provider-b"), "2026-10-07T18:35:00Z"),
        unpaid,
    ]);
    const history = await collectHistory({ sessionsDir: f.root });
    const today = summarizeHistory(history.records, "today", new Date("2026-10-08T06:30:00Z"));
    assert.equal(today.tokens, 50);
    assert.equal(today.cost, 0.02);
    assert.equal(today.unknownCosts, 1);
    assert.equal(today.buckets[0]?.tokens, 50, "India's first half hour belongs in the first local hour");
    assert.equal(today.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 50);
});

test("files last written before the period starts are not opened, and a wider scan finds them", async (t) => {
    const f = await fixture(t);
    await f.write("old", [assistant("old", 1000, 1)]);
    await f.write("new", [assistant("new", 20, 0.02)]);
    await utimes(join(f.root, "project/old.jsonl"), new Date("2026-09-01T10:00:00Z"), new Date("2026-09-01T10:00:00Z"));
    const since = +periodRange("week", new Date(stamp)).start;
    const narrow = await collectHistory({ sessionsDir: f.root, since });
    assert.equal(narrow.files, 1);
    assert.equal(narrow.older, 1);
    assert.equal(narrow.since, since);
    assert.equal(summarizeHistory(narrow.records, "all", new Date(stamp)).tokens, 20);
    const all = await collectHistory({ sessionsDir: f.root });
    assert.equal(all.files, 2);
    assert.equal(all.older, 0);
    assert.equal(summarizeHistory(all.records, "all", new Date(stamp)).tokens, 1020);
    const edge = await collectHistory({ sessionsDir: f.root, since: +new Date("2026-09-01T10:00:00Z") });
    assert.equal(edge.files, 2, "a file written exactly at the start is read");
});

test("an unreadable old file is not opened at all, so it costs no skipped-file notice", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, "project"), { recursive: true });
    await writeFile(join(f.root, "project/bad.jsonl"), "{not json\n");
    await utimes(join(f.root, "project/bad.jsonl"), new Date("2026-09-01T10:00:00Z"), new Date("2026-09-01T10:00:00Z"));
    const skipped = await collectHistory({ sessionsDir: f.root, since: +new Date(stamp) });
    assert.equal(skipped.skipped, 0);
    assert.equal(skipped.older, 1);
    assert.equal((await collectHistory({ sessionsDir: f.root })).skipped, 1);
});

test("a folder that is not there is one skipped folder, not a failure", async () => {
    const history = await collectHistory({ sessionsDir: join(tmpdir(), "jig-lens-no-such-folder") });
    assert.deepEqual([history.records, history.files, history.skipped], [[], 0, 1]);
});

test("lines that are not JSON, and files that are not session files, are skipped and counted", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, "project"), { recursive: true });
    await writeFile(join(f.root, "project/mixed.jsonl"), `${JSON.stringify(assistant("a", 5, 0.01))}\nnot json\n\n${JSON.stringify({ type: "session" })}\n`);
    await writeFile(join(f.root, "project/notes.txt"), "not a session");
    const history = await collectHistory({ sessionsDir: f.root });
    assert.equal(history.records.length, 1);
    assert.equal(history.skipped, 1, "the blank line is not counted");
    assert.equal(history.files, 1);
});

test("tool results with a details list are plain usage: the child sessions are files of their own", async (t) => {
    const f = await fixture(t);
    const report = {
        type: "message",
        id: "report",
        timestamp: stamp,
        message: {
            role: "toolResult",
            timestamp: Date.parse(stamp),
            toolName: "subagent",
            usage: { input: 100, output: 20, cost: { total: 0.03 } },
            details: { results: [{ sessionFile: "children/a.jsonl", usage: { input: 40, cost: 0.01 } }] },
        },
    };
    await f.write("parent", [report]);
    await mkdir(join(f.root, "project/children"), { recursive: true });
    await writeFile(join(f.root, "project/children/a.jsonl"), JSON.stringify(assistant("child", 40, 0.01)));
    const summary = summarizeHistory((await collectHistory({ sessionsDir: f.root })).records, "all", new Date(stamp));
    assert.equal(summary.tokens, 160);
    assert.ok(Math.abs(summary.cost - 0.04) < 1e-10);
});

test("a period is whole days on the user's clock, and a week starts on Monday", () => {
    const now = new Date(2026, 9, 8, 12, 0, 0); // Thursday 8 October 2026
    const day = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()].join("-");
    assert.equal(day(periodRange("today", now).start), "2026-10-8-0");
    assert.equal(day(periodRange("today", now).end), "2026-10-9-0");
    assert.equal(day(periodRange("week", now).start), "2026-10-5-0");
    assert.equal(day(periodRange("week", now).end), "2026-10-12-0");
    assert.equal(day(periodRange("last-week", now).start), "2026-9-28-0");
    assert.equal(day(periodRange("last-week", now).end), "2026-10-5-0");
    assert.equal(day(periodRange("30-days", now).start), "2026-9-9-0");
    assert.equal(periodRange("all", now).start.getTime(), 0);
    const sunday = new Date(2026, 9, 11, 9, 0, 0);
    assert.equal(day(periodRange("week", sunday).start), "2026-10-5-0", "Sunday belongs to the week that began on Monday");
});

test("models are added up under the name the caller maps them to, most expensive first", () => {
    const record = (model: string, cost: number, input: number) => ({ timestamp: Date.parse(stamp), provider: "p", model, input, output: 0, cacheRead: 0, cacheWrite: 0, cost, type: "assistant" });
    const names = (_provider: string, model: string) => (model === "m-1" || model === "m-2" ? { provider: "named", model: "One" } : undefined);
    const summary = summarizeHistory([record("m-1", 0.1, 10), record("m-2", 0.2, 20), record("m-3", 0.5, 5)], "all", new Date(stamp), names);
    assert.deepEqual(summary.models.map((model) => [model.provider, model.model, model.records]), [["p", "m-3", 1], ["named", "One", 2]]);
    assert.equal(summary.tokens, 35);
});
