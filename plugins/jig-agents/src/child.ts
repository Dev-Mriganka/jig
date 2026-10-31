// One child: its counters, its pipes and its end. The parent owns all of it: the limits, the answers to questions and the stop are
// decided here, out of the child's reach. A child ends once, in `conclude`, whatever the cause. The parts that have a job of their own
// are in their own files: the process (child-process.ts), the questions (child-questions.ts) and the wording of the end (child-report.ts).
import type { ChildProcess } from "node:child_process";
import { oneLine, stripControl } from "./clean.ts";
import { ProcessHandle } from "./child-process.ts";
import { Questions } from "./child-questions.ts";
import { outcomeFor, reportText, settledPlan, watchResult } from "./child-report.ts";
import type { ConcludePlan, WatchResult } from "./child-report.ts";
import type { ChildSpec, ChildState, Outcome, Snapshot } from "./child-types.ts";
import type { AskDeps } from "./forward.ts";
import type { Host, PiCommand } from "./host.ts";
import { costText, describe, graceOver, reached, wrapUpMessage } from "./limits.ts";
import type { Used, Wrap } from "./limits.ts";
import { checkStarted, StartError } from "./launch.ts";
import { RpcChannel } from "./rpc.ts";
import type { Wire } from "./rpc.ts";
import type { Meta } from "./store.ts";
import { writeMeta, writeText } from "./store.ts";

/** What the child needs from the runtime around it. */
export interface ChildContext {
    host: Host;
    ask: AskDeps;
    maxAsks: number;
    /** Called whenever the child's state, counters or transcript change. */
    changed(child: Child): void;
}

const TRANSCRIPT_LINES = 200;
const STARTUP_MS = 60_000;
const PROMPT_MS = 30_000;
const SMALL_MS = 5_000;
const TICK_MS = 1000;
const MAX_REPORT_CHARS = 200_000;
const MAX_TRANSCRIPT_LINE = 300;

function messageText(message: unknown): string {
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text as string] : []))
        .join("\n");
}

export class Child {
    state: ChildState = "starting";
    outcome: Outcome | undefined;
    turns = 0;
    pid: number | undefined;
    reportFile: string | undefined;
    readonly transcript: string[] = [];

    private readonly process: ProcessHandle;
    private readonly questions: Questions;
    private channel: RpcChannel | undefined;
    private closing = false;
    private ended: Promise<void> = Promise.resolve();
    private closedController = new AbortController();
    private tickHandle: unknown;
    private promptAt = 0;
    private wrap: Wrap | undefined;
    private cost = 0;
    private priced = false;
    private lastStop: { reason: string; message: string } | undefined;
    private startErrors: string[] = [];
    private pidStart: string | undefined;
    private parentStart: string | undefined;
    private modelSeen = "";
    private noted: string | undefined;

    spec: ChildSpec;
    private readonly ctx: ChildContext;

    constructor(spec: ChildSpec, ctx: ChildContext) {
        this.spec = spec;
        this.ctx = ctx;
        this.process = new ProcessHandle(ctx.host);
        this.questions = new Questions(ctx.ask, ctx.maxAsks, {
            spec: () => this.spec,
            ending: () => this.closing,
            ended: () => this.state === "finished" || this.state === "stopped" || this.state === "failed",
            note: (line) => this.note(line),
            send: (record) => this.channel?.send(record),
            changed: () => ctx.changed(this),
            now: () => ctx.host.now(),
            signal: () => this.closedController.signal,
        });
    }

    /** Makes ready to run again in a new process, as a resumed child: new limits and a clean count, the same session and transcript. */
    reset(spec: ChildSpec): void {
        this.spec = spec;
        this.state = "starting";
        this.outcome = undefined;
        this.turns = 0;
        this.pid = undefined;
        this.process.reset();
        this.channel = undefined;
        this.closing = false;
        this.closedController = new AbortController();
        this.promptAt = 0;
        this.wrap = undefined;
        this.cost = 0;
        this.lastStop = undefined;
        this.startErrors = [];
        this.questions.reset();
        this.pidStart = undefined;
        this.noted = undefined;
        this.note(`--- resumed (start ${spec.generation}) ---`);
    }

