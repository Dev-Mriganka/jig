// A child that cannot be trusted with a task, or that misbehaves once it has one: a Pi that did not load the parent's plugins, the wrong
// model, a plugin that failed to load, a child that dies, or one that sends garbage or too much of it. Every case ends the child, says
// why, and leaves nothing running.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { startWorld, until } from "./world.ts";
import type { World, WorldOptions } from "./world.ts";

let w: World | undefined;
afterEach(async () => {
    await w?.close();
    w = undefined;
});

async function begin(options: WorldOptions = {}): Promise<World> {
    w = await startWorld(options);
    return w;
}

const alive = (world: World): boolean => world.rt.host.alive(world.log().start?.pid ?? 0);
const types = (world: World) => world.log().commands.map((c) => c.type);

describe("a child that is not what was asked for is stopped before it gets its task", () => {
    test("one that did not load jig-core is refused: it would run ungoverned", { timeout: 30_000 }, async () => {
        const world = await begin({ script: { commands: ["mcp", "llama"] } });
        const refused = await world.tool({ action: "start", role: "scout", task: "secret task" });
        assert.equal(refused.isError, true);
        assert.match(
            refused.text,
            /does not list the \/jig command, so it did not load the same plugins as this session/,
        );
        assert.equal(types(world).includes("prompt"), false, "the task was never sent");
        await until(() => !alive(world), "the child to end");
        assert.equal(world.rt.children.size, 0);
    });

    test("one that did not load jig-sandbox is refused when the parent has it", { timeout: 30_000 }, async () => {
        const world = await begin({ commands: ["sandbox"], script: { commands: ["jig"] } });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(refused.text, /does not list the \/sandbox command/);
        assert.equal(types(world).includes("prompt"), false);
    });

    test("jig-sandbox is not required of a child when the parent has none", { timeout: 30_000 }, async () => {
        const world = await begin({ script: { commands: ["jig"], steps: [{ hold: true }] } });
        const started = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.equal(started.isError, false, started.text);
    });

    test("one that loaded both is accepted", { timeout: 30_000 }, async () => {
        const world = await begin({
            commands: ["sandbox"],
            script: { commands: ["jig", "sandbox"], steps: [{ hold: true }] },
        });
        assert.equal((await world.tool({ action: "start", role: "scout", task: "x" })).isError, false);
    });

    test("one with a plugin that failed to load is refused", { timeout: 30_000 }, async () => {
        const world = await begin({
            script: {
                startup: [
                    {
                        event: {
                            type: "extension_error",
                            extensionPath: "/x/jig-sandbox/src/index.ts",
                            event: "load",
                            error: "broken settings file",
                        },
                    },
                ],
            },
        });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(refused.text, /a plugin failed to load in the child: .*broken settings file/);
        assert.equal(types(world).includes("prompt"), false);
    });

    test("a model that Pi does not know is refused before anything starts", { timeout: 30_000 }, async () => {
        const world = await begin({ config: { agents: { roles: { scout: { model: "nowhere/unknown-model" } } } } });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(refused.text, /Pi does not know the model nowhere\/unknown-model/);
        assert.equal(world.log().start, undefined);
    });

    test("one on another model than the role's is refused", { timeout: 30_000 }, async () => {
        const world = await begin({
            config: { agents: { roles: { scout: { model: "faux/small-model:low" } } } },
            settings: { enabledModels: ["faux/*"] },
            script: {},
        });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(refused.text, /runs faux\/faux-1, not the faux\/small-model that was asked for/);
    });

    test("the role's model and thinking level go to the child as flags, after the check against enabledModels", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { roles: { scout: { model: "faux/small-model:low" } } } },
            settings: { enabledModels: ["faux/small-model", "other/*"] },
            script: { model: { provider: "faux", id: "small-model" }, steps: [{ hold: true }] },
        });
        const started = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.equal(started.isError, false, started.text);
        const argv = world.log().start?.argv ?? [];
        assert.equal(argv[argv.indexOf("--model") + 1], "faux/small-model");
        assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
    });

    test("a model that enabledModels does not allow refuses the start and names the patterns", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { roles: { scout: { model: "faux/big-model" } } } },
            settings: { enabledModels: ["other/*", "faux/small-*"] },
        });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(refused.text, /agents\.roles\.scout\.model "faux\/big-model" is not allowed by enabledModels/);
        assert.match(refused.text, /allowed: other\/\*, faux\/small-\*/);
        assert.equal(world.log().start, undefined, "no process was started");
    });

    test("without an enabledModels list, any model Pi knows is allowed, as Pi's own setting says", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            config: { agents: { roles: { scout: { model: "faux/anything" } } } },
            script: { model: { provider: "faux", id: "anything" }, steps: [{ hold: true }] },
        });
        assert.equal((await world.tool({ action: "start", role: "scout", task: "x" })).isError, false);
    });

    test("a role with no model of its own runs the parent's model and thinking level", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({ script: { steps: [{ hold: true }] } });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const argv = world.log().start?.argv ?? [];
        assert.equal(argv[argv.indexOf("--model") + 1], "faux/faux-1");
        assert.ok(argv.includes("--thinking"));
    });

    test("a child that rejects its task, or does not start a run for it, is refused", { timeout: 30_000 }, async () => {
        let world = await begin({ script: { rejectPrompt: true } });
        const rejected = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(rejected.text, /did not accept its task: prompt failed: no model/);
        await world.close();
        world = await begin({ script: { disposition: "handled" } });
        const handled = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.match(handled.text, /did not start a run for its task \(handled\)/);
    });

    test("a child that dies while starting is refused with what it said on stderr", { timeout: 30_000 }, async () => {
        const world = await begin({ script: { startup: [{ stderr: "Error: cannot find module" }, { exit: 7 }] } });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /the child could not be started/);
    });

    test("a Pi that cannot be run at all is refused, and nothing is left", { timeout: 30_000 }, async () => {
        const world = await begin({ host: { piCommand: () => ({ file: "/nonexistent/pi", args: [] }) } });
        const refused = await world.tool({ action: "start", role: "scout", task: "x" });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /could not be started/);
        assert.equal(world.rt.children.size, 0);
    });
});

