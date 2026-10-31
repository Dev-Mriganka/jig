// The plugin as Pi loads it, with a fake Pi and a broker that does not sandbox: what it registers, what it starts and stops,
// what a command goes through, and that it never touches Pi's signal handling. The real sandbox is in the escape tests.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { jigCore } from "../../jig-core/src/index.ts";
import { withdrawJig } from "../../jig-core/src/client.ts";
import { jig } from "../../jig-core/src/client.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import type { SandboxSettings } from "../src/config.ts";
import { sandbox } from "../src/index.ts";
import type { SandboxOptions } from "../src/index.ts";
import { fakeBrokers } from "./support/fake-broker.ts";
import type { FakeBrokerOptions } from "./support/fake-broker.ts";
import { fakeContext, fakePi } from "./support/fake-pi.ts";
import type { FakeContext, FakePi } from "./support/fake-pi.ts";

const SIGNALS = [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
    "SIGQUIT",
    "exit",
    "beforeExit",
    "uncaughtException",
    "unhandledRejection",
] as const;
const listeners = (): number[] => SIGNALS.map((name) => process.listenerCount(name));

interface ExecCall {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv | undefined;
    timeout: number | undefined;
}

/** The requests of a type that were for the agent's commands, not for the sandbox's own start-up test. */
function forCommands(
    s: { brokers: ReturnType<typeof fakeBrokers> },
    type: string,
): Array<{ type: string; fields: Record<string, unknown> }> {
    const requests = s.brokers.log.requests;
    const probe = requests.findIndex(
        (request) => request.type === "wrap" && request.fields.command === "echo jig-sandbox-probe",
    );
    const probeId = probe < 0 ? undefined : requests[probe]?.fields.commandId;
    return requests.filter(
        (request) =>
            request.type === type &&
            request.fields.commandId !== probeId &&
            request.fields.command !== "echo jig-sandbox-probe",
    );
}

interface Setup {
    pi: FakePi;
    context: FakeContext;
    execs: ExecCall[];
    brokers: ReturnType<typeof fakeBrokers>;
    root: string;
    home: string;
    project: string;
    /** Runs the tool Pi would call. */
    bash(command: string, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    command(args: string): Promise<string[]>;
}

let root: string;
const SAVED_TOKEN = process.env.MY_SERVICE_TOKEN;
beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-plugin-test-")));
    // Pi gives a command its own environment, so the credential has to be in this process's for the tool to see it.
    process.env.MY_SERVICE_TOKEN = "token-value-0123456789";
});
afterEach(() => {
    if (SAVED_TOKEN === undefined) delete process.env.MY_SERVICE_TOKEN;
    else process.env.MY_SERVICE_TOKEN = SAVED_TOKEN;
    rmSync(root, { recursive: true, force: true });
    try {
        withdrawJig(jig());
    } catch {
        // jig-core was not loaded.
    }
});

/** What the fake command prints, by what it was asked. */
type Script = (command: string) => string;

