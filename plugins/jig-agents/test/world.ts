// A whole parent session for the plugin: a real Pi session (the SDK, with its scripted "faux" model) that has the real jig-core and
// the plugin loaded, a real git repository as its working folder, and, in place of Pi, a fake child that speaks the RPC protocol
// (support/fake-child.mjs). A tool call goes through jig-core first, as in Pi: classified, decided, asked, and only then run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, JsonObject } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jigCore } from "../../jig-core/src/index.ts";
import { fakeClock } from "../../jig-core/test/support/clock.ts";
import type { FakeClock } from "../../jig-core/test/support/clock.ts";
import { fakeMasker } from "../../jig-core/test/support/fakes.ts";
import { agents } from "../src/index.ts";
import { realHost } from "../src/host.ts";
import type { Host } from "../src/host.ts";
import type { Runtime } from "../src/runtime.ts";

export const FAKE_CHILD = path.resolve(import.meta.dirname, "support/fake-child.mjs");

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** A repository with one commit. Returns its real path. */
export function makeRepo(parent: string, name: string): string {
    const dir = path.join(parent, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "README.md"), "first\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
    return realpathSync(dir);
}

/** Waits for something that happens in real time, such as a child process writing a line. */
export async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const limit = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > limit) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the fake screen was asked, and how many questions were open at once. */
export interface ScreenLog {
    selects: Array<{ title: string; options: string[] }>;
    inputs: Array<{ title: string; placeholder: string | undefined }>;
    active: number;
    maxActive: number;
    /** Questions that were closed (aborted) while open. */
    closed: number;
}

export interface ScreenScript {
    /** Answers a selector: the option to choose, or undefined to close it. A promise that never settles keeps it open until aborted. */
    select?: (title: string, options: string[]) => string | undefined | Promise<string | undefined>;
    input?: (title: string) => string | undefined | Promise<string | undefined>;
}

/** A fake screen that, like Pi's, closes a question when its signal fires. */
function screenWith(script: ScreenScript): { ui: Record<string, unknown>; log: ScreenLog } {
    const log: ScreenLog = { selects: [], inputs: [], active: 0, maxActive: 0, closed: 0 };
    async function open<T>(
        opts: { signal?: AbortSignal } | undefined,
        answer: () => T | Promise<T>,
    ): Promise<T | undefined> {
        log.active++;
        log.maxActive = Math.max(log.maxActive, log.active);
        try {
            return await new Promise<T | undefined>((resolve, reject) => {
                const signal = opts?.signal;
                const onAbort = () => {
                    log.closed++;
                    resolve(undefined);
                };
                if (signal?.aborted) return onAbort();
                signal?.addEventListener("abort", onAbort, { once: true });
                Promise.resolve().then(answer).then(resolve, reject);
            });
        } finally {
            log.active--;
        }
    }
    const ui = {
        select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
            log.selects.push({ title, options });
            return open(opts, () => script.select?.(title, options));
        },
        input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => {
            log.inputs.push({ title, placeholder });
            return open(opts, () => script.input?.(title));
        },
        confirm: async () => false,
        notify: () => undefined,
        custom: async () => undefined,
    };
    return { ui, log };
}

export interface Script {
    commands?: string[];
    model?: { provider: string; id: string; cost?: Record<string, number> };
    startup?: unknown[];
    steps?: unknown[];
    onSteer?: unknown[];
    onDone?: unknown[];
    ignoreAbort?: boolean;
    ignoreStdinEnd?: boolean;
    ignoreSigterm?: boolean;
    rejectPrompt?: boolean;
    disposition?: string;
    slowCommands?: number;
}

export interface WorldOptions {
    /** The user's jig.json. */
    config?: Record<string, unknown>;
    ui?: ScreenScript;
    /** Make the working folder a git repository (default true). */
    repo?: boolean;
    /** Files for `<agent folder>/agents/`, by file name. */
    agentFiles?: Record<string, string>;
    /** Pi's settings.json. */
    settings?: Record<string, unknown>;
    /** Names added to the environment the parent runs with. */
    env?: Record<string, string>;
    /** What the first fake child does. */
    script?: Script;
    /** Replace parts of the host (a test of the process table, say). */
    host?: Partial<Host>;
    mode?: "rpc" | "tui";
    /**
     * Commands the parent session has besides jig-core's and `/agents`. The default is `sandbox`, a stand-in for jig-sandbox's command,
     * because the shipped scout and reviewer have `bash`, which a read-only role may have only where there is a sandbox; the fake child
     * lists it too. Pass `[]` for a parent without one.
     */
    commands?: string[];
    /** More extensions for the parent session: tools to call, for a test of what the session lets through. */
    extensions?: ExtensionFactory[];
    /** Skill files (`SKILL.md`) the parent session has, as Pi lists them. */
    skills?: string[];
    /** Runs once the folders exist and before the session starts: prepare files the plugin will find. */
    prepare?: (paths: { root: string; stateDir: string; agentDir: string; cwd: string }) => void | Promise<void>;
}

