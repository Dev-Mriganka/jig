// Nothing company-specific goes into this repository: no company or product names of the harness this was ported from.
// The words are built from parts, so that this file does not hold them itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WORDS = [["lem", "on"], ["von", "age"], ["bed", "rock"], ["switch", "board"]].map((parts) => parts.join(""));

test("no tracked file names the company, its cloud account or the harness this was ported from", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const found: string[] = [];
    for (const file of files) {
        if (/\.(png|jpg|gif|webp|ico|woff2?)$/.test(file) || file.endsWith("package-lock.json")) continue;
        let text: string;
        try {
            text = readFileSync(path.join(ROOT, file), "utf8");
        } catch {
            continue;
        }
        for (const word of WORDS) if (new RegExp(word, "i").test(text) || new RegExp(word, "i").test(file)) found.push(`${file}: ${word.slice(0, 2)}…`);
    }
    assert.deepEqual(found, []);
});

test("the environment variable is JIG_THEME_FOOTER", () => {
    const source = readFileSync(path.join(ROOT, "plugins/jig-theme/src/session.ts"), "utf8");
    assert.match(source, /JIG_THEME_FOOTER/);
});
