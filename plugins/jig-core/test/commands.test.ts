// The /jig commands: status, rules per tool and action, and records.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { CallClass, JigApi } from "../src/contract.ts";
import { fakeClock } from "./support/clock.ts";
import { start, text } from "./support/harness.ts";
import type { Harness, StartOptions } from "./support/harness.ts";
import { tempState } from "./support/state.ts";
import { rig, scripted } from "./support/watches.ts";

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

/** Runs `/jig <args>` and returns everything it showed: notices, and the lines of a selector. */
async function jigCommand(harness: Harness, args = ""): Promise<string> {
    const before = [harness.ui.notifications.length, harness.ui.selects.length] as const;
    const command = harness.host.commands.get("jig");
    assert.ok(command, "/jig is registered");
    await command.handler(args, harness.ctx as never);
    return [
        ...harness.ui.notifications.slice(before[0]).map((entry) => entry.message),
        ...harness.ui.selects.slice(before[1]).map((entry) => entry.options.join("\n")),
    ].join("\n");
}

const gitSchema = { properties: { action: { anyOf: [{ const: "status", type: "string" }, { const: "push", type: "string" }] } } };

function declareGit(api: JigApi): void {
    api.declareTool({
        tool: "git",
        plugin: "jig-git",
        classify: (input): CallClass | undefined => {
            if (input.action === "status") return { action: "status", environment: "local", effect: "read" };
            if (input.action === "push") return { action: "push", environment: "external", effect: "write" };
            return undefined;
        },
    });
}

