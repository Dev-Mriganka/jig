// The registry of background tasks: starting, stopping, limits, deadlines, change listeners and the end of the session.
//
// A task is a command run exactly as a foreground one is, wrapped by the sandbox's broker with the same rules, and started
// here instead of by Pi's bash tool so that Pi's side owns its process group and its pipes. The registry, the launch gate and
// the order of the group kill follow gvanderclay/pi-bg-bash (MIT, see docs/background.md, "Credit"), reworked for bubblewrap
// and for tasks that end with the session.
import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxSettings } from "../config.ts";
import { afterEnd } from "./after-end.ts";
import { captureOutput } from "./capture.ts";
import { buildTaskEnv } from "./env.ts";
import { describeStop, stateText } from "./format.ts";
import { TaskLog } from "./logfile.ts";
import { Notifier, WAKE_TYPE } from "./notify.ts";
import { tailText } from "./output.ts";
import { GRACE_MS, realPort, terminate } from "./process.ts";
import type { ProcessPort } from "./process.ts";
import {
    cleanupSessions,
    ensureSessionFolder,
    removeSessionFolder,
    sessionFolder,
    writeManifest,
    writeOwner,
} from "./sessions.ts";
import { failedTask, runningTask } from "./task-record.ts";
import type { StartRequest, StopReport, TasksDeps } from "./tasks-deps.ts";
import type { KillReason, StopOutcome, Task } from "./types.ts";
import { LineMatcher } from "./patterns.ts";

/** Logs rotate at 4 MiB. */
export const LOG_SEGMENT_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_CAP_MS = 5_000;
const SEGMENT = "jig-theme:segment";

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });

export class Tasks {
    readonly notifier: Notifier;
    private readonly deps: TasksDeps;
    private readonly port: ProcessPort;
    private readonly now: () => number;
    private readonly tasks = new Map<string, Task>();
    private readonly launching = new Set<Promise<void>>();
    private readonly listeners = new Set<() => void>();
    private ctx: ExtensionContext | undefined;
    private sessionId = "session";
    private folder: string | undefined;
    private nextId = 1;
    private closed = false;
    private lastLabel: string | undefined;

    constructor(deps: TasksDeps) {
        this.deps = deps;
        this.port = deps.port ?? realPort;
        this.now = deps.now ?? Date.now;
        this.notifier = new Notifier({
            send: (message, options) => deps.send(message, options),
            now: this.now,
            wake: () => deps.settings().wake === "on",
            task: (id) => this.tasks.get(id),
            tail: (task, lines, bytes) => tailText(task, lines, bytes, this.now()),
            ...(deps.timing === undefined ? {} : { timing: deps.timing }),
        });
    }

    // ---- the session

    /** Called at session start: remembers the screen and stops what a crashed session left behind. */
    sessionStart(ctx: ExtensionContext): void {
        this.closed = false;
        this.notifier.reopen();
        this.setContext(ctx);
        try {
            this.sessionId = ctx.sessionManager.getSessionId();
        } catch {
            // Keep the default.
        }
        this.folder = undefined;
        this.cleanOrphans();
        this.publish();
    }

    setContext(ctx: ExtensionContext | undefined): void {
        if (ctx?.ui) this.ctx = ctx;
    }

    get context(): ExtensionContext | undefined {
        return this.ctx;
    }

