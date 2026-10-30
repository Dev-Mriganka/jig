// The hooks after a tool ran: redact, mask, cap; the call's record; the turn's record; and the session's start and end.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig } from "../src/client.ts";
import type { CallClass, JigApi } from "../src/contract.ts";
import { brokenMasker } from "./support/fakes.ts";
import { start, text, textOf } from "./support/harness.ts";
import type { Harness, Result, StartOptions } from "./support/harness.ts";
import { rawRecords, tempState } from "./support/state.ts";

const state = tempState();
beforeEach(() => { state.start(); });

let h: Harness | undefined;
afterEach(async () => {
    await h?.shutdown();
    h = undefined;
    state.stop();
});
async function begin(options: StartOptions = {}): Promise<Harness> {
    h = await start(options);
    return h;
}

const CONFIG = { environments: { prod: { kind: "production" }, staging: { kind: "test" }, qa: { kind: "test", mask: true } }, secrets: { backends: ["env"] } };

/** A tool whose calls act where `env` says and read (or write, with `effect`). */
function declare(api: JigApi, extra: Partial<Parameters<JigApi["declareTool"]>[0]> = {}, tool = "fake"): void {
    api.declareTool({
        tool,
        plugin: "jig-test",
        classify: (input): CallClass => ({ environment: String(input.env ?? "local"), effect: input.effect === "write" ? "write" : "read" }),
        ...extra,
    });
}

const run = (harness: Harness, env: string, result: Result, tool = "fake") => harness.call({ tool, input: { env }, result });

describe("secrets", () => {
    test("a resolved value is removed from the text, the details and the structured content", async () => {
        process.env.JIG_TEST_SECRET = "tok-4f9a2c7e-secret";
        try {
            const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
            const value = await harness.api.secrets.resolve("env:JIG_TEST_SECRET");
            const outcome = await run(harness, "local", {
                content: [{ type: "text", text: `the token is ${value}, again ${value}` }],
                details: { echoed: value, nested: [{ deeper: `x${value}x` }] },
                structuredContent: { token: value, list: [value] },
            });
            assert.equal(textOf(outcome.final), "the token is [redacted], again [redacted]");
            assert.deepEqual(outcome.final.details, { echoed: "[redacted]", nested: [{ deeper: "x[redacted]x" }] });
            assert.deepEqual(outcome.final.structuredContent, { token: "[redacted]", list: ["[redacted]"] });
        } finally {
            delete process.env.JIG_TEST_SECRET;
        }
    });

    test("its encodings too", async () => {
        process.env.JIG_TEST_SECRET = "tok/4f9a+2c7e=secret value";
        try {
            const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
            const value = await harness.api.secrets.resolve("env:JIG_TEST_SECRET");
            const bytes = Buffer.from(value);
            const outcome = await run(harness, "local", text(`${bytes.toString("base64")} ${encodeURIComponent(value)} ${bytes.toString("hex")}`));
            assert.equal(textOf(outcome.final), "[redacted] [redacted] [redacted]");
        } finally {
            delete process.env.JIG_TEST_SECRET;
        }
    });

    test("a secret-shaped string is removed although nobody resolved it", async () => {
        const token = ["ghp", "_", "A1b2".repeat(9)].join("");
        const harness = await begin({ plugins: (api) => declare(api) });
        const outcome = await run(harness, "local", { content: [{ type: "text", text: `Authorization: token ${token}` }], details: { header: token } });
        assert.equal(textOf(outcome.final), "Authorization: token [redacted]");
        assert.deepEqual(outcome.final.details, { header: "[redacted]" });
    });

    test("the result is left untouched, and nothing is returned, when there is nothing to remove", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        const replacements: unknown[] = [];
        const handlers = harness.host.handlers.get("tool_result") ?? [];
        const original = handlers[0] as (event: never, ctx: never) => unknown;
        const event = { type: "tool_result", toolCallId: "clean-1", toolName: "fake", input: { env: "local" }, content: [{ type: "text", text: "all clear" }], details: { n: 1 }, isError: false };
        await harness.host.fire("tool_call", { toolCallId: "clean-1", toolName: "fake", input: { env: "local" } }, harness.ctx);
        replacements.push(await original(event as never, harness.ctx as never));
        assert.deepEqual(replacements, [undefined]);
    });
});

