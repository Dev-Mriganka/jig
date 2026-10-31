// The plugin against the stock Pi, not the fake child: a real `pi --mode rpc` process with the repository's own jig-core and jig-agents
// loaded through settings.json, as a user's Pi has them. Pi's own scripted model (the faux provider, registered by
// support/scripted-model.ts) stands in for a service, so no model is ever called. Each test gives the child a temporary agent folder
// (PI_CODING_AGENT_DIR) and a temporary home, and a child's environment never holds AWS_PROFILE or any other name the plugin drops.
// It is skipped, with the reason, when there is no Pi 1.x next to this Node. JIG_AGENTS_TEST_PI names another one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { TestContext } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { ROLE_POLICY_VARIABLE, writeRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import { realHost, thisPi } from "../src/host.ts";
import type { Host, PiCommand } from "../src/host.ts";
import { childEnvironment, flagsFor } from "../src/launch.ts";
import { loadRoles, shippedFolder } from "../src/roles.ts";
import { RpcChannel } from "../src/rpc.ts";
import { realTimers } from "../src/host.ts";
import { skipUnlessRealSandbox } from "../../jig-sandbox/test/support/programs.ts";
import { startWorld, until } from "./world.ts";
import type { ScreenScript, World } from "./world.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");
const MODEL_EXTENSION = path.resolve(import.meta.dirname, "support/scripted-model.ts");
const PI_BIN = process.env.JIG_AGENTS_TEST_PI ?? path.join(path.dirname(process.execPath), "pi");

/** The stock Pi, found as the plugin finds its own: through the link to its entry file. */
function stock(): { pi: PiCommand } | { skip: string } {
    if (!existsSync(PI_BIN)) return { skip: `no Pi at ${PI_BIN} (set JIG_AGENTS_TEST_PI)` };
    const pi = thisPi([process.execPath, PI_BIN], process.execPath);
    const entry = pi.args[0];
    if (entry === undefined) return { skip: `${PI_BIN} is not a Pi entry file that can be run with Node` };
    let manifest: { name?: string; version?: string };
    try {
        manifest = JSON.parse(
            readFileSync(path.resolve(path.dirname(entry), "../../package.json"), "utf8"),
        ) as typeof manifest;
    } catch {
        return { skip: `${PI_BIN} does not sit in a Pi package` };
    }
    if (manifest.name !== "@earendil-works/pi-coding-agent" || !/^1\./.test(manifest.version ?? "")) {
        return { skip: `${PI_BIN} is ${manifest.name} ${manifest.version}, not Pi 1.x` };
    }
    return { pi };
}

const found = stock();
const skip = "skip" in found ? found.skip : false;

interface Folders {
    root: string;
    agent: string;
    home: string;
    script: string;
}

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temporary agent folder for the child: the packages Jig loads, the scripted model, and the user's jig.json. */
function folders(
    options: {
        jig?: boolean;
        /** Also load jig-sandbox in the child, so that its `bash` runs in the real sandbox. */
        sandbox?: boolean;
        config?: unknown;
        steps?: unknown[];
        roles?: Record<string, string>;
    } = {},
): Folders {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-agents-real-")));
    roots.push(root);
    const agent = path.join(root, "agent");
    const home = path.join(root, "home");
    mkdirSync(agent, { recursive: true });
    mkdirSync(home, { recursive: true });
    const jig = options.jig !== false;
    writeFileSync(
        path.join(agent, "settings.json"),
        JSON.stringify({
            extensions: [MODEL_EXTENSION],
            packages: jig
                ? [
                      {
                          source: REPO,
                          extensions: [
                              "plugins/jig-core/src/index.ts",
                              "plugins/jig-agents/src/index.ts",
                              ...(options.sandbox === true ? ["plugins/jig-sandbox/src/index.ts"] : []),
                          ],
                          skills: [],
                          prompts: [],
                          themes: [],
                      },
                  ]
                : [],
        }),
    );
    writeFileSync(path.join(agent, "jig.json"), JSON.stringify(options.config ?? {}));
    // Roles with the test tools: the shipped roles list only the tools a real role needs, and the real child has no jig-sandbox, so none of
    // these lists bash.
    mkdirSync(path.join(agent, "agents"));
    const roles: Record<string, string> = {
        tester: "---\ndescription: Uses the tools of the test\ntools: read, ask_tool, echo_tool, write_tool\nwrites: false\n---\nYou use the tools you are told to.\n",
        ...options.roles,
    };
    for (const [name, text] of Object.entries(roles)) writeFileSync(path.join(agent, "agents", `${name}.md`), text);
    const script = path.join(root, "model-script.json");
    writeFileSync(script, JSON.stringify({ steps: options.steps ?? [{ text: "hello" }] }));
    return { root, agent, home, script };
}