    // ---- reading it --------------------------------------------------------------------------------------------------

    get id(): string {
        return this.spec.id;
    }
    get name(): string {
        return this.spec.name;
    }
    /** True until the child has ended, for any reason. */
    get live(): boolean {
        return this.state === "starting" || this.state === "running";
    }
    /** The promise of the child's end: settled when its outcome is known and its process gone. */
    get done(): Promise<void> {
        return this.ended;
    }

    /** Wall-clock milliseconds since the first prompt, minus the time spent waiting for the user. */
    activeMs(): number {
        if (this.promptAt === 0) return 0;
        const now = this.ctx.host.now();
        return Math.max(0, now - this.promptAt - this.questions.waitedTotal(now));
    }

    used(): Used {
        return { turns: this.turns, activeMs: this.activeMs(), cost: this.priced ? this.cost : undefined };
    }

    snapshot(): Snapshot {
        const used = this.used();
        const waiting = this.questions.waiting;
        let display: string = this.state;
        if (this.state === "running") {
            display =
                waiting > 0 ? "waiting for you" : this.wrap ? `wrapping up (${this.wrap.limit} limit)` : "running";
        } else if (this.outcome?.kind === "limit" && this.outcome.limit !== undefined) {
            display = `stopped at the ${this.outcome.limit} limit`;
        }
        return {
            id: this.spec.id,
            name: this.spec.name,
            role: this.spec.role,
            state: this.state,
            display,
            turns: used.turns,
            maxTurns: this.spec.limits.maxTurns,
            minutes: Math.round((used.activeMs / 60_000) * 10) / 10,
            maxMinutes: this.spec.limits.maxMinutes,
            cost: costText(used.cost),
            maxCost: this.spec.limits.maxCost,
            waiting,
            model: this.modelSeen || this.spec.model?.model || "the parent's",
            cwd: this.spec.cwd,
            ...(this.spec.branch === undefined ? {} : { branch: this.spec.branch }),
        };
    }

    /** The last lines of the transcript, for `/agents show`. */
    tail(count = 40): string[] {
        return this.transcript.slice(-count);
    }

    /** Adds a line to the transcript. */
    note(line: string): void {
        const clean = oneLine(line, MAX_TRANSCRIPT_LINE);
        if (clean === "") return;
        this.transcript.push(clean);
        if (this.transcript.length > TRANSCRIPT_LINES)
            this.transcript.splice(0, this.transcript.length - TRANSCRIPT_LINES);
    }

    // ---- starting it -------------------------------------------------------------------------------------------------

    private meta(): Meta {
        return {
            version: 1,
            id: this.spec.id,
            name: this.spec.name,
            role: this.spec.role,
            session: this.spec.session,
            ...(this.pid === undefined ? {} : { pid: this.pid }),
            ...(this.pidStart === undefined ? {} : { pidStart: this.pidStart }),
            parentPid: this.ctx.host.pid,
            ...(this.parentStart === undefined ? {} : { parentStart: this.parentStart }),
            state: this.state,
            startedAt: this.spec.startedAt,
            updatedAt: new Date(this.ctx.host.now()).toISOString(),
            cwd: this.spec.cwd,
            ...(this.spec.model === undefined ? {} : { model: this.spec.model.model }),
            ...(this.spec.branch === undefined ? {} : { branch: this.spec.branch }),
            ...(this.spec.worktree === undefined ? {} : { worktree: this.spec.worktree }),
            generation: this.spec.generation,
            ...(this.noted === undefined ? {} : { note: this.noted }),
        };
    }

    private save(): void {
        try {
            writeMeta(this.spec.dir, this.meta());
        } catch {
            // A record that cannot be written costs the orphan sweep one child; it does not stop the work.
        }
    }