describe("/jig", () => {
    test("is registered, with completions for its two words", async () => {
        const harness = await begin();
        const command = harness.host.commands.get("jig");
        assert.ok(command?.description);
        assert.deepEqual(command.getArgumentCompletions?.("r"), [{ value: "rules", label: "rules" }, { value: "records", label: "records" }]);
        assert.deepEqual(command.getArgumentCompletions?.("rec"), [{ value: "records", label: "records" }]);
        assert.equal(command.getArgumentCompletions?.("x"), null);
    });

    test("shows the status: tools governed, plugins, tools on the unknown default, watches and the configuration", async () => {
        const harness = await begin({
            tools: [{ name: "read" }, { name: "mystery" }, { name: "viewer", annotations: { readOnlyHint: true } }, { name: "git" }],
            plugins: declareGit,
        });
        const status = await jigCommand(harness);
        // The four tools given, and jig-core's own `watch`.
        assert.match(status, /jig-core governs 5 tools in session session-test/);
        assert.match(status, /Plugins: jig-core, jig-git/);
        assert.match(status, /Tools on the unknown default \(they ask until classified\): mystery\n/);
        assert.match(status, /Open watches: 0/);
        assert.match(status, /Configuration: none found \(.*jig\.json\), defaults apply/);
    });

    test("counts the open watches, and says which of them are paused or wait for their plugin", async () => {
        // A watch this session saved before Pi was closed, whose plugin is not loaded now.
        const earlier = rig();
        earlier.engine.registerKind(scripted(earlier.clock, "gone", (n) => ({ state: n })).kind);
        earlier.begin("session-test");
        const waiting = earlier.engine.start({ kind: "gone", spec: {}, title: "from the plugin that is not loaded" });
        earlier.engine.end();

        const clock = fakeClock();
        const harness = await begin({
            clock,
            plugins: (api) => {
                api.watches.registerKind(scripted(clock, "ok", (n) => ({ state: n })).kind);
                api.watches.registerKind(scripted(clock, "broken", () => { throw new Error("down"); }).kind);
            },
        });
        assert.match(await jigCommand(harness), /Open watches: 1 \(1 waiting for its plugin\)\n/);

        const one = harness.api.watches.start({ kind: "ok", spec: {}, title: "one" });
        harness.api.watches.start({ kind: "ok", spec: {}, title: "two" });
        assert.match(await jigCommand(harness), /Open watches: 3 \(1 waiting for its plugin\)\n/);

        const broken = harness.api.watches.start({ kind: "broken", spec: {}, title: "three" });
        await clock.advance(5 * 60_000);
        assert.match(await jigCommand(harness), /Open watches: 4 \(1 paused, 1 waiting for its plugin\)\n/);

        // The watch tool shows the same three states in its lines.
        const tool = harness.host.registered.get("watch");
        const listed = await tool?.execute("call-1", { action: "list" } as never, undefined, undefined, harness.ctx as never);
        const lines = (listed?.content[0] as { text: string }).text.split("\n");
        assert.equal(lines.length, 4);
        assert.match(lines.find((line) => line.startsWith(waiting)) ?? "", /\| from the plugin that is not loaded \| waiting for its plugin \(jig-test\) \| (?:\d+ s|\d+ min)$/);
        assert.match(lines.find((line) => line.startsWith(one)) ?? "", /\| one \| open \| 5 min$/);
        assert.match(lines.find((line) => line.startsWith(broken)) ?? "", /\| three \| paused \| 5 min$/);
    });

    test("a watch that has finished is not counted as open", async () => {
        const clock = fakeClock();
        const harness = await begin({ clock, plugins: (api) => api.watches.registerKind(scripted(clock, "ok", () => ({ state: 1, done: { outcome: "passed", summary: "ok" } })).kind) });
        harness.api.watches.start({ kind: "ok", spec: {}, title: "one" });
        assert.match(await jigCommand(harness), /Open watches: 1\n/);
        await clock.advance(5_000);
        assert.match(await jigCommand(harness), /Open watches: 0\n/);
    });

    test("shows a problem with the saved watches", async () => {
        const clock = fakeClock();
        const harness = await begin({ clock, plugins: (api) => api.watches.registerKind(scripted(clock, "ok", (n) => ({ state: n })).kind) });
        assert.ok(!/Watches:/.test(await jigCommand(harness)));
        // A file in the folder that no version of Jig wrote.
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(`${state.dir}/watches`, { recursive: true });
        writeFileSync(`${state.dir}/watches/abcdefgh.json`, "{ not json");
        await harness.host.fire("session_start", { reason: "reload" }, harness.ctx);
        assert.match(await jigCommand(harness), /\nWatches: 1 saved watch file could not be read$/);
    });

    test("jig-core's own watch tool is not on the unknown default", async () => {
        const harness = await begin({ tools: [{ name: "mystery" }] });
        const status = await jigCommand(harness);
        assert.match(status, /Plugins: jig-core\n/);
        assert.match(status, /Tools on the unknown default \(they ask until classified\): mystery\n/);
    });

    test("a declared tool whose classification depends on the call is not on the unknown default", async () => {
        const harness = await begin({ tools: [{ name: "git" }], plugins: declareGit });
        assert.match(await jigCommand(harness), /Tools on the unknown default \(they ask until classified\): none/);
    });

    test("lists configuration problems, with the file and the key", async () => {
        const harness = await begin({ config: { rule: [], records: { retentionDays: 0 } } });
        const status = await jigCommand(harness);
        assert.match(status, /Configuration problems \(2\):/);
        assert.match(status, /jig\.json: rule: is not a known field/);
        assert.match(status, /jig\.json: records\.retentionDays: must be a whole number of days/);
        assert.doesNotMatch(status, /none found/);
    });

    test("names the sections plugins registered and whether each loaded", async () => {
        const harness = await begin({
            config: { git: { timeout: 5 }, lens: { port: "high" } },
            plugins: (api) => {
                api.config.registerSection("git", () => []);
                api.config.registerSection("lens", (raw) => (typeof (raw as { port?: unknown }).port === "number" ? [] : ["lens.port must be a number"]));
                api.config.registerSection("flow", () => []);
            },
        });
        const status = await jigCommand(harness);
        assert.match(status, /Plugin sections in the file: git \(loaded\), lens \(not set or invalid\), flow \(not set or invalid\)/);
        assert.match(status, /jig\.json: lens: lens\.port must be a number/);
    });

    test("an unknown word shows the usage", async () => {
        const harness = await begin();
        assert.match(await jigCommand(harness, "frobnicate"), /Usage: \/jig, \/jig rules \[tool\], \/jig records/);
    });
});

