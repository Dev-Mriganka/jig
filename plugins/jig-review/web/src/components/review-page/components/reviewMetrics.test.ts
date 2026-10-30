import type { ReviewRecord } from "@web/types.js";
import { parseDiff } from "react-diff-view";
import { describe, expect, it } from "vitest";

import { getFileReviewMetrics, getGlobalDiffStats } from "./reviewMetrics.js";

const diff = `diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
-export const b = 1;
+export const b = 2;
+export const c = 3;
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;

describe("reviewMetrics", () => {
  it("counts added and deleted lines globally", () => {
    expect(getGlobalDiffStats(parseDiff(diff))).toEqual({ added: 3, deleted: 2 });
  });

  it("sorts files in explorer order and counts user plus agent messages", () => {
    const review = createReviewWithMessages();

    const metrics = getFileReviewMetrics(
      parseDiff(diff),
      [{ id: "draft-1", body: "Draft", filePath: "src/a.ts", line: 1, side: "new" }],
      review,
    );

    expect(metrics.map((file) => file.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(metrics[0]).toMatchObject({ messages: 4, stats: { added: 1, deleted: 1 } });
  });

  it("marks files whose cumulative diff changed since the previous review iteration", () => {
    const review = createReviewWithTwoIterations();

    const metrics = getFileReviewMetrics(parseDiff(diff), [], review);

    expect(metrics.find((file) => file.filePath === "src/a.ts")).toMatchObject({
      changedSinceLastReview: false,
    });
    expect(metrics.find((file) => file.filePath === "src/b.ts")).toMatchObject({
      changedSinceLastReview: true,
    });
  });
});

function createReviewWithMessages(): ReviewRecord {
  return createReviewRecord({
    comments: [
      {
        id: "comment-1",
        body: "Please fix this",
        filePath: "src/a.ts",
        line: 1,
        side: "new",
        status: "resolved",
        createdAt: "2026-01-01T00:00:00.000Z",
        resolutionId: "resolution-1",
      },
    ],
    resolutions: [
      {
        id: "resolution-1",
        commentIds: ["comment-1"],
        kind: "fixed",
        summary: "Fixed it",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "resolution-2",
        commentIds: ["general-comment"],
        kind: "fixed",
        summary: "Fixed general feedback",
        addressedLocations: [{ filePath: "src/a.ts", line: 1, side: "new" }],
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ],
  });
}

function createReviewWithTwoIterations(): ReviewRecord {
  const previousDiff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;

  return createReviewRecord({
    iterations: [
      {
        id: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        diff: previousDiff,
        diffHash: "previous",
        submittedCommentIds: [],
        resolutionIds: [],
      },
      {
        id: 2,
        createdAt: "2026-01-01T00:00:01.000Z",
        diff,
        diffHash: "current",
        submittedCommentIds: [],
        resolutionIds: [],
      },
    ],
  });
}

function createReviewRecord(overrides: Partial<ReviewRecord>): ReviewRecord {
  return {
    id: "review-1",
    headSha: "HEAD",
    fileScope: "all",
    status: "awaiting-review",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    comments: [],
    resolutions: [],
    iterations: [],
    ...overrides,
  };
}
