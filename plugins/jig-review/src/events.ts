// What this plugin announces on Pi's event bus (`pi.events`). jig-workflow's `review-done` condition will listen for it.
// The payload is plain data; a listener checks it, because anything can publish on the bus.
import type { ApprovalMethod, ReviewFileScope } from "./types.ts";

export const REVIEW_EVENTS = {
    /** A review was approved, in the page with a passkey or in the page and then in Pi. Payload: `ReviewApprovedEvent`. */
    approved: "jig-review:approved",
} as const;

export interface ReviewApprovedEvent {
    reviewId: string;
    scope: ReviewFileScope;
    ticket?: string;
    /** Every reviewed repository and its full HEAD commit when the review was approved. `repo` is the path from Pi's
     *  folder ("" when Pi's folder is the repository). */
    repos: Array<{ repo: string; head: string }>;
    /** Whether the approval vouches for those commits: a branch review whose diff was still the one the user saw. For any
     *  other review the commits are only where each repository stood. */
    covered: boolean;
    /** The files the approved diff changes. */
    files: string[];
    method: ApprovalMethod;
}
