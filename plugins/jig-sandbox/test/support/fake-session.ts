// A session of the plugin with a fake Pi and a broker that does not sandbox (it hands the command back as it was given), and
// optionally the real jig-core in the same fake Pi. Background tasks run as real processes, so their lifecycle is tested
// on any machine; what the real sandbox adds is in the tests that run it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jig, withdrawJig } from "../../../jig-core/src/client.ts";
import { jigCore } from "../../../jig-core/src/index.ts";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import type { SandboxSettings } from "../../src/config.ts";
import { sandbox } from "../../src/index.ts";
import type { SandboxOptions } from "../../src/index.ts";
import { fakeBrokers } from "./fake-broker.ts";
import type { FakeBrokerOptions } from "./fake-broker.ts";
import { fakeContext, fakePi } from "./fake-pi.ts";
import type { FakeContext, FakePi } from "./fake-pi.ts";

export interface FakeSession {
    root: string;
    home: string;
    project: string;
    agentDir: string;
    pi: FakePi;
    ctx: FakeContext;
    brokers: ReturnType<typeof fakeBrokers>;
    /** Calls a tool directly, the way Pi runs it once it was allowed. */
    tool(
        name: string,
        input: Record<string, unknown>,
        context?: FakeContext,
    ): Promise<{ text: string; isError: boolean }>;
    /** Calls a tool through jig-core's gate first, so a classification that blocks it shows. */
    gated(
        name: string,
        input: Record<string, unknown>,
    ): Promise<{ blocked: boolean; text: string; isError: boolean; asked: number }>;
    command(name: string, args: string): Promise<string[]>;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    end(): Promise<void>;
}

export interface FakeSessionOptions {
    core?: boolean;
    ui?: boolean;
    select?: (title: string, options: string[]) => string | undefined;
    settings?: Partial<SandboxSettings>;
    broker?: FakeBrokerOptions;
    options?: SandboxOptions;
    env?: Record<string, string>;
    /** Written to jig.json before jig-core loads. */
    jigJson?: Record<string, unknown>;
    /** The mode of the fake context, for the check that tasks need an interactive session. */
    mode?: string;
}

const SAVED = {
    agent: process.env.PI_CODING_AGENT_DIR,
    state: process.env.JIG_STATE_DIR,
};

/** Takes jig-core's API away, as a session ending does, so the next test loads its own. */
export function unloadJig(): void {
    try {
        withdrawJig(jig());
    } catch {
        // Nothing was loaded.
    }
}

export function fakeSession(over: FakeSessionOptions = {}): FakeSession {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-fake-session-")));
    const home = path.join(root, "home");
    const project = path.join(home, "work", "orders");
    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(project, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    if (over.core === true) {
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.JIG_STATE_DIR = path.join(root, "state");
        writeFileSync(path.join(agentDir, "jig.json"), JSON.stringify(over.jigJson ?? {}));
    }
    const pi = fakePi();
    if (over.core === true) {
        jigCore({ createMasker: () => ({ text: (text: string) => text, value: <T>(value: T): T => value }) as never })(
            pi.pi,
        );
    }
    const brokers = fakeBrokers(over.broker);
    const dummy = process.execPath;
    const settings: SandboxSettings = {
        ...DEFAULT_SETTINGS,
        programs: { bwrap: dummy, socat: dummy, ripgrep: dummy },
        ...over.settings,
    };
    sandbox({
        env: {
            PATH: process.env.PATH ?? "/usr/bin",
            HOME: home,
            LANG: "C.UTF-8",
            MY_SERVICE_TOKEN: "token-value-0123456789",
            ...over.env,
        },
        platform: "linux",
        home: () => home,
        uid: 1000,
        wsl: false,
        tmpRoot: path.join(root, "tmp"),
        agentDir: () => agentDir,
        settings: () => settings,
        ...(over.core === true ? {} : { protectedPaths: () => [] }),
        runtimePaths: () => [],
        startBroker: brokers.start,
        exec: async (command, _cwd, o) => {
            if (command === "echo jig-sandbox-probe") o.onData(Buffer.from("jig-sandbox-probe\n"));
            return { exitCode: 0 };
        },
        // The shell a task runs in is the machine's own, and waits are short.
        background: {
            shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
            timing: { flushMs: 40, inFlightMs: 400, errorGapMs: 30_000, errorWakeups: 3 },
            graceMs: 300,
        },
        ...over.options,
    })(pi.pi);
    const ctx = fakeContext({
        cwd: project,
        ...(over.ui === undefined ? {} : { ui: over.ui }),
        ...(over.select === undefined ? {} : { select: over.select }),
    });
    if (over.mode !== undefined) (ctx.ctx as unknown as { mode: string }).mode = over.mode;
    let counter = 0;

    const session: FakeSession = {
        root,
        home,
        project,
        agentDir,
        pi,
        ctx,
        brokers,
        async tool(name, input, context = ctx) {
            const found = pi.tools.get(name);
            if (found === undefined) throw new Error(`no tool ${name}`);
            try {
                const result = await found.execute(
                    `call-${++counter}`,
                    input as never,
                    undefined,
                    undefined,
                    context.ctx as never,
                );
                return {
                    text: (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""),
                    isError: false,
                };
            } catch (error) {
                return { text: (error as Error).message, isError: true };
            }
        },
        async gated(name, input) {
            const id = `gated-${++counter}`;
            const asksBefore = ctx.screen.selects.length;
            const answer = (await pi.fire("tool_call", { toolCallId: id, toolName: name, input }, ctx.ctx)) as
                | { block?: boolean; reason?: string }
                | undefined;
            const asked = ctx.screen.selects.length - asksBefore;
            if (answer?.block === true) return { blocked: true, text: answer.reason ?? "", isError: false, asked };
            const found = pi.tools.get(name);
            try {
                const result = await found?.execute(id, input as never, undefined, undefined, ctx.ctx as never);
                const text = (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
                return { blocked: false, text, isError: false, asked };
            } catch (error) {
                return { blocked: false, text: (error as Error).message, isError: true, asked };
            }
        },
        async command(name, args) {
            const before = ctx.screen.notifications.length;
            const selects = ctx.screen.selects.length;
            await pi.commands.get(name)?.handler(args, ctx.ctx as never);
            return [
                ...ctx.screen.notifications.slice(before).flatMap((item) => item.message.split("\n")),
                ...ctx.screen.selects.slice(selects).flatMap((item) => [item.title, ...item.options]),
            ];
        },
        async start() {
            await pi.fire("session_start", { reason: "startup" }, ctx.ctx);
            // Session start does not wait for the sandbox, as a slow start must not hold Pi back; a command does.
            await new Promise((resolve) => setImmediate(resolve));
        },
        async shutdown() {
            await pi.fire("session_shutdown", { reason: "quit" }, ctx.ctx);
        },
        async end() {
            await session.shutdown();
            unloadJig();
            rmSync(root, { recursive: true, force: true });
            for (const [name, saved] of [
                ["PI_CODING_AGENT_DIR", SAVED.agent],
                ["JIG_STATE_DIR", SAVED.state],
            ] as const) {
                if (saved === undefined) delete process.env[name];
                else process.env[name] = saved;
            }
        },
    };
    return session;
}
