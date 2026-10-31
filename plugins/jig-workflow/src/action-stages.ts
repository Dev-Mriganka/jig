// The actions that move a ticket between stages: `advance`, which checks every exit condition itself, `back`, and the question the
// user answers when a stage needs them. Nothing here moves a ticket on a claim.
import { InputError } from "../../jig-core/src/kit/values.ts";
import { evaluate, evaluateAll } from "./conditions.ts";
import type { ConditionResult } from "./conditions.ts";
import type { Stage } from "./definition.ts";
import { digest } from "./host.ts";
import type { Runtime } from "./runtime.ts";
import { updateState } from "./store.ts";
import { describeStage, notesHash, stageAt, started, ticketOf } from "./action-support.ts";
import type { ActionResult, Call, Params } from "./action-support.ts";

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