    /** A message of ours reached the transcript. */
    onMessageStart(message: { role?: string; customType?: string }): void {
        if (message.role === "custom" && message.customType === WAKE_TYPE) this.notifier.delivered();
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    // ---- reading

    get(id: string): Task | undefined {
        return this.tasks.get(id);
    }

    requireTask(id: string): Task {
        const task = this.tasks.get(id);
        if (!task) throw new Error(`Unknown task id ${id}. bg_list shows this session's tasks.`);
        return task;
    }

    /** Running first, then newest first. */
    list(): Task[] {
        return [...this.tasks.values()].sort(
            (a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt,
        );
    }

    running(): Task[] {
        return [...this.tasks.values()].filter((task) => task.state === "running");
    }

    // ---- starting

    async start(request: StartRequest, ctx: ExtensionContext | undefined): Promise<Task> {
        if (this.closed) throw new Error("Background tasks are unavailable while the session shuts down.");
        const limits = this.deps.settings();
        if (this.running().length + this.launching.size >= limits.maxTasks) {
            throw new Error(
                `Background limit reached (${limits.maxTasks} running). bg_list shows them; bg_kill one first.`,
            );
        }
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        this.launching.add(gate);
        try {
            return await this.launch(request, ctx, limits);
        } finally {
            this.launching.delete(gate);
            open();
        }
    }

    private async launch(
        request: StartRequest,
        ctx: ExtensionContext | undefined,
        limits: SandboxSettings["background"],
    ): Promise<Task> {
        const cwd = ctx?.cwd || process.cwd();
        const env = buildTaskEnv(this.deps.env, this.deps.agentDir(), ctx);
        const maxMs = limits.maxRuntimeMinutes * 60_000;
        const timeoutMs = Math.min(request.timeoutSeconds === undefined ? maxMs : request.timeoutSeconds * 1000, maxMs);

        // A refusal (the sandbox is off or could not start) throws here and leaves nothing behind.
        const prepared = await this.deps.sandbox.prepare(request.command, cwd, env);
        const snapshot = this.deps.aftermath.before(prepared, cwd);
        const { shell, args } = this.deps.shell();
        let child: ReturnType<typeof spawn> | undefined;
        try {
            child = spawn(shell, [...args, prepared.wrapped], {
                cwd,
                env: prepared.env,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            await prepared.finish();
            throw this.recordFailure(request, cwd, error as Error);
        }
        // A spawn that failed (no such folder) reports it as an event and leaves no pid.
        child.on("error", () => undefined);
        if (this.closed || !child.pid) {
            this.killNow(child.pid);
            await prepared.finish();
            throw new Error(
                this.closed
                    ? "Background tasks are unavailable while the session shuts down."
                    : `Background task failed to start (the shell could not be run in ${cwd}).`,
            );
        }

        let created: { id: string; log: TaskLog };
        try {
            created = this.createLog();
        } catch (error) {
            this.killNow(child.pid);
            await prepared.finish();
            throw new Error(`Background task failed to start (it cannot make its log: ${(error as Error).message}).`);
        }
        const { id, log } = created;

        const task = runningTask({
            id,
            request,
            cwd,
            pid: child.pid,
            startedAt: this.now(),
            timeoutMs,
            log,
            child,
            prepared,
            snapshot,
        });
        task.matcher = new LineMatcher({
            ready: request.notifyOn.ready,
            error: request.notifyOn.error,
            onMatch: (match) => this.onMatch(task, match.kind, match.pattern, match.line, match.offset),
        });
        this.tasks.set(id, task);
        captureOutput(task, child, prepared.values, this.now, (code) => void this.finish(task, code));
        task.deadlineTimer = setTimeout(() => {
            void this.stop(task, "max runtime");
        }, timeoutMs);
        task.deadlineTimer.unref();
        this.writeState();
        this.deps.bridge?.taskStarted(task);
        this.changed();
        return task;
    }

    /** A process that could not be created is kept as a `failed` task, so `bg_list` can say why. */
    private recordFailure(request: StartRequest, cwd: string, error: Error): Error {
        const id = `bg-${this.nextId++}`;
        const task = failedTask(id, request, cwd, this.now(), error.message);
        this.tasks.set(id, task);
        this.evict();
        this.changed();
        return new Error(`Background task ${id} failed to start (${error.message}).`);
    }

    /** The next free id. A log that already exists (a leftover) is skipped, never written over. */
    private createLog(): { id: string; log: TaskLog } {
        const folder = this.sessionFolder();
        for (;;) {
            const id = `bg-${this.nextId++}`;
            try {
                return { id, log: new TaskLog(folder, id, this.deps.segmentBytes ?? LOG_SEGMENT_BYTES) };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
        }
    }

    private onMatch(task: Task, kind: "ready" | "error", pattern: string, line: string, offset: number): void {
        if (kind === "ready") {
            if (task.ready) return;
            task.ready = true;
            task.readyPattern = pattern;
            this.notifier.ready(task, pattern, line, offset);
        } else {
            task.errorMatches++;
            this.notifier.error(task, pattern, line, offset);
        }
        this.changed();
    }

    /** The task's process is gone: record it, undo what it planted, and tell the agent. */
    private async finish(task: Task, exitCode: number): Promise<void> {
        if (task.state !== "running") return;
        if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
        task.matcher?.flush();
        task.matcher?.dispose();
        task.log?.close();
        task.endedAt = this.now();
        task.exitCode = exitCode;
        task.state = task.killReason ? "killed" : "exited";
        if (task.killReason) task.reason = task.killReason;
        task.child = undefined;
        const prepared = task.prepared;
        const snapshot = task.snapshot;
        task.prepared = undefined;
        task.snapshot = undefined;
        this.deps.bridge?.taskEnded(task);
        // The process is gone: whoever stopped it can stop waiting. What follows is the sandbox's own clean-up.
        task.markSettled();
        this.writeState();
        this.changed();
        if (prepared !== undefined && !this.closed)
            await afterEnd(this.deps.aftermath, () => this.ctx, task, prepared, snapshot, this.now);
        else await prepared?.finish();
        if (!this.closed) {
            switch (task.killReason) {
                case undefined:
                case "max runtime":
                    this.notifier.exit(task);
                    break;
                case "by user":
                    this.notifier.userKilled(task);
                    break;
                default:
                    this.notifier.forget(task.id);
            }
            this.evict();
        }
        this.changed();
    }

    // ---- stopping

    /** Stops one task. Safe to call twice: the second call joins the first. */
    stop(task: Task, reason: KillReason): Promise<StopOutcome | undefined> {
        if (task.state !== "running") return Promise.resolve(undefined);
        task.killReason ??= reason;
        task.killing ??= terminate(task.pid, this.now() - task.startedAt, {
            port: this.port,
            ended: (ms) => this.ended(task, ms),
            sleep,
            now: this.now,
            graceMs: this.deps.graceMs ?? GRACE_MS,
        });
        return task.killing;
    }

    /** What the agent hears after `bg_kill`, and what `/ps` shows after a stop. */
    async kill(target: string, reason: "by agent" | "by user"): Promise<StopReport[]> {
        const wanted = target === "all" ? this.running() : [this.requireTask(target)];
        if (target !== "all") {
            const only = wanted[0] as Task;
            if (only.state !== "running") {
                return [{ id: only.id, text: `${only.id} had already finished: ${stateText(only)}.` }];
            }
        }
        return Promise.all(
            wanted.map(async (task) => {
                if (reason === "by agent") this.notifier.forget(task.id);
                const outcome = await this.stop(task, reason);
                return { id: task.id, text: describeStop(task, outcome) };
            }),
        );
    }

    /** Resolves true once the end of the task is recorded, false after `ms`. */
    private ended(task: Task, ms: number): Promise<boolean> {
        if (task.state !== "running") return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), ms);
            void task.settled.then(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    private killNow(pid: number | undefined): void {
        if (pid && pid > 1) this.port.signal(-pid, "SIGKILL");
    }

    /** `/ps`: forget the finished tasks and their logs. */
    clearFinished(): void {
        for (const task of [...this.tasks.values()]) {
            if (task.state === "running") continue;
            task.log?.remove();
            this.tasks.delete(task.id);
        }
        this.changed();
    }

    private evict(): void {
        const finished = this.list().filter((task) => task.state !== "running");
        for (const task of finished.slice(this.deps.settings().keepFinished)) {
            task.log?.remove();
            this.tasks.delete(task.id);
        }
    }

    // ---- the end of the session

    /** Stops every task (the polite stop, the wait, the hard one; five seconds at most), removes the logs and goes quiet. */
    async shutdown(): Promise<void> {
        this.closed = true;
        this.notifier.close();
        await Promise.all([...this.launching]);
        const work = Promise.all(this.running().map((task) => this.stop(task, "session end")));
        const cap = new Promise<void>((resolve) => {
            setTimeout(resolve, SHUTDOWN_CAP_MS).unref();
        });
        await Promise.race([work, cap]);
        for (const task of this.tasks.values()) {
            if (task.state === "running") this.killNow(task.pid);
            if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
            task.matcher?.dispose();
            task.log?.close();
        }
        this.tasks.clear();
        this.listeners.clear();
        if (this.folder !== undefined) removeSessionFolder(this.folder);
        this.folder = undefined;
        this.publish();
    }

    // ---- the folder, the footer, clean-up

    private sessionFolder(): string {
        if (!this.folder) {
            this.folder = ensureSessionFolder(this.deps.agentDir(), this.sessionId);
            writeOwner(this.folder, process.pid, this.port.startTicks(process.pid));
        }
        return this.folder;
    }

    private writeState(): void {
        if (!this.folder) return;
        try {
            writeManifest(
                this.folder,
                this.running().flatMap((task) => {
                    const startTicks = this.port.startTicks(task.pid);
                    return startTicks ? [{ id: task.id, pid: task.pid, startTicks }] : [];
                }),
            );
        } catch {
            // Clean-up is best effort.
        }
    }

    /** Stops what a crashed session left behind. */
    cleanOrphans(): { removed: string[]; killed: number[] } {
        try {
            return cleanupSessions({
                agentDir: this.deps.agentDir(),
                port: this.port,
                now: this.now(),
                keep: sessionFolder(this.deps.agentDir(), this.sessionId),
            });
        } catch {
            return { removed: [], killed: [] };
        }
    }

    private changed(): void {
        this.publish();
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                // A view that has closed.
            }
        }
    }

    /** The footer part: how many tasks run, through `jig-theme`'s event. An empty label takes it away. */
    private publish(): void {
        const count = this.closed ? 0 : this.running().length;
        const label = count === 0 ? "" : `${count} bg task${count === 1 ? "" : "s"}`;
        if (label === this.lastLabel) return;
        this.lastLabel = label;
        try {
            this.deps.emit(SEGMENT, { id: "jig-sandbox-tasks", label, tone: "accent" });
        } catch {
            // The bus of a session that has ended.
        }
    }
}

export type { Task };
