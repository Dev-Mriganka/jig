import type { ReviewRecord } from "@web/types.js";
import { type ChangeData, type FileData, getChangeKey, parseDiff } from "react-diff-view";
import { describe, expect, it } from "vitest";

import { buildReviewThreads, getSelectedLine } from "./buildReviewThreads.js";

const addedFileDiff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const value = 1;
`;

describe("getSelectedLine", () => {
  it("maps a clicked inserted change to a new-side line comment location", () => {
    const { change } = parseAddedFile();

    expect(getSelectedLine(change, "new", "src/new.ts")).toMatchObject({
      filePath: "src/new.ts",
      line: 1,
      side: "new",
    });
  });
});

describe("buildReviewThreads", () => {
  it("adds agent resolution threads to addressed diff locations", () => {
    const { change, file } = parseAddedFile();
    const threads = buildReviewThreads({
      drafts: [],
      file,
      activeReview: createReview({
        resolutions: [
          {
            id: "resolution-1",
            commentIds: ["general-comment"],
            kind: "fixed",
            summary: "Updated the changed line.",
            addressedLocations: [{ filePath: "src/new.ts", line: 1, side: "new" }],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    });

    expect(threads.has(getChangeKey(change))).toBe(true);
  });
});

function parseAddedFile(): { change: ChangeData; file: FileData } {
  const [file] = parseDiff(addedFileDiff);
  const change = file?.hunks[0]?.changes[0];

  if (file === undefined || change === undefined) throw new Error("The fixture diff holds one inserted line.");

  return { change, file };
}

function createReview(overrides: Partial<ReviewRecord>): ReviewRecord {
  return {
    id: "review-1",
    headSha: "head",
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
