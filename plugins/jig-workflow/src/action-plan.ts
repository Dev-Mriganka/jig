// The actions about the plan: `submit-plan`, which records the user's approval of exactly the text they read, and `scenario`, which
// records a result with its evidence against that approved plan. Neither records a claim; both check the plan as it is now.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { InputError } from "../../jig-core/src/kit/values.ts";
import { fingerprintOf, MAX_PLAN_CHARS, parsePlan, repositoryWarnings } from "./plan.ts";
import { inspect } from "./repos.ts";
import type { Runtime, Work } from "./runtime.ts";
import { readState, updateState } from "./store.ts";
import type { EvidenceKind } from "./store.ts";
import { readText } from "./files.ts";
import { started, ticketOf } from "./action-support.ts";
import type { ActionResult, Call, Params } from "./action-support.ts";

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
