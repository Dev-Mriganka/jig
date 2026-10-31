// The shapes a child is described by: who it is and where it runs (`ChildSpec`), how it ended (`Outcome`) and the numbers `/agents`
// shows (`Snapshot`). Types only, so the files that work on a child (child.ts, child-report.ts, the runtime) share them without
// importing each other's code.
import type { ApprovalMode, Limits } from "./config.ts";
import type { ModelChoice } from "./launch.ts";
import type { LimitName } from "./limits.ts";
import type { StoredState } from "./store.ts";

export type ChildState = StoredState;
export type OutcomeKind = "finished" | "limit" | "stopped" | "error" | "timed-out";

export interface Outcome {
    kind: OutcomeKind;
    limit?: LimitName;
    /** One line: how it ended. */
    summary: string;
    /** The child's final text, cleaned. Empty when it wrote none. */
    text: string;
}

/** Who the child is and where it runs. */
export interface ChildSpec {
    id: string;
    name: string;
    role: string;
    writes: boolean;
    limits: Limits;
    approvals: ApprovalMode;
    cwd: string;
    /** The run folder. */
    dir: string;
    /** The parent session. */
    session: string;
    model: ModelChoice | undefined;
    branch?: string;
    worktree?: string;
    generation: number;
    startedAt: string;
    /** Commands the child must list before it gets a task: jig-core's, and jig-sandbox's when the parent has it. */
    requireCommands: readonly string[];
}

export interface Snapshot {
    id: string;
    name: string;
    role: string;
    state: ChildState;
    /** What the state means to the user: running, waiting for you, finished at the turn limit, ... */
    display: string;
    turns: number;
    maxTurns: number;
    minutes: number;
    maxMinutes: number;
    cost: string;
    maxCost: number;
    waiting: number;
    model: string;
    cwd: string;
    branch?: string;
}