    /**
     * Starts the process, checks it, and sends the task. Throws a `StartError` (after stopping the process) when the child cannot be used:
     * it did not start, it did not load the parent's plugins, or it runs another model than was asked.
     */
    async launch(pi: PiCommand, flags: readonly string[], env: Record<string, string>, task: string): Promise<void> {
        const { host } = this.ctx;
        this.state = "starting";
        this.closing = false;
        let resolveEnded: () => void = () => undefined;
        this.ended = new Promise((resolve) => {
            resolveEnded = resolve;
        });
        this.endedResolve = resolveEnded;
        let proc: ChildProcess;
        try {
            proc = this.process.spawn(pi, flags, env, this.spec.cwd, (gone) => this.onGone(gone));
        } catch (error) {
            await this.failStart(error instanceof Error ? error.message : String(error));
            throw new StartError(
                `the child could not be started: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        this.pid = proc.pid;
        if (proc.pid !== undefined) {
            this.pidStart = await host.processStart(proc.pid);
            this.parentStart = await host.processStart(host.pid);
        }
        this.save();
        if (proc.stdout === null || proc.stdin === null) {
            await this.failStart("the child has no pipes");
            throw new StartError("the child process has no pipes");
        }
        this.channel = new RpcChannel(
            proc.stdout,
            proc.stdin,
            {
                event: (event) => this.onEvent(event),
                ui: (request) => this.questions.onRequest(request),
                unreadable: (reason) =>
                    void this.conclude({
                        state: "failed",
                        kind: "error",
                        reason: `its output could not be read: ${reason}`,
                        abort: false,
                        fetch: false,
                    }),
                closed: () => undefined,
            },
            { timers: host.timers },
        );

        try {
            const [commands, state] = await Promise.all([
                this.channel.request({ type: "get_commands" }, STARTUP_MS),
                this.channel.request({ type: "get_state" }, STARTUP_MS),
            ]);
            this.verify(commands, state);
        } catch (error) {
            const exitText = this.process.exitText;
            const why = exitText !== "" ? exitText : error instanceof Error ? error.message : String(error);
            await this.failStart(why);
            throw error instanceof StartError
                ? error
                : new StartError(`the child could not be started: ${why}${this.process.stderrNote()}`);
        }
        // From here on its events count: a quick child may finish in the same chunk that carries the answer to the prompt.
        this.promptAt = host.now();
        this.state = "running";
        try {
            const reply = (await this.channel.request({ type: "prompt", message: task }, PROMPT_MS)) as
                | { disposition?: string }
                | undefined;
            if (reply?.disposition !== "started") {
                throw new StartError(`the child did not start a run for its task (${String(reply?.disposition)})`);
            }
        } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            await this.failStart(why);
            throw error instanceof StartError
                ? error
                : new StartError(`the child did not accept its task: ${why}${this.process.stderrNote()}`);
        }
        this.save();
        if (this.live && !this.closing) this.scheduleTick();
        this.ctx.changed(this);
    }

    private endedResolve: () => void = () => undefined;

    /** Checks what the child loaded and which model it runs. Throws a `StartError` that says what is wrong. */
    private verify(commands: unknown, state: unknown): void {
        const wanted = { requireCommands: this.spec.requireCommands, model: this.spec.model?.model };
        const check = checkStarted(wanted, this.startErrors, this.modelSeen, commands, state);
        if (check.model !== undefined) this.modelSeen = check.model;
        if (check.priced !== undefined) this.priced = check.priced;
        if (check.problem !== undefined) throw new StartError(check.problem);
    }

    private async failStart(why: string): Promise<void> {
        await this.conclude({ state: "failed", kind: "error", reason: why, abort: false, fetch: false, quiet: true });
    }

    // ---- what it says ------------------------------------------------------------------------------------------------

    private onEvent(event: Wire): void {
        switch (event.type) {
            case "extension_error": {
                const text = oneLine(`${String(event.extensionPath ?? "")}: ${String(event.error ?? "")}`, 300);
                if (this.state === "starting") this.startErrors.push(text);
                else this.note(`plugin error: ${text}`);
                return;
            }
            case "message_end": {
                const message = event.message as
                    | { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
                    | undefined;
                if (message?.role === "assistant") {
                    const text = messageText(message);
                    if (text !== "") this.note(`says: ${text}`);
                    if (typeof message.stopReason === "string") {
                        this.lastStop = { reason: message.stopReason, message: String(message.errorMessage ?? "") };
                    }
                }
                return;
            }
            case "tool_execution_start": {
                let args = "";
                try {
                    args = JSON.stringify(event.args) ?? "";
                } catch {
                    // An argument that cannot be shown is left out.
                }
                this.note(`calls ${String(event.toolName)} ${args}`);
                return;
            }
            case "tool_execution_end":
                if (event.isError === true) this.note(`${String(event.toolName)} failed`);
                return;
            case "turn_end": {
                if (this.state !== "running") return;
                this.turns++;
                const usage = (event.message as { usage?: { cost?: { total?: unknown } } } | undefined)?.usage;
                const turnCost = Number(usage?.cost?.total);
                if (Number.isFinite(turnCost) && turnCost > 0) {
                    this.cost += turnCost;
                    this.priced = true;
                }
                this.ctx.changed(this);
                void this.refreshCost().then(() => this.tick());
                return;
            }
            case "agent_settled":
                void this.settled(event.aborted === true);
                return;
            default:
        }
    }

    /** The session's cost, as Pi counts it (replies, tools that report usage, compaction). Failures leave the last number. */
    private async refreshCost(): Promise<void> {
        try {
            const stats = (await this.channel?.request({ type: "get_session_stats" }, SMALL_MS)) as
                | { cost?: unknown }
                | undefined;
            const cost = Number(stats?.cost);
            if (Number.isFinite(cost) && cost >= 0) {
                if (cost > 0) this.priced = true;
                this.cost = cost === 0 && this.cost > 0 ? this.cost : cost;
            }
        } catch {
            // The cost seen in the turn events stands.
        }
    }

    private async settled(aborted: boolean): Promise<void> {
        if (this.closing || this.state !== "running") return;
        await this.conclude(settledPlan(this.wrap, aborted, this.lastStop));
    }

    // ---- limits ------------------------------------------------------------------------------------------------------

    private scheduleTick(): void {
        this.ctx.host.timers.clearTimeout(this.tickHandle);
        this.tickHandle = this.ctx.host.timers.setTimeout(() => {
            this.tick();
            if (this.state === "running" && !this.closing) this.scheduleTick();
        }, TICK_MS);
    }

    /** Looks at the limits: at one, the child is told to wrap up; when the grace is over, it is aborted. */
    tick(): void {
        if (this.state !== "running" || this.closing) return;
        const used = this.used();
        if (this.wrap !== undefined) {
            if (graceOver(this.wrap, used)) {
                const limit = this.wrap.limit;
                this.note(`aborted: it did not finish within the grace after the ${limit} limit`);
                void this.conclude({ state: "failed", kind: "limit", limit, abort: true, fetch: true });
            }
            return;
        }
        const limit = reached(this.spec.limits, used);
        if (limit === undefined) return;
        this.wrap = { limit, turns: used.turns, activeMs: used.activeMs };
        this.note(`limit reached: ${describe(limit, this.spec.limits, used)}; told to write its report`);
        this.ctx.changed(this);
        void this.channel
            ?.request({ type: "steer", message: wrapUpMessage(limit, this.spec.limits, used) }, SMALL_MS)
            .catch(() => {
                // A child that cannot be told is aborted when the grace ends, or at once if it has no pipe.
                if (this.channel?.writable !== true)
                    void this.conclude({ state: "failed", kind: "limit", limit, abort: false, fetch: false });
            });
    }

    // ---- steering and ending -----------------------------------------------------------------------------------------

    /** Sends the child a message to read after its current turn. */
    async steer(text: string): Promise<void> {
        if (this.state !== "running" || this.closing || this.channel === undefined) {
            throw new Error(`${this.spec.name} is not running`);
        }
        await this.channel.request({ type: "steer", message: text }, PROMPT_MS);
        this.note(`steered: ${text}`);
    }

    private onGone(proc: ChildProcess): void {
        if (this.process.proc !== proc || this.closing || !this.live) return;
        const why = `the child exited (${this.process.exitText || "no exit code"})${this.process.stderrNote()}`;
        void this.conclude({ state: "failed", kind: "error", reason: why, abort: false, fetch: false });
    }

    /** Stops the child and returns its partial report. Does nothing to a child that has already ended. */
    async stop(): Promise<Outcome> {
        if (this.live) await this.conclude({ state: "stopped", kind: "stopped", abort: true, fetch: true });
        await this.ended;
        return this.outcome ?? { kind: "stopped", summary: `${this.spec.name} was stopped`, text: "" };
    }

    /** The parent session is ending: no courtesy, but nothing is left running. */
    async shutdown(waitMs = 3000): Promise<void> {
        if (!this.live && this.process.exited) return;
        if (this.live) {
            this.closing = true;
            this.ctx.host.timers.clearTimeout(this.tickHandle);
            this.closedController.abort();
            this.state = "stopped";
            this.outcome = { kind: "stopped", summary: `${this.spec.name} was stopped: the session ended`, text: "" };
            this.noted = "stopped because the parent session ended";
            this.save();
        }
        await this.process.terminate(waitMs, () => this.channel?.endInput());
        this.channel?.close();
        this.endedResolve();
    }

    /** Ends the child once: counts its last numbers, writes its report, and removes its process. */
    private conclude(plan: ConcludePlan): Promise<void> {
        if (this.closing) return this.ended;
        this.closing = true;
        const work = async (): Promise<void> => {
            this.ctx.host.timers.clearTimeout(this.tickHandle);
            this.closedController.abort();
            let text = "";
            if (this.channel?.writable === true) {
                if (plan.abort) await this.channel.request({ type: "abort" }, SMALL_MS).catch(() => undefined);
                if (plan.fetch) {
                    try {
                        const reply = (await this.channel.request({ type: "get_last_assistant_text" }, SMALL_MS)) as
                            | { text?: unknown }
                            | undefined;
                        if (typeof reply?.text === "string") text = reply.text;
                    } catch {
                        // The partial report is whatever the transcript has.
                    }
                    await this.refreshCost();
                }
            }
            text = stripControl(text).trim().slice(0, MAX_REPORT_CHARS);
            const used = this.used();
            this.outcome = outcomeFor(this.spec, plan, used, text);
            this.state = plan.state;
            if (plan.reason !== undefined) this.noted = plan.reason;
            if (plan.quiet !== true) this.writeReport(used);
            this.save();
            this.ctx.changed(this);
            await this.process.close(() => this.channel?.endInput());
            this.channel?.close();
            this.endedResolve();
        };
        // `ended` is replaced by the promise of the work only once, so that waiters see one end.
        void work().catch(() => this.endedResolve());
        return this.ended;
    }

    private writeReport(used: Used): void {
        const outcome = this.outcome;
        if (outcome === undefined) return;
        try {
            this.reportFile = writeText(
                this.spec.dir,
                "report.md",
                reportText(this.spec, outcome, used, this.modelSeen),
            );
        } catch {
            // The outcome still carries the text.
        }
    }

    /** What a watch tells the agent when this child has ended. Undefined while it runs. */
    result(): WatchResult | undefined {
        if (this.live || this.outcome === undefined) return undefined;
        return watchResult(this.spec, this.outcome, this.used(), this.reportFile);
    }

    /** Ends a child whose time the plugin stopped waiting for (the watch's backstop). */
    async timedOut(): Promise<void> {
        if (!this.live) return;
        await this.conclude({ state: "failed", kind: "timed-out", abort: true, fetch: true });
        await this.ended;
    }
}
