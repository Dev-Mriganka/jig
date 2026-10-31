// `pr watch`: starts the watch on the comments of a pull request (see pr-watch.ts). It reads GitHub to find the pull request and
// changes nothing there, so it is a local write that does not ask, like the ci tool's watch.
import { checkBranch, checkNumber } from "./names.ts";
import { viewPr } from "./pr-read.ts";
import { startCommentWatch, watchingText } from "./pr-watch.ts";
import { openPrFor } from "./pr-write.ts";
import type { Call, Planned } from "./previews.ts";
import { resolveRepo } from "./repo.ts";
import { requireSlug } from "./github.ts";
import { currentBranch } from "./run.ts";

export async function planWatch(
    params: { repo?: string; number?: number; branch?: string },
    call: Call,
): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const slug = await requireSlug(repo, call.settings, call.signal);
    let number: number;
    if (params.number !== undefined) {
        number = checkNumber(params.number);
        const state = (await viewPr(repo, String(number), call, "state")).state;
        if (state !== "OPEN") {
            throw new Error(
                `pull request ${number} in ${slug} is ${String(state).toLowerCase()}, so there is nothing to watch`,
            );
        }
    } else {
        const branch =
            params.branch === undefined ? await currentBranch(repo.root, call.signal) : checkBranch(params.branch);
        if (!branch) throw new Error(`HEAD is detached in ${repo.name}; pass number or branch`);
        const open = await openPrFor(repo, branch, call);
        if (open === undefined) {
            throw new Error(
                `no open pull request for ${branch} in ${repo.name}: pass number, or open one with pr create`,
            );
        }
        number = open.number;
    }
    return {
        preview: { summary: `watch pull request ${number} in ${slug} for new comments, in the background` },
        run: async () => {
            const spec = { slug, number };
            const { id, already } = startCommentWatch(spec);
            return {
                text: watchingText(spec, id, already),
                facts: { pr: number, watch: already ? "existing" : "started" },
                details: { id, number, slug, already },
            };
        },
    };
}
