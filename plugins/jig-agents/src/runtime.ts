// The session's children: starting, steering, resuming and stopping them, counting them, and finding the ones an earlier session left
// behind. One `Runtime` lives from the factory to the end of the plugin's load; a session starts and ends inside it.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import type { WatchDoneEvent } from "../../jig-core/src/contract.ts";
import { oneLine, stripControl } from "./clean.ts";
import { Child } from "./child.ts";
import type { ChildContext } from "./child.ts";
import type { ChildSpec, Outcome } from "./child-types.ts";
import { approvalsFor, limitsFor, settingsFrom } from "./config.ts";
import type { AgentsSettings } from "./config.ts";
import type { Screen } from "./forward.ts";
import type { Host } from "./host.ts";
import { childEnvironment, flagsFor, StartError } from "./launch.ts";
import type { ModelChoice } from "./launch.ts";
import { recordedRunning, sweep, watchParent } from "./orphans.ts";
import { loadRoles, roleFolders } from "./roles.ts";
import type { LoadedRoles, Role } from "./roles.ts";
import { agentDir, agentsRoot, listChildren, removeOld, runDirOf, stateDir, writeText } from "./store.ts";
import { ChildWatches, WATCH_KIND } from "./watch.ts";
import type { WatchSpec } from "./watch.ts";
import { planRole } from "./role-plan.ts";
import type { RolePlan } from "./role-plan.ts";
import { generateId, modelFor, nameFor, requiredCommands, resolveCwd, taskPrompt } from "./start-plan.ts";
import { addWorktree, removeWorktree } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

/** Run folders older than this are removed when a session starts. */
const KEEP_MS = 14 * 24 * 60 * 60_000;
const MAX_TASK_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 8_000;
/** A child whose parent is gone asks Pi to shut down, and leaves by itself after this long if Pi has not. */
const SHUTDOWN_GRACE_MS = 5_000;

export interface StartInput {
    role: string;
    task: string;
    name?: string;
    cwd?: string;
}

export interface Started {
    child: Child;
    model: string;
    watchId: string;
}

export class Runtime {
    ctx: ExtensionContext | undefined;
    session = "";
    settings: AgentsSettings = settingsFrom(undefined);
    roles: LoadedRoles = { roles: new Map(), problems: [] };
    readonly children = new Map<string, Child>();
    /** Starts and resumes counted against `maxStarted`. */
    started = 0;
    readonly queue = { waiting: 0 };
    private readonly watches = new ChildWatches();
    /** The sweep for orphans that session start began, so a test can wait for it. */
    sweeping: Promise<unknown> = Promise.resolve();
    problem: string | undefined;
    private stopWatchingParent: (() => void) | undefined;
    private exitHook: (() => void) | undefined;
    private active = false;

    readonly pi: ExtensionAPI;
    readonly host: Host;

    constructor(pi: ExtensionAPI, host: Host) {
        this.pi = pi;
        this.host = host;
    }

    /** Whether this Pi is itself a child of another. */
    get isChild(): boolean {
        return (this.host.env().PI_SUBAGENT_ID ?? "").trim() !== "";
    }

    /** Keeps the latest context Pi gave the plugin: the screen to ask on, and the working folder. */
    touch(ctx: ExtensionContext): void {
        this.ctx = ctx;
    }

    private screen(): Screen | undefined {
        const ctx = this.ctx;
        if (ctx === undefined) return undefined;
        // A context from an ended session is not a screen: Pi throws when a stale one is used, and that is a no.
        return this.active ? (ctx as unknown as Screen) : undefined;
    }

    private childContext(): ChildContext {
        return {
            host: this.host,
            ask: {
                screen: () => this.screen(),
                inTurn: (job) => jig().approvals.inTurn(job),
                queue: this.queue,
                waitMs: this.settings.approvalWaitMinutes * 60_000,
                timers: this.host.timers,
            },
            maxAsks: this.settings.maxAsks,
            changed: () => undefined,
        };
    }