/**
 * Says which plugin two tools belong to, as the child's scripted model does for `echo_tool`, so that a skill of `jig-test` follows the
 * role that has `echo_tool` and a skill of `jig-other` follows `other_tool`, which no test role has.
 */
const toolsAreDeclared: ExtensionFactory = () => {
    const read = { environment: "local", effect: "read" as const };
    withJig((api) => {
        api.declareTool({ tool: "echo_tool", plugin: "jig-test", classify: () => read });
        api.declareTool({ tool: "other_tool", plugin: "jig-other", classify: () => read });
    });
};

async function realWorld(
    f: Folders,
    over: {
        ui?: ScreenScript;
        config?: Record<string, unknown>;
        skills?: string[];
        host?: Partial<Host>;
        /** Commands the parent has. The real child loads jig-core and jig-agents only, unless the folders say jig-sandbox too. */
        commands?: string[];
    } = {},
): Promise<World> {
    const pi = (found as { pi: PiCommand }).pi;
    return startWorld({
        ...(over.ui === undefined ? {} : { ui: over.ui }),
        ...(over.skills === undefined ? {} : { skills: over.skills }),
        config: over.config ?? {},
        repo: false,
        commands: over.commands ?? [],
        extensions: [toolsAreDeclared],
        env: {
            PI_CODING_AGENT_DIR: f.agent,
            PI_FAKE_MODEL_SCRIPT: f.script,
            PI_OFFLINE: "1",
            HOME: f.home,
        },
        host: { piCommand: () => pi, ...over.host },
    });
}

let w: World | undefined;
afterEach(async () => {
    await w?.close();
    w = undefined;
});