describe("the structured content", () => {
    test("is replaced along with the content, because Pi drops it otherwise", async () => {
        const token = ["gho", "_", "Z9y8".repeat(9)].join("");
        const harness = await begin({ plugins: (api) => declare(api) });
        const outcome = await run(harness, "local", { content: [{ type: "text", text: `see ${token}` }], structuredContent: { rows: [1, 2, 3], note: "kept" } });
        assert.equal(textOf(outcome.final), "see [redacted]");
        assert.deepEqual(outcome.final.structuredContent, { rows: [1, 2, 3], note: "kept" }, "still there, though only the content changed");
    });

    test("is replaced alone when only it holds the secret", async () => {
        const token = ["gho", "_", "Z9y8".repeat(9)].join("");
        const harness = await begin({ plugins: (api) => declare(api) });
        const outcome = await run(harness, "local", { content: [{ type: "text", text: "clean" }], structuredContent: { leaked: token } });
        assert.equal(textOf(outcome.final), "clean");
        assert.deepEqual(outcome.final.structuredContent, { leaked: "[redacted]" });
    });

    test("only details changed: only details are replaced", async () => {
        const token = ["gho", "_", "Z9y8".repeat(9)].join("");
        const harness = await begin({ plugins: (api) => declare(api) });
        await harness.gate({ tool: "fake", id: "d-1", input: { env: "local" } });
        const answer = await (harness.host.handlers.get("tool_result")?.[0] as (event: never, ctx: never) => unknown)(
            { type: "tool_result", toolCallId: "d-1", toolName: "fake", input: {}, content: [{ type: "text", text: "clean" }], details: { leaked: token }, structuredContent: { fine: true }, isError: false } as never,
            harness.ctx as never,
        );
        assert.deepEqual(answer, { details: { leaked: "[redacted]" } });
    });
});