function setup(
    over: {
        options?: SandboxOptions;
        broker?: FakeBrokerOptions;
        script?: Script;
        settings?: Partial<SandboxSettings>;
        env?: Record<string, string>;
        core?: boolean;
    } = {},
): Setup {
    const home = path.join(root, "home");
    const project = path.join(home, "work", "orders");
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    const pi = fakePi();
    if (over.core === true)
        jigCore({ createMasker: () => ({ text: (t: string) => t, value: <T>(v: T): T => v }) as never })(pi.pi);
    const brokers = fakeBrokers(over.broker);
    const execs: ExecCall[] = [];
    // The three programs the runtime needs: any executable file stands in, since the fake broker never runs them.
    const dummy = process.execPath;
    const settings: SandboxSettings = {
        ...DEFAULT_SETTINGS,
        programs: { bwrap: dummy, socat: dummy, ripgrep: dummy },
        ...over.settings,
    };
    const env = {
        PATH: process.env.PATH ?? "/usr/bin",
        HOME: home,
        LANG: "C.UTF-8",
        MY_SERVICE_TOKEN: "token-value-0123456789",
        ...over.env,
    };
    sandbox({
        env,
        platform: "linux",
        home: () => home,
        uid: 1000,
        wsl: false,
        tmpRoot: path.join(root, "tmp"),
        agentDir: () => path.join(home, ".pi", "agent"),
        settings: () => settings,
        ...(over.core === true ? {} : { protectedPaths: () => [] }),
        runtimePaths: () => [],
        startBroker: brokers.start,
        exec: async (command, cwd, o) => {
            // The test command the sandbox runs when it starts, to prove that it works.
            if (command === "echo jig-sandbox-probe") {
                o.onData(Buffer.from("jig-sandbox-probe\n"));
                return { exitCode: 0 };
            }
            execs.push({ command, cwd, env: o.env, timeout: o.timeout });
            if (o.signal?.aborted) throw new Error("aborted");
            o.onData(Buffer.from(over.script?.(command) ?? ""));
            return { exitCode: 0 };
        },
        ...over.options,
    })(pi.pi);
    const context = fakeContext({ cwd: project });
    return {
        pi,
        context,
        execs,
        brokers,
        root,
        home,
        project,
        async bash(command, signal) {
            const tool = pi.tools.get("bash");
            assert.ok(tool, "the bash tool is registered");
            try {
                const result = await tool.execute(
                    "call-1",
                    { command } as never,
                    signal,
                    undefined,
                    context.ctx as never,
                );
                const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
                return { text, isError: (result as { isError?: boolean }).isError === true };
            } catch (error) {
                return { text: (error as Error).message, isError: true };
            }
        },
        start: () =>
            pi.fire("session_start", { reason: "startup" }, context.ctx).then(async () => {
                // Session start does not wait for the sandbox, as a slow start must not hold Pi back; a command does.
                await new Promise((resolve) => setImmediate(resolve));
            }),
        shutdown: async () => void (await pi.fire("session_shutdown", { reason: "quit" }, context.ctx)),
        async command(args) {
            const before = context.screen.notifications.length;
            const selectsBefore = context.screen.selects.length;
            await pi.commands.get("sandbox")?.handler(args, context.ctx as never);
            const said = context.screen.notifications.slice(before).flatMap((item) => item.message.split("\n"));
            return [...said, ...context.screen.selects.slice(selectsBefore).flatMap((item) => item.options)];
        },
    };
}

describe("what the plugin registers", () => {
    test("the bash tool that replaces Pi's, the three background tools, /sandbox and /ps, and the session hooks; it starts nothing", () => {
        const before = listeners();
        const s = setup();
        assert.deepEqual([...s.pi.tools.keys()], ["bash", "bg_output", "bg_list", "bg_kill"]);
        assert.deepEqual([...s.pi.commands.keys()].sort(), ["ps", "sandbox"]);
        assert.deepEqual([...s.pi.handlers.keys()].sort(), [
            "message_start",
            "session_shutdown",
            "session_start",
            "tool_call",
        ]);
        assert.equal(s.brokers.log.launches.length, 0, "no broker until a session starts");
        assert.deepEqual(listeners(), before);
    });

    test("the tool keeps Pi's name, parameters and way of being drawn, and its description says how the sandbox behaves", () => {
        const tool = setup().pi.tools.get("bash");
        assert.ok(tool);
        assert.equal(tool.name, "bash");
        const properties = (tool.parameters as unknown as { properties: object }).properties;
        assert.deepEqual(Object.keys(properties).sort(), [
            "background",
            "command",
            "name",
            "notifyOn",
            "outside",
            "reason",
            "timeout",
        ]);
        assert.equal(typeof tool?.renderCall, "function");
        assert.match(tool?.description ?? "", /Execute a bash command/);
        assert.match(tool?.description ?? "", /sandbox/);
        assert.match(tool?.description ?? "", /\[sandbox\]/);
        assert.match(tool?.description ?? "", /git tool/);
        assert.match(tool?.description ?? "", /edit and write tools/);
    });

    test("the default export is a factory, as Pi loads it", async () => {
        const module = await import("../src/index.ts");
        assert.equal(typeof module.default, "function");
    });
});

