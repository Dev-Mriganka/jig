// What each action of the `workflow` tool does. An action changes a ticket's state only through the plugin: it asks for a run, an
// approval or a check, and records the outcome. It never records a claim.
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { InputError } from "../../jig-core/src/kit/values.ts";
import { evaluate, evaluateAll } from "./conditions.ts";
import type { ConditionResult } from "./conditions.ts";
import { callText } from "./definition.ts";
import type { Stage, Workflow } from "./definition.ts";
import { environmentLines } from "./environment.ts";
import { digest, hash } from "./host.ts";
import { disabledLines, matching, missingWorkflow } from "./load.ts";
import { outsideRunner } from "./outside.ts";
import { fingerprintOf, MAX_PLAN_CHARS, parsePlan, repositoryWarnings } from "./plan.ts";
import { inspect, short } from "./repos.ts";
import type { RepoView } from "./repos.ts";
import type { Runtime, Work } from "./runtime.ts";
import { activeWorkLines, suggestion, ticketStatus } from "./status.ts";
import {
    archiveState,
    HISTORY_FOLDER,
    newState,
    readState,
    statePath,
    updateState,
    whatIsLost,
    writeState,
} from "./store.ts";
import type { EvidenceKind, WorkflowState } from "./store.ts";
import { planTests, runTests, testIdentity } from "./tests.ts";
import type { TestPlan } from "./tests.ts";
import { addBound, isTicketKey } from "./ticket.ts";
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

// ---- finding the work ----------------------------------------------------------------------------------------------------

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
        throw new InputError(missingWorkflow(rt.loaded, work.read.state.workflow, ticket));
    }
    return { work, state: work.read.state, workflow: loaded.workflow };
}

