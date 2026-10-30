import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo } from "./support/repos.ts";
import type { Fixture } from "./support/repos.ts";

let h: Harness;
let counter = 0;

before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

/** A clone on a feature branch cut from origin/main, not pushed, with `commits` commits. */
function unpushed(branch: string, commits = 1, owner?: string): Fixture {
    const r = makeRepo(h.sb, `push${++counter}`, owner);
    git(r.dir, "switch", "-q", "-c", branch, "--no-track", "origin/main");
    for (let i = 1; i <= commits; i++) commitFile(r.dir, `f${i}.ts`, `${i}\n`, `Change ${i}`);
    return r;
}

const remoteSha = (r: Fixture, branch: string) => git(r.origin, "rev-parse", `refs/heads/${branch}`);
const pushes = () => h.jig.started_processes.filter((p) => p.file === "git" && p.args[0] === "push");

test("push: the preview lists the commits, branch, remote and head; the push creates the branch and sets the upstream", async () => {
    const r = unpushed("feature/p1", 2);
    const head = git(r.dir, "rev-parse", "HEAD");
    const result = await h.call("git", { action: "push", repo: r.name });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
    assert.match(result.preview?.summary ?? "", /^push feature\/p1 \([0-9a-f]{7}\) to origin: 2 commits$/);
    assert.match(
        result.preview?.body ?? "",
        /^Branch feature\/p1 at [0-9a-f]{7} to origin, creating the branch there\.\n2 commits origin does not have yet:\n {2}[0-9a-f]{7} Change 2\n {2}[0-9a-f]{7} Change 1\nForce: no\.$/,
    );
    assert.equal(result.preview?.fingerprint?.length, 32);
    assert.match(result.text, /^Pushed feature\/p1 \([0-9a-f]{7}\) from push\d+ to origin; upstream set\./);
    assert.equal(remoteSha(r, "feature/p1"), head);
    assert.equal(git(r.dir, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/p1");
    assert.deepEqual([...h.jig.facts.values()].at(-1)?.[0], { commits: 2 });
});

test("push: a branch with nothing new says so", async () => {
    const r = unpushed("feature/p2");
    git(r.dir, "push", "-q", "-u", "origin", "feature/p2");
    const result = await h.call("git", { action: "push", repo: r.name });
    assert.match(result.preview?.body ?? "", /No new commits: origin already has every commit of this branch\./);
    assert.match(result.preview?.summary ?? "", /: 0 commits$/);
    ok(result);
});

test("push: more than 20 commits are counted and the first 20 shown", async () => {
    const r = unpushed("feature/p3", 23);
    const preview = (await h.call("git", { action: "push", repo: r.name })).preview;
    assert.match(preview?.body ?? "", /23 commits origin does not have yet:/);
    assert.match(preview?.body ?? "", / {2}\.\.\. 3 more/);
});

test("push: refuses the default branch, and the branches git.protected names", async () => {
    const r = unpushed("feature/p4");
    git(r.dir, "switch", "-q", "main");
    const main = await h.call("git", { action: "push", repo: r.name });
    assert.match(
        main.error?.message ?? "",
        /refusing to push protected branch main; push a feature branch and open a pull request/,
    );
    git(r.dir, "switch", "-q", "-c", "release/1.0", "--no-track", "origin/main");
    commitFile(r.dir, "r.ts", "r\n", "Release work");
    h.jig.setSection("git", { protected: ["release/*"] });
    const release = await h.call("git", { action: "push", repo: r.name });
    assert.match(release.error?.message ?? "", /refusing to push protected branch release\/1\.0/);
    // Naming the protected branches replaces the default: now main is an ordinary branch.
    git(r.dir, "switch", "-q", "main");
    commitFile(r.dir, "m.ts", "m\n", "Work on main");
    assert.match(ok(await h.call("git", { action: "push", repo: r.name })), /^Pushed main/);
    assert.equal(pushes().filter((p) => p.cwd === r.dir).length, 1, "the refused pushes never started git");
});

test("push: a force push is only with a lease, and never to a protected branch", async () => {
    const r = unpushed("feature/p5");
    git(r.dir, "push", "-q", "-u", "origin", "feature/p5");
    git(r.dir, "reset", "-q", "--hard", "HEAD~1");
    const rewritten = commitFile(r.dir, "g.ts", "g\n", "Rewritten");
    const plain = await h.call("git", { action: "push", repo: r.name });
    assert.match(
        plain.error?.message ?? "",
        /git push failed: .*(rejected|non-fast-forward)/s,
        "without force git rejects it",
    );
    const forced = await h.call("git", { action: "push", repo: r.name, force_with_lease: true });
    assert.match(
        forced.preview?.body ?? "",
        /Force: --force-with-lease \(refused if the remote moved since it was last fetched\)\./,
    );
    assert.match(forced.text, /with --force-with-lease/);
    assert.equal(remoteSha(r, "feature/p5"), rewritten);
    git(r.dir, "switch", "-q", "main");
    assert.match(
        (await h.call("git", { action: "push", repo: r.name, force_with_lease: true })).error?.message ?? "",
        /refusing to push protected branch main/,
    );
});

test("push: a lease holds back a push when the remote moved since the last fetch", async () => {
    const r = unpushed("feature/p6");
    git(r.dir, "push", "-q", "-u", "origin", "feature/p6");
    const other = `${h.sb.root}/other-${counter}`;
    git(h.sb.root, "clone", "-q", "--branch", "feature/p6", r.origin, other);
    commitFile(other, "theirs.ts", "t\n", "Teammate");
    git(other, "push", "-q", "origin", "feature/p6");
    git(r.dir, "reset", "-q", "--hard", "HEAD~1");
    commitFile(r.dir, "mine.ts", "m\n", "Mine");
    const result = await h.call("git", { action: "push", repo: r.name, force_with_lease: true });
    assert.match(result.error?.message ?? "", /git push failed/);
    assert.equal(
        git(r.origin, "log", "-1", "--format=%s", "feature/p6"),
        "Teammate",
        "the teammate's commit is still there",
    );
});

test("push: a commit that lands after the preview is refused as changed since the preview", async () => {
    const r = unpushed("feature/p7");
    const result = await h.call(
        "git",
        { action: "push", repo: r.name },
        { between: () => void commitFile(r.dir, "late.ts", "late\n", "Late commit") },
    );
    assert.match(
        result.error?.message ?? "",
        /git push changed since the preview; run it again to see the new preview/,
    );
    assert.throws(() => git(r.origin, "rev-parse", "--verify", "refs/heads/feature/p7"), "nothing was pushed");
    ok(await h.call("git", { action: "push", repo: r.name }));
    assert.equal(remoteSha(r, "feature/p7"), git(r.dir, "rev-parse", "HEAD"));
});

test("push: without an approved preview (a rule allowed it) it still pushes exactly the current branch", async () => {
    const r = unpushed("feature/p8");
    const result = await h.call("git", { action: "push", repo: r.name }, { ask: false });
    assert.equal(result.preview, undefined);
    assert.match(ok(result), /^Pushed feature\/p8/);
});

test("push: a detached HEAD, an unknown remote and a missing branch are refused before git runs", async () => {
    const r = unpushed("feature/p9");
    assert.match(
        (await h.call("git", { action: "push", repo: r.name, remote: "fork" })).error?.message ?? "",
        /has no remote called fork/,
    );
    assert.match(
        (await h.call("git", { action: "push", repo: r.name, branch: "feature/none" })).error?.message ?? "",
        /branch feature\/none does not exist locally/,
    );
    assert.match(
        (await h.call("git", { action: "push", repo: r.name, remote: "-x" })).error?.message ?? "",
        /not a valid remote name/,
    );
    git(r.dir, "checkout", "-q", "--detach");
    assert.match(
        (await h.call("git", { action: "push", repo: r.name })).error?.message ?? "",
        /HEAD is detached in push\d+; switch to a branch before pushing/,
    );
    assert.equal(pushes().filter((p) => p.cwd === r.dir).length, 0);
});

test("push: another branch than the checked-out one can be named", async () => {
    const r = unpushed("feature/p10");
    git(r.dir, "switch", "-q", "main");
    assert.match(
        ok(await h.call("git", { action: "push", repo: r.name, branch: "feature/p10" })),
        /^Pushed feature\/p10/,
    );
    assert.equal(remoteSha(r, "feature/p10"), git(r.dir, "rev-parse", "feature/p10"));
});

test("push: a failure is one line with git's reason", async () => {
    const r = unpushed("feature/p11");
    git(r.dir, "remote", "set-url", "origin", `${h.sb.root}/remotes/nowhere.git`);
    const result = await h.call("git", { action: "push", repo: r.name });
    assert.match(
        result.error?.message ?? "",
        /^git push failed: .*(does not appear to be a git repository|Could not read from remote)/,
    );
});

// ---- a lost reply -------------------------------------------------------------------------------------------------

test("push, reply lost but the push landed: one ls-remote shows it, and nothing is pushed twice", async () => {
    const r = unpushed("feature/l1");
    h.jig.loseGitReply(
        (args) => args[0] === "push",
        { code: 128, stderr: "fatal: the remote end hung up unexpectedly\n" },
        true,
    );
    const result = await h.call("git", { action: "push", repo: r.name });
    assert.match(
        ok(result),
        /^Pushed feature\/l1 .*\(The reply was lost \(fatal: the remote end hung up unexpectedly\); one check shows origin has it\. Nothing was sent twice\.\)/,
    );
    assert.equal(pushes().length, 1, "git push ran once");
    assert.equal(
        h.jig.started_processes.filter((p) => p.args[0] === "ls-remote" && p.cwd === r.dir).length,
        1,
        "and one read checked it",
    );
    assert.equal(remoteSha(r, "feature/l1"), git(r.dir, "rev-parse", "HEAD"));
});

test("push, reply lost and the push did not land: one ls-remote shows that, and it is not retried", async () => {
    const r = unpushed("feature/l2");
    h.jig.loseGitReply((args) => args[0] === "push", { code: 128, stderr: "connection reset by peer" }, false);
    const result = await h.call("git", { action: "push", repo: r.name });
    assert.match(
        result.error?.message ?? "",
        /git push: the reply was lost \(connection reset by peer\) and origin does not have [0-9a-f]{7}\. Nothing was sent twice; push again if you still want it\./,
    );
    assert.equal(pushes().length, 1, "git push was asked for once, and not again");
    assert.throws(() => git(r.origin, "rev-parse", "--verify", "refs/heads/feature/l2"), "and it did not land");
    assert.equal(h.jig.started_processes.filter((p) => p.args[0] === "ls-remote" && p.cwd === r.dir).length, 1);
});

test("push, timed out: the same single check", async () => {
    const r = unpushed("feature/l3");
    h.jig.loseGitReply((args) => args[0] === "push", { code: 143, timedOut: true }, true);
    const text = ok(await h.call("git", { action: "push", repo: r.name }));
    assert.match(text, /\(The reply was lost \(timed out\); one check shows origin has it\./);
});

test("push, a refusal that is not a lost reply is reported as failed, with no check", async () => {
    const r = unpushed("feature/l4");
    h.jig.loseGitReply(
        (args) => args[0] === "push",
        { code: 1, stderr: "remote: Permission to acme/svc denied to someone.\nfatal: unable to access" },
        false,
    );
    const result = await h.call("git", { action: "push", repo: r.name });
    assert.match(
        result.error?.message ?? "",
        /^git push failed: remote: Permission to acme\/svc denied to someone\.; fatal: unable to access$/,
    );
    assert.equal(h.jig.started_processes.filter((p) => p.args[0] === "ls-remote").length, 0);
});

// ---- the watch that starts after a push ---------------------------------------------------------------------------

test("push starts a watch on the required checks of the pushed head, titled by branch and commit", async () => {
    const r = unpushed("feature/w1", 1, "acme");
    h.gh.on("pr list", { json: [] });
    const text = ok(await h.call("git", { action: "push", repo: r.name }));
    const head = git(r.dir, "rev-parse", "HEAD");
    assert.equal(h.jig.started.length, 1);
    const started = h.jig.started[0];
    assert.equal(started?.kind, "github");
    assert.equal(started?.title, `checks of branch feature/w1 at ${head.slice(0, 7)}`);
    assert.deepEqual(started?.spec, {
        repo: "acme/" + r.name,
        branch: "feature/w1",
        sha: head,
        finish: { kind: "required" },
    });
    assert.equal(started?.timeoutMinutes, 60);
    assert.equal(started?.stallMinutes, 30);
    assert.match(text, new RegExp(`Watching checks of branch feature/w1 at ${head.slice(0, 7)} as w1\\.$`));
});

test("push starts the watch on the pull request when one is open for the branch", async () => {
    const r = unpushed("feature/w2", 1, "acme");
    h.gh.on("pr list", { json: [{ number: 42 }] });
    const text = ok(await h.call("git", { action: "push", repo: r.name }));
    assert.equal(h.jig.started[0]?.title, "checks of pull request 42");
    assert.equal((h.jig.started[0]?.spec as { pr?: number }).pr, 42);
    assert.match(text, /Watching checks of pull request 42 as w1\.$/);
    assert.deepEqual(h.gh.callsOf("pr list")[0]?.args.slice(0, 8), [
        "pr",
        "list",
        "--head",
        "feature/w2",
        "--state",
        "open",
        "--limit",
        "1",
    ]);
});

test("a later push to the same branch replaces the watch of the earlier commit", async () => {
    const r = unpushed("feature/w3", 1, "acme");
    h.gh.on("pr list", { json: [] });
    ok(await h.call("git", { action: "push", repo: r.name }));
    commitFile(r.dir, "more.ts", "m\n", "More");
    ok(await h.call("git", { action: "push", repo: r.name }));
    assert.equal(h.jig.started.length, 2);
    assert.deepEqual(h.jig.stopped, ["w1"]);
});

test("no watch starts when git.watch.auto is off, or when origin is not on GitHub", async () => {
    const r = unpushed("feature/w4", 1, "acme");
    h.jig.setSection("git", { watch: { auto: false } });
    assert.doesNotMatch(ok(await h.call("git", { action: "push", repo: r.name })), /Watching/);
    const local = unpushed("feature/w5");
    assert.doesNotMatch(ok(await h.call("git", { action: "push", repo: local.name })), /Watching/);
    assert.equal(h.jig.started.length, 0);
});

test("git.watch carries its limits into the watch", async () => {
    const r = unpushed("feature/w6", 1, "acme");
    h.gh.on("pr list", { json: [] });
    h.jig.setSection("git", { watch: { timeoutMinutes: 15, stallMinutes: 5 } });
    ok(await h.call("git", { action: "push", repo: r.name }));
    assert.deepEqual([h.jig.started[0]?.timeoutMinutes, h.jig.started[0]?.stallMinutes], [15, 5]);
});
