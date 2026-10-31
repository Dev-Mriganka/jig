// Reading workflow files from folders: order, replacement, the files that fail, and picking a workflow by ticket.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadWorkflows, matching } from "../src/load.ts";

let root: string;
beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "jig-workflow-load-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function folder(name: string, files: Record<string, unknown>): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content));
    }
    return dir;
}

const workflow = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    stages: [{ id: "one", goal: "first" }],
    ...over,
});

describe("loading", () => {
    test("every valid file, with where it came from", () => {
        const dir = folder("a", { "feature.json": workflow("feature"), "bugfix.json": workflow("bugfix") });
        const loaded = loadWorkflows([{ dir, source: "configured" }]);
        assert.deepEqual([...loaded.workflows.keys()].sort(), ["bugfix", "feature"]);
        assert.equal(loaded.workflows.get("feature")?.file, path.join(dir, "feature.json"));
        assert.equal(loaded.workflows.get("feature")?.source, "configured");
        assert.deepEqual(loaded.failures, []);
    });

    test("a folder that is not there holds nothing, and files that are not .json are not read", () => {
        const dir = folder("a", { "feature.json": workflow("feature"), "notes.txt": "x", "README.md": "# hi" });
        const loaded = loadWorkflows([
            { dir: path.join(root, "missing"), source: "agent folder" },
            { dir, source: "project" },
        ]);
        assert.deepEqual([...loaded.workflows.keys()], ["feature"]);
        assert.deepEqual(loaded.failures, []);
    });

    test("a later folder replaces an earlier file of the same name", () => {
        const first = folder("first", { "feature.json": workflow("feature", { description: "company" }) });
        const second = folder("second", { "feature.json": workflow("feature", { description: "mine" }) });
        const loaded = loadWorkflows([
            { dir: first, source: "configured" },
            { dir: second, source: "agent folder" },
        ]);
        assert.equal(loaded.workflows.get("feature")?.workflow.description, "mine");
        assert.equal(loaded.workflows.get("feature")?.source, "agent folder");
    });

    test("a broken file is reported with its path and its first problem, and the others still load", () => {
        const dir = folder("a", {
            "good.json": workflow("good"),
            "bad.json": workflow("bad", { colour: "red", stages: [] }),
            "torn.json": "{ nope",
            "wrong-name.json": workflow("other"),
        });
        const loaded = loadWorkflows([{ dir, source: "configured" }]);
        assert.deepEqual([...loaded.workflows.keys()], ["good"]);
        const byFile = Object.fromEntries(
            loaded.failures.map((failure) => [path.basename(failure.file), failure.reason]),
        );
        assert.match(byFile["bad.json"] ?? "", /^colour: unknown field \(and 1 more\)$/);
        assert.match(byFile["torn.json"] ?? "", /^not valid JSON/);
        assert.match(byFile["wrong-name.json"] ?? "", /^name: is "other"/);
        assert.equal(loaded.failures[0]?.file, path.join(dir, "bad.json"), "the path is the whole path");
    });

    test("a file over 64 KB is not a workflow", () => {
        const dir = folder("a", { "big.json": JSON.stringify(workflow("big", { description: "x".repeat(70_000) })) });
        assert.match(loadWorkflows([{ dir, source: "configured" }]).failures[0]?.reason ?? "", /larger than 64 KB/);
    });

    test("a folder named like a file is skipped with a reason", () => {
        const dir = folder("a", {});
        mkdirSync(path.join(dir, "odd.json"));
        assert.deepEqual(
            loadWorkflows([{ dir, source: "configured" }]).failures.map((f) => f.reason),
            ["not a file"],
        );
    });
});

describe("picking a workflow by ticket", () => {
    test("by the pattern each workflow matches", () => {
        const dir = folder("a", {
            "feature.json": workflow("feature", { match: { ticket: "^PROJ-\\d+$" } }),
            "bugfix.json": workflow("bugfix", { match: { ticket: "^BUG-\\d+$" } }),
            "any.json": workflow("any"),
            "wide.json": workflow("wide", { match: { ticket: "-\\d+$" } }),
        });
        const loaded = loadWorkflows([{ dir, source: "configured" }]);
        assert.deepEqual(matching(loaded, "PROJ-123"), ["feature", "wide"]);
        assert.deepEqual(matching(loaded, "BUG-7"), ["bugfix", "wide"]);
        assert.deepEqual(matching(loaded, "OTHER"), []);
    });
});
