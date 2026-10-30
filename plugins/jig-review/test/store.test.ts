import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildReviewSubmissionPrompt } from "../src/prompts.ts";
import { SettingsStore } from "../src/settings.ts";
import { ReviewStore } from "../src/store.ts";

let tempDirectory: string | undefined;

afterEach(async () => {
    if (tempDirectory !== undefined) {
        await rm(tempDirectory, { force: true, recursive: true });
        tempDirectory = undefined;
    }
});

async function createStores(): Promise<{ reviewStore: ReviewStore; settings: SettingsStore }> {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "jig-review-store-"));
    const settings = new SettingsStore(tempDirectory);
    return { reviewStore: new ReviewStore(settings), settings };
}

// A pending review is only cleaned up once nobody can still be using it; these records belong to this live process, so they
// are stale only a day later.
const A_DAY_LATER = (): number => Date.now() + 25 * 60 * 60 * 1000;

describe("ReviewStore", () => {
    it("deletes empty pending reviews during inactive cleanup", async () => {
        const { reviewStore } = await createStores();
        const review = await reviewStore.create("head", "diff", "all");
        assert.deepEqual(await reviewStore.cleanupInactiveReviews(undefined, A_DAY_LATER()), {
            abandoned: 0,
            deleted: 1,
        });
        await assert.rejects(reviewStore.load(review.id));
    });

    it("keeps comment-bearing pending reviews as abandoned history", async () => {
        const { reviewStore } = await createStores();
        const review = await reviewStore.create("head", "diff", "all");
        await reviewStore.addSubmittedComments(review, [{ body: "Please check this." }]);
        await reviewStore.addIteration(review, "updated diff");
        assert.deepEqual(await reviewStore.cleanupInactiveReviews(undefined, A_DAY_LATER()), {
            abandoned: 1,
            deleted: 0,
        });
        assert.equal((await reviewStore.load(review.id)).status, "abandoned");
    });

    it("does not clean up the active pending review", async () => {
        const { reviewStore } = await createStores();
        const review = await reviewStore.create("head", "diff", "all");
        assert.deepEqual(await reviewStore.cleanupInactiveReviews(review.id, A_DAY_LATER()), {
            abandoned: 0,
            deleted: 0,
        });
        assert.equal((await reviewStore.load(review.id)).status, "awaiting-review");
    });

    it("leaves a fresh pending review of a live process alone: another Pi in the folder may have it open", async () => {
        const { reviewStore } = await createStores();
        const review = await reviewStore.create("head", "diff", "all");
        assert.deepEqual(await reviewStore.cleanupInactiveReviews(), { abandoned: 0, deleted: 0 });
        const loaded = await reviewStore.load(review.id);
        assert.equal(loaded.status, "awaiting-review");
        assert.equal(loaded.ownerPid, process.pid);
    });

    it("never touches reviews that are approved or waiting for the agent", async () => {
        const { reviewStore } = await createStores();
        const approved = await reviewStore.approve(await reviewStore.create("head", "diff", "all"), {
            method: "passkey",
        });
        await reviewStore.save({ ...approved, id: `${approved.id}-b`, status: "awaiting-agent" });
        assert.deepEqual(await reviewStore.cleanupInactiveReviews(undefined, A_DAY_LATER()), {
            abandoned: 0,
            deleted: 0,
        });
        assert.equal((await reviewStore.load(approved.id)).status, "approved");
        assert.equal((await reviewStore.load(`${approved.id}-b`)).status, "awaiting-agent");
    });

    it("writes each record readable by the user alone", async () => {
        const { reviewStore, settings } = await createStores();
        const review = await reviewStore.create("head", "diff", "all");
        assert.equal((await stat(path.join(settings.reviewsDir, `${review.id}.json`))).mode & 0o777, 0o600);
    });

    it("lists newest first", async () => {
        const { reviewStore } = await createStores();
        const older = await reviewStore.create("a", "diff", "all");
        await reviewStore.save({ ...older, id: "2099-01-01T00-00-00Z", createdAt: "2099-01-01T00:00:00.000Z" });
        assert.deepEqual(
            (await reviewStore.listAll()).map((review) => review.headSha),
            ["a", "a"],
        );
        assert.equal((await reviewStore.listAll())[0]?.id, "2099-01-01T00-00-00Z");
    });
});

