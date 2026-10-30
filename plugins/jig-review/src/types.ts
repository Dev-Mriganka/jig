// The records the review store keeps and the page shows. The web page imports these types, and nothing else from
// this folder, so the page and the server cannot drift apart.

export type ReviewStatus = "awaiting-review" | "awaiting-agent" | "approved" | "abandoned";

/** "branch": everything since the branch left the main branch, committed or not (the review before a push). */
export type ReviewFileScope = "all" | "staged" | "unstaged" | "touched" | "branch";

export type ReviewSettings = {
    autoAskReview: boolean;
    autoOpenBrowser: boolean;
    diffView: "split" | "unified";
};

export type ReviewComment = {
    id: string;
    body: string;
    filePath?: string;
    line?: number;
    side?: "old" | "new";
    status: "submitted" | "resolved" | "answered";
    createdAt: string;
    submittedAt?: string;
    resolutionId?: string;
};

export type ReviewResolutionLocation = {
    body?: string;
    filePath: string;
    line: number;
    side?: "old" | "new";
};

export type ReviewResolution = {
    id: string;
    commentIds: string[];
    kind: "fixed" | "answered" | "wont-fix";
    summary: string;
    beforeAfter?: string;
    addressedLocations?: ReviewResolutionLocation[];
    createdAt: string;
};

export type ReviewIteration = {
    id: number;
    createdAt: string;
    diff: string;
    diffHash: string;
    submittedCommentIds: string[];
    resolutionIds: string[];
};

/** How an approval was given. A passkey proves the user was present; "page-and-pi" is the page's click plus a `y` in Pi. */
export type ApprovalMethod = "passkey" | "page-and-pi";

/** What approving a review left behind. Written by the extension only, in a folder the agent's shell does not write. */
export type ReviewApproval = {
    method: ApprovalMethod;
    at: string;
    /** The passkey's SHA-256 fingerprint (hex), for a passkey approval. */
    fingerprint?: string;
};

export type ReviewRecord = {
    id: string;
    /** What the page shows after "HEAD": a commit for one repository, else the ticket, folder or "workspace". */
    headSha: string;
    /** Every reviewed repository's commit ("repo@sha, ..."), for the agent; absent for a one-repository review. */
    heads?: string;
    /**
     * Full commit of every repository the review covers, recorded when it was approved and only if the diff the user
     * approved was still the current one. `repo` is the path from Pi's folder ("" for the folder itself). A workflow
     * gate reads this to find which commits an approved review covers.
     */
    approvedHeads?: Array<{ repo: string; sha: string }>;
    fileScope: ReviewFileScope;
    /** Folder the review was limited to, relative to Pi's folder; absent for the whole workspace. */
    folder?: string;
    /** Ticket the review covers: its bound repositories. */
    ticket?: string;
    status: ReviewStatus;
    /** Process id of the Pi that created the review: once it has exited, nobody can still be working in the review. */
    ownerPid?: number;
    createdAt: string;
    updatedAt: string;
    approvedAt?: string;
    approvedDiffAgainst?: string;
    /** How and when the approval was given. Present exactly when the status is "approved". */
    approval?: ReviewApproval;
    /** Set when Approve was clicked in the page without a passkey and Pi has not answered yet. Cleared by a `n`. */
    pageApprovedAt?: string;
    commentsResolved?: number;
    comments: ReviewComment[];
    resolutions: ReviewResolution[];
    iterations: ReviewIteration[];
};

/** What the page may know about a registered passkey: never the key itself. The fingerprint names it. */
export type PasskeySummary = {
    /** SHA-256 of the public key, as 64 lowercase hex digits. */
    fingerprint: string;
    algorithm: "ES256" | "RS256";
    createdAt: string;
    lastUsedAt?: string;
};
