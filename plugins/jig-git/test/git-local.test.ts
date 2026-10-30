import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo, teammateCommit, writeFile } from "./support/repos.ts";
import type { Fixture } from "./support/repos.ts";

let h: Harness;
let counter = 0;

before(() => {
    h = setupHarness();
});
after(() => h.cleanup());

/** A fresh clone with its own origin, so each test starts from known refs. */
function fresh(): Fixture {
    return makeRepo(h.sb, `svc${++counter}`);
}

/** A clone on a feature branch that is pushed with upstream. */
function featureClone(branch = "feature/one"): Fixture {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", branch, "--no-track", "origin/main");
    git(r.dir, "push", "-q", "-u", "origin", branch);
    return r;
}

const branch = (r: Fixture) => git(r.dir, "branch", "--show-current");

// ---- branch -------------------------------------------------------------------------------------------------------

test("branch create: cut from the freshly fetched origin/main, not from a stale local main", async () => {
    const r = fresh();
    const newTip = teammateCommit(h.sb, r, "main", "teammate.txt", "Teammate change on main");
    const text = ok(
        await h.call("git", { action: "branch", repo: r.name, operation: "create", branch: "feature/new" }),
    );
    assert.match(text, /^Created feature\/new from origin\/main \([0-9a-f]{7}\) in svc\d+\.$/);
    assert.equal(git(r.dir, "rev-parse", "HEAD"), newTip);
    assert.equal(branch(r), "feature/new");
    assert.throws(
        () => git(r.dir, "rev-parse", "--abbrev-ref", "@{upstream}"),
        "a new branch has no upstream until it is pushed",
    );
});

test("branch create: an untracked file does not block it; tracked edits do", async () => {
    const r = fresh();
    writeFile(r.dir, "notes.txt", "untracked\n");
    ok(await h.call("git", { action: "branch", repo: r.name, operation: "create", branch: "feature/a" }));
    assert.equal(branch(r), "feature/a");
    const dirty = fresh();
    writeFile(dirty.dir, "README.md", "edited\n");
    const result = await h.call("git", {
        action: "branch",
        repo: dirty.name,
        operation: "create",
        branch: "feature/b",
    });
    assert.match(
        result.error?.message ?? "",
        /has uncommitted changes in 1 file; commit or stash them before creating feature\/b/,
    );
});

test("branch create: refuses a protected name, an existing name, a bad base and a name the pattern rejects", async () => {
    const r = fresh();
    const run = (input: Record<string, unknown>) =>
        h.call("git", { action: "branch", repo: r.name, operation: "create", ...input });
    assert.match((await run({ branch: "main" })).error?.message ?? "", /refusing to create protected branch main/);
    git(r.dir, "branch", "feature/x");
    assert.match((await run({ branch: "feature/x" })).error?.message ?? "", /already exists; use operation switch/);
    assert.match(
        (await run({ branch: "feature/y", base: "../x" })).error?.message ?? "",
        /base "\.\.\/x" is not a valid branch name/,
    );
    assert.match(
        (await run({ branch: "feature/y", base: "nope" })).error?.message ?? "",
        /could not fetch origin\/nope/,
    );
    h.jig.setSection("git", { branchName: "^feature/[a-z]+$" });
    assert.match(
        (await run({ branch: "feature/Y2" })).error?.message ?? "",
        /branch name "feature\/Y2" does not match git\.branchName \(\^feature\/\[a-z\]\+\$\)/,
    );
    ok(await run({ branch: "feature/ok" }));
    h.jig.setSection("git", undefined);
});

test("branch create: the base comes from git.base when it is set", async () => {
    const r = fresh();
    git(r.dir, "branch", "-q", "release", "origin/main");
    git(r.dir, "push", "-q", "origin", "release");
    h.jig.setSection("git", { base: "release" });
    assert.match(
        ok(await h.call("git", { action: "branch", repo: r.name, operation: "create", branch: "feature/r" })),
        /from origin\/release/,
    );
    h.jig.setSection("git", undefined);
});

