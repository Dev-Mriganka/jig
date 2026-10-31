// The sandbox of one Pi session: the broker process, the session's private folders, the rules for each command, and the
// state `bash` and the commands read. Pi's own types are used only as types, so this file can be driven by a test.
//
// Fail closed: while the sandbox is not ready, or when it could not start, `prepare` refuses with the steps to fix it.
// A command never runs bare because something went wrong; only the user's `/sandbox off` runs one unsandboxed.
import { rmSync } from "node:fs";
import path from "node:path";
import { BrokerError } from "./broker-client.ts";
import type { Broker, BrokerEvent } from "./broker-client.ts";
import { denyNotApplied } from "./config.ts";
import type { NetworkMode, SandboxSettings } from "./config.ts";
import { scrubEnvironment } from "./env.ts";
import { withRealCache } from "./files.ts";
import type { FileView } from "./files.ts";
import type { HostAsker } from "./network/ask-host.ts";
import type { Bridge } from "./network/bridge.ts";
import type { Policy } from "./network/policy.ts";
import { installCommand, findPrograms } from "./programs.ts";
import type { FoundPrograms } from "./programs.ts";
import { inside } from "./pathing.ts";
import { canWritePath, computeRules, runtimeFilesystem } from "./rules.ts";
import { wireNetwork } from "./network/wiring.ts";
import { firstLine, messageOf, refusal, userNamespaceHint } from "./sandbox-messages.ts";
import { makeSessionFolders, runtimeConfig } from "./sandbox-setup.ts";
import type { Captured, Prepared, SandboxDeps, SandboxState } from "./sandbox-types.ts";
import type { RuleSet, RuntimeFilesystem } from "./rules.ts";

/** A command was not run because the sandbox cannot run it. The message is for the agent: what happened and what to do. */
export class SandboxRefused extends Error {}

const SAFE_NETWORK: NetworkMode = "off";

export class Sandbox {
    state: SandboxState = { kind: "stopped" };
    /** Why the network mode is not the one asked for, when it is not. */
    modeNote: string | undefined;
    /** Settings that are accepted and not in effect, for `/sandbox` to say. */
    notes: string[] = [];
    mode: NetworkMode = "open";
    sessionDir: string | undefined;
    programs: FoundPrograms = { found: {}, missing: [] };
    private broker: Broker | undefined;
    /** Settles when the session's start has finished, whether or not it has begun: jig-core asks before it does. */
    private ready: Promise<void>;
    private markReady: () => void = () => undefined;
    private counter = 0;
    private started = false;
    private lastCwd: string;
    private cache: { cwd: string; at: number; rules: RuleSet } | undefined;
    /** Credential names removed from Pi's environment, handed to the runtime to remove again. */
    private removedNames: string[] = [];
    /** The localhost bridge: ports of background tasks and of `network.localhost`, carried into each command. */
    readonly bridge: Bridge;
    /** What the proxy's callback asks, in `filtered` and `ask` modes. */
    readonly policy: Policy;
    /** Asking you about a host, in `ask` mode. */
    readonly hostAsker: HostAsker;
    /** What was wrong before the user turned the sandbox off, so turning it on again says it. */
    private lastProblem: string | undefined;

    private readonly deps: SandboxDeps;
    /** The file system the rules look at: resolving far-away folders (the Windows part of PATH on WSL) is remembered. */
    private readonly files: FileView;

    constructor(deps: SandboxDeps) {
        this.deps = deps;
        this.lastCwd = process.cwd();
        this.ready = new Promise<void>((resolve) => {
            this.markReady = resolve;
        });
        const mine = (place: string): boolean =>
            [deps.home(), "/tmp", deps.tmpRoot, this.lastCwd].some((root) => inside(place, root));
        this.files = withRealCache(deps.files, (place) => !mine(place), 30_000, deps.now);

        const wired = wireNetwork(deps, {
            mode: () => this.mode,
            socat: () => this.programs.found.socat,
            canWrite: (place) => this.canWrite(place),
        });
        this.hostAsker = wired.hostAsker;
        this.bridge = wired.bridge;
        this.policy = wired.policy;
    }

    // ---- state ----------------------------------------------------------------------------------------------------------

    /** Secret files the agent made in this session: they are its own, so the rules do not hide them. */
    get createdByAgent(): Set<string> {
        return this.deps.createdByAgent;
    }

    get active(): boolean {
        return this.state.kind === "ready" || this.state.kind === "starting";
    }

    /** The settings now. */
    settings(): SandboxSettings {
        return this.deps.settings();
    }