    // ---- session -----------------------------------------------------------------------------------------------------

    /** A session starts: reads the configuration and the roles, finds children an earlier session left, and tidies old run folders. */
    begin(ctx: ExtensionContext): void {
        this.ctx = ctx;
        this.active = true;
        this.session = ctx.sessionManager.getSessionId();
        let section: unknown;
        try {
            section = jig().config.section("agents");
        } catch {
            section = undefined;
        }
        this.settings = settingsFrom(section);
        this.roles = loadRoles(roleFolders(this.settings.folders, agentDir(this.host.env())));
        this.started = 0;

        const parent = (this.host.env().PI_SUBAGENT_PARENT_PID ?? "").trim();
        if (this.isChild) {
            // A child checks that its parent is still there, and shuts down when it is not.
            const pid = Number(parent);
            if (Number.isInteger(pid) && pid > 0) {
                this.stopWatchingParent = watchParent(this.host, pid, () => {
                    // Pi in RPC mode, idle, only notes the request and leaves when the next command arrives, which will not come.
                    try {
                        ctx.shutdown();
                    } catch {
                        this.host.exit(1);
                    }
                    this.host.timers.setTimeout(() => this.host.exit(0), SHUTDOWN_GRACE_MS);
                });
            }
            return;
        }

        const state = stateDir(this.host.env());
        this.sweeping = this.tidy(state).catch((error: unknown) => {
            this.problem = `the sweep for children left by an earlier session failed: ${oneLine(String(error), 200)}`;
        });
        this.exitHook = () => {
            // The last line: Pi is exiting and `session_shutdown` did not end a child. A group kill is synchronous.
            for (const child of this.children.values()) {
                if (child.live && child.pid !== undefined) this.host.signal(child.pid, "SIGKILL", true);
            }
        };
        process.on("exit", this.exitHook);
    }

    private async tidy(state: string): Promise<void> {
        const owned = new Set(this.children.keys());
        const swept = await sweep(this.host, state, owned);
        if (swept.stopped.length > 0 && this.ctx?.hasUI === true) {
            this.ctx.ui.notify(
                `Stopped ${swept.stopped.length} child agent${swept.stopped.length === 1 ? "" : "s"} an earlier session left running.`,
                "warning",
            );
        }
        removeOld(agentsRoot(state), this.host.now(), KEEP_MS, recordedRunning);
        this.recover(state);
    }

    /** Children of this session that earlier runs recorded: they can be listed, and resumed from their saved sessions. */
    private recover(state: string): void {
        for (const { dir, meta } of listChildren(agentsRoot(state))) {
            if (meta.session !== this.session || this.children.has(meta.id)) continue;
            const role = this.roles.roles.get(meta.role);
            const spec: ChildSpec = {
                id: meta.id,
                name: meta.name,
                role: meta.role,
                writes: role?.writes ?? false,
                limits: limitsFor(this.settings, meta.role),
                approvals: approvalsFor(this.settings, meta.role),
                cwd: meta.cwd,
                dir,
                session: meta.session,
                model: undefined,
                ...(meta.branch === undefined ? {} : { branch: meta.branch }),
                ...(meta.worktree === undefined ? {} : { worktree: meta.worktree }),
                generation: meta.generation,
                startedAt: meta.startedAt,
                requireCommands: [],
            };
            const child = new Child(spec, this.childContext());
            child.state = recordedRunning(meta) ? "lost" : meta.state;
            child.note(meta.note ?? `recovered: it was ${meta.state} when its session closed`);
            this.children.set(meta.id, child);
        }
    }

    /** The session ends, for any reason: every child is ended. */
    async end(): Promise<void> {
        this.active = false;
        this.stopWatchingParent?.();
        this.stopWatchingParent = undefined;
        const all = [...this.children.values()];
        await Promise.all(all.map((child) => child.shutdown().catch(() => undefined)));
        if (this.exitHook !== undefined) process.off("exit", this.exitHook);
        this.exitHook = undefined;
        this.children.clear();
        this.watches.clear();
        this.queue.waiting = 0;
    }

