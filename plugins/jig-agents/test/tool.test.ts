// The `subagent` tool and the `/agents` command: how each action is classified for jig-core, what input is refused before anything runs,
// and what the command shows. Everything allowed by default is a local write or a read, so no call here asks.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { InputError } from "../../jig-core/src/kit/values.ts";
import { ACTION_NAMES, checkInput, createTool, describeTool, roleLines } from "../src/tool.ts";
import { loadRoles, shippedFolder } from "../src/roles.ts";
import { startWorld } from "./world.ts";
import type { World } from "./world.ts";

let w: World | undefined;
afterEach(async () => {
    await w?.close();
    w = undefined;
});

describe("the declaration", () => {
    const declaration = createTool({} as never, "d").declaration;

    test("start, message and stop are local writes and status is a read, none of which asks", () => {
        const classify = (input: Record<string, unknown>) => declaration.classify(input);
        assert.deepEqual(classify({ action: "start", role: "scout", task: "x" }), {
            action: "start",
            environment: "local",
            effect: "write",
        });
        assert.deepEqual(classify({ action: "message", child: "a", text: "x" }), {
            action: "message",
            environment: "local",
            effect: "write",
        });
        assert.deepEqual(classify({ action: "stop", child: "a" }), {
            action: "stop",
            environment: "local",
            effect: "write",
        });
        assert.deepEqual(classify({ action: "status" }), { action: "status", environment: "local", effect: "read" });
        for (const action of ACTION_NAMES) {
            const used = declaration.classify({ action, ...pick(action) });
            assert.equal(used?.atLeast, undefined, `${action} is never stricter than the table`);
        }
    });

    test("an unknown action, a missing parameter or a parameter the action does not use is invalid input", () => {
        assert.throws(
            () => checkInput({ action: "fly" }),
            (error: Error) => error instanceof InputError && /unknown action "fly"/.test(error.message),
        );
        assert.throws(() => checkInput({}), InputError);
        assert.throws(() => checkInput({ action: "start", role: "scout" }), /subagent start needs task/);
        assert.throws(() => checkInput({ action: "stop" }), /needs child/);
        assert.throws(() => checkInput({ action: "status", role: "scout" }), /does not use role/);
        assert.throws(() => checkInput({ action: "start", role: "scout", task: "x", text: "y" }), /does not use text/);
        assert.throws(() => checkInput({ action: "start", role: 5, task: "x" }), /role must be text/);
        assert.doesNotThrow(() => checkInput({ action: "status", child: undefined }));
    });

    test("the actions are the README's, in order", () => {
        assert.deepEqual(ACTION_NAMES, ["start", "status", "message", "stop"]);
    });
});

/** The parameters an action needs. */
function pick(action: string): Record<string, string> {
    const wanted: Record<string, string[]> = {
        start: ["role", "task"],
        status: [],
        message: ["child", "text"],
        stop: ["child"],
    };
    return Object.fromEntries((wanted[action] ?? []).map((key) => [key, "x"]));
}

describe("the description", () => {
    const roles = loadRoles([shippedFolder()]).roles;

    test("lists every role with its description and whether it writes, and says when to delegate", () => {
        const text = describeTool(roles.values());
        assert.match(text, /- scout: Read-only exploration of code, logs and tickets, with evidence \(read-only\)/);
        assert.match(text, /- worker: .* \(writes, in a git worktree of its own\)/);
        assert.match(text, /more than about five files or 20,000 tokens of output \(start a scout\)/);
        assert.match(text, /fresh look at your own change \(start a reviewer\)/);
        assert.match(text, /do not poll/);
        assert.equal(roleLines(roles.values()).split("\n").length, 3);
    });

    test("a company's roles are added to the list at session start", { timeout: 30_000 }, async () => {
        w = await startWorld({
            agentFiles: {
                "oncall.md":
                    "---\ndescription: Reads runbooks and says who to page\ntools: read, grep\nwrites: false\n---\nYou read runbooks.\n",
            },
        });
        const tool = w.session.getAllTools().find((candidate) => candidate.name === "subagent");
        assert.match(tool?.description ?? "", /- oncall: Reads runbooks and says who to page \(read-only\)/);
        assert.match(tool?.description ?? "", /- scout: /);
    });
});