test("branch switch: local, origin-only (tracking), the current one, and refusals", async () => {
    const r = fresh();
    git(r.dir, "branch", "feature/local-only");
    git(r.dir, "branch", "feature/remote-only", "origin/main");
    git(r.dir, "push", "-q", "origin", "feature/remote-only");
    git(r.dir, "branch", "-D", "feature/remote-only");
    const run = (name: string) => h.call("git", { action: "branch", repo: r.name, operation: "switch", branch: name });
    ok(await run("feature/local-only"));
    assert.equal(branch(r), "feature/local-only");
    assert.match(ok(await run("feature/remote-only")), /^Switched to feature\/remote-only/);
    assert.equal(git(r.dir, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/remote-only");
    assert.match(ok(await run("feature/remote-only")), /Already on feature\/remote-only/);
    assert.match((await run("feature/nowhere")).error?.message ?? "", /not found locally or at origin/);
    writeFile(r.dir, "README.md", "dirty\n");
    assert.match((await run("feature/local-only")).error?.message ?? "", /uncommitted changes in 1 file/);
});

test("branch delete: a merged branch goes; an unmerged, the current and a protected one stay", async () => {
    const r = fresh();
    git(r.dir, "branch", "feature/merged");
    git(r.dir, "switch", "-q", "-c", "feature/unmerged");
    commitFile(r.dir, "u.txt", "u\n", "Only here");
    git(r.dir, "switch", "-q", "main");
    const run = (name: string) => h.call("git", { action: "branch", repo: r.name, operation: "delete", branch: name });
    assert.match(ok(await run("feature/merged")), /^Deleted feature\/merged \(was [0-9a-f]{7}\)/);
    assert.match(
        (await run("feature/unmerged")).error?.message ?? "",
        /feature\/unmerged is not fully merged, so it was not deleted/,
    );
    assert.match((await run("main")).error?.message ?? "", /refusing to delete protected branch main/);
    git(r.dir, "switch", "-q", "feature/unmerged");
    assert.match((await run("feature/unmerged")).error?.message ?? "", /is checked out/);
});

test("branch needs an operation and a branch, with the usage line", async () => {
    const r = fresh();
    const bad = await h.call("git", { action: "branch", repo: r.name });
    assert.match(
        bad.error?.message ?? "",
        /^git branch needs operation, branch\. Usage: git branch \{operation, branch, repo\?, base\?\}$/,
    );
    const wrong = await h.call("git", { action: "branch", repo: r.name, operation: "fly", branch: "x" });
    assert.match(wrong.error?.message ?? "", /operation must be one of create, switch, delete/);
});

// ---- worktree -----------------------------------------------------------------------------------------------------

test("worktree: add a new branch from the fetched base, list it, and remove it", async () => {
    const r = fresh();
    const text = ok(
        await h.call("git", {
            action: "worktree",
            repo: r.name,
            operation: "add",
            dir: `${r.name}-wt`,
            branch: "feature/wt",
        }),
    );
    const folder = path.join(h.sb.workspace, `${r.name}-wt`);
    assert.match(text, new RegExp(`Added the work tree ${folder} on feature/wt`));
    assert.ok(fs.existsSync(path.join(folder, "README.md")));
    const list = ok(await h.call("git", { action: "worktree", repo: r.name, operation: "list" }));
    assert.match(list, new RegExp(`${folder} {2}feature/wt`));
    assert.equal(h.jig.declared.get("git")?.classify({ action: "worktree", operation: "list" })?.effect, "read");
    assert.match(
        ok(await h.call("git", { action: "worktree", repo: r.name, operation: "remove", dir: `${r.name}-wt` })),
        /Removed the work tree/,
    );
    assert.ok(!fs.existsSync(folder));
    assert.ok(git(r.dir, "rev-parse", "--verify", "feature/wt"), "the branch is kept");
});

test("worktree: refuses a folder that exists, a bad dir, the main tree, and force", async () => {
    const r = fresh();
    const add = (input: Record<string, unknown>) =>
        h.call("git", { action: "worktree", repo: r.name, operation: "add", branch: "feature/x", ...input });
    fs.mkdirSync(path.join(h.sb.workspace, "taken"));
    assert.match((await add({ dir: "taken" })).error?.message ?? "", /already exists; pick another dir/);
    assert.match((await add({ dir: "../up" })).error?.message ?? "", /dir must be one folder name/);
    assert.match((await add({})).error?.message ?? "", /git worktree add needs dir/);
    const main = await h.call("git", { action: "worktree", repo: r.name, operation: "remove", dir: r.dir });
    assert.match(main.error?.message ?? "", /is not a linked work tree/);
    ok(await add({ dir: `${r.name}-dirty` }));
    writeFile(path.join(h.sb.workspace, `${r.name}-dirty`), "wip.txt", "uncommitted\n");
    const dirty = await h.call("git", {
        action: "worktree",
        repo: r.name,
        operation: "remove",
        dir: `${r.name}-dirty`,
    });
    assert.match(dirty.error?.message ?? "", /git worktree failed|contains modified or untracked files/);
});

// ---- commit -------------------------------------------------------------------------------------------------------

test("commit: commits only the named paths; other staged and unstaged work is left alone", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/c1");
    writeFile(r.dir, "a.ts", "a\n");
    writeFile(r.dir, "b.ts", "b\n");
    writeFile(r.dir, "c.ts", "c\n");
    git(r.dir, "add", "--", "b.ts");
    const result = await h.call(
        "git",
        { action: "commit", repo: r.name, paths: ["a.ts"], message: "Add a" },
        { ask: true },
    );
    assert.match(result.preview?.summary ?? "", /^commit 1 file on feature\/c1 in svc\d+$/);
    assert.match(result.preview?.body ?? "", /^ {2}a\.ts\n\nAdd a$/);
    assert.match(result.text, /^Committed [0-9a-f]{7} on feature\/c1 in svc\d+: Add a \(1 file\)\.$/);
    assert.equal(git(r.dir, "log", "-1", "--format=%s"), "Add a");
    assert.equal(git(r.dir, "diff", "--cached", "--name-only"), "b.ts", "b.ts stays staged");
    assert.match(git(r.dir, "status", "--porcelain"), /\?\? c\.ts/, "c.ts stays untracked");
    assert.deepEqual([...h.jig.facts.values()].at(-1)?.[0], { files: 1 });
});

test("commit: a path with glob characters is a literal file name", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/c2");
    writeFile(r.dir, "*.txt", "literal\n");
    writeFile(r.dir, "other.txt", "other\n");
    ok(await h.call("git", { action: "commit", repo: r.name, paths: ["*.txt"], message: "Literal" }));
    assert.equal(git(r.dir, "show", "--name-only", "--format=", "HEAD"), "*.txt");
    assert.match(git(r.dir, "status", "--porcelain"), /\?\? other\.txt/);
});