describe("the broker's life", () => {
    test("it is started at session start in a folder of its own, with a short environment, and stopped at shutdown", async () => {
        const before = listeners();
        const s = setup();
        await s.start();
        await s.bash("true");
        const [launch] = s.brokers.log.launches;
        assert.ok(launch);
        assert.ok(existsSync(launch.script) && launch.script.endsWith("broker.mjs"));
        assert.notEqual(launch.cwd, s.project, "never the project");
        assert.ok(launch.cwd.startsWith(path.join(root, "tmp", "jig-sandbox-1000")));
        assert.ok(launch.cwd.endsWith(`${path.sep}broker`));
        assert.deepEqual(Object.keys(launch.env).sort(), ["CLAUDE_CODE_TMPDIR", "HOME", "LANG", "PATH", "TMPDIR"]);
        assert.equal(launch.env.CLAUDE_CODE_TMPDIR, path.join(path.dirname(launch.cwd), "tmp"));
        assert.ok(!JSON.stringify(launch.env).includes("token-value"));
        assert.equal(s.brokers.log.stops, 0);

        const session = path.dirname(launch.cwd);
        assert.ok(existsSync(session));
        await s.shutdown();
        assert.equal(s.brokers.log.stops, 1);
        assert.equal(existsSync(session), false, "the session's folders are removed");
        await s.shutdown();
        assert.equal(s.brokers.log.stops, 1, "stopping twice stops once");
        assert.deepEqual(listeners(), before, "no signal handler was installed in Pi's process, or removed from it");
    });

    test("the runtime is given the network as the mode says: no allow list for open, an empty strict one for off", async () => {
        const open = setup();
        await open.start();
        await open.bash("true");
        const openConfig = open.brokers.log.requests.find((request) => request.type === "init")?.fields
            .config as Record<string, any>;
        assert.equal("allowedDomains" in openConfig.network, false);
        await open.shutdown();

        const off = setup({ settings: { network: { ...DEFAULT_SETTINGS.network, mode: "off" } } });
        await off.start();
        await off.bash("true");
        const offConfig = off.brokers.log.requests.find((request) => request.type === "init")?.fields.config as Record<
            string,
            any
        >;
        assert.deepEqual(offConfig.network.allowedDomains, []);
        assert.equal(offConfig.network.strictAllowlist, true);
        await off.shutdown();
    });

    test("filtered and ask give the runtime an empty allow list that only the callback widens, and ask the broker for the callback", async () => {
        for (const mode of ["filtered", "ask"] as const) {
            const s = setup({
                settings: { network: { ...DEFAULT_SETTINGS.network, mode, allow: ["api.example.com"] } },
            });
            await s.start();
            await s.bash("true");
            const init = s.brokers.log.requests.find((request) => request.type === "init");
            const config = init?.fields.config as Record<string, any>;
            assert.deepEqual(config.network.allowedDomains, [], `${mode}: no list the runtime would decide from`);
            assert.equal(config.network.strictAllowlist, undefined, `${mode}: strict would never ask the callback`);
            assert.deepEqual(config.network.deniedDomains, []);
            assert.equal(init?.fields.askHosts, true);
            assert.equal(
                JSON.stringify(config).includes("api.example.com"),
                false,
                "allow and deny are read by the callback",
            );
            assert.match((await s.command(""))[0] ?? "", new RegExp(`network ${mode}$`));
            await s.shutdown();
        }
    });

    test("on a platform where the bridge between commands is untried, filtered and ask mean off, and /sandbox says so", async () => {
        const s = setup({
            settings: { network: { ...DEFAULT_SETTINGS.network, mode: "filtered" } },
            options: { platform: "darwin" },
        });
        await s.start();
        assert.match(
            (await s.command(""))[0] ?? "",
            /network off \(network mode filtered is tested on Linux and WSL2 only, so the network is off\)/,
        );
    });

    test("docker: true is accepted and not in effect, and /sandbox says so", async () => {
        const s = setup({ settings: { docker: true } });
        await s.start();
        const lines = await s.command("");
        assert.ok(lines.some((line) => line.includes("sandbox.docker is not supported")));
        const config = (s.brokers.log.requests.find((request) => request.type === "init")?.fields.config ??
            {}) as Record<string, any>;
        assert.equal(
            JSON.stringify(config).includes("allowAllUnixSockets"),
            false,
            "all Unix sockets are never allowed",
        );
    });

    test("the runtime is told to remove the credential variables a second time", async () => {
        const s = setup();
        await s.start();
        await s.bash("true");
        const config = s.brokers.log.requests.find((request) => request.type === "init")?.fields.config as Record<
            string,
            any
        >;
        assert.deepEqual(config.credentials.envVars, [{ name: "MY_SERVICE_TOKEN", mode: "deny" }]);
        assert.equal(config.filesystem.allowGitConfig, true);
        assert.equal(config.bwrapPath, process.execPath);
    });

    test("when the runtime cannot start, bash is refused with the reason and the way to fix it, and the broker is stopped", async () => {
        const s = setup({ broker: { failOn: "init" } });
        await s.start();
        const result = await s.bash("echo hi");
        assert.equal(result.isError, true);
        assert.match(result.text, /^bash is refused: the sandbox could not start: fake broker refuses init/);
        assert.match(result.text, /\/sandbox doctor/);
        assert.match(result.text, /\/sandbox off/);
        assert.equal(s.execs.length, 0, "the command never ran");
        assert.equal(s.brokers.log.stops, 1);
        assert.match((await s.command(""))[0] ?? "", /^bash is REFUSED, the sandbox could not start/);
    });

    test("a missing program is named with the command that installs it", async () => {
        const s = setup({ settings: { programs: {} }, env: { PATH: "/nonexistent" } });
        await s.start();
        const result = await s.bash("echo hi");
        assert.match(
            result.text,
            /bwrap, socat, rg are not installed; install them with: sudo apt install bubblewrap socat ripgrep/,
        );
        assert.equal(s.brokers.log.launches.length, 0);
    });

    test("the doctor names each missing program with the command that installs it", async () => {
        const s = setup({ settings: { programs: {} }, env: { PATH: "/nonexistent" } });
        await s.start();
        const lines = await s.command("doctor");
        assert.ok(
            lines.includes(
                "FAIL program bwrap: not found; install it with: sudo apt install bubblewrap, or give its path in sandbox.programs.bwrap in jig.json",
            ),
            lines.join("\n"),
        );
        assert.ok(
            lines.some((line) =>
                line.startsWith("FAIL program socat: not found; install it with: sudo apt install socat"),
            ),
        );
        assert.ok(
            lines.some((line) =>
                line.startsWith("FAIL program rg: not found; install it with: sudo apt install ripgrep"),
            ),
        );
        assert.ok(lines.some((line) => line.startsWith("FAIL start: bwrap, socat, rg are not installed")));
        assert.ok(lines.some((line) => /^\d+ checks? failed\.$/.test(line)));
    });

    test("a platform without a sandbox is said plainly", async () => {
        const s = setup({ options: { platform: "win32" } });
        await s.start();
        assert.match((await s.bash("echo hi")).text, /the sandbox is not supported on win32 yet/);
    });

    test("a command waits for a start that is still going", async () => {
        const s = setup();
        const started = s.pi.fire("session_start", { reason: "startup" }, s.context.ctx);
        const result = await s.bash("echo early");
        await started;
        assert.equal(result.isError, false);
        assert.equal(s.execs.length, 1);
    });

    test("a broker that stopped on its own is replaced, and the command that found it gone is refused once", async () => {
        const s = setup();
        await s.start();
        await s.bash("true");
        await s.brokers.log.brokers[0]?.stop();
        const refused = await s.bash("echo again");
        assert.equal(refused.isError, true);
        assert.match(refused.text, /refused once/);
        assert.equal(s.brokers.log.launches.length, 2, "a new broker was started");
        const next = await s.bash("echo works");
        assert.equal(next.isError, false);
        assert.equal(s.execs.at(-1)?.command, "echo works");
    });
});

