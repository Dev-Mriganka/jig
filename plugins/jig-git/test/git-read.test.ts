import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseStatus } from "../src/git-read.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo, writeFile } from "./support/repos.ts";
import type { Fixture } from "./support/repos.ts";

let h: Harness;
let svc: Fixture;
let api: Fixture;

before(() => {
    h = setupHarness();
    svc = makeRepo(h.sb, "svc");
    api = makeRepo(h.sb, "api");
    // svc: a feature branch pushed, then one commit ahead of its upstream, plus an untracked file.
    git(svc.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    git(svc.dir, "push", "-q", "-u", "origin", "feature/one");
    commitFile(svc.dir, "src/a.ts", "export const a = 1;\n", "Add a");
    writeFile(svc.dir, "scratch.txt", "untracked\n");
    // api: a modified tracked file on main.
    writeFile(api.dir, "README.md", "# changed\n");
});
after(() => h.cleanup());

test("status without a repo lists every repo in the workspace, one line each", async () => {
    const text = ok(await h.call("git", { action: "status" }));
    const lines = text.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines.find((l) => l.startsWith("api")) ?? "", /api\s+main\s+up to date\s+1 changed/);
    assert.match(lines.find((l) => l.startsWith("svc")) ?? "", /svc\s+feature\/one\s+ahead 1\s+1 changed/);
});

test("status of one repo: branch, upstream, the base, and the changed files", async () => {
    const text = ok(await h.call("git", { action: "status", repo: "svc" }));
    assert.match(text, /^svc {2}feature\/one\n/);
    assert.match(text, /upstream origin\/feature\/one: ahead 1/);
    assert.match(text, /base origin\/main: ahead 1, behind 0/);
    assert.match(text, /1 changed file:\n\?\? scratch\.txt$/);
});

test("started inside a repository, status without a repo is that repository's detail", async () => {
    const text = ok(await h.call("git", { action: "status" }, { cwd: svc.dir }));
    assert.match(text, /^svc {2}feature\/one\n/);
});

test("a call without a repo means the repository Pi was started in; a name needs the workspace", async () => {
    assert.match(ok(await h.call("git", { action: "log" }, { cwd: svc.dir })), /Add a/);
    const outside = await h.call("git", { action: "log" }, { cwd: h.sb.root });
    assert.match(outside.error?.message ?? "", /Pi was not started inside a git repository/);
});

test("porcelain v2 parsing: a detached HEAD is named by its short sha", () => {
    const parsed = parseStatus("# branch.oid 0123456789abcdef\n# branch.head (detached)\n");
    assert.equal(parsed.detached, true);
    assert.equal(parsed.branch, "(detached at 0123456)");
    assert.equal(parsed.changed, 0);
});

test("log: commits with date and author; n is capped; a range, an author and a message filter", async () => {
    const all = ok(await h.call("git", { action: "log", repo: "svc" }));
    assert.match(all, /^2 commits\n[0-9a-f]+ \d{4}-\d{2}-\d{2} Test Author: Add a\n/);
    assert.match(ok(await h.call("git", { action: "log", repo: "svc", n: 1 })), /^1 commit\n/);
    assert.match(
        ok(await h.call("git", { action: "log", repo: "svc", range: "origin/main..HEAD" })),
        /^1 commit\n.*Add a$/,
    );
    assert.match(ok(await h.call("git", { action: "log", repo: "svc", author: "nobody" })), /No commits match/);
    assert.match(ok(await h.call("git", { action: "log", repo: "svc", grep: "add A" })), /Add a/);
    assert.match(ok(await h.call("git", { action: "log", repo: "svc", paths: ["README.md"] })), /Initial commit/);
});

test("log: the full format adds the body of the message", async () => {
    git(svc.dir, "commit", "-q", "--allow-empty", "-m", "Subject line\n\nThe body explains why.");
    const text = ok(await h.call("git", { action: "log", repo: "svc", n: 1, format: "full" }));
    assert.match(text, /Subject line\n {4}The body explains why\./);
    git(svc.dir, "reset", "-q", "--hard", "HEAD~1");
});

test("log refuses a range or a filter that could be read as an option", async () => {
    for (const input of [{ range: "--output=/tmp/x" }, { range: "a..b..c" }, { author: "x\ny" }, { since: "" }]) {
        const result = await h.call("git", { action: "log", repo: "svc", ...input });
        assert.ok(result.error, JSON.stringify(input));
    }
});

test("diff: stat against the merge base, with the untracked note", async () => {
    const text = ok(await h.call("git", { action: "diff", repo: "svc", against: "base" }));
    assert.match(text, /working tree vs merge base with origin\/main/);
    assert.match(text, /\bsrc\/a\.ts \| 1 \+/);
    assert.match(text, /1 untracked file not shown/);
});

test("diff: the working tree vs HEAD is empty when nothing is modified, and a range shows its commits", async () => {
    assert.match(ok(await h.call("git", { action: "diff", repo: "svc" })), /^No changes: working tree vs HEAD\./);
    assert.match(
        ok(await h.call("git", { action: "diff", repo: "svc", range: "origin/main..HEAD", format: "names" })),
        /A\tsrc\/a\.ts/,
    );
});

