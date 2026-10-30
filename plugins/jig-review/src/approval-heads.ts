import { hashDiff } from "./store.ts";
import type { ReviewRecord } from "./types.ts";
import type { WorkspaceReviewSource } from "./workspace.ts";

/**
 * The commits an approval vouches for: every reviewed repository's full HEAD, but only when the diff the user approved
 * is still the current one. A change made since (an edit, a commit that alters the diff) was not reviewed, so then
 * nothing is recorded and the review covers no commit. Only a branch review vouches: one of uncommitted or touched
 * files leaves the branch's earlier commits unseen, so it must not let their HEAD be pushed.
 */
export async function headsToRecord(
    source: Pick<WorkspaceReviewSource, "getDiff" | "getHeads">,
    review: ReviewRecord,
): Promise<Array<{ repo: string; sha: string }> | undefined> {
    if (review.fileScope !== "branch") return undefined;
    const target = { folder: review.folder, ticket: review.ticket };
    try {
        const current = await source.getDiff({ scope: review.fileScope, ...target });
        return hashDiff(current) === review.iterations.at(-1)?.diffHash ? await source.getHeads(target) : undefined;
    } catch {
        return undefined;
    }
}