export interface ChildLog {
    start: { argv: string[]; cwd: string; env: Record<string, string>; pid: number } | undefined;
    commands: Array<Record<string, any>>;
    responses: Array<Record<string, any>>;
    all: Array<Record<string, any>>;
}

export interface World {
    session: AgentSession;
    rt: Runtime;
    clock: FakeClock;
    root: string;
    cwd: string;
    stateDir: string;
    agentDir: string;
    faux: FauxProviderHandle;
    ui: ScreenLog;
    host: Host;
    /** The exit codes the plugin asked for: a child whose parent is gone leaves this way. */
    exits: number[];
    env: Record<string, string>;
    /** Writes the script the next fake child reads. */
    script(script: Script): void;
    /** One model turn that makes these tool calls, then a closing message. */
    calls(
        calls: Array<{ name: string; args: JsonObject }>,
    ): Promise<Array<{ text: string; isError: boolean; details: any }>>;
    /** The `subagent` tool. */
    tool(args: JsonObject): Promise<{ text: string; isError: boolean; details: any }>;
    /** What the fake child wrote to its log. */
    log(): ChildLog;
    /** The watch messages the agent received. */
    watchMessages(): Array<{ content: string; details: any }>;
    /** Moves time by `ms` in steps, letting the child's real I/O run in between. */
    advance(ms: number): Promise<void>;
    /** Runs until the agent has received this many watch messages, advancing the clock, and returns the last. */
    deliver(count?: number): Promise<{ content: string; details: any }>;
    /** Waits for the sweep for children left by an earlier session, moving the clock the sweep's pauses use. */
    swept(): Promise<void>;
    /** Commands as the user would type `/agents ...`. Returns the notices. */
    command(args: string): Promise<string[]>;
    notices(): string[];
    close(): Promise<void>;
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-agents-world-")));
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    const workspace = path.join(root, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const cwd = options.repo === false ? workspace : makeRepo(workspace, "orders-api");
    writeFileSync(path.join(agentDir, "jig.json"), JSON.stringify(options.config ?? {}));
    if (options.settings !== undefined)
        writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(options.settings));
    if (options.agentFiles !== undefined) {
        mkdirSync(path.join(agentDir, "agents"), { recursive: true });
        for (const [name, text] of Object.entries(options.agentFiles))
            writeFileSync(path.join(agentDir, "agents", name), text);
    }

    await options.prepare?.({ root, stateDir, agentDir, cwd });