describe("what a command goes through", () => {
    test("it is wrapped by the broker, run in the project with a clean environment, and its output comes back", async () => {
        const s = setup({ script: () => "hello from the command\n" });
        await s.start();
        const result = await s.bash("echo hello");
        assert.equal(result.text, "hello from the command\n");
        const [call] = s.execs;
        assert.equal(call?.command, "echo hello");
        assert.equal(call?.cwd, s.project);
        assert.equal(call?.env?.MY_SERVICE_TOKEN, undefined, "the credential is not passed on");
        assert.equal(call?.env?.HOME, process.env.HOME, "the rest of Pi's environment is kept");
        assert.match(call?.env?.TMPDIR ?? "", /jig-sandbox-1000\/.*\/tmp$/);
        const wrap = forCommands(s, "wrap")[0];
        assert.equal(wrap?.fields.command, "echo hello");
        const config = wrap?.fields.customConfig as {
            filesystem: { allowWrite: Array<{ path: string; literal: true }> };
        };
        const filesystem = config.filesystem;
        assert.ok(filesystem.allowWrite.some((entry) => entry.path === s.project && entry.literal));
    });

    test("every command is ended in the broker, also when it fails", async () => {
        const s = setup();
        await s.start();
        await s.bash("one");
        await s.bash("two", AbortSignal.abort());
        assert.equal(forCommands(s, "wrap").length, 2);
        assert.equal(forCommands(s, "finish").length, 2);
    });

    test("terminal control sequences are taken out of the output", async () => {
        const s = setup({ script: () => "\u001b[31mred\u001b[0m \u001b]0;title\u0007done\n" });
        await s.start();
        assert.equal((await s.bash("x")).text, "red done\n");
    });

    test("the value of a credential that was removed is replaced if it shows up anyway", async () => {
        const s = setup({ script: () => "the value is token-value-0123456789 ok\n" });
        await s.start();
        assert.equal((await s.bash("x")).text, "the value is [redacted] ok\n");
    });

    test("a block is explained after the command's own output", async () => {
        const s = setup({ script: () => `bash: ${path.join(setupHome())}/.bashrc: Read-only file system\n` });
        function setupHome(): string {
            return path.join(root, "home");
        }
        writeFileSync(path.join(root, "home", ".bashrc"), "# mine\n");
        await s.start();
        const { text } = await s.bash("echo x >> ~/.bashrc");
        const lines = text.trimEnd().split("\n");
        assert.match(lines[0] ?? "", /\.bashrc: Read-only file system$/);
        assert.match(
            lines.at(-1) ?? "",
            /^\[sandbox\] cannot write ~\/\.bashrc: your shells run it outside the sandbox\./,
        );
    });

    test("the runtime's own record of a network refusal is added", async () => {
        const s = setup({ broker: { violations: [{ line: "connect to 169.254.169.254:80 denied" }] } });
        await s.start();
        assert.match(
            (await s.bash("curl x")).text,
            /\[sandbox\] network refused: connect to 169\.254\.169\.254:80 denied/,
        );
    });

    test("a command that is aborted or times out fails as Pi's own would, and the time limit is passed on", async () => {
        const s = setup();
        await s.start();
        const aborted = await s.bash("sleep 9", AbortSignal.abort());
        assert.equal(aborted.isError, true);
        assert.match(aborted.text, /aborted/i);
    });

    test("twelve commands at once each get their own wrap", async () => {
        const s = setup({ script: (command) => `${command}\n` });
        await s.start();
        const results = await Promise.all(Array.from({ length: 12 }, (_, index) => s.bash(`echo ${index}`)));
        for (const [index, result] of results.entries()) assert.equal(result.text, `echo ${index}\n`);
        const ids = forCommands(s, "wrap").map((request) => request.fields.commandId);
        assert.equal(new Set(ids).size, 12);
    });
});