describe("multi-repository reviews", () => {
    it("keep a short label for the page header and every repository's commit for the agent", async () => {
        const { reviewStore } = await createStores();
        const heads = "orders-api@abc123def456, billing-api@0123456789ab";
        const review = await reviewStore.create("PROJ-7", "diff", "branch", { ticket: "PROJ-7", heads });
        const loaded = await reviewStore.load(review.id);
        assert.equal(loaded.headSha, "PROJ-7");
        assert.equal(loaded.ticket, "PROJ-7");
        assert.equal(loaded.heads, heads);
        assert.ok(buildReviewSubmissionPrompt(review, []).includes(`against these commits: ${heads}`));
    });
});

describe("rounds and comments", () => {
    it("a submitted comment makes the review wait for the agent; a resolution links to it; a new iteration shows the next diff", async () => {
        const { reviewStore } = await createStores();
        const review = await reviewStore.create("head", "diff one", "all");
        await reviewStore.addSubmittedComments(review, [{ body: "Why?", filePath: "a.ts", line: 3, side: "new" }]);
        assert.equal(review.status, "awaiting-agent");
        const comment = review.comments[0]!;
        assert.equal(comment.status, "submitted");
        assert.deepEqual(review.iterations[0]!.submittedCommentIds, [comment.id]);

        await reviewStore.addResolution(review, { commentIds: [comment.id], kind: "fixed", summary: "Renamed." });
        assert.equal(review.comments[0]!.status, "resolved");
        assert.equal(review.comments[0]!.resolutionId, review.resolutions[0]!.id);

        await reviewStore.addIteration(review, "diff two");
        assert.equal(review.status, "awaiting-review");
        assert.equal(review.iterations.length, 2);
        assert.equal(review.iterations[1]!.diff, "diff two");
        assert.notEqual(review.iterations[0]!.diffHash, review.iterations[1]!.diffHash);

        await reviewStore.addResolution(review, { commentIds: [comment.id], kind: "answered", summary: "Because." });
        assert.equal(review.comments[0]!.status, "answered", "a later answer replaces the status");
    });
});

describe("approval", () => {
    it("records the approved commits and how it was approved, and no commits when none are given", async () => {
        const { reviewStore } = await createStores();
        const first = await reviewStore.create("PROJ-7", "diff", "branch", { ticket: "PROJ-7" });
        const approved = await reviewStore.approve(first, { method: "passkey", fingerprint: "ab".repeat(32) }, [
            { repo: "worktrees/PROJ-7/api", sha: "a".repeat(40) },
        ]);
        const loaded = await reviewStore.load(approved.id);
        assert.equal(loaded.status, "approved");
        assert.deepEqual(loaded.approvedHeads, [{ repo: "worktrees/PROJ-7/api", sha: "a".repeat(40) }]);
        assert.equal(loaded.approval?.method, "passkey");
        assert.equal(loaded.approval?.fingerprint, "ab".repeat(32));
        assert.equal(loaded.approval?.at, loaded.approvedAt);

        const second = await reviewStore.create("PROJ-8", "diff", "branch", { ticket: "PROJ-8" });
        const bare = await reviewStore.load((await reviewStore.approve(second, { method: "page-and-pi" })).id);
        assert.ok(!("approvedHeads" in bare), "no heads were given, none are recorded");
        assert.equal(bare.approval?.method, "page-and-pi");
    });

    it("notes a click in the page without approving, and forgets it when Pi says no", async () => {
        const { reviewStore } = await createStores();
        const review = await reviewStore.create("head", "diff", "all");
        await reviewStore.markPageApproved(review);
        const marked = await reviewStore.load(review.id);
        assert.equal(marked.status, "awaiting-review", "a page click is not an approval");
        assert.ok(marked.pageApprovedAt);
        assert.equal(marked.approval, undefined);
        await reviewStore.clearPageApproval(review);
        assert.ok(!("pageApprovedAt" in (await reviewStore.load(review.id))));
    });
});