describe("the tool in a session", () => {
    test("every call is recorded by jig-core with its action, and none asks", { timeout: 30_000 }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        await w.tool({ action: "start", role: "scout", task: "x" });
        await w.tool({ action: "status" });
        await w.tool({ action: "message", child: "scout-1", text: "hi" });
        await w.tool({ action: "stop", child: "scout-1" });
        const { readFileSync, readdirSync } = await import("node:fs");
        const dir = `${w.stateDir}/records`;
        const records = readdirSync(dir).flatMap((name) =>
            readFileSync(`${dir}/${name}`, "utf8")
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as Record<string, any>),
        );
        const calls = records.filter((r) => r.kind === "call" && r.tool === "subagent");
        assert.deepEqual(
            calls.map((r) => [r.action, r.plugin, r.environment, r.effect, r.decision, r.decisionSource]),
            [
                ["start", "jig-agents", "local", "write", "allow", "table"],
                ["status", "jig-agents", "local", "read", "allow", "table"],
                ["message", "jig-agents", "local", "write", "allow", "table"],
                ["stop", "jig-agents", "local", "write", "allow", "table"],
            ],
        );
        // The record of the start names the role and the child's id, and never the task.
        assert.ok(!JSON.stringify(records).includes('"task"'));
    });

    test("the child's own records say whose child it is, through the environment it was started with", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        await w.tool({ action: "start", role: "reviewer", task: "x" });
        const env = w.log().start?.env ?? {};
        assert.equal(env.JIG_AGENT_ROLE, "reviewer");
        assert.equal(env.JIG_PARENT_SESSION, w.session.sessionManager.getSessionId());
    });

    test("/jig shows the plugin's line: how many children run, how many started, and the roles", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        await w.tool({ action: "start", role: "scout", task: "x" });
        assert.deepEqual(w.rt.statusLines(), [
            "jig-agents: 1 child running, 1 of 30 started; roles: reviewer, scout, worker",
        ]);
    });
});

describe("/agents", () => {
    test("with no word lists the children, one line each with state, turn, minutes, cost and model", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        assert.deepEqual(await w.command(""), ["No children in this session."]);
        await w.tool({ action: "start", role: "scout", task: "x" });
        const [text] = await w.command("");
        assert.match(
            text ?? "",
            /^scout-1 \([0-9a-f]{6}\) scout: running; turn 0\/40, 0\/30 min, cost unknown of \$2\.00; faux\/faux-1$/,
        );
    });

    test("roles lists the roles with their tools, model and limits, warns of a configured role with no file, and names a bad file", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({
            config: {
                agents: {
                    roles: {
                        scout: { model: "faux/small-model:low", maxTurns: 12 },
                        ghost: { model: "faux/big-model" },
                    },
                },
            },
            agentFiles: { "broken.md": "---\ndescription: d\ntools: read, bash\nwrites: false\n---\nx\n" },
        });
        const [text] = await w.command("roles");
        assert.match(text ?? "", /scout \(read-only\): Read-only exploration/);
        assert.match(
            text ?? "",
            /tools: read, grep, find, ls, git, logs; model: faux\/small-model:low; limits: 12 turns, 30 min, \$2;/,
        );
        assert.match(text ?? "", /worker \(writes\): /);
        assert.match(
            text ?? "",
            /warning: agents\.roles\.ghost is set in jig\.json, but no agent file defines the role ghost/,
        );
        assert.match(text ?? "", /skipped .*broken\.md: tools: a role with writes: false must not list bash/);
    });

    test("show gives the end of a child's transcript, cleaned", { timeout: 30_000 }, async () => {
        w = await startWorld({
            script: {
                steps: [
                    { turn: { text: "reading the code\u001b[31m now" } },
                    { event: { type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } } },
                    { hold: true },
                ],
            },
        });
        await w.tool({ action: "start", role: "scout", task: "x" });
        const { until } = await import("./world.ts");
        await until(() => (w?.rt.find("scout-1")?.tail().length ?? 0) >= 2, "the transcript");
        const [text] = await w.command("show scout-1");
        assert.match(text ?? "", /^scout-1:\nsays: reading the code\[31m now|^scout-1:\nsays: reading the code now/);
        assert.match(text ?? "", /calls read \{"path":"a\.ts"\}/);
        assert.doesNotMatch(text ?? "", /\u001b/);
    });

    test("say sends the child a message, and stop stops it", { timeout: 30_000 }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        await w.tool({ action: "start", role: "scout", task: "x" });
        assert.deepEqual(await w.command("say scout-1 look at the tests too"), ["Sent to scout-1."]);
        assert.equal(w.log().commands.find((c) => c.type === "steer")?.message, "look at the tests too");
        const [stopped] = await w.command("stop scout-1");
        assert.match(stopped ?? "", /scout-1 was stopped/);
    });

    test("a mistake is a warning with the usage, not an error", { timeout: 30_000 }, async () => {
        w = await startWorld();
        assert.match((await w.command("fly"))[0] ?? "", /^Use \/agents, \/agents roles/);
        assert.match((await w.command("stop nobody"))[0] ?? "", /no child "nobody" in this session; none was started/);
        assert.match((await w.command("show"))[0] ?? "", /name the child/);
    });
});