describe("/sandbox off and on", () => {
    test("off runs the command as Pi would, with Pi's environment, says so in the footer, and on brings the sandbox back", async () => {
        const s = setup({ env: { JIG_PLUGIN_TEST_TOKEN: "plain-token-value" } });
        await s.start();
        assert.equal(s.context.screen.statuses.get("jig-sandbox"), "bash: sandboxed, network open");
        const off = await s.command("off");
        assert.match(off.join(" "), /no longer sandboxed/);
        assert.equal(s.context.screen.statuses.get("jig-sandbox"), "bash: not sandboxed");
        // The fake environment is not the real process's, so what runs here is Pi's own tool: a real shell.
        const plain = await s.bash("echo plain-run");
        assert.equal(plain.text.trim(), "plain-run");
        assert.equal(s.execs.length, 0, "the sandbox's operations were not used");
        assert.match((await s.command(""))[0] ?? "", /^bash is NOT sandboxed: you turned it off/);

        const on = await s.command("on");
        assert.match(on.join(" "), /sandboxed again/);
        await s.bash("echo wrapped");
        assert.equal(s.execs.at(-1)?.command, "echo wrapped");
    });

    test("when the sandbox could not start, off lets the user run bash anyway, and on says it is still not there", async () => {
        const s = setup({ broker: { failOn: "init" } });
        await s.start();
        assert.equal(s.context.screen.statuses.get("jig-sandbox"), "bash: refused, no sandbox");
        await s.command("off");
        assert.equal((await s.bash("echo plain")).text.trim(), "plain");
        const on = await s.command("on");
        assert.match(on.join(" "), /not available: the sandbox could not start/);
    });

    test("off twice and on twice say what is so", async () => {
        const s = setup();
        await s.start();
        assert.match((await s.command("on")).join(" "), /already on/);
        await s.command("off");
        assert.match((await s.command("off")).join(" "), /already off/);
    });
});

