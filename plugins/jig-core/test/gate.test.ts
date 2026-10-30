// The hook before a tool runs: classify, decide, ask, announce, and block. Driven by hand-made events.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { CallClass, JigApi, Preview, ToolDeclaration } from "../src/contract.ts";
import { fakeTerminal } from "./support/fakes.ts";
import type { FakeUiScript } from "./support/fakes.ts";
import { start } from "./support/harness.ts";
import type { Harness, StartOptions } from "./support/harness.ts";
import { rawRecords, tempState } from "./support/state.ts";
import type { Component } from "@earendil-works/pi-tui";

// A clean state folder for every test, so one test's records are not another's.
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

/** A tool whose calls say where they act and whether they write: `{ env, effect, action }`. */
function declare(api: JigApi, tool = "fake", extra: Partial<ToolDeclaration> = {}): void {
    api.declareTool({
        tool,
        plugin: "jig-test",
        classify: (input): CallClass => ({
            ...(typeof input.action === "string" ? { action: input.action } : {}),
            environment: String(input.env ?? "local"),
            effect: input.effect === "write" ? "write" : "read",
            ...(input.atLeast === "ask" ? { atLeast: "ask" as const } : {}),
        }),
        ...extra,
    });
}

const PROD = { environments: { prod: { kind: "production" }, staging: { kind: "test" } } };
const ALLOW: FakeUiScript = { select: () => "Allow" };

describe("what is allowed without asking", () => {
    test("local reads and writes, and external and production reads", async () => {
        const harness = await begin({ config: PROD, ui: false, plugins: (api) => declare(api) });
        for (const input of [
            { env: "local", effect: "read" }, { env: "local", effect: "write" },
            { env: "external", effect: "read" }, { env: "prod", effect: "read" }, { env: "staging", effect: "read" },
        ]) {
            const outcome = await harness.call({ tool: "fake", input });
            assert.equal(outcome.blocked, false, JSON.stringify(input));
        }
        assert.deepEqual(harness.decisions().map((d) => d.decision), ["allow", "allow", "allow", "allow", "allow"]);
    });

    test("Pi's own tools by their built-in defaults", async () => {
        const harness = await begin({ ui: false });
        for (const tool of ["read", "ls", "find", "grep", "write", "edit", "bash", "ask_user_question", "ask_questions"]) {
            assert.equal((await harness.call({ tool })).blocked, false, tool);
        }
        assert.ok(harness.decisions().every((d) => d.environment === "local" && d.source === "table"));
    });
});

describe("what is denied", () => {
    test("a production write, with the reason the model reads, and the tool never runs", async () => {
        const harness = await begin({ config: PROD, ui: ALLOW, plugins: (api) => declare(api) });
        let ran = false;
        const outcome = await harness.call({ tool: "fake", input: { env: "prod", effect: "write" }, run: () => { ran = true; } });
        assert.equal(outcome.blocked, true);
        assert.equal(outcome.reason, "Blocked by jig-core: writes to production are never allowed.");
        assert.equal(ran, false);
        assert.equal(harness.ui.selects.length, 0, "nobody is asked about something that cannot be allowed");
    });

    test("a rule that tries to allow it was refused at load and is reported", async () => {
        const rule = { tool: "fake", environment: "prod", effect: "write", decision: "allow" };
        const harness = await begin({ config: { ...PROD, rules: [rule, { tool: "other", decision: "ask" }] }, ui: ALLOW, plugins: (api) => declare(api) });
        const [note] = harness.notifications();
        assert.match(note ?? "", /jig-core: 1 configuration problem/);
        assert.match(note ?? "", /jig\.json: rules\[0\]\.decision:/);
        assert.equal((await harness.call({ tool: "fake", input: { env: "prod", effect: "write" } })).blocked, true);
    });

    test("a session allow does not reach production", async () => {
        const harness = await begin({ config: PROD, ui: { select: () => "Allow for this session" }, plugins: (api) => declare(api) });
        // Nothing to allow for the session: production writes never ask. The staging write asks and is allowed.
        assert.equal((await harness.call({ tool: "fake", input: { env: "staging", effect: "write" } })).blocked, false);
        assert.equal((await harness.call({ tool: "fake", input: { env: "prod", effect: "write" } })).blocked, true);
    });

    test("an environment nobody defined counts as production", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", input: { env: "somewhere-new", effect: "write" } });
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason ?? "", /writes to production are never allowed/);
        assert.equal(harness.decisions()[0]?.environmentKind, "production");
    });

    test("a rule can deny anything, and says so", async () => {
        const harness = await begin({ config: { rules: [{ tool: "fake", action: "wipe", decision: "deny" }] }, ui: ALLOW, plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", input: { action: "wipe" } });
        assert.equal(outcome.reason, "Blocked by jig-core: a rule in the configuration denies this call.");
        assert.equal((await harness.call({ tool: "fake", input: { action: "list" } })).blocked, false);
    });

    test("the tool's own atLeast deny", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => api.declareTool({ tool: "fake", plugin: "p", classify: () => ({ environment: "local", effect: "write", atLeast: "deny" }) }) });
        const outcome = await harness.call({ tool: "fake" });
        assert.match(outcome.reason ?? "", /tool's own declaration denies this action/);
    });
});

