// Checks the local-write actions of the `git` tool share: that a tree has no edits before a branch is switched, that the base is fetched
// before work starts from it, a name that new branches must match, and a valid operation word. They are apart so that each action file
// shows only its own steps.
import type { Call } from "./previews.ts";
import type { Repo } from "./repo.ts";
import { git, gitOut, refExists, summaryOf, trackedChanges } from "./run.ts";
import { plural } from "./text.ts";

/** Switching or creating a branch with edits would carry them along; refuse rather than guess. */
export async function requireClean(repo: Repo, doing: string, signal?: AbortSignal): Promise<void> {
    const dirty = await trackedChanges(repo.root, signal);
    if (dirty > 0)
        throw new Error(
            `${repo.name} has uncommitted changes in ${plural(dirty, "file")}; commit or stash them before ${doing}`,
        );
}

export async function shortHead(repo: Repo, signal?: AbortSignal): Promise<string> {
    return (await gitOut(repo.root, ["rev-parse", "--short", "HEAD"], { signal })).trim();
}

export async function fetchBranch(repo: Repo, remote: string, branch: string, signal?: AbortSignal): Promise<void> {
    const fetched = await git(repo.root, ["fetch", "--no-tags", remote, branch], { signal, network: true });
    if (fetched.code !== 0 || fetched.timedOut)
        throw new Error(
            `could not fetch ${remote}/${branch}: ${fetched.timedOut ? "timed out" : summaryOf(fetched.stderr) || "fetch failed"}`,
        );
    if (!(await refExists(repo.root, `refs/remotes/${remote}/${branch}`, signal)))
        throw new Error(`${remote}/${branch} does not exist after the fetch`);
}

/** A name that new branches must match, when `git.branchName` says so. */
export function checkBranchPattern(name: string, call: Call): void {
    const pattern = call.settings.branchName;
    if (pattern !== undefined && !new RegExp(pattern).test(name))
        throw new Error(`branch name "${name}" does not match git.branchName (${pattern})`);
}

export function operationOf(value: unknown, allowed: readonly string[], action: string): string {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`git ${action}: operation must be one of ${allowed.join(", ")}`);
    return value;
}
