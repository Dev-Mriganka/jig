// What changed in the repositories between two snapshots of git status, over real temporary repositories.
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { changedBetween, MAX_CHANGED_PATHS, parseStatus, snapshotWorkspace } from "../src/run-changes.ts";
import { findRepositories } from "../src/workspace.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";
import { git } from "./support/git.ts";

let root = "";
let repo = "";
let jig: FakeJig;

const snap = (maxPaths?: number) => snapshotWorkspace(root, findRepositories, maxPaths);

before(() => {
    jig = installFakeJig();
    root = mkdtempSync(path.join(os.tmpdir(), "jig-review-run-"));
    repo = path.join(root, "api");
    git(root, "init", "-q", "-b", "main", repo);
    for (const file of ["A.java", "B.java", "C.java"]) writeFileSync(path.join(repo, file), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
});
after(() => {
    jig.remove();
    rmSync(root, { recursive: true, force: true });
});

test("reads the paths of a status listing, a rename with its origin", () => {
    assert.deepEqual(parseStatus(" M a b.java\0?? new.java\0R  moved.java\0old.java\0 D gone.java\0"), ["a b.java", "new.java", "moved.java", "old.java", "gone.java"]);
    assert.deepEqual(parseStatus(""), []);
});

test("new and re-edited paths differ; untouched dirty paths, a clean tree and a path gone from the status do not", async () => {
    writeFileSync(path.join(repo, "A.java"), "one\nhand\n");
    writeFileSync(path.join(repo, "B.java"), "one\nhand\n");
    const before = await snap();
    assert.deepEqual(changedBetween(before, await snap()), []);

    writeFileSync(path.join(repo, "B.java"), "one\nhand\nagent\n");
    writeFileSync(path.join(repo, "New.java"), "new\n");
    git(repo, "checkout", "--", "A.java");
    const after = await snap();
    assert.deepEqual(changedBetween(before, after).map((file) => path.relative(repo, file)), ["B.java", "New.java"], "A.java was committed or reverted: gone from the status is not the run's doing");

    git(repo, "checkout", "--", "B.java");
    rmSync(path.join(repo, "New.java"));
});

test("a rename is seen at both ends, a symlink by its target, a nested repository not at all", async () => {
    const before = await snap();
    renameSync(path.join(repo, "C.java"), path.join(repo, "Renamed.java"));
    git(repo, "add", "-A");
    symlinkSync("A.java", path.join(repo, "link"));
    git(repo, "init", "-q", path.join(repo, "nested"));
    writeFileSync(path.join(repo, "nested", "x.txt"), "x\n");
    const changed = changedBetween(before, await snap()).map((file) => path.relative(repo, file));
    assert.deepEqual(changed, ["C.java", "Renamed.java", "link"]);
});

test("a repository with more changed paths than the bound has no snapshot; the others do", async () => {
    git(repo, "reset", "-q", "--hard");
    git(repo, "clean", "-qffdx");
    const other = path.join(root, "other");
    git(root, "init", "-q", "-b", "main", other);
    for (let i = 0; i < 5; i++) writeFileSync(path.join(repo, `f${i}.txt`), "x\n");
    writeFileSync(path.join(other, "o.txt"), "x\n");

    assert.deepEqual([...(await snap(5)).keys()].sort(), [other, repo].sort());
    assert.deepEqual([...(await snap(4)).keys()], [other]);
    assert.equal(MAX_CHANGED_PATHS, 2000);

    // A repository with no snapshot at either end is not compared.
    assert.deepEqual(changedBetween(await snap(4), await snap(4)), []);
});

test("git that fails or times out gives no snapshot, never an error", async () => {
    const failing = async () => ({ code: 128, stdout: "", stderr: "fatal", timedOut: false });
    const timedOut = async () => ({ code: 0, stdout: "", stderr: "", timedOut: true });
    const throwing = async (): Promise<never> => {
        throw new Error("jig-core refused: .git/config sets core.sshcommand");
    };
    for (const broken of [failing, timedOut, throwing]) {
        assert.equal((await snapshotWorkspace(root, findRepositories, undefined, broken)).size, 0);
    }
});

test("every git call goes through jig-core, with the repository as its folder", async () => {
    jig.gitCalls.length = 0;
    await snap();
    assert.ok(jig.gitCalls.length > 0);
    assert.ok(jig.gitCalls.every((call) => call.repo === repo || call.repo === path.join(root, "other")));
});