test("commit: refuses a detached HEAD, a message that is empty, and paths that are not exact files", async () => {
    const r = fresh();
    const run = (input: Record<string, unknown>) =>
        h.call("git", { action: "commit", repo: r.name, message: "m", paths: ["x.ts"], ...input });
    writeFile(r.dir, "x.ts", "x\n");
    git(r.dir, "checkout", "-q", "--detach");
    assert.match(
        (await run({})).error?.message ?? "",
        /HEAD is detached in svc\d+; switch to a branch before committing/,
    );
    git(r.dir, "switch", "-q", "main");
    assert.match((await run({ message: "   " })).error?.message ?? "", /message is required/);
    for (const paths of [["."], ["./"], ["/etc/passwd"], [":(glob)*"], ["-rf"], ["../x"], [".git/config"], ["a\nb"]]) {
        assert.ok((await run({ paths })).error, JSON.stringify(paths));
    }
    assert.match((await run({ paths: undefined })).error?.message ?? "", /git commit needs paths/);
});

test("commit: git.commitMessage must match the message", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/c3");
    writeFile(r.dir, "p.ts", "p\n");
    h.jig.setSection("git", { commitMessage: "^[A-Z]+-\\d+ " });
    const run = (message: string) => h.call("git", { action: "commit", repo: r.name, paths: ["p.ts"], message });
    assert.match(
        (await run("fix things")).error?.message ?? "",
        /the commit message does not match git\.commitMessage \(\^\[A-Z\]\+-\\d\+ \)/,
    );
    assert.equal(git(r.dir, "log", "-1", "--format=%s"), "Initial commit");
    ok(await run("ABC-12 fix things"));
    h.jig.setSection("git", undefined);
});

