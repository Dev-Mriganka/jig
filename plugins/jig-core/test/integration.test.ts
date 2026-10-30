// jig-core inside a real Pi session: the SDK with its scripted model, the real tool registry, the real hooks, and a few
// fake tools. Each test starts its own session.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { jig } from "../src/client.ts";
import { brokenMasker, fakeTerminal } from "./support/fakes.ts";
import type { FakeUiScript } from "./support/fakes.ts";
import { startWorld } from "./support/session.ts";
import type { World, WorldOptions } from "./support/session.ts";
import { rawRecords, tempState } from "./support/state.ts";

const state = tempState();
beforeEach(() => {
    state.start();
});

let world: World | undefined;
afterEach(async () => {
    await world?.close();
    world = undefined;
    state.stop();
});
async function begin(options: WorldOptions = {}): Promise<World> {
    world = await startWorld(options);
    return world;
}

const CONFIG = {
    environments: { prod: { kind: "production" }, staging: { kind: "test" }, qa: { kind: "test", mask: true } },
    secrets: { backends: ["env"] },
};
const ALLOW: FakeUiScript = { select: () => "Allow" };

describe("writes", () => {
    test("a production write is blocked, even with a personal rule that tries to allow it", async () => {
        const rule = { tool: "fake_tool", environment: "prod", effect: "write", decision: "allow" };
        const w = await begin({ config: { ...CONFIG, rules: [rule] }, ui: ALLOW });
        // The rule was refused when the file loaded, and the user was told.
        assert.equal(w.ui?.notifications.length, 1);
        assert.match(
            w.ui?.notifications[0]?.message ?? "",
            /jig\.json: rules\[0\]\.decision:.*production writes.*always denied/,
        );

        const result = await w.call("fake_tool", { env: "prod", effect: "write", action: "wipe" });
        assert.equal(result.isError, true);
        assert.equal(result.text, "Blocked by jig-core: writes to production are never allowed.");
        assert.deepEqual(w.log.executed, [], "the tool never ran");
        assert.equal(w.ui?.selects.length, 0, "and nobody was asked");

        const [record] = w.callRecords();
        assert.deepEqual(
            [
                record?.tool,
                record?.action,
                record?.environment,
                record?.environmentKind,
                record?.effect,
                record?.decision,
                record?.decisionSource,
                record?.outcome,
                record?.errorKind,
            ],
            ["fake_tool", "wipe", "prod", "production", "write", "deny", "floor", "blocked", "denied"],
        );
        assert.deepEqual(
            w.log.decisions.map((d) => [d.decision, d.source]),
            [["deny", "floor"]],
        );
    });

    test("an external write with no screen is blocked", async () => {
        const w = await begin({ config: CONFIG });
        const result = await w.call("fake_tool", { env: "external", effect: "write" });
        assert.equal(result.isError, true);
        assert.equal(result.text, "Blocked by jig-core: this call needs approval and there is no screen to ask on.");
        assert.deepEqual(w.log.executed, []);
        assert.deepEqual(
            w.callRecords().map((r) => [r.outcome, r.errorKind, r.decisionSource]),
            [["blocked", "no-screen", "floor"]],
        );
    });

    test("an external write that the user allows runs, and the record shows the question and the wait", async () => {
        const w = await begin({ config: CONFIG, ui: ALLOW });
        const result = await w.call("fake_tool", {
            env: "external",
            effect: "write",
            action: "push",
            output: "pushed",
        });
        assert.equal(result.isError, false);
        assert.match(result.text, /^pushed/);
        assert.equal(w.log.executed.length, 1);
        assert.match(w.ui?.selects[0]?.title ?? "", /^fake_tool · push · external · write\nfake_tool push in external/);
        const [record] = w.callRecords();
        assert.deepEqual(
            [record?.decision, record?.decisionSource, record?.approval, record?.answer, record?.outcome],
            ["ask", "table", "dialog", "allow", "ok"],
        );
        assert.equal(typeof record?.waitedMs, "number");
        assert.equal(typeof record?.durationMs, "number");
        assert.deepEqual(
            w.log.decisions.map((d) => [d.decision, d.answer]),
            [["ask", "allow"]],
        );
    });

    test("a declined call is blocked with the user's reason, which the record does not keep", async () => {
        const w = await begin({ config: CONFIG, ui: { select: () => "Decline", input: () => "the branch is wrong" } });
        const result = await w.call("fake_tool", { env: "external", effect: "write", marker: "ARGUMENT-MARKER-1" });
        assert.equal(result.isError, true);
        assert.equal(result.text, "Blocked by jig-core: the user declined this call, and said: the branch is wrong");
        assert.deepEqual(w.log.executed, []);
        assert.deepEqual(
            w.callRecords().map((r) => [r.outcome, r.errorKind, r.answer]),
            [["blocked", "declined", "decline"]],
        );
        const raw = rawRecords(state.dir);
        assert.ok(!raw.includes("the branch is wrong") && !raw.includes("ARGUMENT-MARKER-1"));
    });

    test("Allow for this session asks once for the same tool, action and environment", async () => {
        let asked = 0;
        const w = await begin({
            config: CONFIG,
            ui: {
                select: () => {
                    asked++;
                    return "Allow for this session";
                },
            },
        });
        for (let i = 0; i < 3; i++) await w.call("fake_tool", { env: "external", effect: "write", action: "push" });
        assert.equal(asked, 1);
        assert.deepEqual(
            w.callRecords().map((r) => [r.decisionSource, r.answer]),
            [
                ["table", "allow-session"],
                ["session", undefined],
                ["session", undefined],
            ],
        );
        await w.call("fake_tool", { env: "external", effect: "write", action: "force-push" });
        assert.equal(asked, 2);
    });

    test("two writes asked together are asked one at a time", async () => {
        const w = await begin({
            config: CONFIG,
            ui: {
                select: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return "Allow";
                },
            },
        });
        const results = await w.calls([
            { name: "fake_tool", args: { env: "external", effect: "write", action: "a" } },
            { name: "fake_tool", args: { env: "external", effect: "write", action: "b" } },
            { name: "fake_tool", args: { env: "staging", effect: "write", action: "c" } },
        ]);
        assert.deepEqual(
            results.map((r) => r.isError),
            [false, false, false],
        );
        assert.equal(w.ui?.maxActive, 1);
        assert.equal(w.ui?.selects.length, 3);
    });

    test("the review screen shows a preview with a body, and the tool can read what was approved", async () => {
        const custom: FakeUiScript["custom"] = (factory) =>
            new Promise((resolve) => {
                const terminal = fakeTerminal();
                const component = factory(terminal.tui, terminal.theme, terminal.keybindings, resolve) as Component;
                assert.match(component.render(80).join("\n"), /fake_tool run in external/);
                assert.match(component.render(80).join("\n"), /the long body/);
                component.handleInput?.("y");
            });
        const w = await begin({ config: CONFIG, mode: "tui", ui: { custom } });
        const result = await w.call("fake_tool", {
            env: "external",
            effect: "write",
            body: "the long body",
            readPreview: true,
        });
        assert.equal(result.isError, false);
        assert.deepEqual((result.details as { approved?: unknown }).approved, {
            summary: "fake_tool run in external",
            body: "the long body",
            format: "text",
            fingerprint: "fp-test",
        });
        assert.equal(w.ui?.customs, 1);
        assert.equal(w.callRecords()[0]?.approval, "review");
    });

    test("built-in tools: a write in the working folder is local, so it is allowed", async () => {
        const w = await begin({ config: CONFIG });
        const result = await w.call("write", { path: "note.txt", content: "hello\n" });
        assert.equal(result.isError, false, result.text);
        assert.equal(readFileSync(path.join(w.cwd, "note.txt"), "utf8"), "hello\n");
        const read = await w.call("read", { path: "note.txt" });
        assert.match(read.text, /hello/);
        assert.deepEqual(
            w.callRecords().map((r) => [r.tool, r.environment, r.effect, r.decision, r.plugin]),
            [
                ["write", "local", "write", "allow", "builtin"],
                ["read", "local", "read", "allow", "builtin"],
            ],
        );
    });
});

