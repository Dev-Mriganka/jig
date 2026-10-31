// The words for a task, shared by the tools, `/ps` and the wake-up messages, so a state reads the same everywhere.
import type { StopOutcome, Task } from "./types.ts";

/** `1.2s`, or `2m 5s` from a minute on, or `1h 4m` from an hour. */
export function formatRuntime(ms: number): string {
    const seconds = Math.max(0, ms) / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** A limit in minutes: `90m`, `4h` or `1h 30m`. */
export function formatMinutes(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A command on one line (a line break shows as a return arrow), cut at `max` characters. */
export function oneLine(command: string, max = 200): string {
    const line = command.replace(/\s*\n\s*/g, " ⏎ ");
    return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The label of a task that was given none: the start of its command. */
export function defaultName(command: string): string {
    return oneLine(command, 40).replace(/"/g, "'");
}

export function stateText(task: Task): string {
    switch (task.state) {
        case "running":
            return "running";
        case "exited":
            return `exited (code ${task.exitCode ?? "?"})`;
        case "killed":
            return `killed (${task.reason ?? "unknown"})`;
        case "failed":
            return `failed to start (${task.reason ?? "unknown"})`;
    }
}

export function runtimeMs(task: Task, now: number): number {
    return (task.endedAt ?? now) - task.startedAt;
}

/** The pattern as the agent wrote it, in slashes: `/ERROR|Exception/`. */
export function slashed(pattern: string): string {
    return `/${pattern}/`;
}

/** `bg-3 | running | 4m 2s | dev server | npm run dev | ready seen, 0 error matches | listening on 3000` */
export function taskLine(task: Task, now: number): string {
    const watching: string[] = [];
    if (task.notifyOn.ready.length > 0) watching.push(task.ready ? "ready seen" : "ready not seen");
    if (task.notifyOn.error.length > 0 || task.errorMatches > 0) {
        watching.push(`${task.errorMatches} error match${task.errorMatches === 1 ? "" : "es"}`);
    }
    return [
        task.id,
        stateText(task),
        formatRuntime(runtimeMs(task, now)),
        task.name,
        oneLine(task.command),
        ...(watching.length > 0 ? [watching.join(", ")] : []),
        ...(task.ports.length > 0 && task.state === "running" ? [`listening on ${task.ports.join(", ")}`] : []),
    ].join(" | ");
}

/** What the agent hears after `bg_kill` for one task. */
export function describeStop(task: Task, outcome: StopOutcome | undefined): string {
    if (!outcome) return `${task.id} had already finished: ${stateText(task)}.`;
    if (outcome.how === "stuck") return `${task.id} is still running after SIGKILL; /ps shows it.`;
    if (outcome.how === "kill") {
        return `${task.id} ignored SIGTERM; killed with SIGKILL after ${Math.round(outcome.ms / 1000)}s.`;
    }
    return `${task.id} stopped by SIGTERM after ${formatRuntime(outcome.ms)} (exited, code ${task.exitCode ?? "?"}).`;
}
