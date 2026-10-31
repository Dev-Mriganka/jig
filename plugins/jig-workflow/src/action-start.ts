// The actions that find and start work: `list`, `status`, `start` (and the questions it asks before replacing a workflow) and `bind`,
// which gives a ticket a work tree of its own. Starting is the only place a ticket's state file is created.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { InputError } from "../../jig-core/src/kit/values.ts";
import { callText } from "./definition.ts";
import type { Stage, Workflow } from "./definition.ts";
import { digest } from "./host.ts";
import { matching } from "./load.ts";
import type { Runtime, Work } from "./runtime.ts";
import { activeWorkLines, ticketStatus } from "./status.ts";
import { archiveState, HISTORY_FOLDER, newState, statePath, whatIsLost, writeState } from "./store.ts";
import { addBound } from "./ticket.ts";
import { readText } from "./files.ts";
import { describeStage, notesHash, started, suggestionForNone, ticketOf } from "./action-support.ts";
import type { ActionResult, Call, Params } from "./action-support.ts";

export function list(rt: Runtime): ActionResult {
    const lines: string[] = [];
    const { workflows, failures } = rt.loaded;
    if (workflows.size === 0) lines.push(`No workflow is defined. ${suggestionForNone()}`);
    for (const [name, { workflow, source, file }] of [...workflows].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(
            `${name}${workflow.description === undefined ? "" : `: ${workflow.description}`}`,
            `  stages: ${workflow.stages.map((stage) => stage.id).join(" → ")}`,
            ...(workflow.match === undefined ? [] : [`  matches tickets: ${workflow.match}`]),
            `  from the ${source}: ${file}`,
        );
    }
    if (failures.length > 0) {
        lines.push(
            "",
            "Files that could not be used:",
            ...failures.map((failure) => `  ${failure.file}: ${failure.reason}`),
        );
    }
    return { text: lines.join("\n"), details: { workflows: [...workflows.keys()].sort(), failures: failures.length } };
}

export async function status(rt: Runtime, params: Params, call: Call): Promise<ActionResult> {
    const live = { live: true, ...(call.signal === undefined ? {} : { signal: call.signal }) };
    if (params.ticket !== undefined) {
        const report = await ticketStatus(rt, rt.work(ticketOf(rt, params)), live);
        return { text: report.text, details: report.details };
    }
    const active = rt.activeTicket();
    const parts: string[] = [];
    let details: Record<string, unknown> = {};
    if (active !== undefined) {
        const report = await ticketStatus(rt, rt.work(active), live);
        parts.push(report.text);
        details = report.details;
    }
    const others = activeWorkLines(rt, active);
    if (others.length > 0) parts.push(`Other active work:\n${others.map((line) => `  ${line}`).join("\n")}`);
    if (parts.length === 0)
        parts.push(
            "No active ticket, and no workflow is running. Make a ticket active with /ticket KEY, then workflow start.",
        );
    return { text: parts.join("\n\n"), details: { ...details, others: others.length } };
}

export interface StartInput {
    ticket: string;
    name?: string;
    replace: boolean;
    /** The user has said yes to replacing (a question in Pi, or the command's own confirmation). */
    confirmed: boolean;
}

/** What starting over a ticket that has a workflow would lose, for the refusal and for the question. */
export function lossText(rt: Runtime, ticket: string, newName?: string): string | undefined {
    const { read } = rt.work(ticket);
    if (read.kind === "none") return undefined;
    if (read.kind === "invalid")
        return `${read.problem}. It would be set aside in ${ticket}'s workflow-history folder.`;
    const state = read.state;
    return (
        `${ticket} already runs ${state.workflow} at stage ${state.stage}. ${newName === undefined ? "Starting a workflow" : `Starting ${newName}`} ` +
        `loses ${whatIsLost(state).join(", ")}. The old state is kept in ${ticket}'s workflow-history folder.`
    );
}

/** The fingerprint of the question about replacing, which the call's approved preview must carry. */
export function replaceFingerprint(rt: Runtime, ticket: string, name: string): string {
    const { read } = rt.work(ticket);
    return digest(
        "start-replace",
        ticket,
        name,
        read.kind === "state" ? read.state.workflow : read.kind,
        read.kind === "state" ? read.state.stage : "",
    );
}

/** Which workflow a start means: the one named, else the one whose pattern matches the ticket. */
export function chooseWorkflow(rt: Runtime, ticket: string, name: string | undefined): string {
    if (name !== undefined) {
        if (!rt.loaded.workflows.has(name)) {
            const known = [...rt.loaded.workflows.keys()].sort();
            throw new InputError(
                `no workflow is called ${JSON.stringify(name.slice(0, 40))}${known.length === 0 ? `. ${suggestionForNone()}` : ` (${known.join(", ")}); /workflow list shows where each came from`}`,
            );
        }
        return name;
    }
    const names = matching(rt.loaded, ticket);
    if (names.length === 1) return names[0] as string;
    throw new InputError(
        names.length === 0
            ? `no workflow matches ${ticket}: name one. ${[...rt.loaded.workflows.keys()].sort().join(", ") || suggestionForNone()}`
            : `${names.join(" and ")} both match ${ticket}: name one`,
    );
}

