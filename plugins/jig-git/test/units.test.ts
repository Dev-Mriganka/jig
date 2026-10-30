import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketOf, fromCheckRun, fromGhRow, fromRollup, fromStatus, judge, listChecks } from "../src/ci.ts";
import type { Check } from "../src/ci.ts";
import { parseApiOutput, prNumberFromUrl } from "../src/github.ts";
import { cleanLog, failureExcerpt, redactLog, selectLog } from "../src/logs.ts";
import { checkParams } from "../src/params.ts";
import { parseRemote, parseWorktrees } from "../src/repo.ts";
import { scrub, summaryOf } from "../src/run.ts";
import { clip, firstLines, lastLines, lines, mapPool, plural } from "../src/text.ts";
import { reviewState } from "../src/watch.ts";

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

// ---- what gh prints for gh api -i ---------------------------------------------------------------------------------

test("gh api -i: the status, the headers in lower case, and the body", () => {
    const ok = parseApiOutput({
        code: 0,
        stdout: 'HTTP/2.0 200 OK\nContent-Type: application/json\nEtag: W/"abc"\nX-Poll-Interval: 60\n\n{"a":1}\n\n{"b":2}',
        stderr: "",
        timedOut: false,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.headers, { "content-type": "application/json", etag: 'W/"abc"', "x-poll-interval": "60" });
    assert.equal(ok.body, '{"a":1}\n\n{"b":2}', "a blank line inside the body is kept");
    const crlf = parseApiOutput({
        code: 0,
        stdout: "HTTP/1.1 200 OK\r\nEtag: x\r\n\r\n[]",
        stderr: "",
        timedOut: false,
    });
    assert.deepEqual([crlf.status, crlf.headers.etag, crlf.body], [200, "x", "[]"]);
});

test("gh api -i: a 304 and a 404 are answers with a status, though gh exits with 1", () => {
    const unchanged = parseApiOutput({
        code: 1,
        stdout: 'HTTP/1.1 304 Not Modified\nEtag: W/"v1"\nX-Poll-Interval: 60\n\n',
        stderr: "gh: HTTP 304\n",
        timedOut: false,
    });
    assert.deepEqual([unchanged.status, unchanged.headers.etag, unchanged.body], [304, 'W/"v1"', ""]);
    const missing = parseApiOutput({
        code: 1,
        stdout: 'HTTP/1.1 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}',
        stderr: "gh: Not Found (HTTP 404)\n",
        timedOut: false,
    });
    assert.deepEqual([missing.status, missing.body], [404, '{"message":"Not Found"}']);
});

test("gh api -i: with no status line the status comes from the complaint, or is 0 when there was no answer", () => {
    assert.equal(
        parseApiOutput({ code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)\n", timedOut: false }).status,
        401,
    );
    assert.equal(
        parseApiOutput({
            code: 1,
            stdout: "",
            stderr: 'Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host',
            timedOut: false,
        }).status,
        0,
    );
    assert.equal(parseApiOutput({ code: 0, stdout: "[]", stderr: "", timedOut: false }).status, 200);
});

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

test("each source of checks becomes the same shape", () => {
    assert.deepEqual(
        fromCheckRun({
            id: 5,
            name: "build",
            status: "completed",
            conclusion: "failure",
            html_url: "u",
            output: { title: "T" },
        }),
        { name: "build", bucket: "fail", detail: "failure", url: "u", id: 5, title: "T" },
    );
    assert.deepEqual(fromStatus({ context: "ci/x", state: "pending", target_url: "t", description: "d" }), {
        name: "ci/x",
        bucket: "pending",
        detail: "pending",
        url: "t",
        title: "d",
    });
    assert.equal(fromStatus({ context: "ci/x", state: "error" }).bucket, "fail");
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
    for (const [bucket, expected] of [
        ["pass", "pass"],
        ["fail", "fail"],
        ["pending", "pending"],
        ["skipping", "skipped"],
        ["cancel", "fail"],
    ] as const)
        assert.equal(fromGhRow({ name: "x", bucket }).bucket, expected, bucket);
});

test("the checks that matter pass when they all pass, and fail at the first failure", () => {
    const check = (name: string, bucket: Check["bucket"]): Check => ({ name, bucket });
    assert.equal(judge([], []).verdict, "pending", "nothing reported is not a pass");
    assert.equal(judge([check("a", "pass"), check("b", "skipped")], []).verdict, "pass");
    assert.equal(judge([check("a", "pass"), check("b", "pending")], []).verdict, "pending");
    assert.equal(
        judge([check("a", "pass")], ["a", "b"]).verdict,
        "pending",
        "a required check no one has reported is pending",
    );
    assert.deepEqual(judge([check("a", "pass")], ["a", "b"]).missing, ["b"]);
    assert.equal(
        judge([check("a", "pass"), check("b", "fail"), check("c", "pending")], ["a", "b", "c"]).verdict,
        "fail",
        "the first failure decides",
    );
    assert.equal(
        judge([check("a", "pass"), check("x", "fail")], ["a"]).verdict,
        "pass",
        "a check that is not required cannot fail the watch",
    );
});

test("checks are listed failing first, then pending, passing and skipped", () => {
    const text = listChecks([
        { name: "z", bucket: "pass" },
        { name: "b", bucket: "skipped" },
        { name: "a", bucket: "fail", url: "u" },
        { name: "c", bucket: "pending" },
    ]);
    assert.equal(text, "fail     a u\npending  c\npass     z\nskipped  b");
    assert.match(
        listChecks(Array.from({ length: 70 }, (_, i) => ({ name: `c${i}`, bucket: "pass" as const }))),
        /\n\.\.\. 10 more$/,
    );
});

// ---- job logs -----------------------------------------------------------------------------------------------------

test("a log loses its time stamps, colour codes and carriage returns", () => {
    assert.equal(
        cleanLog("﻿2026-10-30T10:00:00.1234567Z \u001b[31mred\u001b[0m\r\n2026-10-30T10:00:01Z plain\n"),
        "red\nplain\n",
    );
});

test("what looks like a credential is replaced, and ordinary text is left alone", () => {
    const text = [
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "pat github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
        "aws AKIAABCDEFGHIJKLMNOP",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        "PASSWORD: hunter2hunter2",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "normal line with token words but no value",
        "TOKEN=***",
    ].join("\n");
    const out = redactLog(text);
    for (const secret of [
        "ghp_abc",
        "github_pat_11",
        "AKIAABC",
        "abcdefghijklmnopqrstuvwxyz012345",
        "eyJhbGci",
        "wJalrXUtn",
        "hunter2",
        "MIIEow",
    ])
        assert.ok(!out.includes(secret), secret);
    assert.match(out, /normal line with token words but no value/);
    assert.match(out, /TOKEN=\*\*\*/, "a value GitHub already masked is left as it is");
    assert.match(out, /\[redacted private key\]/);
});

test("the part of a failed log worth reading is the lines before the first error, or the end of the log", () => {
    const log = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    log[29] = "##[error]Process completed with exit code 1.";
    const excerpt = failureExcerpt(log.join("\n")).split("\n");
    assert.equal(excerpt.at(-3), "##[error]Process completed with exit code 1.");
    assert.equal(excerpt.at(-1), "line 32");
    assert.equal(excerpt.length, 20);
    const quiet = failureExcerpt(Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")).split("\n");
    assert.deepEqual([quiet[0], quiet.at(-1), quiet.length], ["line 31", "line 50", 20]);
    assert.ok(failureExcerpt("x".repeat(5000)).length <= 2003);
});

test("a log is cut to its tail or to the lines that match, never to more than 400", () => {
    const log = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}${i % 100 === 0 ? " MARK" : ""}`).join("\n");
    assert.deepEqual(selectLog(log, { tail: 3 }), {
        text: "line 998\nline 999\nline 1000",
        note: "the last 3 lines; 997 earlier lines left out",
    });
    assert.equal(selectLog(log, {}).text.split("\n").length, 80);
    assert.equal(selectLog(log, { tail: 9999 }).text.split("\n").length, 400);
    assert.deepEqual(selectLog(log, { grep: "mark" }).note, "10 matching lines");
    assert.equal(selectLog(log, { grep: "mark" }).text.split("\n")[1], "101: line 101 MARK");
    assert.equal(selectLog(log, { grep: "line" }).text.split("\n").length, 400);
    assert.match(selectLog(log, { grep: "line" }).note, /1000 matching lines, the first 400 shown/);
    assert.equal(selectLog("short log", {}).note, "the whole log");
});

// ---- reviews ------------------------------------------------------------------------------------------------------

test("the latest review of each person decides; a plain comment decides nothing", () => {
    const review = (login: string, state: string) => ({ login, state, body: "", url: "" });
    const result = reviewState([
        review("a", "APPROVED"),
        review("a", "CHANGES_REQUESTED"),
        review("b", "APPROVED"),
        review("c", "CHANGES_REQUESTED"),
        review("c", "COMMENTED"),
        review("", "APPROVED"),
    ]);
    assert.deepEqual(
        result.approved.map((r) => r.login),
        ["b"],
    );
    assert.deepEqual(
        result.changes.map((r) => r.login),
        ["a", "c"],
    );
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
    assert.deepEqual(lastLines("a\nb\nc\n", 2), { text: "b\nc", cut: 1 });
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