describe("a child that misbehaves once it runs", () => {
    test("one that dies mid-run ends as an error with its exit code and the last thing it said", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            script: { steps: [{ turn: { text: "working" } }, { stderr: "FATAL: out of memory\n" }, { exit: 3 }] },
        });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const message = await world.deliver();
        assert.match(message.content, /ended with an error\./);
        assert.match(message.content, /scout-1 failed: the child exited \(exit code 3\)/);
        assert.match(message.content, /FATAL: out of memory/);
        assert.equal(message.details.watches[0].outcome, "error");
    });

    test("one whose model fails ends as an error that says so, not as a finished report", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({
            script: {
                steps: [
                    { turn: { text: "", stopReason: "error", errorMessage: "529 overloaded" } },
                    { settle: { text: "" } },
                ],
            },
        });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const message = await world.deliver();
        assert.match(message.content, /scout-1 failed: the model failed: 529 overloaded/);
    });

    test("one that aborts by itself ends as an error", { timeout: 30_000 }, async () => {
        const world = await begin({ script: { steps: [{ event: { type: "agent_settled", aborted: true } }] } });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const message = await world.deliver();
        assert.match(message.content, /scout-1 failed: its run was aborted/);
    });

    test("one that sends a few lines of garbage is tolerated and goes on to finish", { timeout: 30_000 }, async () => {
        const world = await begin({
            script: {
                steps: [
                    { flood: 5 },
                    { raw: "[1,2,3]\n" },
                    { raw: '{"type": 5}\n' },
                    { raw: '"text"\n' },
                    { settle: { text: "finished anyway" } },
                ],
            },
        });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const message = await world.deliver();
        assert.match(message.content, /finished anyway/);
    });

    test("one that floods its output with unreadable lines is given up on, stopped, and reported", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({ script: { steps: [{ flood: 500 }, { hold: true }] } });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const message = await world.deliver();
        assert.match(message.content, /scout-1 failed: its output could not be read: more than 20 unreadable lines/);
        await until(() => !alive(world), "the child to end");
    });

    test("one that floods events (valid ones) is read to the end", { timeout: 30_000 }, async () => {
        const events = Array.from({ length: 3000 }, () => ({
            event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
        }));
        const world = await begin({ script: { steps: [...events, { settle: { text: "after the flood" } }] } });
        await world.tool({ action: "start", role: "scout", task: "x" });
        const message = await world.deliver();
        assert.match(message.content, /after the flood/);
    });

    test("one that never answers a command does not hang the start: the wait is bounded", {
        timeout: 30_000,
    }, async () => {
        const world = await begin({ script: { slowCommands: 600_000 } });
        const pending = world.tool({ action: "start", role: "scout", task: "x" });
        await until(() => world.log().start !== undefined, "the child to start");
        await world.advance(61_000);
        const refused = await pending;
        assert.equal(refused.isError, true);
        assert.match(refused.text, /get_commands was not answered within 60 s/);
        await until(() => !alive(world), "the child to be stopped");
    });
});
