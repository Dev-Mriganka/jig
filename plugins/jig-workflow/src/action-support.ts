// What every action of the `workflow` tool shares: its parameters and result, the ticket an action is about, the workflow that
// ticket has started, and the words that say where a stage leads. Kept apart so that each action file reads only what it needs.
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { InputError } from "../../jig-core/src/kit/values.ts";
import type { Stage, Workflow } from "./definition.ts";
import { hash } from "./host.ts";
import type { Runtime, Work } from "./runtime.ts";
import { suggestion } from "./status.ts";
import type { WorkflowState } from "./store.ts";
import { isTicketKey } from "./ticket.ts";
import { readText } from "./files.ts";

export interface Params {
    action: string;
    ticket?: string;
    name?: string;
    replace?: boolean;
    repo?: string;
    dir?: string;
    base?: string;
    number?: number;
    result?: "pass" | "fail";
    evidence?: { path?: string; toolResult?: string; text?: string };
    to?: string;
}

export interface ActionResult {
    text: string;
    details?: Record<string, unknown>;
}

export interface Call {
    toolCallId: string;
    signal?: AbortSignal;
    /** The context the tool runs in, which can run other tools; absent in a plain call. */
    ctx?: ExtensionToolContext;
}

/** The ticket an action is about: the one named, else the session's. */
export function ticketOf(rt: Runtime, params: { ticket?: string }): string {
    const ticket = params.ticket ?? rt.activeTicket();
    if (ticket === undefined) {
        throw new InputError("there is no active ticket: make one active with /ticket KEY, or pass ticket");
    }
    if (!isTicketKey(ticket))
        throw new InputError(`${JSON.stringify(String(ticket).slice(0, 40))} is not a ticket key`);
    return ticket;
}

export interface Started {
    work: Work;
    state: WorkflowState;
    workflow: Workflow;
}

/** The ticket's workflow, started and found; an `InputError` that says what to do when it is not. */
export function started(rt: Runtime, ticket: string): Started {
    const work = rt.work(ticket);
    if (work.read.kind === "none") throw new InputError(`${ticket} has no workflow: ${suggestion(rt, ticket)}`);
    if (work.read.kind === "invalid") throw new InputError(`${work.read.problem}; mend or delete the file`);
    const loaded = rt.definition(work.read.state);
    if (loaded === undefined) {
        throw new InputError(
            `the workflow ${work.read.state.workflow} of ${ticket} is not loaded: /workflow reload, or /workflow list for files that failed`,
        );
    }
    return { work, state: work.read.state, workflow: loaded.workflow };
}

export function stageAt(workflow: Workflow, state: WorkflowState): { index: number; stage: Stage } {
    const index = workflow.stages.findIndex((stage) => stage.id === state.stage);
    const stage = workflow.stages[index];
    if (stage === undefined) {
        throw new InputError(
            `${state.ticket} is at stage ${state.stage}, which the workflow ${workflow.name} no longer has: use back, to=<stage> (${workflow.stages.map((s) => s.id).join(", ")})`,
        );
    }
    return { index, stage };
}

/** Where a stage leads: its goal and what it needs. */
export function describeStage(workflow: Workflow, index: number): string {
    const stage = workflow.stages[index] as Stage;
    const lines = [`Stage ${index + 1} of ${workflow.stages.length}: ${stage.id}.`];
    if (stage.goal !== undefined) lines.push(`Goal: ${stage.goal}`);
    lines.push(
        index === workflow.stages.length - 1
            ? "This is the last stage: the work is done."
            : stage.exit.length === 0
              ? "Nothing is needed to leave it."
              : `To leave it: ${stage.exit.join(", ")}.`,
    );
    return lines.join("\n");
}

export function notesHash(work: Work): string {
    return hash(readText(work.paths.notes));
}

export function suggestionForNone(): string {
    return "Put a JSON file in ~/.pi/agent/workflows/ (the plugin's examples/ folder has three), then /workflow reload.";
}