    // ---- finding children --------------------------------------------------------------------------------------------

    /** A child by id or by name. */
    find(ref: string): Child | undefined {
        const wanted = ref.trim();
        const byId = this.children.get(wanted);
        if (byId !== undefined) return byId;
        const named = [...this.children.values()].filter((child) => child.name === wanted);
        return named.length === 1 ? named[0] : undefined;
    }

    require(ref: string | undefined): Child {
        if (ref === undefined || ref.trim() === "") throw new StartError("name the child: its id or its name");
        const child = this.find(ref);
        if (child === undefined) {
            const known = [...this.children.values()].map((entry) => `${entry.name} (${entry.id})`);
            throw new StartError(
                `no child "${oneLine(ref, 40)}" in this session${known.length === 0 ? "; none was started" : `; known: ${known.join(", ")}`}`,
            );
        }
        return child;
    }

    private liveCount(): number {
        return [...this.children.values()].filter((child) => child.live).length;
    }

    // ---- starting ----------------------------------------------------------------------------------------------------

    private checkCounts(): void {
        if (this.liveCount() >= this.settings.maxRunning) {
            throw new StartError(
                `${this.liveCount()} children are running already (agents.maxRunning is ${this.settings.maxRunning}); wait for one to end`,
            );
        }
        if (this.started >= this.settings.maxStarted) {
            throw new StartError(
                `this session has started ${this.started} children already (agents.maxStarted is ${this.settings.maxStarted})`,
            );
        }
    }

    private checkSession(ctx: ExtensionContext): void {
        if (this.isChild) throw new StartError("a child cannot start children");
        if (!this.active) throw new StartError("no session is running");
        if (ctx.mode === "print" || ctx.mode === "json") {
            throw new StartError(
                "children need a session that stays open for their reports; this run ends after one answer",
            );
        }
    }