test("commit --amend: allowed while the commit is unpushed, refused once any remote has it", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/c4", "--no-track", "origin/main");
    commitFile(r.dir, "one.ts", "1\n", "First try");
    writeFile(r.dir, "one.ts", "1 fixed\n");
    const amended = ok(
        await h.call("git", {
            action: "commit",
            repo: r.name,
            paths: ["one.ts"],
            message: "First try, fixed",
            amend: true,
        }),
    );
    assert.match(amended, /^Amended [0-9a-f]{7} on feature\/c4/);
    assert.equal(git(r.dir, "rev-list", "--count", "origin/main..HEAD"), "1", "still one commit");
    assert.equal(git(r.dir, "show", "HEAD:one.ts"), "1 fixed");
    ok(await h.call("git", { action: "commit", repo: r.name, message: "Reworded only", amend: true }));
    assert.equal(git(r.dir, "log", "-1", "--format=%s"), "Reworded only");
    git(r.dir, "push", "-q", "-u", "origin", "feature/c4");
    writeFile(r.dir, "one.ts", "1 again\n");
    const refused = await h.call("git", {
        action: "commit",
        repo: r.name,
        paths: ["one.ts"],
        message: "Too late",
        amend: true,
    });
    assert.match(
        refused.error?.message ?? "",
        /HEAD is already pushed \(origin\/feature\/c4 has it\), so amending it would rewrite shared history; make a new commit instead/,
    );
    assert.equal(git(r.dir, "log", "-1", "--format=%s"), "Reworded only");
});

test("commit: nothing to commit in the named paths says so", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/c5");
    const result = await h.call("git", { action: "commit", repo: r.name, paths: ["README.md"], message: "No change" });
    assert.match(result.error?.message ?? "", /nothing to commit in README\.md/);
});

test("commit: hooks planted in the repository do not run", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/c6");
    const marker = path.join(h.sb.root, "hook-ran");
    for (const hook of ["pre-commit", "commit-msg"]) {
        const file = path.join(r.dir, ".git", "hooks", hook);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    }
    writeFile(r.dir, "hooked.ts", "1\n");
    ok(await h.call("git", { action: "commit", repo: r.name, paths: ["hooked.ts"], message: "Hooked" }));
    assert.ok(!fs.existsSync(marker), "no hook ran");
    // A hooksPath in the repository's own config is the other way to make git run a script: jig-core refuses it.
    git(r.dir, "config", "core.hooksPath", path.join(r.dir, ".git", "hooks"));
    const refused = await h.call("git", { action: "log", repo: r.name });
    assert.match(refused.error?.message ?? "", /sets core\.hookspath, which would run with your credentials/);
});

// ---- stash --------------------------------------------------------------------------------------------------------

test("stash: push, list, pop and drop", async () => {
    const r = fresh();
    writeFile(r.dir, "README.md", "changed\n");
    assert.match(
        ok(await h.call("git", { action: "stash", repo: r.name, operation: "push", message: "wip" })),
        /Saved working directory and index state On main: wip/,
    );
    assert.equal(git(r.dir, "status", "--porcelain"), "");
    assert.match(
        ok(await h.call("git", { action: "stash", repo: r.name, operation: "list" })),
        /^stash@\{0\}: .*: On main: wip$/,
    );
    assert.match(
        ok(await h.call("git", { action: "stash", repo: r.name, operation: "pop" })),
        /^Applied stash@\{0\} \([0-9a-f]{7}\) to svc\d+ and dropped it\.$/,
    );
    assert.equal(git(r.dir, "status", "--porcelain"), "M README.md");
    assert.match(ok(await h.call("git", { action: "stash", repo: r.name, operation: "list" })), /No stashes\./);
    assert.match(
        ok(await h.call("git", { action: "stash", repo: r.name, operation: "push" })),
        /Saved working directory/,
    );
    assert.match(
        ok(await h.call("git", { action: "stash", repo: r.name, operation: "drop" })),
        /^Dropped stash@\{0\} \([0-9a-f]{7}\) of svc\d+\. git stash apply [0-9a-f]{12} brings it back\.$/,
    );
    assert.match(
        ok(await h.call("git", { action: "stash", repo: r.name, operation: "push" })),
        /No local changes to stash/,
    );
});