describe("tools nobody classified", () => {
    test("ask until classified, and run when allowed", async () => {
        const w = await begin({ config: CONFIG, ui: ALLOW });
        const result = await w.call("mystery_tool");
        assert.equal(result.isError, false);
        assert.match(
            w.ui?.selects[0]?.title ?? "",
            /mystery_tool \(not classified, so treated as a write outside this machine\)/,
        );
        assert.deepEqual(
            [w.callRecords()[0]?.decisionSource, w.callRecords()[0]?.environment],
            ["unknown", "external"],
        );
    });

    test("with no screen they are blocked, and a wildcard rule cannot allow them", async () => {
        const w = await begin({ config: { ...CONFIG, rules: [{ tool: "*", decision: "allow" }] } });
        assert.equal((await w.call("mystery_tool")).isError, true);
        assert.equal(w.log.executed.length, 0);
    });

    test("a rule that names the tool can allow it", async () => {
        const w = await begin({ config: { ...CONFIG, rules: [{ tool: "mystery_tool", decision: "allow" }] } });
        assert.equal((await w.call("mystery_tool")).isError, false);
        assert.equal(w.callRecords()[0]?.decisionSource, "rule");
    });

    test("a tool's hints classify it: read-only runs, destructive asks", async () => {
        const w = await begin({ config: CONFIG });
        assert.equal((await w.call("viewer_tool")).isError, false);
        assert.equal((await w.call("editor_tool")).isError, true, "a write outside the machine, with no screen");
        assert.deepEqual(
            w.callRecords().map((r) => [r.tool, r.environment, r.effect]),
            [
                ["viewer_tool", "external", "read"],
                ["editor_tool", "external", "write"],
            ],
        );
    });

    test("a classification rule in configuration classifies it by a parameter", async () => {
        const config = {
            ...CONFIG,
            classify: [{ tool: "mystery_tool", param: "env", value: "prod", environment: "prod", effect: "read" }],
        };
        const w = await begin({ config });
        assert.equal((await w.call("mystery_tool", { env: "prod" })).isError, false);
        assert.deepEqual([w.callRecords()[0]?.environment, w.callRecords()[0]?.decisionSource], ["prod", "table"]);
    });
});

