// Running the command of a deploy or a rollback, once.
//
// A command that changes the cluster is started a single time. If it ends in a way that leaves it unknown whether it took
// effect (it ran too long and was stopped, or the call was cancelled while it ran), it is not started again: the rollout is
// read once, so the model and the user can see what the cluster shows, and nothing more is done.
import { jig } from "../../../jig-core/src/client.ts";
import type { RunResult } from "../../../jig-core/src/contract.ts";
import { CHANGE, startKubectl } from "../runtime/kubernetes/kubectl.ts";
import type { Kube } from "../runtime/kubernetes/kubectl.ts";
import { look, render } from "../runtime/kubernetes/wait.ts";
import { clean, linesOf } from "../values.ts";
import type { Command } from "./command.ts";
import { HELM_CHANGE, startHelm } from "./helm.ts";
import type { Plan } from "./plan.ts";

/** How a command that was started ended. */
export type Ended =
    /** The program ran to its end, with an exit code that may be a failure. */
    | { kind: "finished"; result: RunResult }
    /** It was cut short: the outcome is not known. `why` finishes the sentence "..., so it is unknown whether...". */
    | { kind: "unknown"; why: string };

/**
 * Starts the command, once. A program that could not start (it is not installed) is an error, and nothing ran. A program
 * that was started and then stopped, by the time limit or by the user, is `unknown`.
 */
export async function startCommand(kube: Kube, command: Command, timeoutMs: number | undefined): Promise<Ended> {
    if (kube.signal?.aborted) throw new Error("The call was cancelled before anything was run");
    const limit = timeoutMs ?? (command.program === "helm" ? HELM_CHANGE.timeoutMs : CHANGE.timeoutMs);
    try {
        const result =
            command.program === "helm"
                ? await startHelm(kube, command.args, { ...HELM_CHANGE, timeoutMs: limit })
                : await startKubectl(kube, command.verb, command.args, { ...CHANGE, timeoutMs: limit });
        if (result.timedOut) return { kind: "unknown", why: `${command.program} ran longer than ${limit / 1000} s and was stopped` };
        return { kind: "finished", result };
    } catch (error) {
        // jig-core ends a program that the call's signal stopped with an error, after it had started. Any other error
        // means the program never started.
        if (kube.signal?.aborted) return { kind: "unknown", why: `the call was cancelled while ${command.program} ran` };
        throw error;
    }
}

/**
 * One read of the rollout, as text, for after a command whose outcome is unknown. It runs even when the call was cancelled,
 * because it is the only way left to say what the cluster shows. A read that fails says so, and is not tried again.
 */
export async function lookOnce(kube: Kube, version: string | undefined, now: number): Promise<string> {
    const free: Kube = { target: kube.target, signal: undefined };
    try {
        return render(free, await look(free, version), version, now);
    } catch (error) {
        return `The rollout could not be read either: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Refuses to run when the user approved a preview and the plan would now be something else. When the call did not ask (a rule
 * allowed it), jig-core has no approved preview and there is nothing to compare.
 */
export function checkUnchanged(toolCallId: string, plan: Plan): void {
    const approved = jig().approvedPreview(toolCallId);
    if (approved?.fingerprint === undefined || approved.fingerprint === plan.fingerprint) return;
    throw new Error(
        `deploy ${plan.action} of ${plan.env.service} in ${plan.env.name} changed since the preview (it is running ${plan.from} now); ` +
            "run it again to see the new preview. Nothing was run",
    );
}

/** The first lines of what a program printed, cleaned, for the model to read. */
export function outputOf(stdout: string): string {
    return linesOf(clean(stdout))
        .filter((line) => line.trim() !== "")
        .slice(0, 8)
        .map((line) => line.slice(0, 200))
        .join("\n");
}
