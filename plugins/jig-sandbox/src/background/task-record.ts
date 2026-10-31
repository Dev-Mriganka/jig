// A task's record, made in the two ways a task can start: running, with its process, its log and its sandbox, or failed, when its
// process could not be created. The registry (tasks.ts) holds the records and decides when to make one; filling in the fields is all
// that is here.
import { defaultName } from "./format.ts";
import type { StartRequest } from "./tasks-deps.ts";
import type { Task } from "./types.ts";

/** What a running task is made from: the request, and the process, log and sandbox the registry set up for it. */
export interface RunningInput {
    id: string;
    request: StartRequest;
    cwd: string;
    pid: number;
    startedAt: number;
    timeoutMs: number;
    log: NonNullable<Task["log"]>;
    child: NonNullable<Task["child"]>;
    prepared: NonNullable<Task["prepared"]>;
    snapshot: Task["snapshot"];
}

export function runningTask(input: RunningInput): Task {
    const { request, startedAt, timeoutMs } = input;
    let markSettled!: () => void;
    return {
        id: input.id,
        name: request.name || defaultName(request.command),
        command: request.command,
        cwd: input.cwd,
        pid: input.pid,
        startedAt,
        state: "running",
        deadline: startedAt + timeoutMs,
        timeoutMs,
        notifyOn: request.notifyOn,
        cursor: 0,
        ready: false,
        errorMatches: 0,
        streamBytes: 0,
        log: input.log,
        sandboxLines: [],
        ports: [],
        notes: [],
        child: input.child,
        prepared: input.prepared,
        snapshot: input.snapshot,
        settled: new Promise<void>((resolve) => {
            markSettled = resolve;
        }),
        markSettled: () => markSettled(),
    };
}

/** A process that could not be created is kept as a `failed` task, so `bg_list` can say why. */
export function failedTask(id: string, request: StartRequest, cwd: string, at: number, reason: string): Task {
    return {
        id,
        name: request.name || defaultName(request.command),
        command: request.command,
        cwd,
        pid: 0,
        startedAt: at,
        endedAt: at,
        state: "failed",
        reason,
        deadline: at,
        timeoutMs: 0,
        notifyOn: request.notifyOn,
        cursor: 0,
        ready: false,
        errorMatches: 0,
        streamBytes: 0,
        sandboxLines: [],
        ports: [],
        notes: [],
        settled: Promise.resolve(),
        markSettled: () => undefined,
    };
}