    get pid(): number | undefined {
        return this.broker?.pid;
    }

    /** One line saying what is wrong, when something is. */
    get problem(): string | undefined {
        return this.state.kind === "unavailable" ? this.state.reason : undefined;
    }

    /** Resolves when the sandbox has started or failed to. */
    whenReady(): Promise<void> {
        return this.ready;
    }

    // ---- starting and stopping ----------------------------------------------------------------------------------------

    /** Starts the broker for a session. Never rejects: a failure is the state, and `prepare` refuses with it. */
    start(sessionId: string, cwd: string): Promise<void> {
        if (this.started) return this.ready;
        this.started = true;
        this.lastCwd = cwd;
        this.state = { kind: "starting" };
        void this.startInner(sessionId, cwd)
            .catch((error: unknown) => {
                this.state = { kind: "unavailable", reason: `the sandbox could not start: ${messageOf(error)}` };
            })
            .then(() => this.markReady());
        return this.ready;
    }

    private async startInner(sessionId: string, cwd: string): Promise<void> {
        const { deps } = this;
        const settings = deps.settings();
        this.mode = settings.network.mode;
        this.modeNote = undefined;
        this.notes = [];
        if (settings.docker) {
            // The runtime cannot allow one Unix socket by path on Linux, and allowing all of them would also let a command start
            // Windows programs on WSL: the socket stays closed, and Docker goes through running a command outside.
            this.notes.push(
                "sandbox.docker is not supported: the runtime cannot open the Docker socket alone. The agent can ask to run a Docker command outside the sandbox.",
            );
        }
        const unrefused = denyNotApplied(settings);
        if (unrefused !== undefined) this.notes.push(unrefused);
        if (settings.readOnly) {
            this.notes.push(
                "this agent's role may not write: its home folder and working folder are locked, so a command reads them and writes only /tmp and the session's scratch folder.",
            );
        }
        if ((settings.network.mode === "filtered" || settings.network.mode === "ask") && deps.platform !== "linux") {
            // Fail closed: a mode that is asked for and not available never means a more open one. The bridge between
            // commands is written for Linux's network namespaces, and the Mac side has not been tried.
            this.mode = SAFE_NETWORK;
            this.modeNote = `network mode ${settings.network.mode} is tested on Linux and WSL2 only, so the network is off`;
        }
        if (deps.platform !== "linux" && deps.platform !== "darwin") {
            this.state = { kind: "unavailable", reason: `the sandbox is not supported on ${deps.platform} yet` };
            return;
        }
        const platform = deps.platform;
        this.programs = findPrograms(platform, settings.programs, deps.env.PATH, (place) => this.canWrite(place));
        if (this.programs.missing.length > 0) {
            const names = this.programs.missing.map((item) => item.command).join(", ");
            this.state = {
                kind: "unavailable",
                reason: `${names} ${this.programs.missing.length === 1 ? "is" : "are"} not installed; install ${this.programs.missing.length === 1 ? "it" : "them"} with: ${installCommand(platform, this.programs.missing)}`,
            };
            return;
        }
        this.sessionDir = makeSessionFolders(this.deps, sessionId);
        await this.launch();
        if (this.state.kind !== "starting") return;
        // A real command with the real rules, so a rule or a kernel setting that stops every command is found now and not
        // by the first command the agent sends.
        const probe = await this.capture("echo jig-sandbox-probe", cwd);
        if (probe.exitCode !== 0 || !probe.output.includes("jig-sandbox-probe")) {
            await this.shutdownBroker();
            this.state = {
                kind: "unavailable",
                reason: `a test command did not run in the sandbox${probe.output.trim() === "" ? "" : `: ${firstLine(probe.output)}`}${userNamespaceHint(probe.output)}`,
            };
            return;
        }
        this.state = { kind: "ready" };
    }

