// The extension factory: what it registers, what it publishes, and what it leaves alone.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig, withdrawJig, withJig } from "../src/client.ts";
import jigDefault, { jigCore } from "../src/index.ts";
import { fakeClock } from "./support/clock.ts";
import { fakeContext, fakePi } from "./support/fake-pi.ts";
import { tempState } from "./support/state.ts";
import { passed, scripted } from "./support/watches.ts";

const state = tempState();
let agentDir = "";
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
// A session start reads jig.json from Pi's agent folder: point it at an empty one, not the real one.
beforeEach(() => {
    state.start();
    agentDir = mkdtempSync(path.join(tmpdir(), "jig-index-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
    state.stop();
    rmSync(agentDir, { recursive: true, force: true });
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("the factory", () => {
    test("registers the hooks it needs, the /jig command and the watch tool", () => {
        const host = fakePi();
        jigCore()(host.pi);
        assert.deepEqual([...host.handlers.keys()].sort(), ["session_shutdown", "session_start", "tool_call", "tool_execution_end", "tool_result", "turn_end"]);
        assert.ok(host.commands.has("jig"));
        assert.deepEqual([...host.registered.keys()], ["watch"]);
        withdrawJig(jig());
    });

    test("the module's default export is the extension Pi loads", () => {
        assert.equal(typeof jigDefault, "function");
        const host = fakePi();
        jigDefault(host.pi);
        assert.ok(host.handlers.has("tool_call"));
        withdrawJig(jig());
    });

    test("starts nothing: no session, no files, no timers, until a session starts", async () => {
        const clock = fakeClock();
        const host = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(host.pi);
        assert.equal(existsSync(`${state.dir}/records`), false);
        assert.equal(existsSync(`${state.dir}/watches`), false);
        assert.equal(clock.pending(), 0);
        withdrawJig(jig());
    });

    test("publishes the API for the plugins, version 1", () => {
        const host = fakePi();
        jigCore()(host.pi);
        const api = jig();
        assert.equal(api.version, 1);
        for (const part of ["declareTool", "approvedPreview", "addFacts", "setTicket", "secrets", "signIn", "mask", "watches", "config", "exec"]) assert.ok(part in api, part);
        withdrawJig(api);
    });

    test("a plugin that was waiting for jig-core gets the API as soon as it is published", () => {
        let version: number | undefined;
        withJig((api) => { version = api.version; });
        assert.equal(version, undefined);
        const host = fakePi();
        jigCore()(host.pi);
        assert.equal(version, 1);
        withdrawJig(jig());
    });

    test("a plugin whose start-up callback fails does not stop jig-core from governing, and the failure is reported", async () => {
        withJig(() => { throw new Error("the other plugin broke"); });
        const host = fakePi();
        jigCore()(host.pi);
        assert.ok(host.handlers.has("tool_call"), "the hooks are in place");
        const { ctx, log } = fakeContext({ ui: { select: () => "Allow" } });
        await host.fire("session_start", { reason: "startup" }, ctx);
        assert.match(log.notifications[0]?.message ?? "", /a plugin failed while loading: the other plugin broke/);
        const blocked = await host.fire("tool_call", { toolCallId: "c", toolName: "mystery", input: {} }, fakeContext({ ui: false }).ctx);
        assert.deepEqual((blocked as { block: boolean }).block, true);
        withdrawJig(jig());
    });

    test("each load makes its own state: a reload starts clean", async () => {
        const first = fakePi();
        jigCore()(first.pi);
        const firstApi = jig();
        firstApi.declareTool({ tool: "t", plugin: "p", classify: () => ({ environment: "local", effect: "read" }) });
        await first.fire("session_shutdown", { reason: "reload" }, fakeContext().ctx);
        const second = fakePi();
        jigCore()(second.pi);
        assert.notEqual(jig(), firstApi);
        // The new load knows nothing of the old declaration, so the tool is unknown again.
        const blocked = await second.fire("tool_call", { toolCallId: "c", toolName: "t", input: {} }, fakeContext({ ui: false }).ctx);
        assert.equal((blocked as { block?: boolean }).block, true);
        withdrawJig(jig());
    });
});

describe("the API that plugins get", () => {
    const load = (options: Parameters<typeof jigCore>[0] = {}) => {
        const host = fakePi();
        jigCore(options)(host.pi);
        return { host, api: jig() };
    };

    test("mask uses the masker the factory was given, and makes one for each UTC day", () => {
        let day = new Date("2026-10-30T12:00:00.000Z");
        const made: Array<{ dir: string; day: string }> = [];
        const { api } = load({
            now: () => day,
            createMasker: (dir, now) => {
                made.push({ dir, day: now.toISOString().slice(0, 10) });
                return { text: (input) => input.replaceAll("PERSONAL", "[masked]"), value: <T>(input: T): T => input };
            },
        });
        assert.equal(api.mask.text("a PERSONAL b"), "a [masked] b");
        assert.deepEqual(api.mask.value({ x: 1 }), { x: 1 });
        assert.equal(made.length, 1, "the same day reuses the masker, so its tokens stay the same all day");
        day = new Date("2026-10-30T23:59:59.999Z");
        api.mask.text("again");
        assert.equal(made.length, 1);
        day = new Date("2026-10-31T00:00:00.000Z");
        api.mask.text("next day");
        assert.deepEqual(made, [{ dir: state.dir, day: "2026-10-30" }, { dir: state.dir, day: "2026-10-31" }]);
        withdrawJig(api);
    });

    test("mask throws when it cannot mask, as the contract says, so the caller drops the result", () => {
        const { api } = load();
        assert.throws(() => api.mask.value({ when: new Map() }), /not JSON-like/);
        assert.throws(() => api.mask.value({ run: () => 1 }), /not JSON-like/);
        withdrawJig(api);
    });

    test("watches: a plugin registers a kind when it loads, and starts watches once a session runs", async () => {
        const clock = fakeClock();
        const host = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(host.pi);
        const api = jig();
        assert.deepEqual(Object.keys(api.watches).sort(), ["list", "registerKind", "start", "stop"], "a plugin gets the four calls and no more");
        const { kind, polls } = scripted(clock, "ci", () => passed("done"));
        api.watches.registerKind(kind);
        assert.deepEqual(api.watches.list(), []);
        assert.throws(() => api.watches.start({ kind: "ci", spec: {}, title: "t" }), /only while a session is running/);

        await host.fire("session_start", { reason: "startup" }, fakeContext({ session: "session-1" }).ctx);
        const id = api.watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });
        assert.deepEqual(api.watches.list().map((watch) => [watch.id, watch.status]), [[id, "open"]]);
        assert.equal(api.watches.stop("zzzzzzzz"), false);
        await clock.advance(5_000);
        assert.equal(polls.length, 1);
        await host.fire("session_shutdown", { reason: "quit" }, fakeContext().ctx);
        withdrawJig(api);
    });

    test("watches: the agent gets one follow-up message that starts a turn, and other plugins get the event", async () => {
        const clock = fakeClock();
        const host = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(host.pi);
        const api = jig();
        api.watches.registerKind(scripted(clock, "ci", () => passed("12 of 12 checks passed")).kind);
        await host.fire("session_start", { reason: "startup" }, fakeContext().ctx);
        const id = api.watches.start({ kind: "ci", spec: {}, title: "checks of pull request 42" });
        await clock.advance(10_000);

        assert.equal(host.sent.length, 1);
        assert.deepEqual(host.sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
        assert.equal(host.sent[0]?.message.customType, "jig-watch");
        assert.equal(host.sent[0]?.message.display, true);
        assert.equal(host.sent[0]?.message.content, 'The watch "checks of pull request 42" passed.\n12 of 12 checks passed');
        const done = host.emitted.filter((entry) => entry.channel === "jig:watch-done");
        assert.equal(done.length, 1);
        assert.deepEqual(done[0]?.data, { id, kind: "ci", plugin: "jig-test", title: "checks of pull request 42", result: { outcome: "passed", summary: "12 of 12 checks passed" } });
        await host.fire("session_shutdown", { reason: "quit" }, fakeContext().ctx);
        withdrawJig(api);
    });

    test("watches: the session's screen gets the notices, and a session without one gets none", async () => {
        for (const [ui, expected] of [[{ select: () => "Allow" }, 1], [false, 0]] as const) {
            const clock = fakeClock();
            const host = fakePi();
            jigCore({ now: clock.date, timers: clock.timers })(host.pi);
            const api = jig();
            api.watches.registerKind(scripted(clock, "ci", (n) => ({ state: n })).kind);
            const { ctx, log } = fakeContext({ ui, session: `session-${expected}` });
            await host.fire("session_start", { reason: "startup" }, ctx);
            api.watches.start({ kind: "ci", spec: {}, title: "t", stallMinutes: 1 });
            await clock.advance(5 * 60_000);
            assert.equal(log.notifications.filter((notice) => notice.message.startsWith("Still waiting")).length, expected);
            await host.fire("session_shutdown", { reason: "quit" }, ctx);
            withdrawJig(api);
        }
    });

    test("watches: shutdown stops every timer, and saved watches wait for the same session to start again", async () => {
        const clock = fakeClock();
        const first = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(first.pi);
        jig().watches.registerKind(scripted(clock, "ci", (n) => ({ state: n })).kind);
        await first.fire("session_start", { reason: "startup" }, fakeContext({ session: "session-9" }).ctx);
        const id = jig().watches.start({ kind: "ci", spec: {}, title: "t" });
        await first.fire("session_shutdown", { reason: "quit" }, fakeContext().ctx); // also withdraws the API
        assert.equal(clock.pending(), 0);

        // Pi starts again, in the same session.
        const second = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(second.pi);
        const api = jig();
        api.watches.registerKind(scripted(clock, "ci", () => passed("finished while Pi was closed")).kind);
        await second.fire("session_start", { reason: "resume" }, fakeContext({ session: "session-9" }).ctx);
        assert.deepEqual(api.watches.list().map((watch) => watch.id), [id]);
        await clock.advance(10_000);
        assert.equal(second.sent.length, 1);
        assert.match(String(second.sent[0]?.message.content), /^While Pi was closed: the watch "t" passed\./);
        await second.fire("session_shutdown", { reason: "quit" }, fakeContext().ctx);
    });

    test("watches: a different session does not pick the watch up", async () => {
        const clock = fakeClock();
        const first = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(first.pi);
        jig().watches.registerKind(scripted(clock, "ci", (n) => ({ state: n })).kind);
        await first.fire("session_start", { reason: "startup" }, fakeContext({ session: "session-a" }).ctx);
        jig().watches.start({ kind: "ci", spec: {}, title: "t" });
        await first.fire("session_shutdown", { reason: "quit" }, fakeContext().ctx);

        const second = fakePi();
        jigCore({ now: clock.date, timers: clock.timers })(second.pi);
        const api = jig();
        const other = scripted(clock, "ci", (n) => ({ state: n }));
        api.watches.registerKind(other.kind);
        await second.fire("session_start", { reason: "new" }, fakeContext({ session: "session-b" }).ctx);
        assert.deepEqual(api.watches.list(), []);
        await clock.advance(5 * 60_000);
        assert.equal(other.polls.length, 0);
        await second.fire("session_shutdown", { reason: "quit" }, fakeContext().ctx);
    });

    test("environments.kindOf names the kind of any environment, and an unknown one counts as production", () => {
        const { api } = load();
        assert.equal(api.environments.kindOf("local"), "local");
        assert.equal(api.environments.kindOf("external"), "external");
        assert.equal(api.environments.kindOf("production"), "production");
        assert.equal(api.environments.kindOf("nobody-defined-this"), "production");
        api.config.addEnvironments({ staging: { kind: "test" }, prod: { kind: "production" } });
        assert.equal(api.environments.kindOf("staging"), "test");
        assert.equal(api.environments.kindOf("prod"), "production");
        withdrawJig(api);
    });

    test("declareTool checks what it is given, and declaring a tool again replaces it", () => {
        const { api } = load();
        assert.throws(() => api.declareTool({ tool: "", plugin: "p", classify: () => undefined }), TypeError);
        assert.throws(() => api.declareTool({ tool: "t", plugin: "", classify: () => undefined }), TypeError);
        assert.throws(() => api.declareTool({ tool: "t", plugin: "p" } as never), TypeError);
        api.declareTool({ tool: "t", plugin: "p", classify: () => ({ environment: "local", effect: "read" }) });
        assert.doesNotThrow(() => api.declareTool({ tool: "t", plugin: "p2", classify: () => ({ environment: "local", effect: "write" }) }));
        withdrawJig(api);
    });

    test("setTicket accepts a key and clears it", () => {
        const { api } = load();
        assert.doesNotThrow(() => { api.setTicket("T-1"); api.setTicket(undefined); api.setTicket(""); });
        withdrawJig(api);
    });
});


describe("plugins that load before jig-core", () => {
    test("each queued callback runs even when an earlier one throws, and the errors come back", async () => {
        const { withJig, publishJig: publish, withdrawJig: withdraw } = await import("../src/client.ts");
        const ran: string[] = [];
        withJig(() => { throw new Error("first plugin broke"); });
        withJig(() => { ran.push("second"); });
        const fake = { version: 1 } as never;
        const errors = publish(fake);
        assert.deepEqual(ran, ["second"]);
        assert.equal(errors.length, 1);
        assert.match(String(errors[0]), /first plugin broke/);
        withdraw(fake);
    });
});