describe("with no screen to ask on", () => {
    test("an external write is blocked, and says why", async () => {
        const harness = await begin({ ui: false, plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        assert.equal(outcome.reason, "Blocked by jig-core: this call needs approval and there is no screen to ask on.");
        assert.deepEqual([harness.decisions()[0]?.decision, harness.decisions()[0]?.source], ["deny", "floor"]);
    });

    test("so is an unknown tool, a test environment write and a rule's ask", async () => {
        const harness = await begin({ config: { ...PROD, rules: [{ tool: "fake", action: "careful", decision: "ask" }] }, ui: false, plugins: (api) => declare(api) });
        assert.equal((await harness.call({ tool: "mystery" })).blocked, true);
        assert.equal((await harness.call({ tool: "fake", input: { env: "staging", effect: "write" } })).blocked, true);
        assert.equal((await harness.call({ tool: "fake", input: { action: "careful" } })).blocked, true);
    });
});

describe("asking the user", () => {
    test("Allow lets the call run, and the event says what was asked and answered", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => declare(api) });
        let ran = false;
        const outcome = await harness.call({ tool: "fake", input: { env: "external", effect: "write", action: "push" }, run: () => { ran = true; } });
        assert.deepEqual([outcome.blocked, ran], [false, true]);
        assert.deepEqual(harness.decisions(), [{
            toolCallId: harness.decisions()[0]?.toolCallId, tool: "fake", action: "push", environment: "external", environmentKind: "external",
            effect: "write", decision: "ask", source: "table", answer: "allow",
        }]);
        assert.match(harness.ui.selects[0]?.title ?? "", /fake · push · external · write\nfake push: \{/);
    });

    test("Decline blocks the call and carries the user's reason to the model", async () => {
        const harness = await begin({ ui: { select: () => "Decline", input: () => "run the tests first" }, plugins: (api) => declare(api) });
        let ran = false;
        const outcome = await harness.call({ tool: "fake", input: { env: "external", effect: "write" }, run: () => { ran = true; } });
        assert.deepEqual([outcome.blocked, ran], [true, false]);
        assert.equal(outcome.reason, "Blocked by jig-core: the user declined this call, and said: run the tests first");
        assert.equal(harness.decisions()[0]?.answer, "decline");
    });

    test("Decline without a reason, and a question closed without an answer", async () => {
        const declined = await begin({ ui: { select: () => "Decline", input: () => undefined }, plugins: (api) => declare(api) });
        assert.equal((await declined.call({ tool: "fake", input: { env: "external", effect: "write" } })).reason, "Blocked by jig-core: the user declined this call");
        await declined.shutdown();
        const closed = await begin({ ui: { select: () => undefined }, plugins: (api) => declare(api) });
        assert.equal((await closed.call({ tool: "fake", input: { env: "external", effect: "write" } })).reason, "Blocked by jig-core: the question was closed without an answer");
    });

    test("Allow for this session answers the same question for the rest of the session, and no other", async () => {
        let asked = 0;
        const harness = await begin({ config: PROD, ui: { select: () => { asked++; return "Allow for this session"; } }, plugins: (api) => declare(api) });
        const push = { env: "external", effect: "write", action: "push" };
        await harness.call({ tool: "fake", input: push });
        await harness.call({ tool: "fake", input: push });
        await harness.call({ tool: "fake", input: push });
        assert.equal(asked, 1);
        assert.deepEqual(harness.decisions().map((d) => [d.decision, d.source]), [["ask", "table"], ["allow", "session"], ["allow", "session"]]);
        await harness.call({ tool: "fake", input: { ...push, action: "force-push" } });
        await harness.call({ tool: "fake", input: { ...push, env: "staging" } });
        assert.equal(asked, 3, "another action and another environment ask again");
    });

    test("a failing screen blocks the call as a failure to decide", async () => {
        const harness = await begin({ ui: { select: () => { throw new Error("the client went away"); } }, plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        assert.equal(outcome.reason, "jig-core could not decide: the client went away");
        assert.equal(harness.records()[0]?.errorKind, "internal");
    });

    test("questions from calls that run together are shown one at a time", async () => {
        const harness = await begin({ ui: { select: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return "Allow"; } }, plugins: (api) => declare(api) });
        const input = { env: "external", effect: "write" };
        await Promise.all([1, 2, 3, 4].map((n) => harness.gate({ tool: "fake", input: { ...input, n }, id: `parallel-${n}` })));
        assert.equal(harness.ui.maxActive, 1);
        assert.equal(harness.ui.selects.length, 4);
    });
});

describe("the preview", () => {
    test("comes from the tool's own preview function, and the tool can read what was approved", async () => {
        const preview: Preview = { summary: "Push 2 commits", body: "diff text", format: "diff", fingerprint: "fp-1" };
        const harness = await begin({ ui: ALLOW, plugins: (api) => declare(api, "fake", { preview: async () => preview }) });
        let approved: Preview | undefined;
        let during: Preview | undefined;
        await harness.call({ tool: "fake", id: "c-1", input: { env: "external", effect: "write" }, run: () => { approved = harness.api.approvedPreview("c-1"); during = approved; } });
        assert.deepEqual(approved, preview);
        assert.deepEqual(during, preview);
        assert.equal(harness.api.approvedPreview("c-1"), undefined, "forgotten when the call ends");
        assert.match(harness.ui.selects[0]?.title ?? "", /Push 2 commits/);
    });

    test("is undefined for a call that did not ask", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => declare(api, "fake", { preview: async () => ({ summary: "s" }) }) });
        let seen: Preview | undefined = { summary: "unset" };
        await harness.call({ tool: "fake", id: "c-2", input: { env: "local", effect: "read" }, run: () => { seen = harness.api.approvedPreview("c-2"); } });
        assert.equal(seen, undefined);
    });

    test("a TypeError from the tool's preview means invalid input: the call is blocked and nobody is asked", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => declare(api, "fake", { preview: async () => { throw new TypeError("no transition named Done; there are: In Review"); } }) });
        const outcome = await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason ?? "", /fake cannot run with this input: no transition named Done; there are: In Review/);
        assert.equal(harness.ui.selects.length, 0, "nobody is asked about a call that cannot run");
    });

    test("a preview that fails is shown as unavailable, and the user can still decide", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => declare(api, "fake", { preview: async () => { throw new Error("no network"); } }) });
        const outcome = await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        assert.equal(outcome.blocked, false);
        assert.match(harness.ui.selects[0]?.title ?? "", /preview unavailable: no network/);
    });

    test("a body gets the review screen in the terminal interface, and y allows", async () => {
        const custom: FakeUiScript["custom"] = (factory) => new Promise((resolve) => {
            const terminal = fakeTerminal();
            const component = factory(terminal.tui, terminal.theme, terminal.keybindings, resolve) as Component;
            component.render(80);
            component.handleInput?.("y");
        });
        const harness = await begin({ mode: "tui", ui: { custom }, plugins: (api) => declare(api, "fake", { preview: async () => ({ summary: "s", body: "long text" }) }) });
        assert.equal((await harness.call({ tool: "fake", input: { env: "external", effect: "write" } })).blocked, false);
        assert.deepEqual([harness.ui.customs, harness.ui.selects.length], [1, 0]);
    });

    test("the screen a rule chooses wins over the default", async () => {
        const harness = await begin({ config: { rules: [{ tool: "fake", decision: "ask", approval: "dialog" }] }, mode: "tui", ui: { select: () => "Allow" }, plugins: (api) => declare(api, "fake", { preview: async () => ({ summary: "s", body: "long text" }) }) });
        await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        assert.deepEqual([harness.ui.customs, harness.ui.selects.length], [0, 1]);
    });
});