    /** Starts the broker and gives the runtime its base configuration. */
    private async launch(): Promise<void> {
        const { deps } = this;
        const session = this.sessionDir as string;
        const settings = deps.settings();
        const tmp = path.join(session, "tmp");
        const broker = await deps.startBroker({
            script: deps.brokerScript,
            cwd: path.join(session, "broker"),
            // Short, and without Pi's secrets: the broker only needs to find bwrap, socat and ripgrep.
            env: {
                PATH: deps.env.PATH ?? "",
                HOME: deps.home(),
                LANG: deps.env.LANG ?? "C.UTF-8",
                CLAUDE_CODE_TMPDIR: tmp,
                TMPDIR: tmp,
            },
        });
        this.broker = broker;
        broker.onExit(() => {
            // A broker that goes away on its own is replaced by the next command; one stopped on purpose is not.
            if (this.broker === broker) this.broker = undefined;
        });
        this.removedNames = scrubEnvironment(deps.env, { keep: settings.env.keep }).removed;
        try {
            broker.onEvent((event) => this.onBrokerEvent(broker, event));
            await broker.request(
                "init",
                {
                    config: runtimeConfig(this.mode, this.programs.found, this.removedNames),
                    askHosts: this.mode === "filtered" || this.mode === "ask",
                },
                20_000,
            );
        } catch (error) {
            const stderr = broker.stderrTail().trim();
            await this.shutdownBroker();
            this.state = {
                kind: "unavailable",
                reason: `the sandbox could not start: ${messageOf(error)}${stderr === "" ? "" : ` (${firstLine(stderr)})`}`,
            };
        }
    }

    /** The broker asks about a host the proxy met: decide, and answer. A failure to answer is the broker's timeout, which refuses. */
    private onBrokerEvent(broker: Broker, event: BrokerEvent): void {
        if (event.event !== "ask-host") return;
        const askId = event.askId;
        void this.policy
            .decide(String(event.host), Number(event.port))
            .then((decision) =>
                broker.request("answer-host", {
                    askId,
                    allow: decision.allow,
                    ...(decision.allow ? {} : { reason: decision.reason }),
                }),
            )
            .catch(() => undefined);
    }

    private async shutdownBroker(): Promise<void> {
        const broker = this.broker;
        this.broker = undefined;
        await broker?.stop();
    }

    /** Stops the broker and removes the session's folders. Safe to call twice. */
    async stop(): Promise<void> {
        if (this.started) await this.ready.catch(() => undefined);
        this.state = { kind: "stopped" };
        this.started = false;
        await this.shutdownBroker();
        this.bridge.close();
        const folder = this.sessionDir;
        this.sessionDir = undefined;
        if (folder !== undefined) {
            try {
                rmSync(folder, { recursive: true, force: true });
            } catch {
                // The next session removes it as stale.
            }
        }
    }

    /** `/sandbox off` and `/sandbox on`. Only a sandbox that is ready can be switched off and on again. */
    setEnabled(enabled: boolean): boolean {
        if (!enabled && (this.state.kind === "ready" || this.state.kind === "unavailable")) {
            this.lastProblem = this.state.kind === "unavailable" ? this.state.reason : undefined;
            this.state = { kind: "off" };
            return true;
        }
        if (enabled && this.state.kind === "off") {
            this.state =
                this.broker?.alive === true
                    ? { kind: "ready" }
                    : {
                          kind: "unavailable",
                          reason: this.lastProblem ?? "the sandbox is not running; start a new session",
                      };
            return true;
        }
        return false;
    }

    // ---- rules ---------------------------------------------------------------------------------------------------------

    /** The rules for a working folder, now. */
    rulesFor(cwd: string): RuleSet {
        const { deps } = this;
        const settings = deps.settings();
        const session = this.sessionDir ?? path.join(deps.tmpRoot, "jig-sandbox-none");
        const tmp = [...new Set(["/tmp", deps.tmpRoot])];
        return computeRules({
            platform: deps.platform === "darwin" ? "darwin" : "linux",
            wsl: deps.wsl,
            home: deps.home(),
            uid: deps.uid,
            cwd,
            agentDir: deps.agentDir(),
            tmp,
            sessionDir: path.join(session, "broker"),
            sessionTmp: path.join(session, "tmp"),
            env: deps.env,
            runtimePaths: deps.runtimePaths(),
            protectedPaths: deps.protectedPaths(),
            settings,
            approved: deps.approved(),
            createdByAgent: deps.createdByAgent,
            files: this.files,
        });
    }

    /** Whether a command in the sandbox can write this path, for `jig().sandbox`. True when that cannot be told. */
    canWrite(place: string): boolean {
        try {
            const now = this.deps.now();
            if (this.cache === undefined || this.cache.cwd !== this.lastCwd || now - this.cache.at > 2_000) {
                this.cache = { cwd: this.lastCwd, at: now, rules: this.rulesFor(this.lastCwd) };
            }
            return canWritePath(this.cache.rules, place);
        } catch {
            return true;
        }
    }

    // ---- commands ------------------------------------------------------------------------------------------------------