test("diff: names, patch and staged changes; paths limit the diff", async () => {
    assert.match(ok(await h.call("git", { action: "diff", repo: "api", format: "names" })), /M\tREADME\.md/);
    assert.match(
        ok(await h.call("git", { action: "diff", repo: "api", format: "patch", paths: ["README.md"] })),
        /^\+# changed$/m,
    );
    assert.match(
        ok(await h.call("git", { action: "diff", repo: "api", against: "staged" })),
        /No changes: staged changes vs HEAD/,
    );
    git(api.dir, "add", "README.md");
    assert.match(ok(await h.call("git", { action: "diff", repo: "api", against: "staged" })), /README\.md \| 2 \+-/);
    git(api.dir, "restore", "--staged", "README.md");
});

test("diff: a large patch is cut at 500 lines and says how many were left out", async () => {
    const big = `${Array.from({ length: 2000 }, (_, i) => `line ${i} with some padding text`).join("\n")}\n`;
    commitFile(api.dir, "big.txt", big, "Big file");
    writeFile(api.dir, "big.txt", big.replace(/line/g, "changed"));
    const text = ok(await h.call("git", { action: "diff", repo: "api", format: "patch", paths: ["big.txt"] }));
    assert.match(text, /\.\.\. \d+ more lines; name paths to see less/);
    assert.ok(text.split("\n").length < 520);
    git(api.dir, "checkout", "-q", "--", "big.txt");
    git(api.dir, "reset", "-q", "--hard", "HEAD~1");
    writeFile(api.dir, "README.md", "# changed\n");
});

test("diff: options that do not go together are refused", async () => {
    const both = await h.call("git", { action: "diff", repo: "svc", range: "a..b", against: "staged" });
    assert.match(both.error?.message ?? "", /either range, or against with base/);
    const format = await h.call("git", { action: "diff", repo: "svc", format: "oneline" });
    assert.match(format.error?.message ?? "", /format must be one of summary, names, patch/);
});

test("show: a commit with its stat, and a file at a revision", async () => {
    const commit = ok(await h.call("git", { action: "show", repo: "svc" }));
    assert.match(
        commit,
        /^commit [0-9a-f]{40}\nAuthor: Test Author <test@example\.invalid>\nDate: {3}\d{4}-\d{2}-\d{2}\n\nAdd a/,
    );
    assert.match(commit, /src\/a\.ts \| 1 \+/);
    assert.match(
        ok(await h.call("git", { action: "show", repo: "svc", rev: "origin/main", path: "README.md" })),
        /^origin\/main:README\.md\n# svc/,
    );
    const missing = await h.call("git", { action: "show", repo: "svc", path: "nope.txt" });
    assert.match(missing.error?.message ?? "", /git show failed/);
});

test("blame: who changed each line, and a line range", async () => {
    const text = ok(await h.call("git", { action: "blame", repo: "svc", path: "src/a.ts" }));
    assert.match(text, /\(Test Author \d{4}-\d{2}-\d{2} +1\) export const a = 1;/);
    const range = await h.call("git", { action: "blame", repo: "svc", path: "src/a.ts", lines: "x" });
    assert.match(range.error?.message ?? "", /lines must look like/);
});

test("branches: the current and the protected ones are marked, with tracking; contains filters", async () => {
    const text = ok(await h.call("git", { action: "branches", repo: "svc" }));
    assert.match(text, /\* feature\/one {2}-> origin\/feature\/one \[ahead 1\]/);
    assert.match(text, / {2}main \(protected\) {2}-> origin\/main/);
    const sha = git(svc.dir, "rev-parse", "HEAD");
    const containing = ok(await h.call("git", { action: "branches", repo: "svc", contains: sha }));
    assert.match(containing, /feature\/one/);
    assert.doesNotMatch(containing, /main/);
    assert.match(ok(await h.call("git", { action: "branches", repo: "svc", remotes: true })), /origin\/feature\/one/);
});

test("fetch reports what moved, and nothing when nothing did", async () => {
    assert.match(ok(await h.call("git", { action: "fetch", repo: "svc" })), /nothing new/);
    const other = `${h.sb.root}/other`;
    git(h.sb.root, "clone", "-q", svc.origin, other);
    commitFile(other, "new.txt", "n\n", "Teammate");
    git(other, "push", "-q", "origin", "main");
    git(other, "tag", "v1");
    git(other, "push", "-q", "origin", "v1");
    const text = ok(await h.call("git", { action: "fetch", repo: "svc" }));
    assert.match(text, /2 refs changed/);
    assert.match(text, /updated origin\/main [0-9a-f]+\.\.[0-9a-f]+/);
    assert.match(text, /new v1 [0-9a-f]+/);
});

test("a repository name that escapes the workspace or is not a work tree is refused", async () => {
    for (const repo of ["../svc", "a/b", "..", "-svc", "missing"]) {
        const result = await h.call("git", { action: "log", repo });
        assert.ok(result.error, repo);
    }
    const abs = await h.call("git", { action: "log", repo: `${h.sb.workspace}/svc/../api` });
    assert.match(abs.error?.message ?? "", /must not contain/);
});

test("a repository whose config would run a command is refused with jig-core's reason", async () => {
    h.jig.refuseGit(
        ".git/config sets credential.helper, which would run with your credentials: remove it or ask the user",
    );
    const result = await h.call("git", { action: "log", repo: "svc" });
    assert.match(result.error?.message ?? "", /credential\.helper, which would run with your credentials/);
});