describe("tools nobody classified", () => {
    test("ask, with a summary that says so, and run once allowed", async () => {
        const harness = await begin({ ui: ALLOW });
        assert.equal((await harness.call({ tool: "mystery", input: { x: 1 } })).blocked, false);
        assert.match(harness.ui.selects[0]?.title ?? "", /mystery \(not classified, so treated as a write outside this machine\): \{"x":1\}/);
        assert.deepEqual([harness.decisions()[0]?.source, harness.decisions()[0]?.environment, harness.decisions()[0]?.effect], ["unknown", "external", "write"]);
    });

    test("are not allowed by a wildcard rule, but are by a rule that names them", async () => {
        const wildcard = await begin({ config: { rules: [{ tool: "*", decision: "allow" }] }, ui: false });
        assert.equal((await wildcard.call({ tool: "mystery" })).blocked, true);
        assert.equal(wildcard.decisions()[0]?.source, "floor");
        await wildcard.shutdown();
        const named = await begin({ config: { rules: [{ tool: "mystery", decision: "allow" }] }, ui: false });
        assert.equal((await named.call({ tool: "mystery" })).blocked, false);
        assert.equal(named.decisions()[0]?.source, "rule");
    });

    test("are classified by a rule in configuration, by a parameter", async () => {
        const config = { environments: { live: { kind: "production" } }, classify: [{ tool: "other_db", param: "target", value: "live", environment: "live", effect: "read" }] };
        const harness = await begin({ config, ui: false });
        const read = await harness.call({ tool: "other_db", input: { target: "live" } });
        assert.equal(read.blocked, false);
        assert.deepEqual([harness.decisions()[0]?.environment, harness.decisions()[0]?.effect], ["live", "read"]);
        assert.equal((await harness.call({ tool: "other_db", input: { target: "elsewhere" } })).blocked, true, "another target is still unknown");
    });

    test("are classified by their hints", async () => {
        const harness = await begin({ ui: false, tools: [{ name: "viewer", annotations: { readOnlyHint: true } }, { name: "editor", annotations: { destructiveHint: true } }] });
        assert.equal((await harness.call({ tool: "viewer" })).blocked, false);
        assert.equal((await harness.call({ tool: "editor" })).blocked, true);
        assert.deepEqual(harness.decisions().map((d) => [d.environment, d.effect]), [["external", "read"], ["external", "write"]]);
    });

    test("a declaration that cannot classify this input makes the call unknown", async () => {
        const harness = await begin({ ui: false, plugins: (api) => api.declareTool({ tool: "fake", plugin: "p", classify: () => undefined }) });
        const outcome = await harness.call({ tool: "fake" });
        assert.equal(outcome.blocked, true);
        // It asked, and with no screen the ask became a deny.
        assert.deepEqual([harness.decisions()[0]?.decision, harness.decisions()[0]?.source], ["deny", "floor"]);
    });
});

