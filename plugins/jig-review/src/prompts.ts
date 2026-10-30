// The messages the extension sends the agent as the user. Both are built from data this extension checked: the comments
// the page sent, and an approval that was verified before it was recorded.
import type { ReviewApproval, ReviewComment, ReviewRecord } from "./types.ts";

/** Asks the agent to address the comments the user just submitted in the page. */
export function buildReviewSubmissionPrompt(review: ReviewRecord, comments: ReviewComment[]): string {
    const commentText = comments.map(formatComment).join("\n\n");
    const against = review.heads ? `these commits: ${review.heads}` : `git HEAD ${review.headSha}`;

    return `Interactive code review ${review.id} was submitted against ${against}.

Review comments:

${commentText}

Please address these review comments. For each comment, either make the necessary code changes or explain why no change is needed. When a general comment causes code changes, include addressedLocations in record_interactive_review_resolution so the page shows agent notes on the changed diff lines. When you are done, call the record_interactive_review_resolution tool with the comment ids, resolution kind, summary, a small unified diff snippet in beforeAfter for any code changes, and addressedLocations for the changed lines. The review loop continues until the user approves in the page.`;
}

function formatComment(comment: ReviewComment): string {
    return `- id: ${comment.id}\n  location: ${formatLocation(comment)}\n  comment: ${comment.body}`;
}

function formatLocation(comment: ReviewComment): string {
    if (comment.filePath === undefined) return "General";
    const lineSuffix = comment.line === undefined ? "" : `:${comment.line.toString()}`;
    return `${comment.filePath}${lineSuffix} ${comment.side ?? "new"}`;
}

/** How the approval was given, in words the agent can quote. */
export function describeApproval(approval: Pick<ReviewApproval, "method" | "fingerprint">): string {
    if (approval.method === "passkey") {
        const key = approval.fingerprint ? ` (key ${approval.fingerprint.slice(0, 16)})` : "";
        return `with a passkey${key}, which the user's device verified`;
    }
    return "in the page and then with a `y` in Pi";
}

/**
 * The message an approval sends the agent, so it carries on without the user typing "approved". It says how the
 * approval was given and what it covers: exact commits (a branch review whose diff was still the one shown), nothing
 * (the diff changed after the user looked), or only the latest changes (a review that never clears a push).
 */
export function buildApprovalPrompt(
    review: ReviewRecord,
    approvedHeads: Array<{ repo: string; sha: string }> | undefined,
    approval: Pick<ReviewApproval, "method" | "fingerprint">,
): string {
    const what = review.ticket ? `the ${review.ticket} review` : `review ${review.id}`;
    const how = describeApproval(approval);
    if (review.fileScope !== "branch") {
        return `The user approved ${what} of the latest changes ${how}. It covers those changes only, not the whole branch, so it does not clear a push. Continue with the task.`;
    }
    if (approvedHeads === undefined || approvedHeads.length === 0) {
        return `The user approved ${what} ${how}, but the code changed after they looked, so the approval covers no commit. Do not push: ask the user to run /code-review again and approve the current code.`;
    }
    const covered = approvedHeads.map((head) => `${head.repo || "."}@${head.sha.slice(0, 12)}`).join(", ");
    return `The user approved ${what} ${how}, covering ${covered}. Continue with what was waiting on it (for example the push of exactly those commits; the push still asks the user to confirm).`;
}
