// Sending a write: once, and only if it is still what the person approved.
//
// Two rules here matter more than the rest:
//   - The plan is built again right before sending. If the call asked and was approved, the fingerprint of the plan must
//     equal the approved preview's. A status, a comment or a field that changed in between voids the approval.
//   - A write is never sent twice. When the reply is lost (a timeout, a dropped connection, a 5xx), whether the write
//     happened is unknown, so it is not repeated: the issue is read once, and the tool says what that read shows.
import { jig } from "../../jig-core/src/client.ts";
import type { Env } from "./api.ts";
import { JiraError, LostReplyError, NotSentError } from "./http.ts";
import type { Call } from "./params.ts";
import { fingerprintOf } from "./plan.ts";
import type { Finding, Plan } from "./plan.ts";
import { buildPlan } from "./plans.ts";
import { errorMessage, oneLine } from "./values.ts";

export interface Written {
    text: string;
    /** The issue the write was about, for the call's record. */
    key: string | undefined;
}

function where(call: Call, plan: Plan): string {
    return `jira ${call.action}${plan.key === undefined ? "" : ` on ${plan.key}`}`;
}

/** An error's message without its closing full stop, so a sentence can follow it. */
const sentence = (error: Error): string => error.message.replace(/[.\s]+$/, "");

/** What the read after a lost reply shows, as a `Finding`. A read that fails too settles nothing. */
async function recheck(plan: Plan, signal: AbortSignal | undefined): Promise<Finding> {
    if (signal?.aborted === true)
        return { happened: undefined, text: "the call was cancelled, so nothing was read again" };
    try {
        return await plan.check();
    } catch (error) {
        return { happened: undefined, text: `the read after it failed too (${oneLine(errorMessage(error), 120)})` };
    }
}

/** The text a successful write adds when its text pointed at things its readers cannot open. */
function flagNote(plan: Plan): string {
    if (plan.shown.flags.length === 0) return "";
    const first = plan.shown.flags.slice(0, 3).join("; ");
    return `\nNote: the text pointed at things its readers may not be able to open (${first}).`;
}

export async function runWrite(
    env: Env,
    call: Call,
    toolCallId: string,
    signal: AbortSignal | undefined,
): Promise<Written> {
    const plan = await buildPlan(env, call, false);

    const approved = jig().approvedPreview(toolCallId);
    if (approved?.fingerprint !== undefined && approved.fingerprint !== fingerprintOf(plan)) {
        throw new Error(
            `${where(call, plan)}: changed since the preview; run it again to see the new preview. Nothing was sent.`,
        );
    }

    const record = (key: string | undefined): void => {
        if (key !== undefined) jig().addFacts(toolCallId, { issue: key });
    };
    try {
        const reply = await env.http.request({ method: plan.send.method, path: plan.send.path, body: plan.send.body });
        const done = plan.done(reply);
        record(done.key);
        return { text: done.text + flagNote(plan), key: done.key };
    } catch (error) {
        if (error instanceof NotSentError) {
            throw new Error(`${where(call, plan)}: ${sentence(error)}. Nothing was sent.`);
        }
        if (error instanceof JiraError && error.refused) {
            throw new Error(`${where(call, plan)}: ${sentence(error)}. Jira changed nothing.`);
        }
        if (!(error instanceof JiraError) && !(error instanceof LostReplyError)) throw error;

        const finding = await recheck(plan, signal);
        const lead = `${where(call, plan)}: ${sentence(error)}. The write was not sent again.`;
        if (finding.happened === true) {
            record(finding.key ?? plan.key);
            const text = `${lead} A read afterwards shows that it happened: ${finding.text}.${flagNote(plan)}`;
            return { text, key: finding.key ?? plan.key };
        }
        if (finding.happened === undefined) record(plan.key);
        throw new Error(
            finding.happened === false
                ? `${lead} A read afterwards shows that it did not happen: ${finding.text}. Run it again if it is still wanted.`
                : `${lead} A read afterwards could not settle it: ${finding.text}. Check the issue before trying again.`,
        );
    }
}