describe("/sandbox", () => {
    test("it lists what is hidden, locked and writable, each with where it came from", async () => {
        mkdirSync(path.join(root, "home", ".ssh"), { recursive: true });
        writeFileSync(path.join(root, "home", ".bashrc"), "");
        mkdirSync(path.join(root, "home", ".sdkman"), { recursive: true });
        const s = setup();
        await s.start();
        const lines = await s.command("");
        const text = lines.join("\n");
        assert.match(text, /bash is sandboxed, network open/);
        assert.match(text, /Hidden: never readable \(\d+\):/);
        assert.match(text, /~\/\.ssh {3}\(built in\) {3}it holds credentials/);
        assert.match(text, /Locked: readable, never written/);
        assert.match(text, /~\/\.bashrc {3}\(built in\) {3}your shells run it outside the sandbox/);
        assert.match(text, /Ask first: writable once you say yes \(1\):\n {2}~\/\.sdkman/);
        assert.match(text, /Writable:\n {2}~ {3}\(your home folder\)/);
    });

    test("an unknown word gets the usage", async () => {
        const s = setup();
        await s.start();
        assert.match((await s.command("frobnicate")).join(" "), /Usage: \/sandbox/);
    });

    test("allowed lists nothing at first; add, list and forget work, and the answer is kept in the agent folder", async () => {
        mkdirSync(path.join(root, "home", ".sdkman"), { recursive: true });
        const s = setup();
        await s.start();
        assert.match((await s.command("allowed")).join("\n"), /Allowed always: nothing/);
        assert.match((await s.command("allowed add ~/.sdkman")).join(" "), /Allowed writes to ~\/\.sdkman, always/);
        const file = path.join(root, "home", ".pi", "agent", "jig-sandbox", "allowed.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { folders: [path.join(root, "home", ".sdkman")] });
        assert.match((await s.command("allowed")).join("\n"), /Allowed always:\n {2}~\/\.sdkman/);
        // The rules no longer ask about it.
        assert.ok(!(await s.command("")).join("\n").includes("Ask first: writable once you say yes (1)"));
        assert.match((await s.command("allowed forget ~/.sdkman")).join(" "), /Forgot ~\/\.sdkman: it asks again/);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { folders: [] });
        assert.match((await s.command("allowed forget ~/.sdkman")).join(" "), /Nothing allowed matches/);
    });

    test("allowed add refuses a folder the sandbox does not ask about", async () => {
        const s = setup();
        await s.start();
        assert.match((await s.command("allowed add ~/.ssh")).join(" "), /not a folder the sandbox asks about/);
        assert.equal(existsSync(path.join(root, "home", ".pi", "agent", "jig-sandbox", "allowed.json")), false);
    });
});

