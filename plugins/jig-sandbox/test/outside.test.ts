// Running one command outside the sandbox, with the real jig-core in the same fake Pi: it asks by default, a rule that names
// it allows it, a wildcard does not, no screen refuses, the answer for a session covers one exact command, the output still
// goes through the result pipeline, and it is recorded.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jig, withdrawJig } from "../../jig-core/src/client.ts";
import { jigCore } from "../../jig-core/src/index.ts";
import { readRecords } from "../../jig-core/test/support/state.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { sandbox } from "../src/index.ts";
import { fakeBrokers } from "./support/fake-broker.ts";
import { fakeContext, fakePi } from "./support/fake-pi.ts";

let root: string;

/** Takes jig-core's API away, as a session ending does, so the next test loads its own. */
function unload(): void {
    try {
        withdrawJig(jig());
    } catch {
        // Nothing was loaded.
    }
}

const SAVED = {
    agent: process.env.PI_CODING_AGENT_DIR,
    state: process.env.JIG_STATE_DIR,
    token: process.env.MY_SERVICE_TOKEN,
};
beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-outside-test-")));
    process.env.JIG_STATE_DIR = path.join(root, "state");
    process.env.MY_SERVICE_TOKEN = "token-value-0123456789";
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [name, saved] of [
        ["PI_CODING_AGENT_DIR", SAVED.agent],
        ["JIG_STATE_DIR", SAVED.state],
        ["MY_SERVICE_TOKEN", SAVED.token],
    ] as const) {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
    }
    unload();
});

interface Session {
    pi: ReturnType<typeof fakePi>;
    ctx: ReturnType<typeof fakeContext>;
    brokers: ReturnType<typeof fakeBrokers>;
    sandboxed: string[];
    project: string;
    /** One tool call through jig-core's gate, the tool and jig-core's result pipeline. */
    call(
        input: Record<string, unknown>,
        options?: { id?: string; mutate?: (input: Record<string, unknown>) => void },
    ): Promise<{ blocked: boolean; text: string; ran: boolean }>;
    run(command: string, reason?: string): Promise<{ blocked: boolean; text: string; ran: boolean }>;
    asked(): Array<{ title: string; options: string[] }>;
    command(args: string): Promise<string[]>;
}