describe("the mask backstop", () => {
    const personal = (value: string) => text(`customer: ${value}`);

    test("masks the text, the details and the structured content of a production read", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        const outcome = await run(harness, "prod", {
            content: [{ type: "text", text: "name PERSONAL-JANE" }],
            details: { name: "PERSONAL-JANE", list: ["PERSONAL-X"] },
            structuredContent: { name: "PERSONAL-JANE" },
        });
        assert.equal(textOf(outcome.final), "name [masked]-JANE");
        assert.deepEqual(outcome.final.details, { name: "[masked]-JANE", list: ["[masked]-X"] });
        assert.deepEqual(outcome.final.structuredContent, { name: "[masked]-JANE" });
    });

    test("applies to a test environment only when it says mask: true", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        assert.equal(textOf((await run(harness, "qa", personal("PERSONAL-A"))).final), "customer: [masked]-A");
        assert.equal(textOf((await run(harness, "staging", personal("PERSONAL-B"))).final), "customer: PERSONAL-B");
    });

    test("does not apply to local and external results", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        assert.equal(textOf((await run(harness, "local", personal("PERSONAL-C"))).final), "customer: PERSONAL-C");
        assert.equal(textOf((await run(harness, "external", personal("PERSONAL-D"))).final), "customer: PERSONAL-D");
    });

    test("leaves alone the results of a tool that masks its own", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api, { masksOwnResults: true }) });
        assert.equal(textOf((await run(harness, "prod", personal("PERSONAL-E"))).final), "customer: PERSONAL-E");
    });

    test("an environment nobody defined counts as production, so its results are masked", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        assert.equal(textOf((await run(harness, "nowhere", personal("PERSONAL-F"))).final), "customer: [masked]-F");
    });

    test("when masking fails, the result is withheld, whole and with its details", async () => {
        const harness = await begin({ config: CONFIG, masker: brokenMasker, plugins: (api) => declare(api) });
        const outcome = await run(harness, "prod", { content: [{ type: "text", text: "name PERSONAL-JANE" }], details: { name: "PERSONAL-JANE" }, structuredContent: { name: "PERSONAL-JANE" } });
        assert.equal(textOf(outcome.final), "result withheld: it could not be masked");
        assert.equal(outcome.final.isError, true);
        assert.deepEqual(outcome.final.details, {});
        assert.equal("structuredContent" in outcome.final, false);
        const [record] = harness.records();
        assert.deepEqual([record?.outcome, record?.errorKind, record?.error], ["error", "withheld", "result withheld: it could not be masked"]);
        assert.ok(!rawRecords(state.dir).includes("PERSONAL"));
    });

    test("the masker that ships turns an email in a production result into a token", async () => {
        const { createMasker } = await import("../src/mask/index.ts");
        const harness = await begin({ config: CONFIG, masker: createMasker(new Uint8Array(32).fill(7)), plugins: (api) => declare(api) });
        assert.match(textOf((await run(harness, "prod", personal("jane.doe@example.com"))).final), /^customer: email#[0-9a-f]{6}$/);
        assert.equal(textOf((await run(harness, "local", personal("jane.doe@example.com"))).final), "customer: jane.doe@example.com", "local results do not need it");
    });

    test("an image cannot be masked, so it does not pass", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        const outcome = await run(harness, "prod", { content: [{ type: "text", text: "fine" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
        assert.equal(outcome.final.content.length, 2);
        assert.deepEqual(outcome.final.content[1], { type: "text", text: "[image withheld: images cannot be masked]" });
        const local = await run(harness, "local", { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
        assert.equal(local.final.content[0]?.type, "image");
    });

    test("secrets are removed before masking, and a result with no call on file counts as production", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        const token = ["gho", "_", "Z9y8".repeat(9)].join("");
        const answer = await (harness.host.handlers.get("tool_result")?.[0] as (event: never, ctx: never) => Promise<{ content?: Array<{ text: string }> } | undefined>)(
            { type: "tool_result", toolCallId: "never-decided", toolName: "fake", input: {}, content: [{ type: "text", text: `PERSONAL-H ${token}` }], details: undefined, isError: false } as never,
            harness.ctx as never,
        );
        assert.equal(answer?.content?.[0]?.text, "[masked]-H [redacted]");
    });
});

describe("a result that cannot be checked", () => {
    test("is withheld, not passed through, when it cannot be redacted", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        const loop: Record<string, unknown> = { text: "x" };
        loop.self = loop;
        const outcome = await run(harness, "local", { content: [{ type: "text", text: "visible" }], details: loop });
        assert.equal(textOf(outcome.final), "result withheld: it could not be redacted");
        assert.equal(outcome.final.isError, true);
        assert.equal(harness.records()[0]?.errorKind, "withheld");
    });
});

describe("long results", () => {
    const long = (n: number) => Array.from({ length: Math.ceil(n / 3) }, (_, i) => `${i},`).join("").padEnd(n, "~").slice(0, n);

    test("are cut to 8 000 characters with a pointer, and the whole text goes to a private file", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        const full = long(60_000);
        const outcome = await harness.call({ tool: "fake", id: "long-1", input: { env: "local" }, result: text(full) });
        const shown = textOf(outcome.final);
        assert.ok(shown.startsWith(full.slice(0, 8000)));
        const file = path.join(state.dir, "spill", "session-test", "long-1.txt");
        assert.ok(shown.includes(file) && /read it with the read tool/.test(shown));
        assert.equal(readFileSync(file, "utf8"), full);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(harness.records()[0]?.spill, file);
    });

    test("are masked and redacted first, so the file holds what the model would have seen", async () => {
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", id: "long-2", input: { env: "prod" }, result: text(`PERSONAL-NAME ${long(60_000)}`) });
        const file = path.join(state.dir, "spill", "session-test", "long-2.txt");
        const saved = readFileSync(file, "utf8");
        assert.ok(saved.startsWith("[masked]-NAME "));
        assert.ok(!saved.includes("PERSONAL"));
        assert.ok(textOf(outcome.final).startsWith("[masked]-NAME "));
    });

    test("keep their structured content", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        const outcome = await run(harness, "local", { content: [{ type: "text", text: long(60_000) }], structuredContent: { rows: [1, 2] } });
        assert.deepEqual(outcome.final.structuredContent, { rows: [1, 2] });
    });

    test("are left alone for Pi's own tools, which cut their output themselves", async () => {
        const harness = await begin({ ui: false });
        const outcome = await harness.call({ tool: "bash", result: text(long(60_000)) });
        assert.equal(textOf(outcome.final).length, 60_000);
        assert.ok(!existsSync(path.join(state.dir, "spill")));
    });
});