    const saved: Record<string, string | undefined> = {
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        JIG_STATE_DIR: process.env.JIG_STATE_DIR,
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.JIG_STATE_DIR = stateDir;

    const modelRuntime = await ModelRuntime.create({
        authPath: path.join(root, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(root, "store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const faux = fauxProvider({
        models: [{ id: "faux-1" }, { id: "small-model" }, { id: "big-model" }, { id: "anything" }],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const parentModel = faux.getModel();

    const clock = fakeClock();
    const scriptFile = path.join(root, "script.json");
    const logFile = path.join(root, "child.log");
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? root,
        PI_CODING_AGENT_DIR: agentDir,
        JIG_STATE_DIR: stateDir,
        PI_FAKE_SCRIPT: scriptFile,
        PI_FAKE_LOG: logFile,
        // A secret that a child must never get, and a name that agents.env may let through.
        SECRET_TOKEN: "do-not-pass",
        ...(options.env ?? {}),
    };
    const script = (value: Script): void => {
        writeFileSync(
            scriptFile,
            JSON.stringify({ model: { provider: parentModel.provider, id: parentModel.id }, ...value }),
        );
    };
    script(options.script ?? {});

    const real = realHost();
    const exits: number[] = [];
    const host: Host = {
        ...real,
        // A test must never end its own process.
        exit: (code) => void exits.push(code),
        piCommand: () => ({ file: process.execPath, args: [FAKE_CHILD] }),
        now: () => clock.now(),
        timers: clock.timers,
        env: () => env as NodeJS.ProcessEnv,
        ...(options.host ?? {}),
    };
    let rt: Runtime | undefined;
    const factory = agents({ host, onRuntime: (runtime) => (rt = runtime) });
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: [
            jigCore({ createMasker: () => fakeMasker, now: clock.date, timers: clock.timers }),
            factory,
            ...(options.commands ?? ["sandbox"]).map(
                (name): ExtensionFactory =>
                    (pi) =>
                        pi.registerCommand(name, {
                            description: `a stand-in for /${name}`,
                            handler: async () => undefined,
                        }),
            ),
            ...(options.extensions ?? []),
        ],
        noExtensions: false,
        // Nothing is discovered; the skills a test names are explicit paths, which load all the same.
        noSkills: true,
        ...(options.skills === undefined ? {} : { additionalSkillPaths: options.skills }),
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: parentModel,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    const screen = screenWith(options.ui ?? { select: () => "Allow" });
    const notices: string[] = [];
    screen.ui.notify = (message: string) => void notices.push(message);
    await session.bindExtensions({ uiContext: screen.ui as never, mode: options.mode ?? "rpc" });
    if (rt === undefined) throw new Error("the plugin did not start a runtime");

    let counter = 0;
    async function calls(
        list: Array<{ name: string; args: JsonObject }>,
    ): Promise<Array<{ text: string; isError: boolean; details: any }>> {
        const before = session.messages.length;
        const ids = list.map((_entry, index) => `agents-${++counter}-${index}`);
        faux.setResponses([
            fauxAssistantMessage(
                list.map((entry, index) => fauxToolCall(entry.name, entry.args, { id: ids[index] as string })),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("done"),
        ]);
        await session.prompt(`use ${list.map((entry) => entry.name).join(", ")}`);
        const results = session.messages.slice(before).filter((message) => message.role === "toolResult") as Array<{
            toolCallId: string;
            content: Array<{ text?: string }>;
            isError: boolean;
            details: unknown;
        }>;
        return ids.map((id) => {
            const message = results.find((result) => result.toolCallId === id);
            if (message === undefined)
                throw new Error(`no result for ${id}: ${JSON.stringify(session.messages.slice(before)).slice(0, 500)}`);
            return {
                text: message.content.map((block) => block.text ?? "").join("\n"),
                isError: message.isError === true,
                details: message.details,
            };
        });
    }

    const watchMessages = (): Array<{ content: string; details: any }> =>
        session.messages.filter(
            (message) => message.role === "custom" && (message as { customType?: string }).customType === "jig-watch",
        ) as never;

    const w: World = {
        session,
        rt,
        clock,
        root,
        cwd,
        stateDir,
        agentDir,
        faux,
        ui: screen.log,
        host,
        exits,
        env,
        script,
        calls,
        tool: async (args) => (await calls([{ name: "subagent", args }]))[0] as never,
        log() {
            const all = existsSync(logFile)
                ? readFileSync(logFile, "utf8")
                      .split("\n")
                      .filter((line) => line !== "")
                      .map((line) => JSON.parse(line) as Record<string, any>)
                : [];
            return {
                start: all.find((entry) => entry.type === "start") as never,
                commands: all.filter((entry) => entry.type === "command").map((entry) => entry.command),
                responses: all.filter((entry) => entry.type === "ui-response").map((entry) => entry.response),
                all,
            };
        },
        watchMessages,
        async advance(ms) {
            for (let left = ms; left > 0; left -= 500) {
                await clock.advance(Math.min(500, left));
                await sleep(2);
            }
        },
        async deliver(count = 1) {
            faux.setResponses([fauxAssistantMessage("noted"), fauxAssistantMessage("noted")]);
            const limit = Date.now() + 40_000;
            while (watchMessages().length < count) {
                if (Date.now() > limit)
                    throw new Error(`only ${watchMessages().length} of ${count} watch messages arrived`);
                await clock.advance(1500);
                await sleep(10);
            }
            await session.agent.waitForIdle();
            return watchMessages()[count - 1] as { content: string; details: any };
        },
        async swept() {
            let done = false;
            void rt?.sweeping.finally(() => {
                done = true;
            });
            for (let i = 0; i < 200 && !done; i++) {
                await clock.advance(250);
                await sleep(5);
            }
            if (!done) throw new Error("the sweep did not finish");
        },
        async command(args) {
            const before = notices.length;
            const command = session.extensionRunner.getCommand("agents");
            if (command === undefined) throw new Error("no /agents command");
            const ctx = session.extensionRunner.createCommandContext();
            await command.handler(args, ctx);
            return notices.slice(before);
        },
        notices: () => notices,
        async close() {
            // Ending a session waits on timers the clock owns, so the clock is moved until it is done.
            let ended = false;
            const shutdown = session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).finally(() => {
                ended = true;
            });
            for (let i = 0; !ended && i < 400; i++) {
                await clock.advance(1000);
                await sleep(5);
            }
            await shutdown;
            session.dispose();
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            rmSync(root, { recursive: true, force: true });
        },
    };
    return w;
}