const aliveProcess = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("the stock Pi as a child", { skip }, () => {
    test("starts in RPC mode with the plugin's flags and environment, lists jig-core's and jig-agents' commands, aborts and ends when its input closes", {
        timeout: 60_000,
    }, async (t: TestContext) => {
        const f = folders();
        const role = loadRoles([shippedFolder()]).roles.get("scout");
        assert.ok(role);
        const flags = flagsFor({
            role,
            model: { model: "faux/faux-1", thinking: "off", source: "role" },
            sessionId: "agent-real01",
            promptFile: path.join(f.root, "prompt.md"),
            // Pi takes the flags the plugin adds for what a child reads: no skills, and no AGENTS.md or CLAUDE.md.
            skillFiles: [],
            context: "none",
        });
        writeFileSync(path.join(f.root, "prompt.md"), "You are a scout.");
        const env = childEnvironment(
            {
                PATH: process.env.PATH,
                HOME: f.home,
                PI_CODING_AGENT_DIR: f.agent,
                PI_FAKE_MODEL_SCRIPT: f.script,
                PI_OFFLINE: "1",
                AWS_PROFILE: "must-not-pass",
            },
            [],
            {
                id: "real01",
                name: "tester-1",
                role: "scout",
                parentSession: "parent-1",
                parentPid: process.pid,
                policy: writeRolePolicy({ role: "scout", writes: false, actions: { git: ["status"] }, ask: {} }),
            },
        );
        assert.equal(env.AWS_PROFILE, undefined);
        const cwd = path.join(f.root, "work");
        mkdirSync(cwd);
        const pi = (found as { pi: PiCommand }).pi;
        const proc = spawn(pi.file, [...pi.args, ...flags], {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
        });
        t.after(() => {
            try {
                process.kill(-(proc.pid as number), "SIGKILL");
            } catch {
                // Ended already.
            }
        });
        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
        const channel = new RpcChannel(
            proc.stdout,
            proc.stdin,
            { event: () => undefined, ui: () => undefined, unreadable: () => undefined, closed: () => undefined },
            { timers: realTimers },
        );

        const commands = (await channel.request({ type: "get_commands" })) as {
            commands: Array<{ name: string; source: string }>;
        };
        const names = commands.commands.map((command) => command.name);
        assert.ok(names.includes("jig"), `jig-core's /jig in ${names.join(", ")}`);
        assert.ok(names.includes("agents"), "jig-agents' /agents, which a child loads too");
        const state = (await channel.request({ type: "get_state" })) as {
            sessionId: string;
            model: { provider: string; id: string };
        };
        assert.equal(state.sessionId, "agent-real01", "--session-id is honoured");
        assert.equal(`${state.model.provider}/${state.model.id}`, "faux/faux-1", "--model picks the scripted model");
        await channel.request({ type: "abort" });
        channel.endInput();
        assert.equal(await exited, 0, `a clean exit when its input closes. stderr: ${stderr.slice(-300)}`);
    });

    test("a child notices that its parent is gone and shuts itself down", {
        timeout: 60_000,
    }, async (t: TestContext) => {
        const f = folders();
        const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        await new Promise((resolve) => dead.once("exit", resolve));
        const pi = (found as { pi: PiCommand }).pi;
        const cwd = path.join(f.root, "work");
        mkdirSync(cwd);
        const proc = spawn(pi.file, [...pi.args, "--mode", "rpc", "--no-approve"], {
            cwd,
            env: {
                PATH: process.env.PATH,
                HOME: f.home,
                PI_CODING_AGENT_DIR: f.agent,
                PI_OFFLINE: "1",
                PI_SUBAGENT_ID: "orphan",
                PI_SUBAGENT_PARENT_PID: String(dead.pid),
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        t.after(() => proc.kill("SIGKILL"));
        const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
        // Its input stays open: only the check on its parent can end it, within about ten seconds.
        const code = await Promise.race([
            exited,
            new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 40_000)),
        ]);
        assert.equal(code, 0);
    });
});

describe("a real child run by the plugin, with the scripted model", { skip }, () => {
    test("asks through jig-core, the question reaches the screen, a yes lets the tool run, and the report comes back", {
        timeout: 90_000,
    }, async () => {
        const f = folders({
            steps: [{ tool: "ask_tool", args: { note: "go" } }, { textFromLastToolResult: "Report: " }],
        });
        w = await realWorld(f, { ui: { select: () => "Allow" } });
        const started = await w.tool({ action: "start", role: "tester", task: "use the tool that asks" });
        assert.equal(started.isError, false, started.text);
        const message = await w.deliver();
        assert.match(message.content, /Report: ask_tool ran/);
        assert.equal(w.ui.selects.length, 1);
        const { title, options } = w.ui.selects[0] as { title: string; options: string[] };
        assert.match(
            title,
            /^Subagent "tester-1" \(tester\) asks\. The text below comes from the child\.\n {2}jig-test {2}ask_tool|^Subagent "tester-1" \(tester\) asks\. The text below comes from the child\.\n {2}/,
        );
        assert.match(title, /ask_tool/);
        assert.deepEqual(options, ["Allow", "Allow for this subagent", "Decline"]);
        assert.equal(message.details.watches[0].outcome, "passed");
    });

    test("a no stops the tool, and jig-core's follow-up question reaches the screen as an input", {
        timeout: 90_000,
    }, async () => {
        const f = folders({ steps: [{ tool: "ask_tool", args: {} }, { textFromLastToolResult: "Report: " }] });
        w = await realWorld(f, { ui: { select: () => "Decline", input: () => "not today" } });
        await w.tool({ action: "start", role: "tester", task: "use the tool that asks" });
        const message = await w.deliver();
        assert.doesNotMatch(message.content, /ask_tool ran/);
        assert.match(message.content, /Report: .*(declin|block|not allowed)/is);
        assert.equal(w.ui.selects.length, 1);
        assert.equal(w.ui.inputs.length, 1, "the reason the child's jig-core asks for after a decline");
        assert.match((w.ui.inputs[0] as { title: string }).title, /Why decline\?/);
        assert.match(message.content, /not today/, "what you typed reaches the child's model");
    });

    test("'Allow for this subagent' covers the rest of that child's calls and ends with it", {
        timeout: 90_000,
    }, async () => {
        const f = folders({
            steps: [
                { tool: "ask_tool", args: { note: "one" } },
                { tool: "ask_tool", args: { note: "two" } },
                { text: "both ran" },
            ],
        });
        w = await realWorld(f, { ui: { select: () => "Allow for this subagent" } });
        await w.tool({ action: "start", role: "tester", task: "twice" });
        const first = await w.deliver();
        assert.match(first.content, /both ran/);
        assert.equal(w.ui.selects.length, 1, "asked once, for two calls");
        // A second child starts with nothing allowed: the session answer was the first child's alone.
        const second = await w.tool({ action: "start", role: "tester", task: "again" });
        assert.equal(second.isError, false, second.text);
        await w.deliver(2);
        assert.equal(w.ui.selects.length, 2, "the second child asks again");
    });

    test("no screen to ask on is a no: the tool does not run", { timeout: 90_000 }, async () => {
        const f = folders({ steps: [{ tool: "ask_tool", args: {} }, { textFromLastToolResult: "Report: " }] });
        w = await realWorld(f);
        await w.tool({ action: "start", role: "tester", task: "x" });
        (w.rt as unknown as { ctx: unknown }).ctx = { hasUI: false };
        const message = await w.deliver();
        assert.doesNotMatch(message.content, /ask_tool ran/);
        assert.equal(w.ui.selects.length, 0);
    });

    test("a turn limit stops a looping real child: told to wrap up, aborted, and its process ends", {
        timeout: 90_000,
    }, async () => {
        const f = folders({ steps: [{ loop: { tool: "echo_tool" } }] });
        w = await realWorld(f, { config: { agents: { limits: { maxTurns: 2 } } } });
        await w.tool({ action: "start", role: "tester", task: "loop" });
        const pidOf = (): number => (w?.rt.find("tester-1")?.pid ?? 0) as number;
        const pid = pidOf();
        assert.ok(pid > 0);
        const message = await w.deliver();
        assert.match(message.content, /tester-1 stopped at the turn limit \(2 turns\)/);
        assert.equal(w.rt.find("tester-1")?.outcome?.limit, "turns");
        await until(() => !aliveProcess(pid), "the real Pi to end", 20_000);
    });

    test("ending the parent's session ends a real child that is waiting on a question", {
        timeout: 90_000,
    }, async () => {
        const f = folders({ steps: [{ tool: "ask_tool", args: {} }, { text: "never" }] });
        w = await realWorld(f, { ui: { select: () => new Promise(() => undefined) } });
        await w.tool({ action: "start", role: "tester", task: "wait" });
        const pid = w.rt.find("tester-1")?.pid as number;
        await until(() => (w?.ui.selects.length ?? 0) === 1, "the question", 30_000);
        assert.ok(aliveProcess(pid));
        await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await until(() => !aliveProcess(pid), "the real Pi to end", 20_000);
    });

    test("a Pi that did not load jig-core is refused before it gets its task, and ended", {
        timeout: 90_000,
    }, async () => {
        const f = folders({ jig: false });
        w = await realWorld(f);
        const refused = await w.tool({ action: "start", role: "tester", task: "secret task" });
        assert.equal(refused.isError, true);
        assert.match(
            refused.text,
            /does not list the \/jig, \/agents commands, so it did not load the same plugins as this session/,
        );
        assert.equal(w.rt.children.size, 0);
    });

    test("resumes a finished real child in a new process, from the session file it saved", {
        timeout: 90_000,
    }, async () => {
        const f = folders({ steps: [{ text: "first answer" }] });
        w = await realWorld(f);
        const started = await w.tool({ action: "start", role: "tester", task: "the first part" });
        await w.deliver();
        const firstPid = w.rt.find("tester-1")?.pid as number;
        await until(() => !aliveProcess(firstPid), "the first process to end", 20_000);

        writeFileSync(f.script, JSON.stringify({ steps: [{ text: "second answer" }] }));
        const resumed = await w.tool({ action: "message", child: "tester-1", text: "and now the second part" });
        assert.match(resumed.text, /running again in a new process from its saved session/);
        const second = await w.deliver(2);
        assert.match(second.content, /second answer/);
        assert.notEqual(w.rt.find("tester-1")?.pid, firstPid);

        // One session file holds both tasks: the second process continued the first one's session.
        const sessions = path.join(f.agent, "sessions");
        const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) =>
            name.endsWith(`_agent-${started.details.child}.jsonl`),
        );
        assert.equal(files.length, 1, `one session file for the child in ${files.join(", ")}`);
        const text = readFileSync(path.join(sessions, files[0] as string), "utf8");
        assert.match(text, /the first part/);
        assert.match(text, /and now the second part/);
    });

    test("the child's records name its role and its parent's session", { timeout: 90_000 }, async () => {
        const f = folders({ steps: [{ tool: "echo_tool", args: {} }, { text: "done" }] });
        w = await realWorld(f);
        await w.tool({ action: "start", role: "tester", task: "x" });
        await w.deliver();
        const dir = path.join(w.stateDir, "records");
        const lines = readdirSync(dir).flatMap((name) =>
            readFileSync(path.join(dir, name), "utf8")
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as Record<string, any>),
        );
        const childCalls = lines.filter((record) => record.kind === "call" && record.agentRole === "tester");
        assert.ok(childCalls.length >= 1, "a call record written by the child");
        assert.ok(childCalls.every((record) => record.parentSession === w?.session.sessionManager.getSessionId()));
        assert.ok(childCalls.some((record) => record.tool === "echo_tool"));
    });
});