describe("results", () => {
    test("a production read is masked by the backstop, in the text, the details and the structured content", async () => {
        const w = await begin({ config: CONFIG });
        const result = await w.call("fake_tool", {
            env: "prod",
            effect: "read",
            output: "customer PERSONAL-JANE",
            marker: "PERSONAL-IN-DETAILS",
        });
        assert.equal(result.isError, false);
        assert.match(result.text, /^customer \[masked\]-JANE/);
        assert.ok(!result.text.includes("PERSONAL"));
        assert.equal((result.details as { marker: string }).marker, "[masked]-IN-DETAILS");
        assert.deepEqual(result.ended?.result.structuredContent, { text: "customer [masked]-JANE" });
        assert.ok(!rawRecords(state.dir).includes("PERSONAL"));
    });

    test("a test environment is masked only when configured to be", async () => {
        const w = await begin({ config: CONFIG });
        assert.match((await w.call("fake_tool", { env: "qa", output: "x PERSONAL-1" })).text, /\[masked\]-1/);
        assert.match((await w.call("fake_tool", { env: "staging", output: "x PERSONAL-2" })).text, /PERSONAL-2/);
        assert.match((await w.call("fake_tool", { env: "local", output: "x PERSONAL-3" })).text, /PERSONAL-3/);
    });

    test("a tool that masks its own results is left alone", async () => {
        const w = await begin({ config: CONFIG });
        assert.match((await w.call("own_masker", { env: "prod", output: "own PERSONAL-4" })).text, /PERSONAL-4/);
    });

    test("when masking fails the result is withheld", async () => {
        const w = await begin({ config: CONFIG, masker: brokenMasker });
        const result = await w.call("fake_tool", {
            env: "prod",
            output: "customer PERSONAL-JANE",
            marker: "PERSONAL-IN-DETAILS",
        });
        assert.equal(result.isError, true);
        assert.equal(result.text, "result withheld: it could not be masked");
        assert.deepEqual(result.details, {});
        assert.equal(result.ended?.result.structuredContent, undefined);
        assert.deepEqual(
            w.callRecords().map((r) => [r.outcome, r.errorKind]),
            [["error", "withheld"]],
        );
    });

    test("the masker that ships turns personal data in a production result into tokens, and leaves local results alone", async () => {
        const w = await begin({ config: CONFIG, realMasker: true });
        const production = await w.call("fake_tool", { env: "prod", output: "customer jane.doe@example.com" });
        assert.equal(production.isError, false);
        assert.match(production.text, /^customer email#[0-9a-f]{6}/);
        assert.ok(!production.text.includes("jane.doe@example.com"));
        const local = await w.call("fake_tool", { env: "local", output: "customer jane.doe@example.com" });
        assert.equal(local.isError, false);
        assert.match(local.text, /^customer jane\.doe@example\.com/);
    });

    test("a secret value that a tool puts in its result is removed, with its encodings", async () => {
        const w = await begin({ config: CONFIG, env: { JIG_TEST_SECRET: "sup3r-s3cret/value+1" } });
        const result = await w.call("fake_tool", { env: "local", secretRef: "env:JIG_TEST_SECRET" });
        assert.equal(result.isError, false);
        assert.match(result.text, /secret=\[redacted\]/);
        assert.ok(!result.text.includes("sup3r-s3cret"));
        assert.equal((result.details as { echo: string }).echo, "[redacted]");
        assert.deepEqual(result.ended?.result.structuredContent, { text: "ok secret=[redacted]" });
        assert.ok(!rawRecords(state.dir).includes("sup3r-s3cret"));
        // And it stays hidden from later results, until Pi exits.
        const later = await w.call("fake_tool", {
            env: "local",
            output: `printed sup3r-s3cret/value+1 and ${Buffer.from("sup3r-s3cret/value+1").toString("base64")}`,
        });
        assert.equal(later.text, "printed [redacted] and [redacted]");
    });

    test("a backend that is not enabled gives a clear error", async () => {
        const w = await begin({ config: { secrets: { backends: ["pass"] } }, env: { JIG_TEST_SECRET: "x" } });
        const result = await w.call("fake_tool", { env: "local", secretRef: "env:JIG_TEST_SECRET" });
        assert.equal(result.isError, true);
        assert.match(result.text, /the env secret backend is not enabled: add "env" to secrets\.backends/);
    });

    test("a very long result is cut for the model and saved in full", async () => {
        const w = await begin({ config: CONFIG });
        const full = Array.from({ length: 30_000 }, (_, i) => `${i},`).join("");
        const result = await w.call("fake_tool", { env: "local", output: full }, "long-call");
        const file = w.callRecords()[0]?.spill as string;
        assert.equal(path.dirname(path.dirname(file)), path.join(w.stateDir, "spill"));
        assert.equal(path.basename(file), "long-call.txt");
        assert.ok(result.text.length < 9_500, String(result.text.length));
        assert.ok(result.text.startsWith(full.slice(0, 8000)));
        assert.ok(result.text.includes(file) && result.text.includes("read it with the read tool"));
        assert.ok(readFileSync(file, "utf8").startsWith(full.slice(0, 10_000)));
        assert.equal(statSync(file).mode & 0o777, 0o600);
    });
});

describe("nested calls", () => {
    test("go through the same hooks, and are recorded with their parent's id", async () => {
        const w = await begin({ config: CONFIG, ui: ALLOW });
        const result = await w.call("outer_tool", { env: "external", effect: "write" }, "outer-1");
        assert.equal(result.isError, false);
        assert.match(result.text, /^outer saw: nested output/);
        const records = w.callRecords();
        assert.deepEqual(
            records.map((r) => [r.toolCallId, r.parentToolCallId, r.tool, r.decision, r.outcome]),
            [
                ["outer-1/1", "outer-1", "fake_tool", "ask", "ok"],
                ["outer-1", undefined, "outer_tool", "allow", "ok"],
            ],
        );
        assert.match(
            w.ui?.selects[0]?.title ?? "",
            /fake_tool · inner · external · write/,
            "the nested call asked like any other",
        );
    });

    test("a nested production write is blocked, and the outer tool sees the error", async () => {
        const w = await begin({ config: CONFIG, ui: ALLOW });
        const result = await w.call("outer_tool", { env: "prod", effect: "write" }, "outer-2");
        assert.match(result.text, /^outer saw: ERROR Blocked by jig-core: writes to production are never allowed\./);
        assert.deepEqual(
            w.log.executed.map((e) => e.tool),
            ["outer_tool"],
            "the nested tool never ran",
        );
        const nested = w.callRecords().find((r) => r.toolCallId === "outer-2/1");
        assert.deepEqual(
            [nested?.parentToolCallId, nested?.outcome, nested?.errorKind, nested?.decisionSource],
            ["outer-2", "blocked", "denied", "floor"],
        );
    });
});

describe("failures", () => {
    test("a tool that throws is recorded as an error, with one line", async () => {
        const w = await begin({ config: CONFIG });
        const result = await w.call("fake_tool", { env: "local", fail: true, marker: "ARGUMENT-MARKER-2" });
        assert.equal(result.isError, true);
        assert.match(result.text, /fake tool failed: boom/);
        const [record] = w.callRecords();
        assert.deepEqual(
            [record?.outcome, record?.errorKind, record?.error, record?.decision],
            ["error", "tool", "fake tool failed: boom", "allow"],
        );
        assert.ok(!rawRecords(state.dir).includes("ARGUMENT-MARKER-2"));
    });

    test("a call Pi itself rejects (an unknown tool, bad arguments) is recorded with only its kind", async () => {
        const w = await begin({ config: CONFIG });
        const missing = await w.call("no_such_tool", { secret: "ARGS-MARKER-3" });
        assert.equal(missing.isError, true);
        const invalid = await w.call("fake_tool", { fail: "not a boolean", marker: "ARGS-MARKER-4" } as never);
        assert.equal(invalid.isError, true);
        const records = w.callRecords();
        assert.deepEqual(
            records.map((r) => [r.tool, r.outcome, r.errorKind]),
            [
                ["no_such_tool", "error", "not-run"],
                ["fake_tool", "error", "not-run"],
            ],
        );
        assert.ok(!rawRecords(state.dir).includes("ARGS-MARKER"));
    });
});

describe("records", () => {
    test("every call and every turn gets a line, and every line has its own id", async () => {
        const w = await begin({ config: CONFIG, ui: ALLOW });
        await w.call("fake_tool", { env: "local" });
        await w.call("fake_tool", { env: "external", effect: "write" });
        await w.call("fake_tool", { env: "prod", effect: "write" });
        await w.call("fake_tool", { env: "local", fail: true });
        await w.calls([
            { name: "viewer_tool", args: {} },
            { name: "fake_tool", args: { env: "staging" } },
        ]);
        const records = w.records();
        const calls = records.filter((r) => r.kind === "call");
        const turns = records.filter((r) => r.kind === "turn");
        assert.equal(calls.length, 6, "one line per tool call");
        const assistantMessages = w.session.messages.filter((message) => message.role === "assistant").length;
        assert.equal(turns.length, assistantMessages, "one line per model turn");
        assert.equal(new Set(records.map((r) => r.id)).size, records.length);
        assert.ok(records.every((r) => r.session === w.session.sessionId && r.agentRole === "main"));
        assert.deepEqual(
            calls.map((r) => r.outcome),
            ["ok", "ok", "blocked", "error", "ok", "ok"],
        );
        for (const turn of turns) {
            assert.equal(turn.model, "faux-1");
            for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"])
                assert.equal(typeof turn[field], "number", field);
        }
    });

    test("never hold the arguments or the output of a call", async () => {
        const w = await begin({ config: CONFIG, ui: ALLOW });
        await w.call("fake_tool", {
            env: "external",
            effect: "write",
            output: "OUTPUT-MARKER-5",
            marker: "ARGUMENT-MARKER-6",
            body: "BODY-MARKER-7",
        });
        await w.call("fake_tool", { env: "local", output: "OUTPUT-MARKER-8", marker: "ARGUMENT-MARKER-9", fail: true });
        const raw = rawRecords(state.dir);
        for (const marker of ["OUTPUT-MARKER", "ARGUMENT-MARKER", "BODY-MARKER"])
            assert.ok(!raw.includes(marker), marker);
    });

    test("carry the tool's facts, the ticket, the parent session and the role", async () => {
        const w = await begin({ config: CONFIG, env: { JIG_PARENT_SESSION: "parent-xyz", JIG_AGENT_ROLE: "scout" } });
        jig().setTicket("TICKET-1");
        await w.call("fake_tool", {
            env: "local",
            facts: { passed: 3, ok: true, conclusion: "success", essay: "x".repeat(100) },
        });
        const [record] = w.callRecords();
        assert.deepEqual(
            [record?.ticket, record?.parentSession, record?.agentRole],
            ["TICKET-1", "parent-xyz", "scout"],
        );
        assert.deepEqual(record?.facts, { passed: 3, ok: true, conclusion: "success" });
        jig().setTicket(undefined);
        await w.call("fake_tool", { env: "local" });
        assert.equal("ticket" in (w.callRecords()[1] ?? {}), false);
    });

    test("go to a private file named for the UTC day", async () => {
        const w = await begin({ config: CONFIG });
        await w.call("fake_tool", { env: "local" });
        const file = path.join(w.stateDir, "records", `${new Date().toISOString().slice(0, 10)}.jsonl`);
        assert.ok(existsSync(file));
        assert.equal(statSync(file).mode & 0o777, 0o600);
    });
});

describe("plugin sections of jig.json", () => {
    test("a registered section that is valid is handed to its plugin at session start", async () => {
        const w = await begin({ config: { ...CONFIG, fake: { level: 3 } }, ui: ALLOW });
        assert.deepEqual(w.log.section, { level: 3 });
        assert.deepEqual(w.ui?.notifications, []);
    });

    test("an invalid one is reported, the plugin gets undefined, and jig-core's own settings stay", async () => {
        const rules = [{ tool: "fake_tool", action: "wipe", decision: "deny" }];
        const w = await begin({ config: { ...CONFIG, rules, fake: { level: "high" } }, ui: ALLOW });
        assert.equal(w.log.section, undefined);
        assert.match(
            w.ui?.notifications[0]?.message ?? "",
            /jig-core: 1 configuration problem\n.*jig\.json: fake: fake\.level must be a number/,
        );
        assert.equal((await w.call("fake_tool", { action: "wipe" })).isError, true, "the rule still applies");
    });

    test("a top-level key nobody registered is reported as unknown, and the defaults apply", async () => {
        const w = await begin({
            config: { ...CONFIG, unregistered: {}, rules: [{ tool: "fake_tool", decision: "deny" }] },
            ui: ALLOW,
        });
        assert.match(w.ui?.notifications[0]?.message ?? "", /jig\.json: unregistered: is not a known field/);
        assert.equal((await w.call("fake_tool", { env: "local" })).isError, false, "the deny rule was not used");
    });

    test("a plugin that loads before jig-core still registers its section", async () => {
        const w = await begin({ config: { ...CONFIG, fake: { level: 1 } }, pluginFirst: true, ui: ALLOW });
        assert.deepEqual(w.log.section, { level: 1 });
        assert.equal((await w.call("fake_tool", { env: "local" })).isError, false, "and its tools are declared");
        assert.equal(w.callRecords()[0]?.plugin, "jig-test");
    });
});

describe("the API", () => {
    test("is published while jig-core is loaded, and withdrawn at shutdown", async () => {
        const w = await begin({ config: CONFIG });
        assert.equal(jig().version, 1);
        await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
        assert.throws(() => jig(), /jig-core is not loaded/);
        await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    });
});