describe("the record of a call", () => {
    test("an ordinary call", async () => {
        const harness = await begin({ plugins: (api) => declare(api, { plugin: "jig-test" }) });
        harness.api.setTicket("TICKET-7");
        await harness.call({ tool: "fake", id: "r-1", input: { env: "local" }, result: text("fine"), durationMs: 12 });
        const [record] = harness.records();
        assert.deepEqual(
            { ...record, id: "-", time: "-" },
            {
                id: "-", kind: "call", time: "-", session: "session-test", agentRole: "main", ticket: "TICKET-7",
                tool: "fake", plugin: "jig-test", environment: "local", environmentKind: "local", effect: "read",
                decision: "allow", decisionSource: "table", outcome: "ok", durationMs: 12, toolCallId: "r-1",
            },
        );
    });

    test("a call that asked records the question, the answer and the wait", async () => {
        const harness = await begin({ plugins: (api) => declare(api), ui: { select: () => "Allow for this session" } });
        await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        const [record] = harness.records();
        assert.deepEqual([record?.decision, record?.decisionSource, record?.approval, record?.answer, record?.outcome], ["ask", "table", "dialog", "allow-session", "ok"]);
        assert.equal(typeof record?.waitedMs, "number");
    });

    test("a blocked call", async () => {
        const harness = await begin({ plugins: (api) => declare(api), ui: false });
        await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        const [record] = harness.records();
        assert.deepEqual([record?.outcome, record?.errorKind, record?.decision, record?.decisionSource], ["blocked", "no-screen", "deny", "floor"]);
        assert.match(record?.error, /no screen to ask on/);
        assert.equal("durationMs" in (record ?? {}), false, "it never ran");
    });

    test("a tool that failed: its kind and one line of the error", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", input: { env: "local" }, run: () => { throw new Error("connection refused\nsecond line\nthird"); } });
        assert.equal(outcome.final.isError, true);
        const [record] = harness.records();
        assert.deepEqual([record?.outcome, record?.errorKind, record?.error], ["error", "tool", "connection refused"]);
    });

    test("the error line is redacted, masked in production, and at most 200 characters", async () => {
        const token = ["gho", "_", "Z9y8".repeat(9)].join("");
        const harness = await begin({ config: CONFIG, plugins: (api) => declare(api) });
        await harness.call({ tool: "fake", input: { env: "local" }, run: () => { throw new Error(`failed with ${token}`); } });
        await harness.call({ tool: "fake", input: { env: "prod" }, run: () => { throw new Error("no customer PERSONAL-Z"); } });
        await harness.call({ tool: "fake", input: { env: "local" }, run: () => { throw new Error("x".repeat(500)); } });
        const [local, prod, longError] = harness.records();
        assert.equal(local?.error, "failed with [redacted]");
        assert.equal(prod?.error, "no customer [masked]-Z");
        assert.equal(longError?.error.length, 200);
    });

    test("a call that never reached the manager (an unknown tool, bad arguments) keeps only its kind", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        // Pi reports the failure without calling the tool_call hook.
        await harness.host.fire("tool_execution_end", { toolCallId: "never-seen", toolName: "ghost", result: text('Validation failed. Received arguments: {"secret":"ARGS-MARKER"}'), isError: true }, harness.ctx);
        const [record] = harness.records();
        assert.deepEqual([record?.tool, record?.outcome, record?.errorKind], ["ghost", "error", "not-run"]);
        for (const absent of ["environment", "effect", "decision", "error"]) assert.equal(absent in (record ?? {}), false, absent);
        assert.ok(!rawRecords(state.dir).includes("ARGS-MARKER"));
    });

    test("a nested call carries its parent's id", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        await harness.call({ tool: "fake", id: "outer/1", parent: "outer", input: { env: "local" } });
        assert.deepEqual([harness.records()[0]?.toolCallId, harness.records()[0]?.parentToolCallId], ["outer/1", "outer"]);
    });

    test("facts from the tool are kept when short and plain, and dropped otherwise", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        await harness.call({
            tool: "fake", id: "f-1", input: { env: "local" },
            run: () => { jig().addFacts("f-1", { passed: 3, failed: 0, ok: true, conclusion: "success", long: "x".repeat(65) }); jig().addFacts("f-1", { later: 1 }); },
        });
        assert.deepEqual(harness.records()[0]?.facts, { passed: 3, failed: 0, ok: true, conclusion: "success", later: 1 });
    });

    test("facts added to a call that has ended go nowhere", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        await harness.call({ tool: "fake", id: "f-2", input: { env: "local" } });
        harness.api.addFacts("f-2", { late: true });
        harness.api.addFacts("unknown-call", { late: true });
        assert.equal("facts" in (harness.records()[0] ?? {}), false);
    });

    test("the parent session and the role come from the environment", async () => {
        process.env.JIG_PARENT_SESSION = "parent-session-1";
        process.env.JIG_AGENT_ROLE = "reviewer";
        try {
            const harness = await begin({ plugins: (api) => declare(api) });
            await harness.call({ tool: "fake", input: { env: "local" } });
            assert.deepEqual([harness.records()[0]?.parentSession, harness.records()[0]?.agentRole], ["parent-session-1", "reviewer"]);
        } finally {
            delete process.env.JIG_PARENT_SESSION;
            delete process.env.JIG_AGENT_ROLE;
        }
    });

    test("a tool from another package is labelled with where it came from", async () => {
        const harness = await begin({ ui: false, tools: [{ name: "viewer", annotations: { readOnlyHint: true }, sourceInfo: { source: "npm:some-package" } }] });
        await harness.call({ tool: "viewer" });
        assert.equal(harness.records()[0]?.plugin, "npm:some-package");
    });

    test("when the record cannot be written, the call is not harmed and /jig can say so", async () => {
        const harness = await begin({ plugins: (api) => declare(api) });
        const blocker = path.join(state.dir, "in-the-way");
        writeFileSync(blocker, "a file where a folder should be");
        const saved = process.env.JIG_STATE_DIR;
        process.env.JIG_STATE_DIR = path.join(blocker, "state");
        try {
            const outcome = await harness.call({ tool: "fake", input: { env: "local" }, result: text("still fine") });
            assert.equal(textOf(outcome.final), "still fine");
        } finally {
            process.env.JIG_STATE_DIR = saved;
        }
        const status = await runCommand(harness, "");
        assert.match(status, /Records: the last write failed/);
    });
});