describe("/jig rules", () => {
    const tools = [
        { name: "read" },
        { name: "bash" },
        { name: "mystery" },
        { name: "viewer", annotations: { readOnlyHint: true } },
        { name: "git", parameters: gitSchema },
        { name: "other_db" },
    ];

    test("gives one line per tool with its environment, effect, decision and where each came from", async () => {
        const harness = await begin({ tools, plugins: declareGit });
        const rules = await jigCommand(harness, "rules");
        assert.match(rules, /^bash: local write -> allow \(decision: table; classified by: default\)$/m);
        assert.match(rules, /^read: local read -> allow \(decision: table; classified by: default\)$/m);
        assert.match(rules, /^viewer: external read -> allow \(decision: table; classified by: hint\)$/m);
    });

    test("flags a tool still on the unknown default, so the user can classify it", async () => {
        const harness = await begin({ tools });
        const rules = await jigCommand(harness, "rules");
        assert.match(rules, /^mystery: external write -> ask \(decision: unknown; classified by: default, not classified\)  <- not classified: add a classify rule, or a rule that names it$/m);
    });

    test("gives a line per action for a tool whose schema lists its actions", async () => {
        const harness = await begin({ tools, plugins: declareGit });
        const rules = await jigCommand(harness, "rules git");
        assert.match(rules, /^git status: local read -> allow \(decision: table; classified by: declaration\)$/m);
        assert.match(rules, /^git push: external write -> ask \(decision: table; classified by: declaration\)$/m);
    });

    test("shows the effect of a rule in configuration", async () => {
        const harness = await begin({ tools, config: { rules: [{ tool: "git", action: "status", decision: "deny" }, { tool: "read", decision: "ask" }] }, plugins: declareGit });
        const rules = await jigCommand(harness, "rules");
        assert.match(rules, /^git status: local read -> deny \(decision: rule; classified by: declaration\)$/m);
        assert.match(rules, /^read: local read -> ask \(decision: rule; classified by: default\)$/m);
    });

    test("a classification rule that needs a parameter does not match a call with none", async () => {
        const config = { environments: { live: { kind: "production" } }, classify: [{ tool: "other_db", param: "x", value: "y", environment: "live", effect: "write" }] };
        const harness = await begin({ tools, config });
        assert.match(await jigCommand(harness, "rules other_db"), /^other_db: external write -> ask \(decision: unknown/m);
    });

    test("a declared tool that cannot be classified without a call says it decides per call", async () => {
        const harness = await begin({ tools: [{ name: "fake" }], plugins: (api) => api.declareTool({ tool: "fake", plugin: "jig-test", classify: (input) => (input.env === undefined ? undefined : { environment: String(input.env), effect: "read" }) }) });
        assert.match(await jigCommand(harness, "rules fake"), /^fake: decided per call by its declaration \(jig-test\)$/m);
    });

    test("lists jig-core's own watch tool: list reads and stop writes, both on this machine", async () => {
        const harness = await begin();
        const rules = await jigCommand(harness, "rules watch");
        assert.match(rules, /^watch list: local read -> allow \(decision: table; classified by: declaration\)$/m);
        assert.match(rules, /^watch stop: local write -> allow \(decision: table; classified by: declaration\)$/m);
    });

    test("a tool that is named but unknown", async () => {
        const harness = await begin({ tools });
        assert.equal(await jigCommand(harness, "rules nothing"), "No tool named nothing.");
    });

    test("a long list is shown in a scrollable selector, a short one as a notice", async () => {
        const many = Array.from({ length: 30 }, (_, index) => ({ name: `tool_${String(index).padStart(2, "0")}`, annotations: { readOnlyHint: true } }));
        const harness = await begin({ tools: many });
        await jigCommand(harness, "rules");
        assert.equal(harness.ui.selects.length, 1);
        assert.equal(harness.ui.selects[0]?.options.length, 32, "the 30 tools, and a line for each of the two actions of jig-core's own `watch`");
        await jigCommand(harness, "rules tool_03");
        assert.equal(harness.ui.selects.length, 1, "one line is a notice");
    });
});

describe("/jig records", () => {
    test("says where today's records are, and that there are none yet", async () => {
        const harness = await begin();
        const records = await jigCommand(harness, "records");
        assert.match(records, new RegExp(`Today's records: ${state.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/records/\\d{4}-\\d{2}-\\d{2}\\.jsonl`));
        assert.match(records, /Nothing recorded yet today\./);
    });

    test("summarises calls, errors, questions asked and time waited", async () => {
        const harness = await begin({
            ui: { select: () => "Allow" },
            plugins: (api) => api.declareTool({ tool: "fake", plugin: "jig-test", classify: (input): CallClass => ({ environment: String(input.env ?? "local"), effect: input.effect === "write" ? "write" : "read" }) }),
        });
        await harness.call({ tool: "fake", input: { env: "local" }, result: text("ok") });
        await harness.call({ tool: "fake", input: { env: "local" }, run: () => { throw new Error("broke"); } });
        await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        await harness.call({ tool: "fake", input: { env: "elsewhere", effect: "write" } });
        const records = await jigCommand(harness, "records");
        assert.match(records, /4 calls \(1 errors, 1 blocked\), 1 questions asked, \d+ ms waited for you, 0 model turns/);
    });
});
