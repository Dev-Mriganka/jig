import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketOf, count, describeCounts, fromRollup } from "../src/ci.ts";
import { prNumberFromUrl } from "../src/github.ts";
import { checkParams } from "../src/params.ts";
import { parseRemote, parseWorktrees } from "../src/repo.ts";
import { scrub, summaryOf } from "../src/run.ts";
import { clip, firstLines, lines, mapPool, plural } from "../src/text.ts";

// ---- remotes and work trees ---------------------------------------------------------------------------------------

test("a remote URL gives its host, owner and name, in every form git accepts", () => {
    const acme = { owner: "acme", name: "svc", slug: "acme/svc" };
    for (const [url, host] of [
        ["https://github.com/acme/svc.git", "github.com"],
        ["https://github.com/acme/svc", "github.com"],
        ["https://github.com/acme/svc/", "github.com"],
        ["https://user:token@github.com/acme/svc.git", "github.com"],
        ["git@github.com:acme/svc.git", "github.com"],
        ["git@gh-work:acme/svc", "gh-work"],
        ["ssh://git@github.com/acme/svc.git", "github.com"],
        ["ssh://git@ssh.github.com:443/acme/svc.git", "ssh.github.com"],
        ["git://github.com/acme/svc.git", "github.com"],
    ] as const) {
        assert.deepEqual(parseRemote(url), { host, ...acme }, url);
    }
    for (const bad of [undefined, "", "/srv/git/svc.git", "../svc", "file:///srv/svc.git", "svc"])
        assert.equal(parseRemote(bad), undefined, String(bad));
});

test("the work trees git lists skip prunable and bare entries", () => {
    const porcelain = [
        "worktree /repos/svc",
        "HEAD 1111111",
        "branch refs/heads/main",
        "",
        "worktree /repos/svc-wt",
        "HEAD 2222222",
        "branch refs/heads/feature/x",
        "",
        "worktree /repos/old.git",
        "bare",
        "",
        "worktree /repos/gone",
        "HEAD 3333333",
        "branch refs/heads/feature/y",
        "prunable gitdir file points to non-existent location",
        "",
    ].join("\n");
    assert.deepEqual(parseWorktrees(porcelain), ["/repos/svc", "/repos/svc-wt"]);
});

test("credentials are taken out of anything that is shown", () => {
    assert.equal(
        scrub("fatal: unable to access 'https://user:tok-SECRET@example.com/x'"),
        "fatal: unable to access 'https://example.com/x'",
    );
    assert.equal(summaryOf("a\n\n  b  \nc\nd"), "a; b; c");
    assert.equal(summaryOf("x".repeat(500)).length, 403);
});

// ---- what gh prints ------------------------------------------------------------------------------------------------

test("the number of a pull request is the last /pull/<n> in what gh printed", () => {
    assert.equal(prNumberFromUrl("https://github.com/acme/svc/pull/77\n"), 77);
    assert.equal(
        prNumberFromUrl("Creating...\nhttps://github.com/acme/svc/pull/7\nhttps://github.com/acme/svc/pull/78"),
        78,
    );
    assert.equal(prNumberFromUrl("no url"), undefined);
});

// ---- check states -------------------------------------------------------------------------------------------------

test("a check is pass, fail, pending or skipped; running is never a pass and cancelled is a failure", () => {
    assert.equal(bucketOf("completed", "success"), "pass");
    assert.equal(bucketOf("COMPLETED", "NEUTRAL"), "pass");
    assert.equal(bucketOf("completed", "skipped"), "skipped");
    for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"])
        assert.equal(bucketOf("completed", conclusion), "fail", conclusion);
    for (const status of ["queued", "in_progress", "waiting", "pending"])
        assert.equal(bucketOf(status, undefined), "pending", status);
    assert.equal(bucketOf("completed", undefined), "pending", "completed without a conclusion is not a pass");
    assert.equal(bucketOf("completed", "something-new"), "fail", "an outcome nobody knows is not a pass");
});

test("the roll-up of a pull request becomes the same four words, and counts into one line", () => {
    assert.equal(
        fromRollup({ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SUCCESS" }).bucket,
        "pass",
    );
    assert.equal(fromRollup({ __typename: "StatusContext", context: "b", state: "PENDING" }).bucket, "pending");
    assert.equal(fromRollup({ __typename: "StatusContext", context: "b", state: "FAILURE" }).bucket, "fail");
    assert.equal(
        fromRollup({ __typename: "CheckRun", name: "a", status: "IN_PROGRESS", conclusion: "" }).bucket,
        "pending",
    );
    assert.deepEqual(
        fromRollup({
            __typename: "CheckRun",
            name: "lint",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "u",
        }),
        {
            name: "lint",
            bucket: "fail",
            detail: "failure",
            url: "u",
        },
    );
    const counts = count([
        { name: "a", bucket: "pass" },
        { name: "b", bucket: "fail" },
        { name: "c", bucket: "pending" },
        { name: "d", bucket: "skipped" },
        { name: "e", bucket: "pass" },
    ]);
    assert.equal(describeCounts(counts), "2 pass, 1 fail, 1 pending, 1 skipped");
});

// ---- parameters and text ------------------------------------------------------------------------------------------

const TABLE = {
    commit: { summary: "commit", required: ["message"], optional: ["repo", "paths"] },
    status: { summary: "status" },
};

test("the parameters of a call are checked against the table, with the usage line in every message", () => {
    assert.equal(checkParams("git", TABLE, { action: "commit", message: "m", repo: "x" }), "commit");
    assert.equal(
        checkParams("git", TABLE, { action: "commit", message: "m", paths: undefined }),
        "commit",
        "undefined counts as absent",
    );
    assert.throws(
        () => checkParams("git", TABLE, { action: "commit" }),
        /^Error: git commit needs message\. Usage: git commit \{message, repo\?, paths\?\}$/,
    );
    assert.throws(
        () => checkParams("git", TABLE, { action: "commit", message: "m", force: true }),
        /^Error: git commit does not use force\. Usage: git commit \{message, repo\?, paths\?\}$/,
    );
    assert.throws(
        () => checkParams("git", TABLE, { action: "status", repo: "x" }),
        /^Error: git status does not use repo\. Usage: git status \{\}$/,
    );
    assert.throws(
        () => checkParams("git", TABLE, { action: "drop" }),
        /^Error: git: unknown action "drop"; use one of commit, status$/,
    );
    assert.throws(
        () => checkParams("git", TABLE, { action: "toString" }),
        /unknown action "toString"/,
        "a name from the prototype is not an action",
    );
    assert.throws(() => checkParams("git", TABLE, {}), /unknown action "undefined"/);
});

test("small text helpers", () => {
    assert.equal(clip("abcdef", 3), "abc...");
    assert.equal(clip("abc", 3), "abc");
    assert.deepEqual(firstLines("a\nb\nc\n", 2), { text: "a\nb", cut: 1 });
    assert.deepEqual(firstLines("a", 5), { text: "a", cut: 0 });
    assert.equal(plural(1, "file"), "1 file");
    assert.equal(plural(2, "file"), "2 files");
    assert.equal(lines("a", false, undefined, "", "b"), "a\nb");
});

test("mapPool keeps the order of the results and never runs more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    const out = await mapPool([30, 10, 20, 5, 15], 2, async (ms) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, ms));
        running--;
        return ms * 2;
    });
    assert.deepEqual(out, [60, 20, 40, 10, 30]);
    assert.equal(most, 2);
    assert.deepEqual(await mapPool([], 4, async (x) => x), []);
});
