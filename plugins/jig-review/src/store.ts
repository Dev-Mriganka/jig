// The review records: one JSON file per review, in the workspace's folder (see settings.ts). Every Pi started in the same
// folder shares them, so cleanup is careful, and every write is whole-file.
import { createHash } from "node:crypto";
import { chmod, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SettingsStore } from "./settings.ts";
import type {
    ReviewApproval,
    ReviewComment,
    ReviewFileScope,
    ReviewRecord,
    ReviewResolution,
} from "./types.ts";

/** A pending review untouched for this long is stale whoever owns it. */
export const STALE_REVIEW_MS = 24 * 60 * 60 * 1000;

/** Persists review records as JSON files in the workspace's review folder. */
export class ReviewStore {
    private readonly settingsStore: SettingsStore;

    public constructor(settingsStore: SettingsStore) {
        this.settingsStore = settingsStore;
    }

    /** Creates a review with its first iteration: the diff as it is now. */
    public async create(
        headSha: string,
        diff: string,
        fileScope: ReviewFileScope,
        target: { folder?: string; ticket?: string; heads?: string } = {},
    ): Promise<ReviewRecord> {
        await this.settingsStore.ensureDirectories();
        const now = new Date().toISOString();
        const review: ReviewRecord = {
            id: createTimestampId(),
            headSha,
            fileScope,
            ...(target.folder ? { folder: target.folder } : {}),
            ...(target.ticket ? { ticket: target.ticket } : {}),
            ...(target.heads ? { heads: target.heads } : {}),
            status: "awaiting-review",
            ownerPid: process.pid,
            createdAt: now,
            updatedAt: now,
            comments: [],
            resolutions: [],
            iterations: [
                { id: 1, createdAt: now, diff, diffHash: hashDiff(diff), submittedCommentIds: [], resolutionIds: [] },
            ],
        };
        await this.save(review);
        return review;
    }