export function start(rt: Runtime, input: StartInput): ActionResult {
    const name = chooseWorkflow(rt, input.ticket, input.name);
    const workflow = rt.loaded.workflows.get(name)?.workflow as Workflow;
    const work = rt.work(input.ticket);
    const first = workflow.stages[0] as Stage;

    const loss = lossText(rt, input.ticket, name);
    if (loss !== undefined) {
        if (!input.replace) {
            throw new InputError(`${loss} To switch, call start again with replace: true; it asks the user.`);
        }
        if (!input.confirmed)
            throw new Error("the user did not confirm replacing the workflow, so nothing was changed");
        if (work.read.kind === "state") archiveState(work.paths.dir, work.read.state, rt.host.now());
        else archiveInvalid(work, rt.host.now());
    }
    const state = newState({
        workflow: name,
        ticket: input.ticket,
        stage: first.id,
        notesHash: notesHash(work),
        now: rt.host.now(),
    });
    writeState(work.paths.dir, state);
    rt.guardState(input.ticket);

    const lines = [`Started ${name} on ${input.ticket}.`, describeStage(workflow, 0)];
    if (workflow.holds.length > 0) {
        lines.push(
            `Held until their condition holds: ${workflow.holds.map((hold) => `${hold.calls.map(callText).join(", ")} until ${hold.until}`).join("; ")}.`,
        );
    }
    if (input.ticket !== rt.activeTicket()) {
        lines.push(
            `${input.ticket} is not this session's active ticket, so its holds do not apply here: /ticket ${input.ticket} makes it active.`,
        );
    }
    if (readText(work.paths.notes) === "") {
        lines.push(
            `notes.md does not exist yet: /ticket ${input.ticket} creates the ticket's notes, plan and evidence folders.`,
        );
    }
    return { text: lines.join("\n"), details: { ticket: input.ticket, workflow: name, stage: first.id } };
}

/** Sets aside a state file that cannot be read, so that a new one can be written. It is kept as text: it is what could not be read. */
function archiveInvalid(work: Work, now: Date): void {
    const folder = path.join(work.paths.dir, HISTORY_FOLDER);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/:/g, "-");
    writeFileSync(path.join(folder, `${stamp}-invalid.json`), readText(statePath(work.paths.dir)), {
        flag: "wx",
        mode: 0o600,
    });
}

const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("\n");
}

export async function bind(rt: Runtime, params: Params, call: Call): Promise<ActionResult> {
    const ticket = ticketOf(rt, params);
    const { work, workflow } = started(rt, ticket);
    const repo = params.repo as string;
    if (typeof call.ctx?.executeTool !== "function")
        throw new Error("bind needs to run the git tool, and this call cannot run other tools");
    const branch = workflow.branch.replaceAll("{ticket}", ticket);
    const named = path.basename(repo.replace(/[\\/]+$/, "")).replace(/[^A-Za-z0-9._-]/g, "-");
    const dir = params.dir ?? `${named.replace(/^[^A-Za-z0-9]+/, "")}-${ticket}`.replace(/[^A-Za-z0-9._-]/g, "-");
    if (!DIR_NAME.test(dir))
        throw new InputError(
            `dir ${JSON.stringify(dir.slice(0, 40))} must be one folder name: letters, digits, . _ and -`,
        );
    const outcome = await call.ctx.executeTool(
        "git",
        {
            action: "worktree",
            operation: "add",
            repo,
            dir,
            branch,
            ...(params.base === undefined ? {} : { base: params.base }),
        },
        call.signal === undefined ? {} : { signal: call.signal },
    );
    const said = textOf(outcome.result as never);
    if (outcome.isError) throw new Error(`git could not add the work tree: ${said}`);
    const given = (outcome.result.details as { path?: unknown } | undefined)?.path;
    const where = typeof given === "string" ? given : /work tree (\S+) on/.exec(said)?.[1];
    if (where === undefined) throw new Error(`git added a work tree and did not say where: ${said}`);
    const root = realpathSync(where);
    const added = addBound(work.paths, root);
    return {
        text:
            `${added ? "Bound" : "Already bound:"} ${root} to ${ticket}, on the branch ${branch}.\n` +
            "The repository's holds, tests and reviews now apply there. Change the code in that folder.",
        details: { ticket, root, branch, added },
    };
}
