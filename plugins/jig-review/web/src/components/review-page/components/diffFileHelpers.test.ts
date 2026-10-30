import { getReviewFilePath } from "@web/review-file.js";
import { parseDiff } from "react-diff-view";
import { describe, expect, it } from "vitest";

const addedFileDiff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const value = 1;
`;

describe("diffFileHelpers", () => {
  it("uses the non-dev-null path for added files", () => {
    const [file] = parseDiff(addedFileDiff);

    if (file === undefined) throw new Error("The fixture diff holds one file.");
    expect(getReviewFilePath(file)).toBe("src/new.ts");
  });
});
