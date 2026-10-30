// The units of the ci tool that were jig-git's: the four words for a check, the checks that matter, what a failed log shows
// first, what `gh api -i` prints, and how reviews decide. The units of the new adapters are at the end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApiOutput } from "../src/ci/gh.ts";
import { reviewState } from "../src/ci/github-watch.ts";
import type { Review } from "../src/ci/github-checks.ts";
import { buildCheck, resultOf, stageCheck } from "../src/ci/jenkins-api.ts";
import { jobCheck } from "../src/ci/gitlab-api.ts";
import { cleanLog, failureExcerpt, redactLog, selectLog } from "../src/ci/logs.ts";
import { bucketOf, fromCheckRun, fromGhRow, fromStatus, judge, listChecks } from "../src/ci/model.ts";
import type { Check } from "../src/ci/model.ts";

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
        "token gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789",
        "pat github" + "_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
        "aws AK" + "IAABCDEFGHIJKLMNOP",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        "PASSWORD: hunter2hunter2",
        "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
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
    const review = (login: string, state: string): Review => ({ login, state, body: "", url: "" });
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

// ---- GitLab jobs, Jenkins builds and stages -----------------------------------------------------------------------

test("a GitLab job is pass, fail, pending or skipped; a failure that is allowed does not fail", () => {
    const job = (status: string, more: object = {}) => jobCheck({ id: 1, name: "t", status, ...more });
    assert.equal(job("success").bucket, "pass");
    assert.equal(job("failed").bucket, "fail");
    assert.deepEqual(job("failed", { allow_failure: true }), {
        name: "t",
        bucket: "pass",
        detail: "failed (allowed)",
        id: 1,
        url: undefined,
    });
    for (const status of ["canceled", "canceling"]) assert.equal(job(status).bucket, "fail", status);
    assert.equal(job("skipped").bucket, "skipped");
    for (const status of [
        "created",
        "pending",
        "running",
        "preparing",
        "scheduled",
        "manual",
        "waiting_for_resource",
    ]) {
        assert.equal(job(status).bucket, "pending", status);
    }
    assert.equal(job("something-new").bucket, "fail", "a status nobody knows is not a pass");
    assert.equal(job("failed", { failure_reason: "stuck_or_timeout_failure" }).title, "stuck_or_timeout_failure");
    assert.equal(job("failed", { failure_reason: "script_failure" }).title, undefined, "the usual reason says nothing");
});

test("a Jenkins build is judged by its result, and is pending while it runs", () => {
    const build = (result: string | null, building = result === null) => ({ number: 1, result, building });
    assert.equal(buildCheck("job", build("SUCCESS")).bucket, "pass");
    for (const result of ["FAILURE", "UNSTABLE"]) assert.equal(buildCheck("job", build(result)).bucket, "fail", result);
    assert.equal(buildCheck("job", build("ABORTED")).bucket, "fail");
    assert.equal(buildCheck("job", build("NOT_BUILT")).bucket, "skipped");
    assert.equal(buildCheck("job", build(null)).bucket, "pending");
    assert.equal(buildCheck("job", build("SUCCESS", true)).bucket, "pending", "a build still running is never a pass");
    assert.equal(resultOf(build(null)), "BUILDING");
    assert.equal(resultOf(build("FAILURE")), "FAILURE");
});

test("a pipeline stage is pass, fail, pending or skipped", () => {
    const stage = (status: string) => stageCheck({ name: "s", status }).bucket;
    assert.equal(stage("SUCCESS"), "pass");
    for (const status of ["FAILED", "UNSTABLE", "ABORTED"]) assert.equal(stage(status), "fail", status);
    assert.equal(stage("NOT_EXECUTED"), "skipped");
    for (const status of ["IN_PROGRESS", "PAUSED_PENDING_INPUT"]) assert.equal(stage(status), "pending", status);
    assert.equal(stage("SOMETHING_NEW"), "fail");
});

test("a log from any server loses terminal sequences and control characters", () => {
    assert.equal(cleanLog("a\u001b]0;title\u0007b\u0000c\u001b[2Jd\n"), "ab?cd\n");
});
