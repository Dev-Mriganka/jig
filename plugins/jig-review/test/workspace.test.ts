import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { parseCodeReviewCommand } from "../src/command.ts";
import { findRepositories, normalizeFolder, prefixDiff, WorkspaceReviewSource } from "../src/workspace.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";

let root = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });

function repo(dir: string, file: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, file), "one\ntwo\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
}

let jig: FakeJig;

before(() => {
    jig = installFakeJig();
    root = mkdtempSync(path.join(os.tmpdir(), "jig-review-ws-"));
    repo(path.join(root, "orders-api"), "Service.java");
    repo(path.join(root, "accounts-api"), "Account.java");
    repo(path.join(root, "worktrees", "PROJ-1", "orders-engine"), "Engine.java");
    repo(path.join(root, "untouched"), "Same.java");
    mkdirSync(path.join(root, "notes"));
    writeFileSync(path.join(root, "orders-api", "Service.java"), "one\nTWO\n");
    writeFileSync(path.join(root, "orders-api", "New.java"), "added\n");
    writeFileSync(path.join(root, "worktrees", "PROJ-1", "orders-engine", "Engine.java"), "one\ntwo\nthree\n");
});
after(() => {
    jig.remove();
    rmSync(root, { recursive: true, force: true });
});

test("finds the repositories in a workspace, including those inside a folder such as worktrees/", () => {
    assert.deepEqual(findRepositories(root).map((r) => r.prefix), ["accounts-api", "orders-api", "untouched", "worktrees/PROJ-1/orders-engine"]);
    assert.deepEqual(findRepositories(path.join(root, "orders-api")), [{ root: path.join(root, "orders-api"), prefix: "" }]);
});

test("one review covers every repository with changes, with paths from the workspace folder", async () => {
    const source = new WorkspaceReviewSource(root);
    await source.requireGitRepo();
    assert.deepEqual(await source.getChangedFiles({ scope: "all" }), ["orders-api/New.java", "orders-api/Service.java", "worktrees/PROJ-1/orders-engine/Engine.java"]);
    const diff = await source.getDiff({ scope: "all" });
    assert.match(diff, /^diff --git a\/orders-api\/Service\.java b\/orders-api\/Service\.java$/m);
    assert.match(diff, /^\+\+\+ b\/orders-api\/New\.java$/m);
    assert.match(diff, /^diff --git a\/worktrees\/PROJ-1\/orders-engine\/Engine\.java b\/worktrees\/PROJ-1\/orders-engine\/Engine\.java$/m);
    assert.match(diff, /^-two$/m);
    assert.ok(!diff.includes("untouched/"), "repositories without changes are left out");
    assert.match(await source.getHeadSha(), /^orders-api@[0-9a-f]{12}, worktrees\/PROJ-1\/orders-engine@[0-9a-f]{12}$/);
});

test("the head label names the repositories the selection has files in, not every repository with uncommitted changes", async () => {
    const source = new WorkspaceReviewSource(root);
    // `untouched` is clean (its file was committed); the other repositories are dirty but not in the selection.
    assert.match(await source.getHeadSha({ scope: "touched", files: ["untouched/Same.java"] }), /^untouched@[0-9a-f]{12}$/);
    assert.match(await source.getHeadSha({ scope: "touched", files: ["orders-api/Service.java"] }), /^orders-api@[0-9a-f]{12}$/);
    assert.equal(await source.getHeadSha({ scope: "touched", files: [] }), "none");
});

test("touched files, named from the workspace folder, select only their repositories", async () => {
    const source = new WorkspaceReviewSource(root);
    const diff = await source.getDiff({ scope: "touched", files: ["worktrees/PROJ-1/orders-engine/Engine.java"] });
    assert.match(diff, /worktrees\/PROJ-1\/orders-engine\/Engine\.java/);
    assert.ok(!diff.includes("orders-api"));
});

