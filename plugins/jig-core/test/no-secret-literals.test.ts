// Push protection and secret scanners reject a commit that holds a credential-shaped string, even a fake one in a test.
// Fake credentials are therefore built at run time from parts; this test fails when a literal one slips into the repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

// High-confidence shapes only, written so that this file does not match them itself.
const SHAPES: ReadonlyArray<[string, RegExp]> = [
    ["GitHub token", new RegExp(["gh", "[pousr]_[A-Za-z0-9]{30,}"].join(""))],
    ["GitHub fine-grained token", new RegExp(["github", "_pat_[A-Za-z0-9_]{30,}"].join(""))],
    ["Postman API key", new RegExp(["PM", "AK-[A-Za-z0-9]{10,}"].join(""))],
    ["AWS access key id", new RegExp(["AK", "IA[0-9A-Z]{16}"].join(""))],
    ["Slack token", new RegExp(["xo", "x[baprs]-[A-Za-z0-9-]{10,}"].join(""))],
    ["private key block", new RegExp(["-----BEGIN ", "[A-Z ]*PRIVATE KEY-----"].join(""))],
];

test("no tracked file holds a credential-shaped literal, fake or real", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    const found: string[] = [];
    for (const file of files) {
        if (/\.(png|jpg|gif|webp|ico|woff2?)$/.test(file) || file.endsWith("package-lock.json")) continue;
        let text: string;
        try {
            text = readFileSync(path.join(root, file), "utf8");
        } catch {
            continue;
        }
        for (const [name, shape] of SHAPES) if (shape.test(text)) found.push(`${file}: ${name}`);
    }
    assert.deepEqual(found, [], "build fake credentials at run time from parts, such as [\"PMAK\", \"1a2b\"].join(\"-\")");
});
