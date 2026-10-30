// Golden files: the exact request bodies the query builder makes, kept as JSON next to the tests so that a change to a
// request shows in review as a change to a file. `UPDATE_GOLDEN=1 npm test` rewrites them from the current builder.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "golden");

/** Fails unless `actual` is, key for key and in the same order, the body in `golden/<name>.json`. */
export function matchesGolden(name: string, actual: unknown): void {
    const file = path.join(FOLDER, `${name}.json`);
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") {
        fs.mkdirSync(FOLDER, { recursive: true });
        fs.writeFileSync(file, text);
        return;
    }
    assert.ok(fs.existsSync(file), `no golden file ${name}.json: run with UPDATE_GOLDEN=1 to make it`);
    const expected = fs.readFileSync(file, "utf8");
    // Compared as text, so a change in the order of keys counts: the same query should be the same bytes every time.
    assert.equal(text, expected, `${name}.json differs from what the builder makes now`);
}