test("an empty workspace says so", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "jig-review-empty-"));
    try {
        await assert.rejects(new WorkspaceReviewSource(empty).requireGitRepo(), /No git repositories found/);
    } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("prefixing touches file headers only, never hunk lines that look like headers", () => {
    const diff = ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -1 +1 @@", "--- a/not-a-header", "+++ b/also-content"].join("\n");
    assert.deepEqual(prefixDiff(diff, "repo").split("\n"), ["diff --git a/repo/x.md b/repo/x.md", "--- a/repo/x.md", "+++ b/repo/x.md", "@@ -1 +1 @@", "--- a/not-a-header", "+++ b/also-content"]);
    assert.equal(prefixDiff(diff, ""), diff);
});

test("a folder limits the review to one ticket's repositories", async () => {
    const source = new WorkspaceReviewSource(root);
    assert.deepEqual(await source.getChangedFiles({ scope: "all", folder: "worktrees/PROJ-1" }), ["worktrees/PROJ-1/orders-engine/Engine.java"]);
    assert.deepEqual(await source.getChangedFiles({ scope: "all", folder: "./orders-api/" }), ["orders-api/New.java", "orders-api/Service.java"]);
    await assert.rejects(source.requireGitRepo({ folder: "notes" }), /No git repositories found in notes/);
    assert.throws(() => normalizeFolder(root, "../elsewhere"), /outside/);
    assert.equal(normalizeFolder(root, path.join(root, "worktrees", "PROJ-1")), "worktrees/PROJ-1");
});

test("/code-review takes an optional folder and a scope", () => {
    assert.deepEqual(parseCodeReviewCommand(""), { selection: { scope: "all" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("worktrees/PROJ-1 --staged"), { selection: { scope: "staged", folder: "worktrees/PROJ-1" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("settings"), { subcommand: "settings" });
});

test("--branch reviews everything since the branch left develop: commits and uncommitted work", async () => {
    const ticket = path.join(root, "worktrees", "PROJ-2", "shipping-api");
    repo(ticket, "Order.java");
    git(ticket, "branch", "develop");
    git(ticket, "checkout", "-q", "-b", "feature/PROJ-2");
    writeFileSync(path.join(ticket, "Order.java"), "one\ncommitted\n");
    git(ticket, "commit", "-qam", "committed change");
    writeFileSync(path.join(ticket, "Draft.java"), "uncommitted\n");
    const source = new WorkspaceReviewSource(root);
    const folder = "worktrees/PROJ-2";
    assert.deepEqual(await source.getChangedFiles({ scope: "all", folder }), ["worktrees/PROJ-2/shipping-api/Draft.java"], "HEAD-based review misses the commit");
    assert.deepEqual(await source.getChangedFiles({ scope: "branch", folder }), ["worktrees/PROJ-2/shipping-api/Draft.java", "worktrees/PROJ-2/shipping-api/Order.java"]);
    const diff = await source.getDiff({ scope: "branch", folder });
    assert.match(diff, /^\+committed$/m);
    assert.match(diff, /^\+uncommitted$/m);
});

test("the heads an approval records are full commits, and only while the approved diff is still current", async () => {
    const { headsToRecord } = await import("../src/approval-heads.ts");
    const { hashDiff } = await import("../src/store.ts");
    const folder = "worktrees/PROJ-2";
    const source = new WorkspaceReviewSource(root);
    const sha = git(path.join(root, folder, "shipping-api"), "rev-parse", "HEAD").trim();
    assert.deepEqual(await source.getHeads({ folder }), [{ repo: "worktrees/PROJ-2/shipping-api", sha }]);
    const diff = await source.getDiff({ scope: "branch", folder });
    const review = { folder, fileScope: "branch", iterations: [{ diffHash: hashDiff(diff) }] } as never;
    assert.deepEqual(await headsToRecord(source, review), [{ repo: "worktrees/PROJ-2/shipping-api", sha }]);
    const stale = { folder, fileScope: "branch", iterations: [{ diffHash: hashDiff("an older diff") }] } as never;
    assert.equal(await headsToRecord(source, stale), undefined, "a diff that changed since is not vouched for");
});