describe("rules", () => {
    test("the first match wins, and the personal file comes before what a company plugin added", async () => {
        const harness = await begin({
            config: { rules: [{ tool: "fake", action: "push", decision: "ask" }] },
            ui: { select: () => "Allow" },
            plugins: (api) => {
                declare(api);
                api.config.addEnvironments({ qa: { kind: "test" } });
                api.config.addRules([{ tool: "fake", environment: "qa", decision: "allow" }]);
            },
        });
        // The company allows writes to qa without asking; the personal rule asks for every push.
        await harness.call({ tool: "fake", input: { env: "qa", effect: "write", action: "other" } });
        await harness.call({ tool: "fake", input: { env: "qa", effect: "write", action: "push" } });
        assert.deepEqual(harness.decisions().map((d) => d.decision), ["allow", "ask"]);
    });

    test("a company rule cannot allow a production write", async () => {
        const harness = await begin({
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                api.config.addEnvironments({ prod: { kind: "production" } });
                api.config.addRules([{ tool: "fake", environment: "prod", effect: "write", decision: "allow" }]);
            },
        });
        assert.equal((await harness.call({ tool: "fake", input: { env: "prod", effect: "write" } })).blocked, true);
        // The refusal is reported where the user can see it.
        assert.match(harness.notifications()[0] ?? "", /company: rules\[0\]\.decision:/);
    });

    test("a rule can ask for a read, and a company classification rule works for any tool", async () => {
        const harness = await begin({
            config: { rules: [{ tool: "fake", effect: "read", environment: "external", decision: "ask" }] },
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                api.config.addClassifyRules([{ tool: "company_db", param: "db", value: "main", environment: "external", effect: "read" }]);
            },
        });
        await harness.call({ tool: "fake", input: { env: "external", effect: "read" } });
        await harness.call({ tool: "company_db", input: { db: "main" } });
        assert.deepEqual(harness.decisions().map((d) => [d.tool, d.decision]), [["fake", "ask"], ["company_db", "allow"]]);
    });
});