test("stash: pop refuses a tree with changes, and a stash that does not exist", async () => {
    const r = fresh();
    writeFile(r.dir, "README.md", "one\n");
    ok(await h.call("git", { action: "stash", repo: r.name, operation: "push" }));
    writeFile(r.dir, "README.md", "two\n");
    assert.match(
        (await h.call("git", { action: "stash", repo: r.name, operation: "pop" })).error?.message ?? "",
        /uncommitted changes in 1 file; commit or stash them before popping stash@\{0\}/,
    );
    assert.match(
        (await h.call("git", { action: "stash", repo: r.name, operation: "drop", index: 3 })).error?.message ?? "",
        /there is no stash@\{3\}/,
    );
});

// ---- sync ---------------------------------------------------------------------------------------------------------

test("sync: no upstream is refused; a teammate's push is fast-forwarded in; again says up to date", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/s1", "--no-track", "origin/main");
    assert.match(
        (await h.call("git", { action: "sync", repo: r.name })).error?.message ?? "",
        /has no upstream; push it first/,
    );
    git(r.dir, "push", "-q", "-u", "origin", "feature/s1");
    const tip = teammateCommit(h.sb, r, "feature/s1", "from-team.txt", "Teammate on feature");
    const out = ok(await h.call("git", { action: "sync", repo: r.name }));
    assert.match(out, /^Fast-forwarded feature\/s1 [0-9a-f]{7}\.\.[0-9a-f]{7} from origin\/feature\/s1/);
    assert.equal(git(r.dir, "rev-parse", "HEAD"), tip);
    assert.match(ok(await h.call("git", { action: "sync", repo: r.name })), /already up to date/);
});

test("sync: diverged branches are refused with the counts, and the tree is untouched", async () => {
    const r = featureClone("feature/s2");
    commitFile(r.dir, "mine.txt", "mine\n", "My commit");
    teammateCommit(h.sb, r, "feature/s2", "theirs.txt", "Their commit");
    const before = git(r.dir, "rev-parse", "HEAD");
    const result = await h.call("git", { action: "sync", repo: r.name });
    assert.match(result.error?.message ?? "", /ahead 1, behind 1\); merge or rebase is your call/);
    assert.equal(git(r.dir, "rev-parse", "HEAD"), before);
    assert.equal(git(r.dir, "status", "--porcelain"), "");
});

// ---- merge --------------------------------------------------------------------------------------------------------

test("merge: the base is fetched and merged into the branch; again says already contains", async () => {
    const r = featureClone("feature/m1");
    teammateCommit(h.sb, r, "main", "from-main.txt", "Main moves on");
    const text = ok(await h.call("git", { action: "merge", repo: r.name }));
    assert.match(text, /^Merged origin\/main into feature\/m1 [0-9a-f]{7}\.\.[0-9a-f]{7} in svc\d+\.$/);
    assert.ok(fs.existsSync(path.join(r.dir, "from-main.txt")));
    assert.match(
        ok(await h.call("git", { action: "merge", repo: r.name })),
        /feature\/m1 already contains origin\/main/,
    );
});

test("merge: another branch, local or on origin", async () => {
    const r = featureClone("feature/m2");
    git(r.dir, "switch", "-q", "-c", "feature/other", "--no-track", "origin/main");
    commitFile(r.dir, "other.txt", "o\n", "Other work");
    git(r.dir, "switch", "-q", "feature/m2");
    assert.match(
        ok(await h.call("git", { action: "merge", repo: r.name, branch: "feature/other" })),
        /^Merged feature\/other into feature\/m2/,
    );
    assert.ok(fs.existsSync(path.join(r.dir, "other.txt")));
    const self = await h.call("git", { action: "merge", repo: r.name, branch: "feature/m2" });
    assert.match(self.error?.message ?? "", /is the current branch; there is nothing to merge/);
    const both = await h.call("git", { action: "merge", repo: r.name, branch: "x", base: "y" });
    assert.match(both.error?.message ?? "", /takes branch or base: not both/);
});

