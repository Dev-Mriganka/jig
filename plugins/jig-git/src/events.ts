// The announcement of a push. jig-git does not watch CI, and it cannot import a plugin that does. After a push has landed,
// and after a pull request was opened, it publishes the fact on Pi's event bus as `jig-git:pushed`, and whatever listens acts
// on it: jig-ops starts a watch on the CI of the pushed commit for a service of its catalog that has this repository.
//
// The payload is `{ repo, branch, sha, pr? }`. `repo` is `owner/name` as origin names it on GitHub, `sha` is the full id of
// the pushed head, and `pr` is the open pull request of the branch, when there is one. Nothing is published for a remote
// that is not on GitHub, because there is no `owner/name` to say.
import { gh, ghJson, repoFlags } from "./github.ts";
import type { GitSettings } from "./config.ts";
import { githubRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";

export const PUSHED_EVENT = "jig-git:pushed";

/** What the event carries. */
export interface Pushed {
    repo: string;
    branch: string;
    sha: string;
    pr?: number;
}

/** Publishes an event on Pi's event bus (`pi.events.emit`). */
export type Announce = (event: string, payload: unknown) => void;

// The tools are built once and have no handle on Pi, so the factory hands the bus over when the plugin loads.
let publish: Announce = () => {};

export function setAnnouncer(announce: Announce): void {
    publish = announce;
}

interface Push {
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
 * Publishes `jig-git:pushed` for a head that is on the remote. Returns whether it was published. A listener that fails does
 * not undo the push: the event is a notice, and the push result does not depend on who reads it.
 */
export async function announcePushed(push: Push): Promise<boolean> {
    const { repo, settings, branch, sha, signal } = push;
    const remote = await githubRepo(repo, settings, signal);
    if (!remote) return false;
    const pr = push.pr ?? (await openPullRequest(repo, settings, branch, signal));
    const payload: Pushed = { repo: remote.slug, branch, sha, ...(pr === undefined ? {} : { pr }) };
    try {
        publish(PUSHED_EVENT, payload);
    } catch {
        return false;
    }
    return true;
}