    /** Writes the whole record to its timestamp-named file, readable by the user alone. */
    public async save(review: ReviewRecord): Promise<void> {
        await this.settingsStore.ensureDirectories();
        const file = this.getReviewPath(review.id);
        await writeFile(file, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(file, 0o600);
    }

    public async load(id: string): Promise<ReviewRecord> {
        return normalizeReview(JSON.parse(await readFile(this.getReviewPath(id), "utf8")) as ReviewRecord);
    }

    /** Every record, newest first. */
    public async listAll(): Promise<ReviewRecord[]> {
        await this.settingsStore.ensureDirectories();
        const reviews = await Promise.all((await this.listReviewIds()).map((id) => this.load(id)));
        return reviews.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    /**
     * Deletes empty pending reviews and marks the ones with comments abandoned, but only those nobody can still be
     * using: untouched for a day, or created by a process that has exited. A second terminal, a subagent or `pi -p`
     * shares this store, so a pending review is usually someone's open one.
     */
    public async cleanupInactiveReviews(
        activeReviewId?: string,
        now: number = Date.now(),
    ): Promise<{ abandoned: number; deleted: number }> {
        let reviewIds: string[];
        try {
            reviewIds = await this.listReviewIds();
        } catch (error) {
            if (isMissing(error)) return { abandoned: 0, deleted: 0 };
            throw error;
        }
        let abandoned = 0;
        let deleted = 0;
        for (const id of reviewIds.filter((reviewId) => reviewId !== activeReviewId)) {
            const review = await this.loadIfReadable(id);
            if (review?.status !== "awaiting-review" || !isAbandonedByOwner(review, now)) continue;
            if (hasDiscussion(review)) {
                await this.abandon(review);
                abandoned += 1;
            } else if (await this.removeIfPresent(review.id)) {
                deleted += 1;
            }
        }
        return { abandoned, deleted };
    }

    /** Abandons a pending review, or deletes it when nothing was said in it. Undefined after a deletion. */
    public async abandonOrDelete(review: ReviewRecord): Promise<ReviewRecord | undefined> {
        if (!hasDiscussion(review)) {
            await unlink(this.getReviewPath(review.id));
            return undefined;
        }
        return this.abandon(review);
    }

    /** Adds the comments the page sent, and makes the review wait for the agent. */
    public async addSubmittedComments(
        review: ReviewRecord,
        comments: Omit<ReviewComment, "id" | "createdAt" | "status" | "submittedAt">[],
    ): Promise<ReviewRecord> {
        const now = new Date().toISOString();
        const created = comments.map((comment) => ({
            ...comment,
            id: crypto.randomUUID(),
            status: "submitted" as const,
            createdAt: now,
            submittedAt: now,
        }));
        review.comments.push(...created);
        review.status = "awaiting-agent";
        review.updatedAt = now;
        review.iterations.at(-1)?.submittedCommentIds.push(...created.map((comment) => comment.id));
        await this.save(review);
        return review;
    }

    /** Adds the next round: the cumulative diff as it is after the agent answered. */
    public async addIteration(review: ReviewRecord, diff: string): Promise<ReviewRecord> {
        const now = new Date().toISOString();
        review.status = "awaiting-review";
        review.updatedAt = now;
        review.iterations.push({
            id: review.iterations.length + 1,
            createdAt: now,
            diff,
            diffHash: hashDiff(diff),
            submittedCommentIds: [],
            resolutionIds: [],
        });
        await this.save(review);
        return review;
    }

    /** Records how the agent handled comments, and links each comment to it. */
    public async addResolution(
        review: ReviewRecord,
        resolution: Omit<ReviewResolution, "id" | "createdAt">,
    ): Promise<ReviewRecord> {
        const now = new Date().toISOString();
        const created = { ...resolution, id: crypto.randomUUID(), createdAt: now };
        review.resolutions.push(created);
        review.updatedAt = now;
        for (const comment of review.comments) {
            if (created.commentIds.includes(comment.id)) {
                comment.status = created.kind === "fixed" ? "resolved" : "answered";
                comment.resolutionId = created.id;
            }
        }
        review.iterations.at(-1)?.resolutionIds.push(created.id);
        await this.save(review);
        return review;
    }

    /** Notes that Approve was clicked in the page, before Pi has answered. Not an approval. */
    public async markPageApproved(review: ReviewRecord): Promise<ReviewRecord> {
        review.pageApprovedAt = new Date().toISOString();
        review.updatedAt = review.pageApprovedAt;
        await this.save(review);
        return review;
    }

    /** Pi said no: the page's approval is withdrawn. */
    public async clearPageApproval(review: ReviewRecord): Promise<ReviewRecord> {
        delete review.pageApprovedAt;
        review.updatedAt = new Date().toISOString();
        await this.save(review);
        return review;
    }

    /**
     * Marks the review approved and keeps how it was approved.
     *
     * `approvedHeads` is the full commit of each reviewed repository, given only when the approved diff is still the
     * current one.
     */
    public async approve(
        review: ReviewRecord,
        approval: Omit<ReviewApproval, "at">,
        approvedHeads?: Array<{ repo: string; sha: string }>,
    ): Promise<ReviewRecord> {
        const now = new Date().toISOString();
        review.status = "approved";
        review.approvedAt = now;
        review.approval = { ...approval, at: now };
        review.approvedDiffAgainst = review.headSha;
        if (approvedHeads && approvedHeads.length > 0) review.approvedHeads = approvedHeads;
        review.commentsResolved = review.comments.filter(
            (comment) => comment.status === "resolved" || comment.status === "answered",
        ).length;
        review.updatedAt = now;
        await this.save(review);
        return review;
    }

    /** A record another session is writing, or has just removed, is not this cleanup's to judge: skip it. */
    private async loadIfReadable(id: string): Promise<ReviewRecord | undefined> {
        try {
            return await this.load(id);
        } catch {
            return undefined;
        }
    }

    private async removeIfPresent(id: string): Promise<boolean> {
        try {
            await unlink(this.getReviewPath(id));
            return true;
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }

    private async abandon(review: ReviewRecord): Promise<ReviewRecord> {
        review.status = "abandoned";
        review.updatedAt = new Date().toISOString();
        await this.save(review);
        return review;
    }

    private async listReviewIds(): Promise<string[]> {
        const entries = await readdir(this.settingsStore.reviewsDir);
        return entries
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => entry.replace(/\.json$/, ""))
            .sort();
    }

    private getReviewPath(id: string): string {
        return path.join(this.settingsStore.reviewsDir, `${id}.json`);
    }
}

/** The second the review was made, with `:` written as `-` for file names. Two reviews in one second are the caller's to avoid. */
function createTimestampId(): string {
    return new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replace(/\.\d{3}Z$/, "Z");
}

function normalizeReview(review: ReviewRecord): ReviewRecord {
    const persisted = review as Omit<ReviewRecord, "fileScope"> & { fileScope?: ReviewFileScope };
    persisted.fileScope ??= "all";
    for (const iteration of persisted.iterations) {
        const persistedIteration = iteration as { diff: string; diffHash?: string };
        persistedIteration.diffHash ??= hashDiff(iteration.diff);
    }
    return persisted as ReviewRecord;
}

/**
 * Whether no session can still be using a pending review: it was last touched over a day ago, or the process that
 * created it has exited. A record without an owner is judged by age alone. A process id may be reused by an unrelated
 * process; that only keeps the record until it is a day old.
 */
function isAbandonedByOwner(review: ReviewRecord, now: number): boolean {
    if (now - Date.parse(review.updatedAt) > STALE_REVIEW_MS) return true;
    return review.ownerPid !== undefined && !isRunning(review.ownerPid);
}

/** Whether a process with this id exists. Signal 0 only checks; a process owned by another user still counts. */
function isRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function hasDiscussion(review: ReviewRecord): boolean {
    return review.comments.length > 0 || review.resolutions.length > 0;
}

/** A stable hash for comparing the diffs of two rounds. */
export function hashDiff(diff: string): string {
    return createHash("sha256").update(diff).digest("hex");
}