    /**
     * Wraps a command for the sandbox. `baseEnv` is the environment Pi would give the command. Refuses (throws
     * `SandboxRefused`) when the sandbox is not ready; a broker that fails is restarted and the command is refused once.
     */
    async prepare(command: string, cwd: string, baseEnv: NodeJS.ProcessEnv | undefined): Promise<Prepared> {
        await this.ready;
        const state = this.state;
        if (state.kind === "unavailable") throw new SandboxRefused(refusal(state.reason));
        if (state.kind !== "ready")
            throw new SandboxRefused(
                `bash is refused: the sandbox is ${state.kind === "off" ? "off" : "not running"}.`,
            );
        try {
            return await this.wrap(command, cwd, baseEnv);
        } catch (error) {
            if (!(error instanceof BrokerError)) throw error;
            await this.recover();
            throw new SandboxRefused(
                `bash was refused once: the sandbox broker failed (${error.message}) and was restarted. Run the command again.`,
            );
        }
    }

    /** The wrapping itself: the rules for this command, a clean environment, and the broker's answer. */
    private async wrap(
        command: string,
        cwd: string,
        baseEnv: NodeJS.ProcessEnv | undefined,
        tweak?: (fs: RuntimeFilesystem) => RuntimeFilesystem,
        forwarders = true,
    ): Promise<Prepared> {
        const broker = this.broker;
        if (broker === undefined || !broker.alive) throw new BrokerError("the sandbox broker is not running");
        this.lastCwd = cwd;
        const settings = this.deps.settings();
        const rules = this.rulesFor(cwd);
        this.cache = { cwd, at: this.deps.now(), rules };
        const hidden = rules.rules.filter((rule) => rule.kind === "hidden").map((rule) => rule.path);
        const scrubbed = scrubEnvironment(baseEnv ?? this.deps.env, {
            keep: settings.env.keep,
            hiddenFolders: hidden,
            set: { TMPDIR: path.join(this.sessionDir as string, "tmp") },
        });
        const filesystem = tweak === undefined ? runtimeFilesystem(rules) : tweak(runtimeFilesystem(rules));
        const commandId = `${this.deps.random()}-${++this.counter}`;
        // In `filtered` and `ask` the command's own network has nothing on `localhost`: the ports a task's server or a listed
        // service is on are carried in by forwarders that start first, on the same line, so line numbers do not move.
        // A command run for the sandbox's own sake (the start-up test, the doctor) needs none.
        if (forwarders) await this.bridge.sync();
        const start = forwarders ? this.bridge.preamble() : "";
        const answer = await broker.request<{ wrapped: string }>("wrap", {
            command: `${start}${command}`,
            commandText: command,
            commandId,
            customConfig: { filesystem },
        });
        let finished: Promise<{ violations: Array<{ line: string }> }> | undefined;
        return {
            wrapped: answer.wrapped,
            env: scrubbed.env,
            values: scrubbed.values,
            rules,
            mode: this.mode,
            commandId,
            finish: () => {
                finished ??= broker
                    .request<{ violations: Array<{ line: string }> }>("finish", { commandId }, 10_000)
                    .catch(() => ({ violations: [] }));
                return finished;
            },
        };
    }

    /** Replaces a broker that failed. If the new one cannot start, bash is refused until the session ends. */
    private async recover(): Promise<void> {
        await this.shutdownBroker();
        this.state = { kind: "starting" };
        this.ready = (async () => {
            try {
                await this.launch();
                if (this.state.kind === "starting") this.state = { kind: "ready" };
            } catch (error) {
                this.state = { kind: "unavailable", reason: `the sandbox could not restart: ${messageOf(error)}` };
            }
        })();
        await this.ready;
    }

    /** Runs a command in the sandbox for the sandbox's own sake (the start-up probe, the doctor) and returns what it printed. */
    async capture(
        command: string,
        cwd: string,
        tweak?: (fs: RuntimeFilesystem) => RuntimeFilesystem,
        timeoutSeconds = 30,
        env?: NodeJS.ProcessEnv,
    ): Promise<Captured> {
        let prepared: Prepared;
        try {
            prepared = await this.wrap(command, cwd, env, tweak, false);
        } catch (error) {
            return { exitCode: null, output: messageOf(error) };
        }
        const chunks: Buffer[] = [];
        try {
            const result = await this.deps.exec(prepared.wrapped, cwd, {
                onData: (data) => chunks.push(Buffer.from(data)),
                timeout: timeoutSeconds,
                env: prepared.env,
            });
            return { exitCode: result.exitCode, output: Buffer.concat(chunks).toString("utf8") };
        } catch (error) {
            return { exitCode: null, output: `${Buffer.concat(chunks).toString("utf8")}${messageOf(error)}` };
        } finally {
            await prepared.finish();
        }
    }
}