test("merge: a conflict aborts the merge, leaves the tree as it was, and is not resolved", async () => {
    const r = featureClone("feature/m3");
    commitFile(r.dir, "README.md", "feature version\n", "Feature edits README");
    teammateCommit(h.sb, r, "main", "README.md", "main version\n");
    const before = git(r.dir, "rev-parse", "HEAD");
    const result = await h.call("git", { action: "merge", repo: r.name });
    assert.match(
        result.error?.message ?? "",
        /merging origin\/main into feature\/m3 conflicts in 1 file \(README\.md\); the merge was aborted and the tree is unchanged/,
    );
    assert.equal(git(r.dir, "rev-parse", "HEAD"), before);
    assert.equal(git(r.dir, "status", "--porcelain"), "");
    assert.ok(!fs.existsSync(path.join(r.dir, ".git", "MERGE_HEAD")));
});

test("merge: a tree with changes is refused", async () => {
    const r = featureClone("feature/m4");
    writeFile(r.dir, "README.md", "dirty\n");
    assert.match(
        (await h.call("git", { action: "merge", repo: r.name })).error?.message ?? "",
        /uncommitted changes in 1 file; commit or stash them before merging into feature\/m4/,
    );
});

// ---- rebase and cherry-pick ---------------------------------------------------------------------------------------

test("rebase: the branch is rebased onto the fetched base, and a pushed branch is told it needs a lease", async () => {
    const r = featureClone("feature/r1");
    commitFile(r.dir, "mine.txt", "mine\n", "My work");
    teammateCommit(h.sb, r, "main", "theirs.txt", "Main moves on");
    const text = ok(await h.call("git", { action: "rebase", repo: r.name }));
    assert.match(
        text,
        /^Rebased feature\/r1 onto origin\/main: [0-9a-f]{7} is now [0-9a-f]{7} in svc\d+\. History was rewritten, so pushing feature\/r1 needs force_with_lease\.$/,
    );
    assert.equal(git(r.dir, "rev-list", "--count", "origin/main..HEAD"), "1");
    assert.match(ok(await h.call("git", { action: "rebase", repo: r.name })), /already on top of origin\/main/);
});

test("rebase: a conflict aborts it and leaves the branch as it was; a protected branch is refused", async () => {
    const r = featureClone("feature/r2");
    commitFile(r.dir, "README.md", "feature version\n", "Feature edits README");
    teammateCommit(h.sb, r, "main", "README.md", "main version\n");
    const before = git(r.dir, "rev-parse", "HEAD");
    const result = await h.call("git", { action: "rebase", repo: r.name });
    assert.match(
        result.error?.message ?? "",
        /rebasing feature\/r2 onto origin\/main conflicts in 1 file \(README\.md\); the rebase was aborted and the branch is unchanged/,
    );
    assert.equal(git(r.dir, "rev-parse", "HEAD"), before);
    assert.ok(!fs.existsSync(path.join(r.dir, ".git", "rebase-merge")));
    git(r.dir, "switch", "-q", "main");
    assert.match(
        (await h.call("git", { action: "rebase", repo: r.name })).error?.message ?? "",
        /refusing to rebase protected branch main/,
    );
});

