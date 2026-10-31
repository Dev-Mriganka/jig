// Saying where the work is: the stage and its goal, each exit condition with what is missing and what fixes it, the holds in
// force, and the repositories. `status` and `/workflow` show this in full; the session start line is its first sentence.
import { evaluate } from "./conditions.ts";
import type { ConditionResult } from "./conditions.ts";
import { callText } from "./definition.ts";
import type { Condition, Workflow } from "./definition.ts";
import { matching, turnedOff } from "./load.ts";
import { short } from "./repos.ts";
import type { Runtime, Work } from "./runtime.ts";
import type { WorkflowState } from "./store.ts";

export interface StatusOptions {
    /** Read the pull request now. `status` does; the session start line does not. */
    live: boolean;
    signal?: AbortSignal;
}

export interface StatusReport {
    text: string;
    /** For a screen or a script: the stage, and the conditions that are not met. */
    details: { ticket: string; workflow?: string; stage?: string; missing: Condition[]; holds: Condition[] };
}

/** What to do about a ticket with no workflow: the workflows whose pattern matches its key. */
export function suggestion(rt: Runtime, ticket: string): string {
    const names = matching(rt.loaded, ticket);
    if (names.length === 1)
        return `${names[0]} matches it: workflow start ${names[0]} (or /workflow start ${names[0]})`;
    if (names.length > 1) return `${names.join(" and ")} match it: say which, with workflow start <name>`;
    const all = [...rt.loaded.workflows.keys()].sort();
    return all.length === 0
        ? "no workflow is defined: put a JSON file in ~/.pi/agent/workflows/ (the plugin's examples/ folder has three)"
        : `workflow start <name> starts one (${all.join(", ")})`;
}

