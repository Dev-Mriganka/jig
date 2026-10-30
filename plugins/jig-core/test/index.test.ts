// The extension factory: what it registers, what it publishes, and what it leaves alone.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig, withdrawJig, withJig } from "../src/client.ts";
import jigDefault, { jigCore } from "../src/index.ts";
import { fakeContext, fakePi } from "./support/fake-pi.ts";
import { tempState } from "./support/state.ts";

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
    test("registers the hooks it needs and the /jig command", () => {
        const host = fakePi();
        jigCore()(host.pi);
        assert.deepEqual([...host.handlers.keys()].sort(), ["session_shutdown", "session_start", "tool_call", "tool_execution_end", "tool_result", "turn_end"]);
        assert.ok(host.commands.has("jig"));
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
        const host = fakePi();
        jigCore()(host.pi);
        assert.equal(existsSync(`${state.dir}/records`), false);
        withdrawJig(jig());
    });

    test("publishes the API for the plugins, version 1", () => {
        const host = fakePi();
        jigCore()(host.pi);
        const api = jig();
        assert.equal(api.version, 1);
        for (const part of ["declareTool", "approvedPreview", "addFacts", "setTicket", "secrets", "mask", "watches", "config", "exec"]) assert.ok(part in api, part);
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

    test("watches are a placeholder: kinds are kept, nothing is listed, and starting or stopping says they are not built", () => {
        const { api } = load();
        assert.doesNotThrow(() => api.watches.registerKind({ kind: "k", plugin: "p", intervalMs: 1000, describe: () => "d", poll: async () => ({ state: 1 }) }));
        assert.deepEqual(api.watches.list(), []);
        assert.throws(() => api.watches.start({ kind: "k", spec: {}, title: "t" }), /watches are not built yet/);
        assert.throws(() => api.watches.stop("any"), /watches are not built yet/);
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
