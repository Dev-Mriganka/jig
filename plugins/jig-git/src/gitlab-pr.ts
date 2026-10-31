// The `pr` actions on a GitLab project: which forge a call means, and where each action goes. A pull request is a merge request
// there; the actions, their names and their parameters are the same.
import { forgeOf } from "./forge.ts";
import type { GitlabHome, Home } from "./forge.ts";
import { planComments, planList, planView } from "./gitlab-pr-read.ts";
import type { Call, Planned } from "./previews.ts";
import { resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";

/** Whether a thread id has the shape of a GitLab one: the merge request, a colon, and the discussion. */
export const looksLikeGitlabThread = (value: unknown): boolean =>
    typeof value === "string" && /^\d{1,9}:[0-9a-f]{8,64}$/.test(value);

/**
 * The forge of the repository a `pr` call means. The repository decides, never the call. A reply or a resolve names no
 * repository on GitHub, where a thread is a global id, and goes on needing none there; a GitLab thread needs its project.
 */
export async function homeOf(params: Readonly<Record<string, unknown>>, call: Call): Promise<Home> {
    const aThread = params.action === "reply" || params.action === "resolve";
    let repo: Repo;
    try {
        repo = await resolveRepo(params.repo as string | undefined, call.signal);
    } catch (error) {
        if (aThread && !looksLikeGitlabThread(params.thread)) return { forge: "github" };
        throw error;
    }
    return forgeOf(repo, call.settings, call.signal);
}

export function planGitlabPr(
    params: Readonly<Record<string, unknown>>,
    call: Call,
    home: GitlabHome,
): Promise<Planned> | Planned {
    const p = params as never;
    switch (params.action) {
        case "view":
            return planView(p, call, home);
        case "list":
            return planList(p, call, home);
        case "comments":
            return planComments(p, call, home);
        default:
            throw new Error(`pr ${String(params.action)} on GitLab is not built yet`);
    }
}
