// "The CI of a commit ended": published on Pi's event bus as `jig-ops:ci-finished` when a CI watch reaches its finish line. The
// watch's own result is one line for the agent and names no commit, so a plugin that needs "did the required checks pass at
// this commit" (jig-workflow's `checks-pass`) listens for this instead. A watch that gave up, was stopped or timed out is not
// a result about a commit, and publishes nothing.
import type { WatchResult } from "../../../jig-core/src/contract.ts";
import type { Announce } from "./artifacts.ts";
import type { CiSpec } from "./watch.ts";

export const CI_FINISHED_EVENT = "jig-ops:ci-finished";

/** What the event carries. */
export interface CiFinished {
    /** The catalog's `repo` of the service, such as `acme/orders-api`. */
    repo: string;
    service: string;
    system: string;
    /** The full id of the commit that was watched. */
    sha: string;
    branch?: string;
    pr?: number;
    /** The watch's finish line: `required` (GitHub), `pipeline` or `jobs` (GitLab), `build` or `stages` (Jenkins), and so on. */
    finish: string;
    outcome: "passed" | "failed";
    /** The watch's one-line result. */
    summary: string;
}

/**
 * Publishes the end of a watch, when it says something about a commit: the service has a `repo`, the watch names the commit,
 * and it ended `passed` or `failed`. A listener that fails does not change the watch's result.
 */
export function announceFinished(
    announce: Announce,
    service: { name: string; repo?: string },
    spec: CiSpec,
    done: WatchResult,
): void {
    if (service.repo === undefined || spec.sha === undefined) return;
    if (done.outcome !== "passed" && done.outcome !== "failed") return;
    const branch = spec.system === "github-actions" ? spec.branch : spec.system === "gitlab" ? spec.ref : undefined;
    const pr = spec.system === "github-actions" ? spec.pr : undefined;
    const event: CiFinished = {
        repo: service.repo,
        service: service.name,
        system: spec.system,
        sha: spec.sha,
        ...(branch === undefined ? {} : { branch }),
        ...(pr === undefined ? {} : { pr }),
        finish: spec.finish.kind,
        outcome: done.outcome,
        summary: done.summary,
    };
    try {
        announce(CI_FINISHED_EVENT, event);
    } catch {
        // The event is a notice: the watch's result does not depend on who reads it.
    }
}