/** The conditions of a stage, in one list with the holds', each decided once. */
async function decide(
    rt: Runtime,
    work: Work,
    state: WorkflowState,
    workflow: Workflow,
    options: StatusOptions,
): Promise<{ results: Map<Condition, ConditionResult>; evidence: ReturnType<Runtime["evidence"]> }> {
    const evidence = rt.evidence(work, state, {
        live: options.live,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stage = workflow.stages.find((candidate) => candidate.id === state.stage);
    const wanted = new Set<Condition>([...(stage?.exit ?? []), ...workflow.holds.map((hold) => hold.until)]);
    const results = new Map<Condition, ConditionResult>();
    for (const condition of wanted) results.set(condition, await evaluate(condition, evidence));
    return { results, evidence };
}

export async function ticketStatus(rt: Runtime, work: Work, options: StatusOptions): Promise<StatusReport> {
    const { ticket, read } = work;
    const none = { ticket, missing: [] as Condition[], holds: [] as Condition[] };
    if (read.kind === "none") {
        return { text: `${ticket}: no workflow has been started. ${suggestion(rt, ticket)}.`, details: none };
    }
    if (read.kind === "invalid") {
        return {
            text: `${ticket}: ${read.problem}. The workflow is treated as not started; mend or delete the file.`,
            details: none,
        };
    }
    const { state } = read;
    const loaded = rt.definition(state);
    if (loaded === undefined) {
        return {
            text:
                `${ticket}: the workflow ${state.workflow} is at stage ${state.stage}, and ` +
                (turnedOff(rt.loaded, state.workflow)
                    ? "workflow.disabled in jig.json turns it off. Its holds are not enforced while it is off."
                    : "no workflow file of that name is loaded (run /workflow reload, or see /workflow list for files that failed). " +
                      "Its holds are not enforced until it is found."),
            details: { ...none, workflow: state.workflow, stage: state.stage },
        };
    }
    const workflow = loaded.workflow;
    const index = workflow.stages.findIndex((stage) => stage.id === state.stage);
    const stage = workflow.stages[index];
    if (stage === undefined) {
        return {
            text: `${ticket}: the workflow ${state.workflow} has no stage ${state.stage} any more (the file changed). Go back to an earlier stage with workflow back, to=<stage>. Its stages: ${workflow.stages.map((s) => s.id).join(", ")}.`,
            details: { ...none, workflow: state.workflow, stage: state.stage },
        };
    }

    const { results, evidence } = await decide(rt, work, state, workflow, options);
    rt.saveReadings(work, evidence);
    const lines: string[] = [
        `${ticket} · ${workflow.name} · stage ${index + 1} of ${workflow.stages.length}: ${stage.id}`,
        ...(stage.goal === undefined ? [] : [`Goal: ${stage.goal}`]),
    ];
    const missing: Condition[] = [];
    if (stage.exit.length === 0) {
        lines.push(
            index === workflow.stages.length - 1
                ? "This is the last stage: the work is done."
                : "Nothing is needed to leave this stage.",
        );
    } else {
        lines.push("To leave this stage:");
        for (const condition of stage.exit) {
            const result = results.get(condition);
            if (result === undefined) continue;
            if (!result.ok) missing.push(condition);
            lines.push(
                `  ${condition}: ${result.ok ? "met" : "NOT MET"}`,
                ...result.lines.map((line) => `    ${line}`),
            );
        }
    }
    const holds: Condition[] = [];
    const heldLines: string[] = [];
    for (const hold of workflow.holds) {
        const result = results.get(hold.until);
        if (result === undefined || result.ok) continue;
        if (!holds.includes(hold.until)) holds.push(hold.until);
        heldLines.push(`  ${hold.calls.map(callText).join(", ")} until ${hold.until}`);
    }
    if (heldLines.length > 0) lines.push("Held until their condition holds:", ...heldLines);

    const bound = rt.bound(ticket);
    const repoLines: string[] = [];
    for (const root of bound.roots) {
        const view = await evidence.view(root);
        repoLines.push(
            `  ${view.name} (${view.root})${view.branch === undefined ? ", detached" : ` on ${view.branch}`} at ${short(view.head)}, ` +
                (view.clean === undefined
                    ? "tree unknown"
                    : view.clean
                      ? "tree clean"
                      : "tree has uncommitted changes"),
        );
    }
    lines.push(
        bound.roots.length === 0 ? "No repository is bound (workflow bind adds one)." : "Repositories:",
        ...repoLines,
    );
    lines.push(...bound.problems);
    if (ticket !== rt.activeTicket()) {
        lines.push(
            `Note: ${ticket} is not this session's active ticket, so its holds do not apply here (/ticket ${ticket} makes it active).`,
        );
    }
    return { text: lines.join("\n"), details: { ticket, workflow: workflow.name, stage: stage.id, missing, holds } };
}

/** One line per piece of active work, for `status` without a ticket. */
export function activeWorkLines(rt: Runtime, skip?: string): string[] {
    const lines: string[] = [];
    for (const ticket of rt.tickets()) {
        if (ticket === skip) continue;
        const { read } = rt.work(ticket);
        if (read.kind !== "state") continue;
        const stages = rt.definition(read.state)?.workflow.stages;
        if (stages !== undefined && stages.at(-1)?.id === read.state.stage) continue;
        lines.push(`${ticket}: ${read.state.workflow}, stage ${read.state.stage}`);
    }
    return lines;
}

/**
 * The line shown when a session starts, for the active ticket: where the work is and what is missing, from what is known
 * without the network. Undefined when there is nothing to say.
 */
export async function startLine(rt: Runtime): Promise<string | undefined> {
    const ticket = rt.activeTicket();
    if (ticket === undefined) return undefined;
    const work = rt.work(ticket);
    if (work.read.kind === "none") {
        const names = matching(rt.loaded, ticket);
        return names.length === 1
            ? `${ticket} has no workflow; ${names[0]} matches it: /workflow start ${names[0]}`
            : undefined;
    }
    if (work.read.kind === "invalid") return `${ticket}: ${work.read.problem}`;
    const report = await ticketStatus(rt, work, { live: false });
    const { workflow, stage, missing } = report.details;
    if (workflow === undefined || stage === undefined) return report.text;
    return (
        `workflow ${workflow} on ${ticket}: stage ${stage}` +
        (missing.length === 0 ? "; nothing is missing to leave it" : `; missing: ${missing.join(", ")}`) +
        " (/workflow shows more)"
    );
}