describe("the record of a turn", () => {
    const turn = (usage: unknown, extra: Record<string, unknown> = {}) => ({ turnIndex: 0, message: { role: "assistant", model: "claude-test-1", usage, ...extra }, toolResults: [] });

    test("holds the model, the tokens and the cost", async () => {
        const harness = await begin();
        harness.api.setTicket("T-9");
        await harness.host.fire("turn_end", turn({ input: 1200, output: 300, cacheRead: 5000, cacheWrite: 700, totalTokens: 7200, cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 } }), harness.ctx);
        const [record] = harness.records();
        assert.deepEqual(
            { ...record, id: "-", time: "-" },
            { id: "-", kind: "turn", time: "-", session: "session-test", agentRole: "main", ticket: "T-9", model: "claude-test-1", input: 1200, output: 300, cacheRead: 5000, cacheWrite: 700, cost: 0.037 },
        );
    });

    test("is written for every turn, and only for assistant messages", async () => {
        const harness = await begin();
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
        await harness.host.fire("turn_end", turn(usage), harness.ctx);
        await harness.host.fire("turn_end", turn(usage), harness.ctx);
        await harness.host.fire("turn_end", { turnIndex: 2, message: { role: "custom", content: "x" }, toolResults: [] }, harness.ctx);
        assert.equal(harness.records().filter((record) => record.kind === "turn").length, 2);
    });

    test("a turn with unusable usage data does not break the session", async () => {
        const harness = await begin();
        await assert.doesNotReject(harness.host.fire("turn_end", turn(undefined), harness.ctx));
        assert.equal(harness.records().length, 0);
    });
});

