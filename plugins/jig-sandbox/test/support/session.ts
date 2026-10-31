// A whole session for the tests that run the real sandbox through the plugin: a fake Pi, the plugin with the real broker and
// the real runtime, a fake home with the real home's credential places hidden, and helpers that call the tools the way Pi
// would. Test safety is the same as in `world.ts`: nothing here reads a file under the real home.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import type { SandboxSettings } from "../../src/config.ts";
import { sandbox } from "../../src/index.ts";
import type { SandboxOptions } from "../../src/index.ts";
import { fakeContext, fakePi } from "./fake-pi.ts";
import type { FakeContext, FakePi } from "./fake-pi.ts";
import { testPrograms } from "./programs.ts";
import { REAL_HOME_CREDENTIALS } from "./world.ts";

export interface Session {
    root: string;
    home: string;
    project: string;
    agentDir: string;
    pi: FakePi;
    context: FakeContext;
    /** Calls a tool the way Pi would. A tool that throws answers with its message and `isError`. */
    call(name: string, params: Record<string, unknown>, ctx?: FakeContext): Promise<{ text: string; isError: boolean }>;
    bash(command: string, extra?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
    /** Runs a command of the plugin (`ps`, `sandbox`) and returns what it said. */
    command(name: string, args: string): Promise<string[]>;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    cleanup(): Promise<void>;
}

export interface SessionOptions {
    settings?: (base: SandboxSettings) => SandboxSettings;
    options?: SandboxOptions;
    ui?: boolean;
    select?: (title: string, options: string[]) => string | undefined;
    env?: Record<string, string>;
}

/** Builds a session with the real sandbox. It is not started: call `start()`. */
export function realSession(over: SessionOptions = {}): Session {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-session-")));
    const home = path.join(root, "home");
    const project = path.join(home, "work", "orders");
    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(project, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    const programs = testPrograms();
    const base: SandboxSettings = {
        ...DEFAULT_SETTINGS,
        hide: REAL_HOME_CREDENTIALS.map((name) => path.join(userInfo().homedir, name)),
        programs: {
            ...(programs.bwrap === undefined ? {} : { bwrap: programs.bwrap }),
            ...(programs.socat === undefined ? {} : { socat: programs.socat }),
            ...(programs.ripgrep === undefined ? {} : { ripgrep: programs.ripgrep }),
        },
    };
    const settings = over.settings === undefined ? base : over.settings(base);
    settings.hide = [...new Set([...base.hide, ...settings.hide])];
    const pi = fakePi();
    sandbox({
        env: { ...process.env, HOME: home, ...over.env },
        home: () => home,
        tmpRoot: path.join(root, "tmp"),
        agentDir: () => agentDir,
        settings: () => settings,
        protectedPaths: () => [],
        ...over.options,
    })(pi.pi);
    const context = fakeContext({
        cwd: project,
        ...(over.ui === undefined ? {} : { ui: over.ui }),
        ...(over.select === undefined ? {} : { select: over.select }),
    });
    const session: Session = {
        root,
        home,
        project,
        agentDir,
        pi,
        context,
        async call(name, params, ctx = context) {
            const tool = pi.tools.get(name);
            if (tool === undefined) throw new Error(`no tool ${name}`);
            try {
                const result = await tool.execute(
                    `call-${name}`,
                    params as never,
                    undefined,
                    undefined,
                    ctx.ctx as never,
                );
                const text = (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
                return { text, isError: false };
            } catch (error) {
                return { text: (error as Error).message, isError: true };
            }
        },
        bash: (command, extra = {}) => session.call("bash", { command, ...extra }),
        async command(name, args) {
            const before = context.screen.notifications.length;
            const selects = context.screen.selects.length;
            await pi.commands.get(name)?.handler(args, context.ctx as never);
            return [
                ...context.screen.notifications.slice(before).flatMap((item) => item.message.split("\n")),
                ...context.screen.selects.slice(selects).flatMap((item) => [item.title, ...item.options]),
            ];
        },
        start: () => pi.fire("session_start", { reason: "startup" }, context.ctx).then(() => undefined),
        async shutdown() {
            await pi.fire("session_shutdown", { reason: "quit" }, context.ctx);
        },
        async cleanup() {
            await session.shutdown();
            rmSync(root, { recursive: true, force: true });
        },
    };
    return session;
}

/** Waits until `check` returns something other than undefined or false, polling, up to `ms`. `check` may be async. */
export async function until<T>(
    check: () => T | undefined | false | Promise<T | undefined | false>,
    ms = 10_000,
    what = "the condition",
): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value !== undefined && value !== false) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