    /** Starts a child from a role and a task, and returns once the child has been checked and has its task. */
    async start(input: StartInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<Started> {
        this.touch(ctx);
        this.checkSession(ctx);
        const role = this.roles.roles.get(input.role);
        if (role === undefined) {
            const names = [...this.roles.roles.keys()];
            throw new StartError(`no role "${oneLine(input.role, 40)}"; roles: ${names.join(", ") || "none"}`);
        }
        const task = input.task.trim();
        if (task === "" || task.length > MAX_TASK_CHARS)
            throw new StartError(`the task must be 1 to ${MAX_TASK_CHARS} characters`);
        const name = nameFor(role.name, input.name, (taken) =>
            [...this.children.values()].some((child) => child.name === taken),
        );
        this.checkCounts();
        const cwd = resolveCwd(ctx, input.cwd);
        const model = modelFor(ctx, this.pi, this.settings, agentDir(this.host.env()), role);
        // Worked out before a worktree or a process exists: a role that cannot run here is refused with the reason.
        const requireCommands = requiredCommands(this.pi);
        const plan = planRole(this.pi, role, this.settings.roles[role.name], requireCommands);
        signal?.throwIfAborted();

        // Everything above is checked without waiting, so two starts at once cannot both take the same name or the last place.
        const id = generateId((candidate) => this.children.has(candidate));
        const dir = runDirOf(stateDir(this.host.env()), this.session, id);
        const spec: ChildSpec = {
            id,
            name,
            role: role.name,
            writes: role.writes,
            limits: limitsFor(this.settings, role.name),
            approvals: approvalsFor(this.settings, role.name),
            cwd,
            dir,
            session: this.session,
            model,
            generation: 1,
            startedAt: new Date(this.host.now()).toISOString(),
            requireCommands,
        };
        const child = new Child(spec, this.childContext());
        this.children.set(id, child);
        this.started++;
        let tree: Worktree | undefined;
        try {
            if (role.writes) {
                tree = await addWorktree(
                    (root, args, git) => jig().exec.git(root, args, git === undefined ? {} : { signal: git }),
                    cwd,
                    { name, id, pattern: this.settings.branch },
                    signal,
                );
                // One writer per folder: a worktree is new, so this holds unless something is badly wrong.
                if (tree.path === realpathSync(ctx.cwd)) {
                    throw new StartError("a role that writes may not work in the parent's own folder");
                }
                const clash = [...this.children.values()].find(
                    (other) => other !== child && other.live && other.spec.writes && other.spec.cwd === tree?.path,
                );
                if (clash !== undefined) throw new StartError(`${clash.name} is writing in ${tree.path} already`);
                child.spec = { ...child.spec, cwd: tree.path, branch: tree.branch, worktree: tree.path };
            }
            signal?.throwIfAborted();
            const promptFile = writeText(dir, "system-prompt.md", `${plan.prompt}\n`);
            await this.run(child, role, model, plan, promptFile, taskPrompt(role, name, task, child.spec));
            signal?.throwIfAborted();
            const watchId = this.watches.start(child, this.watchSpec(child.id));
            return { child, model: child.snapshot().model, watchId };
        } catch (error) {
            await child.stop().catch(() => undefined);
            this.children.delete(id);
            this.started--;
            if (tree !== undefined && !(await removeWorktree((root, args) => jig().exec.git(root, args), tree))) {
                const note = ` The worktree ${tree.path} (branch ${tree.branch}) was left in place.`;
                if (error instanceof StartError) throw new StartError(`${error.message}${note}`);
            }
            throw error;
        }
    }

    private async run(
        child: Child,
        role: Role,
        model: ModelChoice | undefined,
        plan: RolePlan,
        promptFile: string,
        prompt: string,
    ): Promise<void> {
        const spec = child.spec;
        const flags = flagsFor({
            role,
            model,
            sessionId: `agent-${spec.id}`,
            promptFile,
            skillFiles: plan.skills.visible.map((skill) => skill.file),
            context: plan.effective.context,
            ...(plan.effective.thinking === undefined ? {} : { thinking: plan.effective.thinking }),
        });
        const env = childEnvironment(this.host.env(), this.settings.env, {
            id: spec.id,
            name: spec.name,
            role: spec.role,
            parentSession: this.session,
            parentPid: this.host.pid,
            policy: plan.policy,
        });
        await child.launch(this.host.piCommand(), flags, env, prompt);
    }

    /** What a child's watch is started with. The backstop is long enough that waiting for you never makes it fire first. */
    watchSpec(ref: string): { spec: WatchSpec; timeoutMinutes: number; stallMinutes: number } {
        const child = this.require(ref);
        const { limits } = child.spec;
        const timeoutMinutes = limits.maxMinutes + 10 + this.settings.maxAsks * this.settings.approvalWaitMinutes;
        return {
            spec: { id: child.id, name: child.name, deadline: this.host.now() + timeoutMinutes * 60_000 },
            timeoutMinutes,
            stallMinutes: limits.maxMinutes,
        };
    }

    /** `jig:watch-done`: a child's watch that was stopped from the `watch` tool ends the child too. */
    onWatchDone(event: WatchDoneEvent): void {
        if (event.kind !== WATCH_KIND) return;
        const childId = this.watches.ended(event.id);
        if (childId === undefined) return;
        const child = this.children.get(childId);
        if (child?.live === true && event.result.outcome === "stopped") void child.stop();
    }

    // ---- steering, resuming, stopping --------------------------------------------------------------------------------

    /** Sends a message to a running child, or starts a finished one again in a new process from its saved session. */
    async message(
        ref: string | undefined,
        text: string,
        ctx: ExtensionContext,
        signal?: AbortSignal,
    ): Promise<{ child: Child; resumed: boolean }> {
        this.touch(ctx);
        const child = this.require(ref);
        const body = text.trim();
        if (body === "" || body.length > MAX_MESSAGE_CHARS)
            throw new StartError(`the message must be 1 to ${MAX_MESSAGE_CHARS} characters`);
        if (child.live) {
            await child.steer(body);
            return { child, resumed: false };
        }
        this.checkSession(ctx);
        const role = this.roles.roles.get(child.spec.role);
        if (role === undefined)
            throw new StartError(`the role ${child.spec.role} no longer exists, so ${child.name} cannot be resumed`);
        this.checkCounts();
        try {
            if (!statSync(child.spec.cwd).isDirectory()) throw new Error("not a folder");
        } catch {
            throw new StartError(`${child.name} worked in ${child.spec.cwd}, which is gone, so it cannot be resumed`);
        }
        const model = modelFor(ctx, this.pi, this.settings, agentDir(this.host.env()), role);
        // A resumed child gets the policy of the role as it is now: a file or a setting that was narrowed since applies to it too.
        const requireCommands = requiredCommands(this.pi);
        const plan = planRole(this.pi, role, this.settings.roles[role.name], requireCommands);
        const spec: ChildSpec = {
            ...child.spec,
            writes: role.writes,
            limits: limitsFor(this.settings, role.name),
            approvals: approvalsFor(this.settings, role.name),
            model,
            generation: child.spec.generation + 1,
            startedAt: new Date(this.host.now()).toISOString(),
            requireCommands,
        };
        signal?.throwIfAborted();
        this.watches.stop(child);
        child.reset(spec);
        this.started++;
        try {
            const promptFile = writeText(spec.dir, "system-prompt.md", `${plan.prompt}\n`);
            await this.run(
                child,
                role,
                model,
                plan,
                promptFile,
                `Message from your parent agent:\n\n${body}\n\nYour last message is your report again; the limits start afresh.`,
            );
            this.watches.start(child, this.watchSpec(child.id));
        } catch (error) {
            await child.stop().catch(() => undefined);
            this.started--;
            throw error;
        }
        return { child, resumed: true };
    }

    /** Stops a child and returns its partial report. */
    async stop(ref: string | undefined): Promise<{ child: Child; outcome: Outcome }> {
        const child = this.require(ref);
        const was = child.live;
        const outcome = await child.stop();
        if (was) this.watches.stop(child);
        return { child, outcome };
    }

    // ---- reading -----------------------------------------------------------------------------------------------------

    /** One line for a child. */
    statusRow(child: Child): string {
        const s = child.snapshot();
        const where = s.branch === undefined ? "" : ` branch ${s.branch}`;
        const asks = s.waiting > 0 ? `, ${s.waiting} question${s.waiting === 1 ? "" : "s"} waiting` : "";
        return `${s.name} (${s.id}) ${s.role}: ${s.display}; turn ${s.turns}/${s.maxTurns}, ${s.minutes}/${s.maxMinutes} min, ${s.cost} of $${s.maxCost.toFixed(2)}${asks}; ${s.model}${where}`;
    }

    /** One line per child, oldest first. */
    statusRows(): string[] {
        return [...this.children.values()].map((child) => this.statusRow(child));
    }

    /** Lines for `/jig`. */
    statusLines(): string[] {
        if (this.isChild) return [];
        const lines: string[] = [];
        const live = this.liveCount();
        lines.push(
            `jig-agents: ${live} child${live === 1 ? "" : "ren"} running, ${this.started} of ${this.settings.maxStarted} started; roles: ${[...this.roles.roles.keys()].join(", ") || "none"}`,
        );
        for (const problem of this.roles.problems) {
            lines.push(
                `jig-agents: agent file ${path.basename(problem.file)} skipped: ${stripControl(problem.problem)}`,
            );
        }
        if (this.problem !== undefined) lines.push(`jig-agents: ${this.problem}`);
        return lines;
    }
}
