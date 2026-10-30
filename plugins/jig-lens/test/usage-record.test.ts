// What a Pi session entry says about usage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageRecord } from "../src/usage-record.ts";

const at = "2026-10-08T06:30:00.000Z";

test("a model reply carries its tokens and cost, under the model that answered", () => {
    const record = usageRecord({
        type: "message",
        id: "a1",
        timestamp: at,
        message: {
            role: "assistant",
            timestamp: Date.parse(at),
            provider: "provider-a",
            model: "logical",
            responseModel: "physical",
            usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 8, cost: { total: 0.01 } },
        },
    });
    assert.deepEqual(record, {
        id: "a1",
        timestamp: Date.parse(at),
        provider: "provider-a",
        model: "physical",
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 10,
        cost: 0.01,
        type: "assistant",
    });
});

test("without a response model, the model asked for is the one shown", () => {
    const record = usageRecord({ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1 }, timestamp: 5 } });
    assert.equal(record?.model, "m");
});

test("a tool result with usage is usage too, as a subagent's work is", () => {
    const record = usageRecord({ type: "message", id: "t1", message: { role: "toolResult", timestamp: 7, usage: { input: 10, output: 4, cost: { total: 0.02 } } } });
    assert.equal(record?.type, "toolResult");
    assert.equal(record?.provider, "Tools");
    assert.equal(record?.model, "summaries");
    assert.equal(record?.cost, 0.02);
});

test("a cache refresh, a compaction and a branch summary carry usage of their own, with the time of the entry", () => {
    for (const type of ["usage", "compaction", "branch_summary"]) {
        const record = usageRecord({ type, id: type, timestamp: at, usage: { output: 5, cost: { total: 0.03 } } });
        assert.equal(record?.type, type);
        assert.equal(record?.timestamp, Date.parse(at));
        assert.equal(record?.output, 5);
    }
    assert.equal(usageRecord({ type: "usage", timestamp: at, provider: "p", model: "physical", usage: { cacheRead: 50 } })?.model, "physical");
});

test("a cost that is a plain number counts, and a cost that is missing is unknown, not zero", () => {
    assert.equal(usageRecord({ type: "usage", usage: { cost: 0.5 } })?.cost, 0.5);
    const unpriced = usageRecord({ type: "message", message: { role: "assistant", usage: { input: 10 }, timestamp: 1 } });
    assert.equal(unpriced?.cost, undefined);
    assert.equal("cost" in (unpriced ?? {}), false);
    assert.equal(usageRecord({ type: "usage", usage: { cost: { total: -1 } } })?.cost, undefined, "a negative cost is not a price");
});

test("anything that is not a measurement is zero, and an entry with no time has the time 0", () => {
    const record = usageRecord({ type: "usage", usage: { input: "100", output: -5, cacheRead: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY } });
    assert.deepEqual([record?.input, record?.output, record?.cacheRead, record?.cacheWrite, record?.timestamp], [0, 0, 0, 0, 0]);
    assert.equal(usageRecord({ type: "usage", timestamp: "not a date", usage: {} })?.timestamp, 0);
});

test("entries that are not usage give nothing", () => {
    for (const entry of [
        null, undefined, 3, "x", [], {},
        { type: "message", message: { role: "user", usage: { input: 1 } } },
        { type: "message", message: { role: "assistant" } },
        { type: "message", message: { role: "assistant", usage: "lots" } },
        { type: "session", id: "s" },
        { type: "model_change" },
        { type: "usage" },
    ]) {
        assert.equal(usageRecord(entry), undefined, JSON.stringify(entry));
    }
});