describe("starting and ending a session", () => {
    test("old records, spill files and preview pages are removed when the session starts", async () => {
        const day = 24 * 60 * 60 * 1000;
        const records = path.join(state.dir, "records");
        const spill = path.join(state.dir, "spill", "old-session");
        const previews = path.join(state.dir, "previews");
        for (const dir of [records, spill, previews]) mkdirSync(dir, { recursive: true });
        const oldRecord = path.join(records, "2020-01-01.jsonl");
        const oldSpill = path.join(spill, "a.txt");
        const oldPreview = path.join(previews, "p.html");
        for (const file of [oldRecord, oldSpill, oldPreview]) writeFileSync(file, "x");
        for (const file of [oldSpill, oldPreview]) utimesSync(file, new Date(Date.now() - 30 * day), new Date(Date.now() - 30 * day));
        await begin();
        for (const file of [oldRecord, oldSpill, oldPreview]) assert.equal(existsSync(file), false, file);
    });

    test("the retention in configuration is used", async () => {
        const records = path.join(state.dir, "records");
        mkdirSync(records, { recursive: true });
        const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        writeFileSync(path.join(records, `${recent}.jsonl`), "{}\n");
        await begin({ config: { records: { retentionDays: 5 } } });
        assert.equal(existsSync(path.join(records, `${recent}.jsonl`)), false, "ten days old, kept for five");
    });

    test("problems in the file are shown once, with the file and the key, when there is a screen", async () => {
        const harness = await begin({ config: { rule: [], records: { retentionDays: 0 } } });
        const [note] = harness.notifications();
        assert.match(note ?? "", /jig-core: 2 configuration problems/);
        assert.match(note ?? "", /jig\.json: rule: is not a known field/);
        assert.match(note ?? "", /jig\.json: records\.retentionDays:/);
        assert.equal(harness.notifications().length, 1);
        assert.equal(harness.ui.notifications[0]?.type, "error");
    });

    test("with no screen nothing is shown, and the defaults apply", async () => {
        const harness = await begin({ config: { rule: [] }, ui: false });
        assert.deepEqual(harness.notifications(), []);
        assert.equal((await harness.call({ tool: "read" })).blocked, false);
    });

    test("a long list of problems is cut short", async () => {
        const harness = await begin({ config: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`bad${index}`, 1])) });
        const [note] = harness.notifications();
        assert.match(note ?? "", /jig-core: 9 configuration problems/);
        assert.match(note ?? "", /and 4 more \(see \/jig\)/);
    });

    test("the API is withdrawn at shutdown, and shutting down twice does no harm", async () => {
        const harness = await begin();
        assert.doesNotThrow(() => jig());
        await harness.host.fire("session_shutdown", { reason: "reload" }, harness.ctx);
        assert.throws(() => jig(), /jig-core is not loaded/);
        await assert.doesNotReject(harness.host.fire("session_shutdown", { reason: "quit" }, harness.ctx));
    });

    test("an API published by a newer jig-core is not withdrawn by an older one shutting down late", async () => {
        const first = await begin();
        const newer = await start();
        await first.host.fire("session_shutdown", { reason: "reload" }, first.ctx);
        assert.doesNotThrow(() => jig(), "the newer API stays");
        await newer.shutdown();
    });
});

/** Runs `/jig <args>` and returns what it showed. */
async function runCommand(harness: Harness, args: string): Promise<string> {
    const command = harness.host.commands.get("jig");
    assert.ok(command);
    await command.handler(args, harness.ctx as never);
    return [...harness.ui.notifications.map((entry) => entry.message), ...harness.ui.selects.map((entry) => entry.options.join("\n"))].join("\n---\n");
}
