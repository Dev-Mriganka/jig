// Waking the agent: task events become messages, and a noisy build is one message and not twenty. The shape of the message
// (the task, what happened, the matching line, the last lines, and a follow-up that starts a turn) is adapted from
// gvanderclay/pi-bg-bash (MIT, see docs/background.md, "Credit"). Waking on a pattern, limiting repeats and holding while one
// message is on its way are behaviours described in aliou/pi-processes's README; no code was taken from it.
import { formatRuntime, runtimeMs, slashed, stateText } from "./format.ts";
import { formatBytes } from "./output.ts";
import type { Task } from "./types.ts";

/** The `customType` of a waking message. `message_start` for it ends the hold on the next one. */
export const WAKE_TYPE = "jig-sandbox-background";
/** The `customType` of the one-line note after you stop a task: it never wakes the agent. */
export const NOTE_TYPE = "jig-sandbox-background-note";

/** What the design says, and what a test shortens. */
export interface Timing {
    /** Events that arrive within this are one message. */
    flushMs: number;
    /** At most this many error wake-ups per task. */
    errorWakeups: number;
    /** At least this long between two error wake-ups of a task. */
    errorGapMs: number;
    /** A message is taken as received after this long even if no sign of it came. */
    inFlightMs: number;
}

export const DEFAULT_TIMING: Timing = { flushMs: 1_000, errorWakeups: 3, errorGapMs: 30_000, inFlightMs: 60_000 };

/** More events than this waiting are counted and not kept. */
const PENDING_MAX = 20;
const TAIL_LINES = 20;
const TAIL_BYTES = 4_096;
const LINES_BUDGET = 60;
const MESSAGE_BYTES = 8_192;
const MATCH_CHARS = 300;

export type EventKind = "ready" | "error" | "exit";

export interface TaskEvent {
    taskId: string;
    kind: EventKind;
    at: number;
    /** Where the matching line is in the log, so a `bg_output` read that covered it can drop the event. */
    offset?: number;
    pattern?: string;
    line?: string;
    /** Error matches since the last message about this task, which did not wake the agent. */
    similar?: number;
}

export interface SendOptions {
    deliverAs?: "followUp";
    triggerTurn: boolean;
}

export interface NotifierDeps {
    /** Delivers one message. It may throw: a session that has ended. */
    send(
        message: { customType: string; content: string; display: boolean; details: unknown },
        options: SendOptions,
    ): void;
    now(): number;
    /** Whether a message wakes the agent (`background.wake`). */
    wake(): boolean;
    task(id: string): Task | undefined;
    tail(task: Task, lines: number, bytes: number): { text: string; cut: boolean };
    timing?: Partial<Timing>;
}

interface ErrorState {
    wakeups: number;
    lastWakeAt: number;
    suppressed: number;
}

export class Notifier {
    private readonly deps: NotifierDeps;
    private readonly timing: Timing;
    private pending: TaskEvent[] = [];
    private omitted = 0;
    private inFlight = false;
    private flushTimer: NodeJS.Timeout | undefined;
    private flightTimer: NodeJS.Timeout | undefined;
    private closed = false;
    private readonly errors = new Map<string, ErrorState>();

    constructor(deps: NotifierDeps) {
        this.deps = deps;
        this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    }

    ready(task: Task, pattern: string, line: string, offset: number): void {
        this.push({ taskId: task.id, kind: "ready", at: this.deps.now(), pattern, line, offset });
    }

    /** At most three wake-ups per task, 30 seconds apart. Matches in between are counted and reported with the next one. */
    error(task: Task, pattern: string, line: string, offset: number): void {
        const state = this.errors.get(task.id) ?? { wakeups: 0, lastWakeAt: Number.NEGATIVE_INFINITY, suppressed: 0 };
        this.errors.set(task.id, state);
        const now = this.deps.now();
        if (state.wakeups >= this.timing.errorWakeups || now - state.lastWakeAt < this.timing.errorGapMs) {
            state.suppressed++;
            return;
        }
        state.wakeups++;
        state.lastWakeAt = now;
        const similar = state.suppressed;
        state.suppressed = 0;
        this.push({ taskId: task.id, kind: "error", at: now, pattern, line, offset, similar });
    }

    exit(task: Task): void {
        const state = this.errors.get(task.id);
        this.push({ taskId: task.id, kind: "exit", at: this.deps.now(), similar: state?.suppressed ?? 0 });
    }

    /** One line, sent at once and never waking the agent, saying you stopped a task it started. */
    userKilled(task: Task): void {
        if (this.closed) return;
        const content = `Background task ${task.id} "${task.name}" was stopped by the user: ${stateText(task)}.`;
        try {
            this.deps.send(
                {
                    customType: NOTE_TYPE,
                    content,
                    display: true,
                    details: { events: [{ id: task.id, kind: "exit", state: task.state, exitCode: task.exitCode }] },
                },
                { triggerTurn: false },
            );
        } catch {
            // A session that has ended: you saw the stop yourself.
        }
    }

    /** The agent read output that covers these bytes, so the wake-up for them would only repeat what it saw. */
    seen(taskId: string, start: number, end: number): void {
        this.pending = this.pending.filter(
            (event) =>
                !(
                    event.taskId === taskId &&
                    event.kind !== "exit" &&
                    event.offset !== undefined &&
                    event.offset >= start &&
                    event.offset < end
                ),
        );
    }