async function begin(
    over: {
        rules?: unknown[];
        ui?: boolean;
        select?: (title: string, options: string[]) => string | undefined;
        secrets?: boolean;
        core?: boolean;
    } = {},
): Promise<Session> {
    const home = path.join(root, "home");
    const project = path.join(home, "work", "orders");
    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(project, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
        path.join(agentDir, "jig.json"),
        JSON.stringify({
            rules: over.rules ?? [],
            ...(over.secrets === true ? { secrets: { backends: ["env"] } } : {}),
        }),
    );
    const pi = fakePi();
    if (over.core !== false)
        jigCore({ createMasker: () => ({ text: (text: string) => text, value: <T>(value: T): T => value }) as never })(
            pi.pi,
        );
    const brokers = fakeBrokers();
    const sandboxed: string[] = [];
    const dummy = process.execPath;
    sandbox({
        env: { ...process.env, HOME: home },
        platform: "linux",
        home: () => home,
        uid: 1000,
        wsl: false,
        tmpRoot: path.join(root, "tmp"),
        agentDir: () => agentDir,
        settings: () => ({ ...DEFAULT_SETTINGS, programs: { bwrap: dummy, socat: dummy, ripgrep: dummy } }),
        runtimePaths: () => [],
        startBroker: brokers.start,
        exec: async (command, _cwd, o) => {
            if (command === "echo jig-sandbox-probe") o.onData(Buffer.from("jig-sandbox-probe\n"));
            else sandboxed.push(command);
            return { exitCode: 0 };
        },
    })(pi.pi);
    const ctx = fakeContext({
        cwd: project,
        ...(over.ui === false ? { ui: false } : {}),
        ...(over.select === undefined ? {} : { select: over.select }),
    });
    await pi.fire("session_start", { reason: "startup" }, ctx.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    let counter = 0;

    const call: Session["call"] = async (input, options = {}) => {
        const id = options.id ?? `call-${++counter}`;
        const event = { toolCallId: id, toolName: "bash", input };
        const answer = (await pi.fire("tool_call", event, ctx.ctx)) as { block?: boolean; reason?: string } | undefined;
        if (answer?.block === true) return { blocked: true, text: answer.reason ?? "", ran: false };
        options.mutate?.(input);
        const tool = pi.tools.get("bash");
        let content: Array<{ type: string; text?: string }>;
        let isError = false;
        try {
            const result = await tool?.execute(id, input as never, undefined, undefined, ctx.ctx as never);
            content = (result?.content ?? []) as typeof content;
        } catch (error) {
            content = [{ type: "text", text: (error as Error).message }];
            isError = true;
        }
        const replacement = (await pi.fire(
            "tool_result",
            { ...event, content, details: undefined, isError },
            ctx.ctx,
        )) as { content?: typeof content } | undefined;
        const final = replacement?.content ?? content;
        await pi.fire(
            "tool_execution_end",
            { toolCallId: id, toolName: "bash", result: { content: final }, isError },
            ctx.ctx,
        );
        return { blocked: false, text: final.map((part) => part.text ?? "").join(""), ran: !isError };
    };
    return {
        pi,
        ctx,
        brokers,
        sandboxed,
        project,
        call,
        run: (command, reason = "the integration tests need a database") => call({ command, outside: true, reason }),
        asked: () =>
            ctx.screen.selects.filter((item) => item.options.includes("Run once") || item.options.includes("Allow")),
        async command(args) {
            const before = ctx.screen.notifications.length;
            const selects = ctx.screen.selects.length;
            await pi.commands.get("sandbox")?.handler(args, ctx.ctx as never);
            return [
                ...ctx.screen.notifications.slice(before).flatMap((item) => item.message.split("\n")),
                ...ctx.screen.selects.slice(selects).flatMap((item) => item.options),
            ];
        },
    };
}

const RUN_ONCE = (_title: string, options: string[]): string | undefined =>
    options.includes("Run once") ? "Run once" : undefined;
const NAMING = { tool: "bash", action: "outside", command: "echo outside-*", decision: "allow" };

describe("asking", () => {
    test("it asks by default, showing the exact command, the folder, the reason and the warning, with its own words on the buttons", async () => {
        const s = await begin({ select: RUN_ONCE });
        const outcome = await s.run("echo outside-ran");
        assert.equal(outcome.blocked, false);
        const [question] = s.asked();
        assert.ok(question);
        assert.match(question.title, /bash · outside · local · write/);
        assert.match(question.title, /Run outside the sandbox\? It gets your credentials and full network\./);
        assert.match(question.title, /Command:  echo outside-ran/);
        assert.match(question.title, /Folder:   ~\/work\/orders/);
        assert.match(question.title, /Why:      the integration tests need a database/);
        assert.deepEqual(question.options, ["Run once", "This exact command, this session", "No"]);
    });

    test("an approved command runs with Pi's ordinary local operations: not wrapped, with Pi's environment", async () => {
        const s = await begin({ select: RUN_ONCE });
        const before = s.brokers.log.requests.filter((request) => request.type === "wrap").length;
        const outcome = await s.run("echo outside-ran; printenv MY_SERVICE_TOKEN");
        assert.match(outcome.text, /^outside-ran\ntoken-value-0123456789/);
        assert.equal(
            s.brokers.log.requests.filter((request) => request.type === "wrap").length,
            before,
            "the broker was not asked to wrap it",
        );
        assert.deepEqual(s.sandboxed, [], "and the sandbox's operations did not run it");
    });

    test("No stops it: nothing runs", async () => {
        const s = await begin({ select: (_title, options) => (options.includes("Run once") ? "No" : undefined) });
        const outcome = await s.run("echo outside-ran");
        assert.equal(outcome.blocked, true);
        assert.equal(outcome.ran, false);
        assert.match(outcome.text, /declined/);
    });

    test("an ordinary bash call is sandboxed and asks nothing", async () => {
        const s = await begin({ select: RUN_ONCE });
        await s.call({ command: "echo ordinary" });
        assert.deepEqual(s.asked(), []);
        assert.deepEqual(s.sandboxed, ["echo ordinary"]);
    });

    test("a request without a reason, with a long reason, or with a command too long to read is blocked and nobody is asked", async () => {
        const s = await begin({ select: RUN_ONCE });
        const noReason = await s.call({ command: "echo x", outside: true });
        assert.equal(noReason.blocked, true);
        assert.match(noReason.text, /outside needs a reason/);
        const longReason = await s.run("echo x", "r".repeat(301));
        assert.match(longReason.text, /at most 300/);
        const longCommand = await s.run(`echo ${"x".repeat(1_000)}`);
        assert.match(longCommand.text, /too long to show in full/);
        assert.deepEqual(s.asked(), []);
    });

    test("a command that holds control characters is shown with them made visible", async () => {
        const s = await begin({ select: RUN_ONCE });
        await s.run("echo safe\rrm -rf /tmp/x\u001b[2J");
        const title = s.asked()[0]?.title ?? "";
        assert.ok(!title.includes("\r") && !title.includes("\u001b"));
        assert.match(title, /echo safe\\x0drm -rf \/tmp\/x\\x1b\[2J/);
    });
});

describe("rules", () => {
    test("a rule that names the tool, the action and the command allows it without asking, and /sandbox lists the run", async () => {
        const s = await begin({ rules: [NAMING], select: RUN_ONCE });
        const outcome = await s.run("echo outside-from-rule");
        assert.equal(outcome.blocked, false);
        assert.match(outcome.text, /outside-from-rule/);
        assert.deepEqual(s.asked(), []);
        const listing = (await s.command("")).join("\n");
        assert.match(listing, /Run outside the sandbox this session \(1\):/);
        assert.match(listing, /echo outside-from-rule/);
        assert.match(listing, /in ~\/work\/orders, allowed by a rule; why: the integration tests need a database/);
    });

    test("the same rule does not allow another command", async () => {
        const s = await begin({ rules: [NAMING], select: RUN_ONCE });
        await s.run("echo different");
        assert.equal(s.asked().length, 1);
    });

    test("a wildcard rule, a rule with no action and a rule with no command do not allow it", async () => {
        for (const rule of [
            { tool: "*", decision: "allow" },
            { tool: "bash", decision: "allow" },
            { tool: "bash", command: "echo *", decision: "allow" },
            { tool: "bash", action: "outside", decision: "allow" },
            { tool: "bash", action: "outside", command: "*", decision: "allow" },
        ]) {
            const s = await begin({ rules: [rule], select: RUN_ONCE });
            await s.run("echo wild");
            assert.equal(s.asked().length, 1, JSON.stringify(rule));
            unload();
            rmSync(root, { recursive: true, force: true });
            root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-outside-test-")));
            process.env.JIG_STATE_DIR = path.join(root, "state");
        }
    });

    test("with no screen it is refused", async () => {
        const s = await begin({ ui: false });
        const outcome = await s.run("echo outside-ran");
        assert.equal(outcome.blocked, true);
        assert.match(outcome.text, /no screen/);
    });

    test("with no screen, a rule that names it still allows it", async () => {
        const s = await begin({ ui: false, rules: [NAMING] });
        assert.equal((await s.run("echo outside-headless")).blocked, false);
    });
});

describe("the answer for a session", () => {
    test("covers that exact command: the same text again does not ask, anything else does", async () => {
        const s = await begin({
            select: (_title, options) =>
                options.includes("Run once") ? "This exact command, this session" : undefined,
        });
        await s.run("echo one");
        assert.equal(s.asked().length, 1);
        await s.run("echo one");
        assert.equal(s.asked().length, 1, "the same command again");
        await s.run("echo two");
        assert.equal(s.asked().length, 2, "another command");
        await s.run("echo one ");
        assert.equal(s.asked().length, 3, "even one that differs by a space");
        const listing = (await s.command("")).join("\n");
        assert.match(listing, /Run outside the sandbox this session \(4\):/);
        assert.match(listing, /allowed this exact command, this session/);
    });
});

describe("the output and the record", () => {
    test("a secret that jig-core resolved is taken out of the output, as for any tool", async () => {
        const value = ["outside", "secret", "value", "0123456789"].join("-");
        process.env.JIG_OUTSIDE_PLUGIN_SECRET = value;
        try {
            const s = await begin({ select: RUN_ONCE, secrets: true });
            assert.equal(await jig().secrets.resolve("env:JIG_OUTSIDE_PLUGIN_SECRET"), value);
            const outcome = await s.run("echo the secret is $JIG_OUTSIDE_PLUGIN_SECRET today");
            assert.ok(!outcome.text.includes(value), outcome.text);
            assert.match(outcome.text, /the secret is .+ today/);
        } finally {
            delete process.env.JIG_OUTSIDE_PLUGIN_SECRET;
        }
    });

    test("terminal control sequences in the output are taken out", async () => {
        const s = await begin({ select: RUN_ONCE });
        const outcome = await s.run("printf '\\033[31mred\\033[0m \\033]0;title\\007done'");
        assert.equal(outcome.text, "red done");
    });

    test("it is recorded as its own action, with the fact that it ran outside, and never with the command", async () => {
        const s = await begin({ select: RUN_ONCE });
        await s.run("echo outside-recorded-command");
        const record = readRecords(process.env.JIG_STATE_DIR ?? "").find((entry) => entry.tool === "bash");
        assert.equal(record?.action, "outside");
        assert.deepEqual((record?.facts as Record<string, unknown> | undefined)?.outside, true);
        assert.equal(record?.decision, "ask");
        assert.equal(record?.answer, "allow");
        assert.ok(!JSON.stringify(record).includes("outside-recorded-command"));
    });
});

describe("it never runs unless jig-core let this call through", () => {
    test("a call that skipped jig-core's gate does not run outside", async () => {
        const s = await begin({ select: RUN_ONCE });
        const tool = s.pi.tools.get("bash");
        await assert.rejects(
            () =>
                tool?.execute(
                    "no-gate",
                    { command: "echo should-not-run", outside: true, reason: "x" } as never,
                    undefined,
                    undefined,
                    s.ctx.ctx as never,
                ) as Promise<unknown>,
            /bash was not run outside the sandbox: jig-core has not allowed this call/,
        );
    });

    test("a call that jig-core did not classify as outside does not run outside", async () => {
        const s = await begin({ select: RUN_ONCE });
        const tool = s.pi.tools.get("bash");
        // jig-core allowed an ordinary bash call; its id is then used to ask for outside.
        await s.pi.fire("tool_call", { toolCallId: "same", toolName: "bash", input: { command: "ls" } }, s.ctx.ctx);
        await assert.rejects(
            () =>
                tool?.execute(
                    "same",
                    { command: "echo should-not-run", outside: true, reason: "x" } as never,
                    undefined,
                    undefined,
                    s.ctx.ctx as never,
                ) as Promise<unknown>,
            /jig-core has not allowed this call/,
        );
    });

    test("a command that changed after the user was shown it does not run", async () => {
        const s = await begin({ select: RUN_ONCE });
        const outcome = await s.call(
            { command: "echo what-the-user-saw", outside: true, reason: "x" },
            { mutate: (input) => void (input.command = "echo something-else") },
        );
        assert.equal(outcome.ran, false);
        assert.match(outcome.text, /changed after the user was shown it/);
    });

    test("without jig-core nothing can run outside", async () => {
        const s = await begin({ core: false });
        const outcome = await s.call({ command: "echo should-not-run", outside: true, reason: "x" });
        assert.equal(outcome.ran, false);
        assert.match(outcome.text, /jig-core is not loaded/);
    });
});

describe("what the agent is told", () => {
    test("the tool has the two parameters and its description says when to use them", async () => {
        const s = await begin();
        const tool = s.pi.tools.get("bash");
        assert.ok(tool);
        const properties = (
            tool.parameters as unknown as { properties: Record<string, { description?: string; maxLength?: number }> }
        ).properties;
        assert.deepEqual(Object.keys(properties).sort(), ["command", "outside", "reason", "timeout"]);
        assert.equal(properties.reason?.maxLength, 300);
        assert.match(
            properties.outside?.description ?? "",
            /only when the sandbox blocks something you need and no Jig tool does it/i,
        );
        assert.match(tool.description, /set outside: true and give a reason \(at most 300 characters\)/);
    });

    test("/jig rules shows the ordinary action and the outside one", async () => {
        const s = await begin();
        await s.pi.commands.get("jig")?.handler("rules bash", s.ctx.ctx as never);
        const shown = s.ctx.screen.notifications.map((item) => item.message).join("\n");
        assert.match(shown, /bash: local write -> allow \(decision: table; classified by: default\)/);
        assert.match(shown, /bash outside: local write -> ask \(decision: tool; classified by: declaration\)/);
    });
});