test("cherry_pick: applies commits; a conflict aborts it; a protected branch is refused", async () => {
    const r = fresh();
    git(r.dir, "switch", "-q", "-c", "feature/other", "--no-track", "origin/main");
    const one = commitFile(r.dir, "one.txt", "1\n", "One");
    const two = commitFile(r.dir, "two.txt", "2\n", "Two");
    const conflicting = commitFile(r.dir, "README.md", "other readme\n", "Readme on other");
    git(r.dir, "switch", "-q", "-c", "feature/pick", "--no-track", "origin/main");
    commitFile(r.dir, "README.md", "pick readme\n", "Readme on pick");
    const text = ok(await h.call("git", { action: "cherry_pick", repo: r.name, revs: [one, two] }));
    assert.match(text, /^Cherry-picked 2 commits onto feature\/pick: [0-9a-f]{7}\.\.[0-9a-f]{7} in svc\d+\.$/);
    assert.ok(fs.existsSync(path.join(r.dir, "two.txt")));
    const before = git(r.dir, "rev-parse", "HEAD");
    const result = await h.call("git", { action: "cherry_pick", repo: r.name, revs: [conflicting] });
    assert.match(
        result.error?.message ?? "",
        /cherry-picking onto feature\/pick conflicts in 1 file \(README\.md\); it was aborted and the branch is unchanged/,
    );
    assert.equal(git(r.dir, "rev-parse", "HEAD"), before);
    assert.equal(git(r.dir, "status", "--porcelain"), "");
    git(r.dir, "switch", "-q", "main");
    assert.match(
        (await h.call("git", { action: "cherry_pick", repo: r.name, revs: [one] })).error?.message ?? "",
        /refusing to cherry-pick onto protected branch main/,
    );
    assert.match(
        (await h.call("git", { action: "cherry_pick", repo: r.name, revs: ["--abort"] })).error?.message ?? "",
        /is not a valid revision/,
    );
});

// ---- restore ------------------------------------------------------------------------------------------------------

test("restore: asks by default, shows the paths and a diff stat, and discards them", async () => {
    const r = fresh();
    writeFile(r.dir, "README.md", "changed\nlines\n");
    commitFile(r.dir, "keep.txt", "keep\n", "Add keep");
    writeFile(r.dir, "keep.txt", "edited\n");
    const result = await h.call("git", { action: "restore", repo: r.name, paths: ["README.md"] });
    assert.equal(result.cls?.atLeast, "ask");
    assert.equal(result.preview?.fingerprint?.length, 32);
    assert.match(
        result.preview?.summary ?? "",
        /^discard the uncommitted changes in 1 path of svc\d+; they cannot be recovered$/,
    );
    assert.match(result.preview?.body ?? "", /^ {2}README\.md\n\nREADME\.md \| 3 \+\+-/);
    assert.match(result.text, /^Restored 1 path in svc\d+ to HEAD\./);
    assert.equal(git(r.dir, "status", "--porcelain"), "M keep.txt", "only the named path was restored");
});

test("restore: a change that happens after the preview is refused", async () => {
    const r = fresh();
    writeFile(r.dir, "README.md", "first edit\n");
    const result = await h.call(
        "git",
        { action: "restore", repo: r.name, paths: ["README.md"] },
        { between: () => writeFile(r.dir, "README.md", "a different edit\n") },
    );
    assert.match(
        result.error?.message ?? "",
        /git restore changed since the preview; run it again to see the new preview/,
    );
    assert.equal(fs.readFileSync(path.join(r.dir, "README.md"), "utf8"), "a different edit\n", "nothing was discarded");
});

test("restore: staged changes go too, and an untracked path is an error from git", async () => {
    const r = fresh();
    writeFile(r.dir, "README.md", "staged edit\n");
    git(r.dir, "add", "README.md");
    ok(await h.call("git", { action: "restore", repo: r.name, paths: ["README.md"] }));
    assert.equal(git(r.dir, "status", "--porcelain"), "");
    writeFile(r.dir, "new.txt", "untracked\n");
    const result = await h.call("git", { action: "restore", repo: r.name, paths: ["new.txt"] });
    assert.match(
        result.error?.message ?? "",
        /git restore failed: error: pathspec 'new\.txt' did not match any file\(s\) known to git/,
    );
});

test("restore needs paths that are exact files", async () => {
    const r = fresh();
    for (const paths of [["."], ["/etc"], ["../x"]])
        assert.ok((await h.call("git", { action: "restore", repo: r.name, paths })).error, JSON.stringify(paths));
});