describe("when jig-core itself fails", () => {
    test("a declaration that throws blocks the call, with the reason", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => api.declareTool({ tool: "fake", plugin: "p", classify: () => { throw new Error("classify blew up"); } }) });
        let ran = false;
        const outcome = await harness.call({ tool: "fake", run: () => { ran = true; } });
        assert.deepEqual([outcome.blocked, ran], [true, false]);
        assert.equal(outcome.reason, "jig-core could not decide: classify blew up");
        const [record] = harness.records();
        assert.deepEqual([record?.outcome, record?.errorKind], ["blocked", "internal"]);
    });

    test("a declaration that returns nonsense blocks the call too", async () => {
        const harness = await begin({ ui: ALLOW, plugins: (api) => api.declareTool({ tool: "fake", plugin: "p", classify: () => ({ environment: "local", effect: "destroy" }) as unknown as CallClass }) });
        const outcome = await harness.call({ tool: "fake" });
        assert.match(outcome.reason ?? "", /^jig-core could not decide: .*invalid classification/);
    });

    test("a listener on the event bus that fails does not change the decision", async () => {
        const harness = await begin({ ui: false, plugins: (api) => declare(api) });
        (harness.host.pi.events as { emit: unknown }).emit = () => { throw new Error("listener broke"); };
        assert.equal((await harness.call({ tool: "fake", input: { env: "local", effect: "read" } })).blocked, false);
        assert.equal((await harness.call({ tool: "fake", input: { env: "external", effect: "write" } })).blocked, true);
    });
});

describe("nested calls", () => {
    test("are decided like any other call, and carry the id of their parent", async () => {
        const harness = await begin({ config: PROD, ui: ALLOW, plugins: (api) => declare(api) });
        const outcome = await harness.call({ tool: "fake", id: "outer/1", parent: "outer", input: { env: "prod", effect: "write" } });
        assert.equal(outcome.blocked, true);
        const [record] = harness.records();
        assert.deepEqual([record?.toolCallId, record?.parentToolCallId, record?.outcome], ["outer/1", "outer", "blocked"]);
    });
});

describe("nothing leaks into the records", () => {
    test("neither the arguments of a call nor the reason the user typed", async () => {
        const harness = await begin({ ui: { select: () => "Decline", input: () => "USER-TYPED-REASON-9" }, plugins: (api) => declare(api) });
        await harness.call({ tool: "fake", input: { env: "external", effect: "write", text: "ARGUMENT-MARKER-5" } });
        const raw = rawRecords(state.dir);
        assert.ok(raw.includes('"declined"'));
        assert.ok(!raw.includes("ARGUMENT-MARKER-5"));
        assert.ok(!raw.includes("USER-TYPED-REASON-9"));
    });
});