/** A real Pi started by hand with the flags and policy a parent would give it, for a test of what the child itself does. */
async function spawnChild(
    t: TestContext,
    f: Folders,
    options: { policy: string; flags: string[]; script: unknown[] },
): Promise<{ run(): Promise<string>; stderr(): string }> {
    writeFileSync(f.script, JSON.stringify({ steps: options.script }));
    const cwd = path.join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const pi = (found as { pi: PiCommand }).pi;
    const env = childEnvironment(
        {
            PATH: process.env.PATH,
            HOME: f.home,
            PI_CODING_AGENT_DIR: f.agent,
            PI_FAKE_MODEL_SCRIPT: f.script,
            PI_OFFLINE: "1",
        },
        [],
        {
            id: "hand01",
            name: "hand-1",
            role: "hand",
            parentSession: "parent-1",
            parentPid: process.pid,
            policy: options.policy,
        },
    );
    const proc = spawn(
        pi.file,
        [...pi.args, "--mode", "rpc", "--no-approve", "--model", "faux/faux-1", ...options.flags],
        {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
        },
    );
    t.after(() => {
        try {
            process.kill(-(proc.pid as number), "SIGKILL");
        } catch {
            // Ended already.
        }
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    let settled: (() => void) | undefined;
    const channel = new RpcChannel(
        proc.stdout,
        proc.stdin,
        {
            event: (event) => {
                if (event.type === "agent_settled") settled?.();
            },
            ui: () => undefined,
            unreadable: () => undefined,
            closed: () => undefined,
        },
        { timers: realTimers },
    );
    return {
        stderr: () => stderr,
        async run() {
            const done = new Promise<void>((resolve) => {
                settled = resolve;
            });
            await channel.request({ type: "prompt", message: "go" });
            await Promise.race([
                done,
                new Promise((_resolve, reject) =>
                    setTimeout(() => reject(new Error(`no answer. stderr: ${stderr.slice(-300)}`)), 40_000),
                ),
            ]);
            const last = (await channel.request({ type: "get_last_assistant_text" })) as { text?: string };
            return last.text ?? "";
        },
    };
}

describe("a real child enforces the narrowing its role gave it", { skip }, () => {
    const roles = {
        actioner:
            "---\ndescription: Looks, does not peek\ntools: read, act_tool\nactions: act_tool look\nwrites: false\n---\nYou look.\n",
        asker: "---\ndescription: Looks, after asking\ntools: read, act_tool\nask: act_tool look\nwrites: false\n---\nYou look.\n",
    };

    test("a role that may not write: the child's own gate refuses a write and names the role, and a read runs", {
        timeout: 90_000,
    }, async () => {
        const f = folders({ steps: [{ tool: "write_tool", args: {} }, { textFromLastToolResult: "Report: " }] });
        w = await realWorld(f);
        await w.tool({ action: "start", role: "tester", task: "write" });
        const refused = await w.deliver();
        assert.match(
            refused.content,
            /Report: .*Blocked by jig-core: the role "tester" may not write, and write_tool writes/,
        );
        assert.equal(w.ui.selects.length, 0, "nobody was asked: the role decided");

        writeFileSync(
            f.script,
            JSON.stringify({ steps: [{ tool: "echo_tool", args: {} }, { textFromLastToolResult: "Report: " }] }),
        );
        await w.tool({ action: "start", role: "tester", task: "read" });
        assert.match((await w.deliver(2)).content, /Report: echo/);
    });

    test("actions: an action the role does not list is refused, whatever the tool's own rules say", {
        timeout: 90_000,
    }, async () => {
        const f = folders({
            roles,
            steps: [{ tool: "act_tool", args: { action: "peek" } }, { textFromLastToolResult: "Report: " }],
        });
        w = await realWorld(f);
        await w.tool({ action: "start", role: "actioner", task: "peek" });
        assert.match(
            (await w.deliver()).content,
            /Report: .*the role "actioner" may run only act_tool look; act_tool peek is not one of them/,
        );

        writeFileSync(
            f.script,
            JSON.stringify({
                steps: [{ tool: "act_tool", args: { action: "look" } }, { textFromLastToolResult: "Report: " }],
            }),
        );
        await w.tool({ action: "start", role: "actioner", task: "look" });
        assert.match((await w.deliver(2)).content, /Report: act_tool look ran/);
    });

    test("ask: an action the rules allow asks anyway, in the parent's dialog, with the role in the question", {
        timeout: 90_000,
    }, async () => {
        const f = folders({
            roles,
            steps: [
                { tool: "act_tool", args: { action: "peek" } },
                { tool: "act_tool", args: { action: "look" } },
                { textFromLastToolResult: "Report: " },
            ],
        });
        w = await realWorld(f, { ui: { select: () => "Allow" } });
        await w.tool({ action: "start", role: "asker", task: "look" });
        assert.match((await w.deliver()).content, /Report: act_tool look ran/);
        assert.equal(w.ui.selects.length, 1, "peek ran without a question; look asked");
        assert.match(
            JSON.stringify(w.ui.selects[0]),
            /Asked by role-policy: the role \\"asker\\" asks before act_tool look/,
        );
    });

    test("a policy the child cannot read is refused at start, as a plugin that failed to load is, and the task is never sent", {
        timeout: 90_000,
    }, async () => {
        const f = folders();
        const real = realHost();
        w = await realWorld(f, {
            host: {
                spawn: (file, args, options) =>
                    real.spawn(file, args, {
                        ...options,
                        env: { ...options.env, [ROLE_POLICY_VARIABLE]: "{not a policy" },
                    }),
            },
        });
        const refused = await w.tool({ action: "start", role: "tester", task: "secret task" });
        assert.equal(refused.isError, true);
        assert.match(
            refused.text,
            /a plugin failed to load in the child: .*JIG_ROLE_POLICY cannot be read \(the policy is not JSON\); every call is refused until the agent is started again/,
        );
        assert.equal(w.rt.children.size, 0);
    });

    test("bash in a read-only role, in a child with no sandbox: the child refuses it", {
        timeout: 90_000,
    }, async (t: TestContext) => {
        const f = folders();
        const child = await spawnChild(t, f, {
            policy: writeRolePolicy({ role: "reader", writes: false, actions: {}, ask: {} }),
            flags: ["--tools", "read,bash"],
            script: [{ tool: "bash", args: { command: "echo hi" } }, { textFromLastToolResult: "Report: " }],
        });
        const report = await child.run();
        assert.match(
            report,
            /Report: .*Blocked by jig-core: the role "reader" may not write, and its bash is read-only only inside jig-sandbox, which is not active in this agent/,
        );
        assert.doesNotMatch(report, /\bhi\b/);
    });

    test("a child whose policy says it may write runs bash as before", { timeout: 90_000 }, async (t: TestContext) => {
        const f = folders();
        // `bash` is a local write that jig-core's rules allow; a writing role is not narrowed. The command is harmless.
        const child = await spawnChild(t, f, {
            policy: writeRolePolicy({ role: "doer", writes: true, actions: {}, ask: {} }),
            flags: ["--tools", "read,bash"],
            script: [{ tool: "bash", args: { command: "echo only-a-test" } }, { textFromLastToolResult: "Report: " }],
        });
        assert.match(await child.run(), /Report: .*only-a-test/);
    });
});

/** The real sandbox needs bubblewrap and its friends; without them the test that uses it says why it is skipped. */
const sandboxSkip = skip === false ? skipUnlessRealSandbox() : skip;

describe("a real child with the real sandbox runs a read-only bash", { skip: sandboxSkip }, () => {
    const roles = {
        sleuth: "---\ndescription: Reads with a shell\ntools: read, bash\nwrites: false\n---\nYou look around.\n",
    };

    test("it reads, writes /tmp, and cannot write its working folder, which the sandbox says and the gate allowed", {
        timeout: 120_000,
    }, async () => {
        const command =
            'd=$(mktemp -d /tmp/jig-sleuth-XXXXXX); echo scratch > "$d/f"; cat "$d/f"; rm -r "$d"; ' +
            'ls; echo nope > ./made-by-the-sleuth.txt; echo "exit: $?"';
        const f = folders({
            sandbox: true,
            roles,
            steps: [{ tool: "bash", args: { command } }, { textFromLastToolResult: "Report: " }],
        });
        w = await realWorld(f, { commands: ["sandbox"] });
        writeFileSync(path.join(w.cwd, "kept.txt"), "kept\n");
        const started = await w.tool({ action: "start", role: "sleuth", task: "look" });
        assert.equal(started.isError, false, started.text);
        const report = (await w.deliver()).content;
        assert.match(report, /scratch/, "/tmp is writable");
        assert.match(report, /kept\.txt/, "the working folder is readable");
        assert.match(report, /exit: [1-9]/, "the write failed");
        assert.match(report, /\[sandbox\] cannot write .*made-by-the-sleuth\.txt: this agent's role may not write/);
        assert.equal(existsSync(path.join(w.cwd, "made-by-the-sleuth.txt")), false);
        assert.equal(readFileSync(path.join(w.cwd, "kept.txt"), "utf8"), "kept\n");
    });

    test("bash with outside: true is refused by the gate before anyone is asked", { timeout: 120_000 }, async () => {
        const args = {
            command: "echo escaped > /tmp/jig-outside-test",
            outside: true,
            reason: "the sandbox is in the way",
        };
        const f = folders({
            sandbox: true,
            roles,
            steps: [{ tool: "bash", args }, { textFromLastToolResult: "Report: " }],
        });
        w = await realWorld(f, { commands: ["sandbox"], ui: { select: () => "Allow" } });
        await w.tool({ action: "start", role: "sleuth", task: "go outside" });
        assert.match((await w.deliver()).content, /Report: .*the role "sleuth" may not write, and bash outside writes/);
        assert.equal(w.ui.selects.length, 0);
        assert.equal(existsSync("/tmp/jig-outside-test"), false);
    });
});

describe("a real child reads only what its role gave it", { skip }, () => {
    /** Three skills the parent has, and two more that belong to plugins, one of which declares a tool the role has. */
    function parentSkills(root: string): string[] {
        const make = (where: string, name: string, body = `${name} body\n`): string => {
            const dir = path.join(root, "skills", where, name);
            mkdirSync(dir, { recursive: true });
            const file = path.join(dir, "SKILL.md");
            writeFileSync(file, `---\nname: ${name}\ndescription: About ${name}. Use it when asked.\n---\n${body}`);
            return file;
        };
        return [
            make("mine", "alpha-skill"),
            make("mine", "beta-skill", "BETA-BODY-MARKER\n"),
            make("mine", "gamma-skill"),
            make("plugins/jig-test/skills", "delta-skill"),
            make("plugins/jig-other/skills", "eps-skill"),
        ];
    }
    const inspect = [
        "AGENTS-MARKER-LINE",
        "BETA-BODY-MARKER",
        "alpha-skill",
        "beta-skill",
        "gamma-skill",
        "delta-skill",
        "eps-skill",
    ];
    const reader = (more: string): Record<string, string> => ({
        reader: `---\ndescription: Reads with chosen skills\ntools: read, echo_tool\nwrites: false\n${more}\n---\nYou read.\n`,
    });

    /** Starts the role in a real child and returns which markers its model was given, by marker. */
    async function seen(
        role: string,
        files: Record<string, string>,
        config?: Record<string, unknown>,
    ): Promise<Record<string, boolean>> {
        const f = folders({ roles: files, steps: [{ inspect }] });
        w = await realWorld(f, { skills: parentSkills(f.root), ...(config === undefined ? {} : { config }) });
        writeFileSync(path.join(w.cwd, "AGENTS.md"), "# Notes\n\nAGENTS-MARKER-LINE\n");
        const started = await w.tool({ action: "start", role, task: "look" });
        assert.equal(started.isError, false, started.text);
        const text = (await w.deliver()).content;
        const found = /prompt has: (.*)/.exec(text)?.[1] ?? "";
        const result = Object.fromEntries(found.split("; ").map((pair) => pair.split("=") as [string, string]));
        assert.deepEqual(Object.keys(result), inspect, text);
        return Object.fromEntries(Object.entries(result).map(([marker, answer]) => [marker, answer === "yes"]));
    }

    test("by default the skills follow the tools: the role's own plugin, and what nobody owns, but not another plugin's", {
        timeout: 90_000,
    }, async () => {
        const result = await seen("reader", reader(""));
        // The task says the markers nowhere, so a yes is the system prompt: the skills Pi listed, and the project's instructions.
        assert.deepEqual(
            [
                result["alpha-skill"],
                result["beta-skill"],
                result["gamma-skill"],
                result["delta-skill"],
                result["eps-skill"],
            ],
            [true, true, true, true, false],
        );
        assert.equal(result["AGENTS-MARKER-LINE"], true, "project instructions are read by default");
        assert.equal(result["BETA-BODY-MARKER"], false, "a skill is listed, not loaded");
    });

    test("a list of skills is exactly those; a preloaded one is in the instructions whole; context none leaves AGENTS.md out", {
        timeout: 90_000,
    }, async () => {
        const result = await seen(
            "reader",
            reader("skills: alpha-skill, beta-skill\npreload: beta-skill\ncontext: none"),
        );
        assert.deepEqual(
            [
                result["alpha-skill"],
                result["beta-skill"],
                result["gamma-skill"],
                result["delta-skill"],
                result["eps-skill"],
            ],
            [true, true, false, false, false],
        );
        assert.equal(result["BETA-BODY-MARKER"], true, "the preloaded skill's text is in the child's instructions");
        assert.equal(result["AGENTS-MARKER-LINE"], false, "context none: AGENTS.md is not read");
    });

    test("configuration replaces the file's skills, preload and context", { timeout: 90_000 }, async () => {
        const result = await seen("reader", reader("skills: alpha-skill\ncontext: none"), {
            agents: { roles: { reader: { skills: ["gamma-skill"], context: "project" } } },
        });
        assert.deepEqual(
            [result["alpha-skill"], result["gamma-skill"], result["BETA-BODY-MARKER"], result["AGENTS-MARKER-LINE"]],
            [false, true, false, true],
        );
    });

    test("none lists no skill at all", { timeout: 90_000 }, async () => {
        const result = await seen("reader", reader("skills: none"));
        for (const name of ["alpha-skill", "beta-skill", "gamma-skill", "delta-skill", "eps-skill"]) {
            assert.equal(result[name], false, name);
        }
    });
});