    /** The agent stopped the task itself: no wake-up of any kind for it. */
    forget(taskId: string): void {
        this.pending = this.pending.filter((event) => event.taskId !== taskId);
        this.errors.delete(taskId);
    }

    /** `message_start` for a message of ours: it has reached the transcript, so the next one may go. */
    delivered(): void {
        if (!this.inFlight) return;
        this.inFlight = false;
        if (this.flightTimer) clearTimeout(this.flightTimer);
        this.flightTimer = undefined;
        this.schedule();
    }

    /** A new session on the same extension: wake-ups work again. */
    reopen(): void {
        this.closed = false;
        this.inFlight = false;
        this.errors.clear();
    }

    close(): void {
        this.closed = true;
        this.pending = [];
        this.omitted = 0;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        if (this.flightTimer) clearTimeout(this.flightTimer);
        this.flushTimer = undefined;
        this.flightTimer = undefined;
    }

    get pendingCount(): number {
        return this.pending.length;
    }

    private push(event: TaskEvent): void {
        if (this.closed) return;
        this.pending.push(event);
        if (this.pending.length > PENDING_MAX) {
            this.pending.shift();
            this.omitted++;
        }
        this.schedule();
    }

    private schedule(): void {
        if (this.closed || this.flushTimer || this.inFlight || this.pending.length === 0) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush();
        }, this.timing.flushMs);
        this.flushTimer.unref();
    }

    private flush(): void {
        if (this.closed || this.inFlight || this.pending.length === 0) return;
        const events = this.pending;
        const omitted = this.omitted;
        const waking = this.deps.wake();
        try {
            const { content, details } = this.compose(events, omitted);
            this.deps.send(
                { customType: WAKE_TYPE, content, display: true, details },
                waking ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: false },
            );
        } catch {
            // Keep the events and try again after the usual wait.
            this.schedule();
            return;
        }
        this.pending = [];
        this.omitted = 0;
        this.inFlight = true;
        this.flightTimer = setTimeout(() => {
            this.flightTimer = undefined;
            this.inFlight = false;
            this.schedule();
        }, this.timing.inFlightMs);
        this.flightTimer.unref();
    }

    private compose(events: readonly TaskEvent[], omitted: number): { content: string; details: unknown } {
        const sections: string[] = [];
        const summary: Array<{ id: string; kind: EventKind; state: string; exitCode?: number }> = [];
        const lines = Math.max(5, Math.min(TAIL_LINES, Math.floor(LINES_BUDGET / events.length)));
        if (omitted > 0) sections.push(`${omitted} earlier background event${omitted === 1 ? "" : "s"} omitted.`);
        for (const event of events) {
            const task = this.deps.task(event.taskId);
            if (!task) continue;
            sections.push(this.section(task, event, lines));
            summary.push({
                id: task.id,
                kind: event.kind,
                state: task.state,
                ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
            });
        }
        let content = sections.join("\n\n");
        if (Buffer.byteLength(content) > MESSAGE_BYTES) {
            content = `${Buffer.from(content)
                .subarray(0, MESSAGE_BYTES - 40)
                .toString("utf8")
                .replace(/�$/, "")}\n[message cut to 8 KiB]`;
        }
        return { content, details: { events: summary } };
    }

    private section(task: Task, event: TaskEvent, lines: number): string {
        const now = this.deps.now();
        const label = `Background task ${task.id} "${task.name}"`;
        const similar =
            event.similar === undefined || event.similar === 0
                ? undefined
                : `+${event.similar} similar match${event.similar === 1 ? "" : "es"}`;
        const matched = event.line === undefined ? undefined : event.line.slice(0, MATCH_CHARS);
        const parts: string[] = [];
        if (event.kind === "ready") {
            parts.push(
                `${label}: READY, matched ${slashed(event.pattern ?? "")} after ${formatRuntime(event.at - task.startedAt)} (still running).`,
            );
        } else if (event.kind === "error") {
            const since = similar === undefined ? "still running" : `${similar} since the last message; still running`;
            parts.push(
                `${label}: ERROR, matched ${slashed(event.pattern ?? "")} at ${Math.round((event.at - task.startedAt) / 1000)}s (${since}).`,
            );
        } else {
            const errors =
                task.errorMatches > 0
                    ? ` ${task.errorMatches} error match${task.errorMatches === 1 ? "" : "es"} while running.`
                    : "";
            parts.push(`${label}: ${stateText(task)}, ran ${formatRuntime(runtimeMs(task, now))}.${errors}`);
        }
        if (matched !== undefined) parts.push(`Matched line: ${matched}`);
        if (task.log?.error) parts.push(`The log stopped (${task.log.error}); later output was not recorded.`);
        const tail = this.deps.tail(task, lines, TAIL_BYTES);
        if (tail.text === "") parts.push("(no output)");
        else {
            const heading = tail.cut
                ? `Last ${lines} lines (cut to ${formatBytes(TAIL_BYTES)}; bg_output {"id":"${task.id}","tail":200} reads more)`
                : "Last output";
            parts.push(`${heading}:\n${tail.text}`);
        }
        if (event.kind === "exit" && task.sandboxLines.length > 0) parts.push(task.sandboxLines.join("\n"));
        return parts.join("\n");
    }
}
