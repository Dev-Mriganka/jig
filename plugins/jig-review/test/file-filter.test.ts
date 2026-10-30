import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterReviewableFiles } from "../src/file-filter.ts";

describe("filterReviewableFiles", () => {
    it("removes installed packages", () => {
        assert.deepEqual(filterReviewableFiles(["src/index.ts", "node_modules/pkg/index.js"]), ["src/index.ts"]);
    });

    it("keeps built output that a repository commits: not every dist folder is generated noise", () => {
        assert.deepEqual(filterReviewableFiles(["dist/app.js", "src/index.ts"]), ["dist/app.js", "src/index.ts"]);
    });

    it("applies project gitignore rules in addition to defaults", () => {
        assert.deepEqual(filterReviewableFiles(["src/index.ts", "coverage/report.json", "tmp/output.log"], "coverage/\ntmp/*.log\n"), ["src/index.ts"]);
    });
});