function stageAt(workflow: Workflow, state: WorkflowState): { index: number; stage: Stage } {
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
function describeStage(workflow: Workflow, index: number): string {
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

function notesHash(work: Work): string {
    return hash(readText(work.paths.notes));
}

// ---- list and status ---------------------------------------------------------------------------------------------------

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
    lines.push(...disabledLines(rt.loaded));
    return { text: lines.join("\n"), details: { workflows: [...workflows.keys()].sort(), failures: failures.length } };
}

function suggestionForNone(): string {
    return "Put a JSON file in ~/.pi/agent/workflows/ (the plugin's examples/ folder has three), then /workflow reload.";
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

// ---- start ---------------------------------------------------------------------------------------------------------------

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

// ---- bind ----------------------------------------------------------------------------------------------------------------

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

// ---- the plan --------------------------------------------------------------------------------------------------------------

/** The names each bound repository answers to: its folder and the name origin gives. */
async function boundNames(rt: Runtime, ticket: string): Promise<Array<{ root: string; names: string[] }>> {
    const views = await Promise.all(rt.bound(ticket).roots.map((root) => inspect(rt.host, root)));
    return views.map((view) => ({
        root: view.root,
        names: [view.name, ...(view.remoteName === undefined ? [] : [view.remoteName])],
    }));
}

/** The plan as it is now, checked; an `InputError` listing what is wrong when it cannot be submitted. */
export function checkedPlan(work: Work): ReturnType<typeof parsePlan> & { text: string } {
    const text = readText(work.paths.plan);
    if (text.trim() === "")
        throw new InputError(`plan.md is empty or missing (${work.paths.plan}): write it, then submit it`);
    const plan = parsePlan(text);
    if (plan.problems.length > 0)
        throw new InputError(
            `plan.md cannot be submitted yet:\n${plan.problems.map((problem) => `  ${problem}`).join("\n")}`,
        );
    return { ...plan, text };
}

export async function submitPlan(rt: Runtime, params: Params, call: Call): Promise<ActionResult> {
    const ticket = ticketOf(rt, params);
    const { work } = started(rt, ticket);
    const plan = checkedPlan(work);
    const approved = rt.host.approvedPreview(call.toolCallId);
    if (approved === undefined) {
        throw new Error(
            "the plan was not put to the user in this call (a rule or an earlier answer allowed it without asking), so it is not approved. Call submit-plan again.",
        );
    }
    if (approved.fingerprint !== plan.fingerprint) {
        throw new Error(
            "plan.md changed since the preview the user approved: nothing was recorded. Call submit-plan again.",
        );
    }
    updateState(work.paths.dir, (state) => {
        state.plan = {
            fingerprint: plan.fingerprint,
            at: rt.host.now().toISOString(),
            scenarios: plan.scenarios.length,
        };
    });
    return {
        text:
            `The user approved the plan for ${ticket}: ${plan.scenarios.length} scenario${plan.scenarios.length === 1 ? "" : "s"}, ` +
            `fingerprint ${plan.fingerprint.slice(0, 12)}. Any edit to plan.md needs approving again.`,
        details: { ticket, fingerprint: plan.fingerprint, scenarios: plan.scenarios.length },
    };
}

/** The question for a plan: the plan itself, with its fingerprint and what the check noticed. */
export async function planPreview(
    rt: Runtime,
    params: Params,
): Promise<{ summary: string; body: string; fingerprint: string }> {
    const ticket = ticketOf(rt, params);
    const { work } = started(rt, ticket);
    const plan = checkedPlan(work);
    const warnings = repositoryWarnings(plan, await boundNames(rt, ticket));
    const header = [
        `Fingerprint: ${plan.fingerprint.slice(0, 12)}`,
        ...warnings.map((warning) => `Noticed: ${warning}`),
    ];
    const body = plan.text.length > MAX_PLAN_CHARS ? plan.text.slice(0, MAX_PLAN_CHARS) : plan.text;
    return {
        summary:
            `Approve the plan for ${ticket}: ${plan.scenarios.length} scenario${plan.scenarios.length === 1 ? "" : "s"}, ` +
            `repositories ${plan.repositories.join(", ")} (fingerprint ${plan.fingerprint.slice(0, 12)})`,
        body: `${header.map((line) => `> ${line}`).join("\n")}\n\n${body}`,
        fingerprint: plan.fingerprint,
    };
}

// ---- scenarios -------------------------------------------------------------------------------------------------------------

const EVIDENCE_TEXT = { min: 10, max: 2000 };

function evidenceOf(
    rt: Runtime,
    work: Work,
    given: NonNullable<Params["evidence"]>,
): { kind: EvidenceKind; ref: string } {
    const kinds = (["path", "toolResult", "text"] as const).filter((kind) => given[kind] !== undefined);
    if (kinds.length !== 1) throw new InputError("evidence needs exactly one of path, toolResult or text");
    const kind = kinds[0] as EvidenceKind;
    const ref = given[kind] as string;
    if (kind === "text") {
        const text = ref.trim();
        if (text.length < EVIDENCE_TEXT.min || text.length > EVIDENCE_TEXT.max) {
            throw new InputError(
                `evidence text must be ${EVIDENCE_TEXT.min} to ${EVIDENCE_TEXT.max} characters: say what you saw`,
            );
        }
        return { kind, ref: text };
    }
    if (kind === "toolResult") {
        const seen = rt.seenResult(ref);
        if (seen === undefined) {
            throw new InputError(
                `this session saw no tool call ${JSON.stringify(ref.slice(0, 60))}: name a call from this session, or save the result in the ticket folder and give its path`,
            );
        }
        if (seen.error)
            throw new InputError(
                `the tool call ${JSON.stringify(ref.slice(0, 60))} failed, so it shows nothing passed`,
            );
        return { kind, ref };
    }
    const resolved = path.resolve(work.paths.dir, ref);
    let real: string;
    let folder: string;
    try {
        real = realpathSync(resolved);
        folder = realpathSync(work.paths.dir);
    } catch {
        throw new InputError(`${ref} does not exist in the ticket folder (${work.paths.dir})`);
    }
    if (real !== folder && !real.startsWith(folder + path.sep))
        throw new InputError(`${ref} is not inside the ticket folder`);
    if (!statSync(real).isFile() || statSync(real).size === 0)
        throw new InputError(`${ref} is not a file with content`);
    return { kind, ref: path.relative(folder, real).split(path.sep).join("/") };
}

export async function scenario(rt: Runtime, params: Params): Promise<ActionResult> {
    const ticket = ticketOf(rt, params);
    const { work, state } = started(rt, ticket);
    const number = params.number as number;
    const result = params.result as "pass" | "fail";
    const text = readText(work.paths.plan);
    if (state.plan === undefined || state.plan.fingerprint !== fingerprintOf(text)) {
        throw new InputError(
            "the plan is not approved as it stands: run workflow submit-plan first, so the scenarios are the ones the user read",
        );
    }
    const scenarios = parsePlan(text).scenarios;
    const found = scenarios.find((candidate) => candidate.number === number);
    if (found === undefined)
        throw new InputError(`the plan has no scenario ${number}; it has 1 to ${scenarios.length}`);
    if (result === "pass" && params.evidence === undefined) {
        throw new InputError(
            "a pass needs evidence: a path in the ticket folder, a tool result of this session, or what you observed",
        );
    }
    const evidence = params.evidence === undefined ? undefined : evidenceOf(rt, work, params.evidence);
    updateState(work.paths.dir, (current) => {
        current.scenarios[String(number)] = {
            result,
            hash: found.hash,
            at: rt.host.now().toISOString(),
            ...(evidence === undefined ? {} : { evidence }),
        };
    });
    const after = readState(work.paths.dir);
    const recorded = after.kind === "state" ? after.state.scenarios : {};
    const passed = scenarios.filter(
        (candidate) =>
            recorded[String(candidate.number)]?.result === "pass" &&
            recorded[String(candidate.number)]?.hash === candidate.hash,
    ).length;
    return {
        text: `Recorded scenario ${number} of ${ticket} as ${result}${evidence === undefined ? "" : ` (evidence: ${evidence.kind} ${evidence.ref.length > 80 ? `${evidence.ref.slice(0, 80)}...` : evidence.ref})`}. ${passed} of ${scenarios.length} scenarios pass.`,
        details: { ticket, number, result, passed, total: scenarios.length },
    };
}

// ---- tests -----------------------------------------------------------------------------------------------------------------

/** The bound repositories a test run covers: all of them, or the one `repo` names (by folder, name or path). */
async function testViews(rt: Runtime, ticket: string, repo: string | undefined): Promise<RepoView[]> {
    const roots = rt.bound(ticket).roots;
    if (roots.length === 0)
        throw new InputError(
            `no repository is bound to ${ticket}: bind one with workflow bind (or list it in ticket.json)`,
        );
    const views = await Promise.all(roots.map((root) => inspect(rt.host, root)));
    if (repo === undefined) return views;
    const cwd = rt.cwd;
    const chosen = views.filter(
        (view) =>
            view.name === repo ||
            view.remoteName === repo ||
            view.root === repo ||
            view.root === path.resolve(cwd, repo),
    );
    if (chosen.length === 0) {
        throw new InputError(
            `${JSON.stringify(repo.slice(0, 80))} is not bound to ${ticket}; bound: ${views.map((view) => view.name).join(", ")}`,
        );
    }
    return chosen;
}

export interface TestsToRun {
    views: RepoView[];
    plans: TestPlan[];
}

/** The commands a test call would run, one per bound repository; an `InputError` when one has no command. */
export async function plannedTests(rt: Runtime, params: Params): Promise<TestsToRun & { ticket: string }> {
    const ticket = ticketOf(rt, params);
    started(rt, ticket);
    const views = await testViews(rt, ticket, params.repo);
    const plans = views.map((view) => planTests(rt.settings, view, rt.cwd));
    const problems = plans.flatMap((plan) => (plan.problem === undefined ? [] : [plan.problem]));
    if (problems.length > 0) throw new InputError(problems.join("; "));
    return { ticket, views, plans };
}

/** The fingerprint of what a test call would run, which the user's yes has to carry when there is no sandbox. */
export function testFingerprint(ticket: string, plans: readonly TestPlan[], views: readonly RepoView[]): string {
    return digest("test", ticket, ...plans.flatMap((plan, index) => [...testIdentity(plan), views[index]?.head]));
}

export async function runTestsAction(rt: Runtime, params: Params, call: Call): Promise<ActionResult> {
    const { ticket, views, plans } = await plannedTests(rt, params);
    const { work } = started(rt, ticket);
    // Where it runs is decided now, not when the call was classified: a sandbox that has gone away must not become an unasked run.
    const sandboxed = rt.host.sandbox.canRun();
    if (!sandboxed) {
        const approved = rt.host.approvedPreview(call.toolCallId);
        if (approved === undefined) {
            throw new Error(
                "there is no sandbox that can run commands, and the user was not asked to run these tests outside it. Nothing was run. Call test again.",
            );
        }
        if (approved.fingerprint !== testFingerprint(ticket, plans, views)) {
            throw new Error(
                "the commands or the commits changed since the user approved running them outside the sandbox. Nothing was run. Call test again.",
            );
        }
    }
    const lines: string[] = [];
    let passed = 0;
    for (const [index, plan] of plans.entries()) {
        const view = views[index] as RepoView;
        try {
            // With a sandbox, a command set to run outside goes through the bash tool's own question; without one the call asked above.
            const outside = sandboxed && plan.outside === true;
            const run = await runTests(rt.host, plan, view, {
                sandboxed: sandboxed && !outside,
                ...(outside ? { outside: outsideRunner(call.ctx) } : {}),
                ...(call.signal === undefined ? {} : { signal: call.signal }),
            });
            updateState(work.paths.dir, (state) => {
                state.tests[view.root] = run.result;
            });
            const verdict = run.result.passed
                ? "PASSED"
                : run.result.timedOut
                  ? `TIMED OUT after ${plan.timeoutSeconds} s`
                  : `FAILED (exit ${run.result.exitCode})`;
            const note = run.result.clean
                ? ""
                : " on a tree with uncommitted changes, which does not count: commit, then run again";
            if (run.result.passed && run.result.clean) passed++;
            lines.push(
                `${view.name}: ${verdict} at ${short(view.head)}${note} · ${plan.command} · ${run.result.sandboxed ? "in the sandbox" : "outside the sandbox, as you approved"} · ${(run.result.durationMs / 1000).toFixed(1)} s`,
                ...(run.result.passed && run.result.clean ? [] : [indent(run.tail)]),
            );
        } catch (error) {
            // A cancelled call stops here; a repository that cannot be run does not stop the others.
            if (call.signal?.aborted === true) throw error;
            lines.push(`${view.name}: could not run: ${(error as Error).message.split("\n")[0]}`);
        }
    }
    lines.push(
        `${passed} of ${plans.length} repositor${plans.length === 1 ? "y" : "ies"} passed at HEAD on a clean tree.`,
    );
    return { text: lines.join("\n"), details: { ticket, passed, total: plans.length, sandboxed } };
}

function indent(text: string): string {
    return text === ""
        ? ""
        : text
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n");
}

/** The question about running tests outside the sandbox: each command, where, and for how long. */
export function testQuestion(ticket: string, plans: readonly TestPlan[]): { summary: string; body: string } {
    return {
        summary: `Run the tests of ${ticket} OUTSIDE the sandbox, as you, with your credentials and the network? (${plans.length} repositor${plans.length === 1 ? "y" : "ies"})`,
        body: [
            "No sandbox is running that can run commands, so these would run as a shell, as you:",
            "",
            ...plans.flatMap((plan) => [
                `- ${plan.name}: ${plan.command}`,
                `    in ${plan.root}, at most ${plan.timeoutSeconds} s (${plan.source ?? "set in jig.json"})`,
                ...environmentLines(plan.env),
            ]),
            "",
            "A test can run anything. With jig-sandbox active, these would run inside it without asking.",
        ].join("\n"),
    };
}

// ---- advance and back --------------------------------------------------------------------------------------------------------

/** What a move to the next stage rests on, as a fingerprint: the stages and every line of evidence. */
function advanceFingerprint(ticket: string, from: string, to: string, results: readonly ConditionResult[]): string {
    return digest(
        "advance",
        ticket,
        from,
        to,
        ...results.flatMap((result) => [result.condition, result.ok, ...result.lines]),
    );
}

export async function advance(rt: Runtime, params: Params, call: Call): Promise<ActionResult> {
    const ticket = ticketOf(rt, params);
    const { work, state, workflow } = started(rt, ticket);
    const { index, stage } = stageAt(workflow, state);
    const next = workflow.stages[index + 1];
    if (next === undefined)
        return {
            text: `${ticket} is at the last stage, ${stage.id}: the work is done.`,
            details: { ticket, advanced: false, done: true },
        };

    const others = stage.exit.filter((condition) => condition !== "you-approve");
    const options = { live: true, ...(call.signal === undefined ? {} : { signal: call.signal }) };
    const probe = rt.evidence(work, state, options);
    const results = await evaluateAll(others, probe);
    rt.saveReadings(work, probe);

    const needsYou = stage.exit.includes("you-approve");
    let approvedNow = false;
    if (needsYou && results.every((result) => result.ok)) {
        const approved = rt.host.approvedPreview(call.toolCallId);
        approvedNow =
            approved !== undefined && approved.fingerprint === advanceFingerprint(ticket, stage.id, next.id, results);
        if (approved !== undefined && !approvedNow) {
            throw new Error(
                "the evidence changed since the user was asked, so their yes does not cover this move. Nothing was changed. Call advance again.",
            );
        }
    }
    const everything: ConditionResult[] = [...results];
    if (needsYou) everything.push(await evaluate("you-approve", rt.evidence(work, state, { ...options, approvedNow })));
    const missing = everything.filter((result) => !result.ok);
    if (missing.length > 0) {
        return {
            text: [
                `Not moved: ${ticket} stays at ${stage.id}. Missing:`,
                ...missing.flatMap((result) => [`  ${result.condition}`, ...result.lines.map((line) => `    ${line}`)]),
            ].join("\n"),
            details: { ticket, advanced: false, stage: stage.id, missing: missing.map((result) => result.condition) },
        };
    }
    const at = rt.host.now().toISOString();
    const notes = notesHash(work);
    updateState(work.paths.dir, (current) => {
        current.stage = next.id;
        current.stageSince = at;
        current.notesAtStage = notes;
        current.history.push({ at, event: "advance", from: stage.id, to: next.id });
    });
    return {
        text: `Moved ${ticket} from ${stage.id} to ${next.id}.\n${describeStage(workflow, index + 1)}`,
        details: { ticket, advanced: true, from: stage.id, to: next.id },
    };
}

/** The question for moving on when the stage needs you: the evidence, and where the work goes. Refused while anything else is missing. */
export async function advancePreview(
    rt: Runtime,
    params: Params,
    signal: AbortSignal,
): Promise<{ summary: string; body: string; fingerprint: string }> {
    const ticket = ticketOf(rt, params);
    const { work, state, workflow } = started(rt, ticket);
    const { index, stage } = stageAt(workflow, state);
    const next = workflow.stages[index + 1];
    if (next === undefined) throw new InputError(`${ticket} is at the last stage, ${stage.id}`);
    const probe = rt.evidence(work, state, { live: true, signal });
    const results = await evaluateAll(
        stage.exit.filter((condition) => condition !== "you-approve"),
        probe,
    );
    const missing = results.filter((result) => !result.ok);
    if (missing.length > 0) {
        throw new InputError(
            `${ticket} cannot move on from ${stage.id} yet:\n${missing.flatMap((result) => [`  ${result.condition}`, ...result.lines.map((line) => `    ${line}`)]).join("\n")}`,
        );
    }
    return {
        summary: `Move ${ticket} from ${stage.id} to ${next.id}?`,
        body: [
            `${workflow.name} on ${ticket}: ${stage.id} → ${next.id}`,
            "",
            ...(stage.goal === undefined ? [] : [`Goal of ${stage.id}: ${stage.goal}`, ""]),
            "The evidence:",
            ...results.flatMap((result) => [`- ${result.condition}`, ...result.lines.map((line) => `    ${line}`)]),
            "",
            `Next, ${next.id}: ${next.goal ?? ""}`,
        ].join("\n"),
        fingerprint: advanceFingerprint(ticket, stage.id, next.id, results),
    };
}

export function back(rt: Runtime, params: Params): ActionResult {
    const ticket = ticketOf(rt, params);
    const { work, state, workflow } = started(rt, ticket);
    const { index, stage } = stageAt(workflow, state);
    let target: number;
    if (params.to !== undefined) {
        target = workflow.stages.findIndex((candidate) => candidate.id === params.to);
        if (target < 0)
            throw new InputError(
                `the workflow ${workflow.name} has no stage ${JSON.stringify(params.to.slice(0, 40))} (${workflow.stages.map((s) => s.id).join(", ")})`,
            );
        if (target >= index)
            throw new InputError(`${params.to} is not before ${stage.id}: back goes to an earlier stage`);
    } else {
        target = index - 1;
        if (target < 0) throw new InputError(`${stage.id} is the first stage: there is nothing before it`);
    }
    const to = workflow.stages[target] as Stage;
    const at = rt.host.now().toISOString();
    const notes = notesHash(work);
    updateState(work.paths.dir, (current) => {
        current.stage = to.id;
        current.stageSince = at;
        current.notesAtStage = notes;
        current.history.push({ at, event: "back", from: stage.id, to: to.id });
    });
    return {
        text: `Moved ${ticket} back from ${stage.id} to ${to.id}. Nothing recorded was erased: results still count while the commit or the plan they are about is unchanged.\n${describeStage(workflow, target)}`,
        details: { ticket, from: stage.id, to: to.id },
    };
}
