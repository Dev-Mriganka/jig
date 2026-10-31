// The shapes the background module shares. Types only: nothing here runs.
import type { ChildProcess } from "node:child_process";
import type { Prepared } from "../sandbox.ts";
import type { TaskLog } from "./logfile.ts";
import type { LineMatcher } from "./patterns.ts";

export type TaskState = "running" | "exited" | "killed" | "failed";

/** Why a task was stopped. The words are shown as `killed (<reason>)`. */
export type KillReason = "by agent" | "by user" | "max runtime" | "session end";

/** The patterns that wake the agent besides the task ending: the text of regular expressions. */
export interface NotifyOn {
    ready: string[];
    error: string[];
}

export interface Task {
    id: string;
    /** A label for lists and messages. */
    name: string;
    command: string;
    cwd: string;
    /** The shell Pi's side started. It leads its own process group, so its pid is also the group's. */
    pid: number;
    startedAt: number;
    endedAt?: number;
    state: TaskState;
    exitCode?: number;
    /** Set when `state` is `killed` (a `KillReason`) or `failed` (the message). */
    reason?: string;
    /** The wall-clock time the task is stopped at. */
    deadline: number;
    timeoutMs: number;
    notifyOn: NotifyOn;
    /** Where the next default `bg_output` read starts. Offsets count bytes of the cleaned log, from the first one written. */
    cursor: number;
    ready: boolean;
    readyPattern?: string;
    errorMatches: number;
    /** Bytes of output seen, which is the log's size until a write error stops the log. */
    streamBytes: number;
    log?: TaskLog;
    /** `[sandbox]` lines about what the task did that the sandbox stopped or undid, kept for the messages. */
    sandboxLines: string[];
    /** The ports the task listens on that other commands reach (`filtered` and `ask` modes). */
    ports: number[];
    /** Things the agent should know about the task that are not in its output, such as a port that could not be bridged. */
    notes: string[];
    // ---- what the manager keeps while the task runs
    child?: ChildProcess;
    prepared?: Prepared;
    snapshot?: unknown;
    matcher?: LineMatcher;
    killReason?: KillReason;
    killing?: Promise<StopOutcome>;
    deadlineTimer?: NodeJS.Timeout;
    /** Settles once the end of the task has been recorded. */
    settled: Promise<void>;
    markSettled: () => void;
}

export interface StopOutcome {
    how: "term" | "kill" | "stuck";
    ms: number;
}
