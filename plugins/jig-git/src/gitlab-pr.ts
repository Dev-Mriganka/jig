// The `pr` actions on a GitLab project: which forge a call means, and where each action goes. A pull request is a merge request
// there; the actions, their names and their parameters are the same.
import { forgeOf } from "./forge.ts";
import type { GitlabHome, Home } from "./forge.ts";
import { getMr, openMrFor, parseThread, planComments, planList, planView } from "./gitlab-pr-read.ts";
import type { Gl } from "./gitlab-pr-read.ts";
import {
    planComment,
    planCreate,
    planEdit,
    planMerge,
    planReady,
    planReply,
    planResolve,
    planReview,
} from "./gitlab-pr-write.ts";
import { checkBranch, checkNumber } from "./names.ts";
import { startCommentWatch, watchingText } from "./pr-watch.ts";
import type { Call, Planned } from "./previews.ts";
import { resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { currentBranch } from "./run.ts";

/** Whether a thread id has the shape of a GitLab one: the merge request, a colon, and the discussion. */
export const looksLikeGitlabThread = (value: unknown): boolean => parseThread(value) !== undefined;

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

/**
 * `pr watch` on a merge request: starts the watch on its comments (see pr-watch.ts). It reads GitLab to find the merge request and
 * changes nothing there, so it is a local write that does not ask.
 */
async function planWatch(
    params: { repo?: string; number?: number; branch?: string },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const gl: Gl = { home, repo: await resolveRepo(params.repo, call.signal), call };
    let number: number;
    if (params.number !== undefined) {
        number = checkNumber(params.number);
        const state = (await getMr(gl, number)).state;
        if (state !== "opened") {
            throw new Error(`merge request ${number} in ${home.path} is ${state}, so there is nothing to watch`);
        }
    } else {
        const branch =
            params.branch === undefined ? await currentBranch(gl.repo.root, call.signal) : checkBranch(params.branch);
        if (!branch) throw new Error(`HEAD is detached in ${gl.repo.name}; pass number or branch`);
        const open = await openMrFor(gl, branch);
        if (open === undefined) {
            throw new Error(
                `no open merge request for ${branch} in ${gl.repo.name}: pass number, or open one with pr create`,
            );
        }
        number = open.iid;
    }
    return {
        preview: { summary: `watch merge request ${number} in ${home.path} for new comments, in the background` },
        run: async () => {
            const spec = { slug: home.path, number, forge: "gitlab" as const, host: home.host };
            const { id, already } = startCommentWatch(spec);
            return {
                text: watchingText(spec, id, already),
                facts: { pr: number, watch: already ? "existing" : "started" },
                details: { id, number, slug: home.path, already },
            };
        },
    };
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
        case "create":
            return planCreate(p, call, home);
        case "edit":
            return planEdit(p, call, home);
        case "ready":
            return planReady(p, call, home);
        case "comment":
            return planComment(p, call, home);
        case "reply":
            return planReply(p, call, home);
        case "resolve":
            return planResolve(p, call, home);
        case "review":
            return planReview(p, call, home);
        case "merge":
            return planMerge(p, call, home);
        case "watch":
            return planWatch(p, call, home);
        default:
            throw new Error(`pr: unknown action ${String(params.action)}`);
    }
}
