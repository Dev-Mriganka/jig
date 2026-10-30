// The watch that starts by itself. After a push, and after a pull request is opened, the required checks of the pushed
// commit are watched, so nobody has to ask "is it done?". A newer push to the same branch replaces the watch of the older
// commit: its result would only be about a commit that is no longer the head.
import { jig } from "../../jig-core/src/client.ts";
import type { GitSettings } from "./config.ts";
import { ghJson, gh, repoFlags } from "./github.ts";
import { githubRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { KIND } from "./watch.ts";
import type { GithubSpec } from "./watch.ts";

/** The open watch that started by itself for each branch, by `owner/name#branch`. */
const started = new Map<string, string>();

interface AutoWatch {
    repo: Repo;
    settings: GitSettings;
    branch: string;
    /** The full sha of the pushed head. */
    sha: string;
    /** The pull request, when it is known. Otherwise one open for the branch is looked up. */
    pr?: number;
    signal?: AbortSignal;
}

/** The number of the open pull request that has `branch` as its head, if there is one. A failed lookup is no pull request. */
async function openPullRequest(
    repo: Repo,
    settings: GitSettings,
    branch: string,
    signal?: AbortSignal,
): Promise<number | undefined> {
    try {
        const flags = await repoFlags(repo, settings, signal);
        const result = await gh(
            ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "number", ...flags],
            { cwd: repo.root, signal },
        );
        return ghJson<{ number: number }[]>("gh pr list", result)[0]?.number;
    } catch {
        return undefined;
    }
}

/**
 * Starts a watch on the required checks of a pushed head, when `git.watch.auto` is on and origin is on GitHub. Returns the
 * id and the title of the watch, or undefined when none was started.
 */
export async function startChecksWatch(options: AutoWatch): Promise<{ id: string; title: string } | undefined> {
    const { repo, settings, branch, sha, signal } = options;
    if (!settings.watch.auto) return undefined;
    const remote = await githubRepo(repo, settings, signal);
    if (!remote) return undefined;
    const pr = options.pr ?? (await openPullRequest(repo, settings, branch, signal));
    const key = `${remote.slug}#${branch}`;
    const earlier = started.get(key);
    if (
        earlier !== undefined &&
        jig()
            .watches.list()
            .some((watch) => watch.id === earlier && watch.status !== "done")
    )
        jig().watches.stop(earlier);
    const spec: GithubSpec = {
        repo: remote.slug,
        ...(pr === undefined ? {} : { pr }),
        branch,
        sha,
        finish: { kind: "required" },
    };
    const title =
        pr === undefined ? `checks of branch ${branch} at ${sha.slice(0, 7)}` : `checks of pull request ${pr}`;
    const id = jig().watches.start({
        kind: KIND,
        spec,
        title,
        timeoutMinutes: settings.watch.timeoutMinutes,
        stallMinutes: settings.watch.stallMinutes,
    });
    started.set(key, id);
    return { id, title };
}

/** Forgets the watches that started by themselves; for tests. */
export function forgetAutoWatches(): void {
    started.clear();
}