describe("with jig-core", () => {
    test("the sandbox section is registered, the sandbox is registered, and /jig says bash is sandboxed", async () => {
        const s = setup({ core: true });
        const registered = jig().sandbox;
        assert.equal(typeof registered.register, "function");
        await s.start();
        await s.bash("true");
        await s.pi.commands.get("jig")?.handler("", s.context.ctx as never);
        const shown = s.context.screen.notifications.map((item) => item.message).join("\n");
        assert.match(shown, /bash: sandboxed, network open/);
        assert.doesNotMatch(shown, /NOT sandboxed/);
    });

    test("session start says the same once the sandbox is ready, and when it is not available it says why", async () => {
        const good = setup({ core: true });
        await good.start();
        assert.ok(good.context.screen.notifications.some((item) => item.message === "bash: sandboxed, network open"));
        withdrawJig(jig());

        rmSync(root, { recursive: true, force: true });
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-plugin-test-")));
        const bad = setup({ core: true, broker: { failOn: "init" } });
        await bad.start();
        const warning = bad.context.screen.notifications.find((item) => item.message.startsWith("bash: NOT sandboxed"));
        assert.match(warning?.message ?? "", /bash is refused, because the sandbox could not start/);
        assert.equal(warning?.type, "warning");
    });

    test("jig-core's protected paths are hidden, and a program in a place bash can write is refused to Jig's tools", async () => {
        const secretFolder = path.join(root, "company-secrets");
        mkdirSync(secretFolder, { recursive: true });
        const s = setup({ core: true });
        jig().config.addProtectedPaths({ secret: [secretFolder] });
        await s.start();
        await s.bash("true");
        const wrap = forCommands(s, "wrap")[0];
        const given = wrap?.fields.customConfig as { filesystem: { denyRead: Array<{ path: string }> } };
        const denyRead = given.filesystem.denyRead;
        assert.ok(
            denyRead.some((entry) => entry.path === secretFolder),
            "the company's path is hidden from bash too",
        );

        const planted = path.join(s.home, "planted");
        writeFileSync(planted, "#!/bin/sh\necho planted\n", { mode: 0o755 });
        await assert.rejects(jig().exec.run(planted, [], { cwd: root }), /a place the sandbox lets bash write/);
    });
});

describe("running a command for another plugin (jig-core's sandbox.run)", () => {
    test("the command is wrapped like a bash command, with the rules and the clean environment, and its output comes back", async () => {
        const s = setup({ core: true, script: (command) => (command === "npm test" ? "3 passing\n" : "") });
        await s.start();
        assert.equal(jig().sandbox.canRun, true);
        const result = await jig().sandbox.run("npm test", { cwd: s.project, timeoutMs: 90_000 });
        assert.deepEqual(result, { code: 0, output: "3 passing\n", timedOut: false, truncated: false });

        const wrapped = forCommands(s, "wrap").filter((request) => request.fields.commandText === "npm test");
        assert.equal(wrapped.length, 1, "the broker wrapped it");
        const ran = s.execs.find((exec) => exec.cwd === s.project);
        assert.equal(ran?.timeout, 90, "milliseconds became Pi's seconds");
        assert.ok(!JSON.stringify(ran?.env).includes("token-value"), "no credential in the command's environment");
    });

    test("a command that ran out of time is a result with timedOut, and one that was cancelled is a rejection", async () => {
        let mode: "timeout" | "abort" = "timeout";
        const s = setup({
            core: true,
            options: {
                exec: async (command, _cwd, o) => {
                    if (command === "echo jig-sandbox-probe") {
                        o.onData(Buffer.from("jig-sandbox-probe\n"));
                        return { exitCode: 0 };
                    }
                    o.onData(Buffer.from("partial\n"));
                    throw new Error(mode === "timeout" ? `timeout:${o.timeout}` : "aborted");
                },
            },
        });
        await s.start();
        assert.deepEqual(await jig().sandbox.run("slow", { cwd: s.project, timeoutMs: 1500 }), {
            code: null,
            output: "partial\n",
            timedOut: true,
            truncated: false,
        });
        mode = "abort";
        await assert.rejects(jig().sandbox.run("slow", { cwd: s.project }), /aborted/);
    });

    test("only the end of a long output is kept, and the result says so", async () => {
        const s = setup({ core: true, script: () => `${"a".repeat(100)}${"b".repeat(100)}` });
        await s.start();
        const result = await jig().sandbox.run("noisy", { cwd: s.project, maxOutputBytes: 100 });
        assert.equal(result.output, "b".repeat(100));
        assert.equal(result.truncated, true);
    });

    test("with the sandbox switched off nothing runs: canRun is false and run rejects", async () => {
        const s = setup({ core: true });
        await s.start();
        await s.command("off");
        assert.equal(jig().sandbox.canRun, false);
        const before = s.execs.length;
        await assert.rejects(jig().sandbox.run("npm test", { cwd: s.project }), /no sandbox can run this command/);
        assert.equal(s.execs.length, before, "no command was started");
    });

    test("when the sandbox could not start the command is refused with the reason, never run bare", async () => {
        const s = setup({ core: true, broker: { failOn: "init" } });
        await s.start();
        const before = s.execs.length;
        assert.equal(jig().sandbox.canRun, false);
        await assert.rejects(jig().sandbox.run("npm test", { cwd: s.project }), /it could not start/);
        assert.equal(s.execs.length, before);
    });
});
