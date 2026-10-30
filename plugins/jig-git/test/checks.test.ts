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

function repo(): Fixture {
    const r = makeRepo(h.sb, `ci${++counter}`, "acme");
    git(r.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    commitFile(r.dir, "x.ts", "x\n", "Add x");
    return r;
}

const SHA = "a".repeat(40);
const slug = (r: Fixture) => `acme/${r.name}`;

// ---- status -------------------------------------------------------------------------------------------------------

test("status of a pull request: failing first, then pending, passing and skipped; gh's non-zero exit is not an error", async () => {
    const r = repo();
    h.gh.on("pr checks", {
        code: 8,
        json: [
            { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://ci/lint" },
            { name: "deploy", state: "PENDING", bucket: "pending", link: "https://ci/deploy" },
            { name: "unit", state: "FAILURE", bucket: "fail", link: "https://ci/unit" },
            { name: "docs", state: "SKIPPED", bucket: "skipping", link: "" },
            { name: "e2e", state: "CANCELLED", bucket: "cancel", link: "" },
        ],
    });
    const text = ok(await h.call("checks", { action: "status", repo: r.name, number: 42 }));
    assert.match(
        text,
        /^pull request 42: 1 pass, 2 fail, 1 pending, 1 skipped\nfail {5}e2e\nfail {5}unit https:\/\/ci\/unit\npending {2}deploy https:\/\/ci\/deploy\npass {5}lint https:\/\/ci\/lint\nskipped {2}docs$/,
    );
    assert.deepEqual(h.gh.calls()[0]?.args, [
        "pr",
        "checks",
        "42",
        "--json",
        "name,state,bucket,link,workflow",
        "-R",
        slug(r),
    ]);
    assert.deepEqual([...h.jig.facts.values()].at(-1)?.[0], { pass: 1, fail: 2, pending: 1, skipped: 1 });
});

test("status: required_only asks gh for the required checks; no checks says so; an error is one line", async () => {
    const r = repo();
    h.gh.on("pr checks", { json: [{ name: "build", state: "SUCCESS", bucket: "pass", link: "" }] });
    const text = ok(await h.call("checks", { action: "status", repo: r.name, number: 42, required_only: true }));
    assert.match(text, /^pull request 42 \(required checks\): 1 pass/);
    assert.ok(h.gh.calls()[0]?.args.includes("--required"));
    h.gh.on("pr checks", { code: 1, stderr: "no checks reported on the 'feature/one' branch\n" });
    assert.match(ok(await h.call("checks", { action: "status", repo: r.name, number: 42 })), /no checks reported\./);
    h.gh.on("pr checks", { code: 1, stderr: "HTTP 500\n" });
    assert.match(
        (await h.call("checks", { action: "status", repo: r.name, number: 42 })).error?.message ?? "",
        /^gh pr checks failed: HTTP 500$/,
    );
});

const RUNS = {
    total_count: 3,
    check_runs: [
        {
            id: 11,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/svc/actions/runs/1/job/11",
        },
        {
            id: 12,
            name: "unit",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/acme/svc/actions/runs/1/job/12",
        },
        { id: 13, name: "e2e", status: "in_progress", conclusion: null, html_url: "u" },
    ],
};

test("status of a branch or a commit: the check runs and the commit statuses, through the API", async () => {
    const r = repo();
    h.gh.on("api", { json: RUNS }, ["check-runs"]);
    h.gh.on(
        "api",
        { json: { statuses: [{ context: "legacy/ci", state: "success", target_url: "https://legacy/1" }] } },
        ["/status"],
    );
    const text = ok(await h.call("checks", { action: "status", repo: r.name }));
    assert.match(
        text,
        /^branch feature\/one: 2 pass, 1 fail, 1 pending, 0 skipped\nfail {5}unit https:\/\/github\.com\/acme\/svc\/actions\/runs\/1\/job\/12\npending {2}e2e u\npass {5}build/,
    );
    assert.match(text, /pass {5}legacy\/ci https:\/\/legacy\/1/);
    assert.ok(h.gh.calls().some((call) => call.args.some((arg) => arg.includes("commits/feature%2Fone/check-runs"))));
    const bySha = ok(await h.call("checks", { action: "status", repo: r.name, sha: SHA }));
    assert.match(bySha, new RegExp(`^commit ${"a".repeat(7)}: `));
});

test("status of a branch with required_only keeps the checks branch protection requires", async () => {
    const r = repo();
    h.gh.on("api", { json: RUNS }, ["check-runs"]);
    h.gh.on("api", { json: { statuses: [] } }, ["/status"]);
    h.gh.on("api", { json: { default_branch: "main" } }, [`=repos/${slug(r)}`]);
    h.gh.on(
        "api",
        { json: { protection: { required_status_checks: { contexts: ["build"], checks: [{ context: "unit" }] } } } },
        ["branches/main"],
    );
    h.gh.on("api", { json: [] }, ["rules/branches/main"]);
    const text = ok(await h.call("checks", { action: "status", repo: r.name, required_only: true }));
    assert.match(text, /^branch feature\/one \(required checks\): 1 pass, 1 fail, 0 pending, 0 skipped\n/);
    assert.doesNotMatch(text, /e2e/);
});

test("status: with nothing required configured, all checks are shown and the answer says so", async () => {
    const r = repo();
    h.gh.on("api", { json: RUNS }, ["check-runs"]);
    h.gh.on("api", { json: { statuses: [] } }, ["/status"]);
    h.gh.on("api", { json: { default_branch: "main" } }, [`=repos/${slug(r)}`]);
    h.gh.on("api", { status: 404, stderr: "Not Found", json: { message: "Branch not protected" } }, ["branches/main"]);
    h.gh.on("api", { json: [] }, ["rules/branches/main"]);
    const text = ok(await h.call("checks", { action: "status", repo: r.name, required_only: true }));
    assert.match(text, /e2e/);
    assert.match(text, /No required checks are configured for the default branch, so all checks are shown\.$/);
});

test("status takes one of number, branch or sha", async () => {
    const r = repo();
    assert.match(
        (await h.call("checks", { action: "status", repo: r.name, sha: SHA, branch: "x" })).error?.message ?? "",
        /takes one of number, branch or sha/,
    );
});

// ---- runs, run, artifacts -----------------------------------------------------------------------------------------

test("runs: one line per run with its outcome; filters become gh options", async () => {
    const r = repo();
    h.gh.on("run list", {
        json: [
            {
                databaseId: 101,
                name: "ci",
                workflowName: "CI",
                status: "completed",
                conclusion: "failure",
                headBranch: "feature/one",
                headSha: SHA,
                event: "push",
                createdAt: "2026-10-30T10:00:00Z",
                url: "u",
            },
            {
                databaseId: 100,
                name: "ci",
                workflowName: "CI",
                status: "in_progress",
                conclusion: "",
                headBranch: "feature/one",
                headSha: SHA,
                event: "push",
                createdAt: "2026-10-30T09:00:00Z",
                url: "u",
            },
        ],
    });
    const text = ok(
        await h.call("checks", { action: "runs", repo: r.name, branch: "feature/one", state: "failure", limit: 5 }),
    );
    assert.match(
        text,
        /^svc|^ci\d+: 2 runs\n#101 failure {4}CI {2}feature\/one aaaaaaa {2}push {2}2026-10-30T10:00\n#100 in_progress CI/,
    );
    const args = h.gh.calls()[0]?.args ?? [];
    assert.equal(args[args.indexOf("--branch") + 1], "feature/one");
    assert.equal(args[args.indexOf("--status") + 1], "failure");
    assert.equal(args[args.indexOf("--limit") + 1], "5");
    assert.match(
        (await h.call("checks", { action: "runs", repo: r.name, state: "weird" })).error?.message ?? "",
        /state must be one of queued/,
    );
    h.gh.on("run list", { json: [] });
    assert.match(ok(await h.call("checks", { action: "runs", repo: r.name })), /No workflow runs match/);
});

test("run: the jobs, and the steps of a job that did not pass", async () => {
    const r = repo();
    h.gh.on("run view", {
        json: {
            databaseId: 101,
            name: "ci",
            workflowName: "CI",
            status: "completed",
            conclusion: "failure",
            headBranch: "feature/one",
            headSha: SHA,
            event: "push",
            url: "https://github.com/acme/svc/actions/runs/101",
            jobs: [
                {
                    databaseId: 11,
                    name: "build",
                    status: "completed",
                    conclusion: "success",
                    url: "u",
                    steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }],
                },
                {
                    databaseId: 12,
                    name: "unit",
                    status: "completed",
                    conclusion: "failure",
                    url: "u",
                    steps: [
                        { name: "Checkout", status: "completed", conclusion: "success", number: 1 },
                        { name: "npm test", status: "completed", conclusion: "failure", number: 2 },
                    ],
                },
            ],
        },
    });
    const text = ok(await h.call("checks", { action: "run", repo: r.name, run_id: 101 }));
    assert.equal(
        text,
        [
            "Run #101 CI: failure",
            `feature/one at ${"a".repeat(7)}, push; https://github.com/acme/svc/actions/runs/101`,
            "success    build (job 11)",
            "failure    unit (job 12)",
            "    step 2 npm test: failure",
        ].join("\n"),
    );
});

test("artifacts: name, size, date and whether it expired", async () => {
    const r = repo();
    h.gh.on("api", {
        json: {
            total_count: 2,
            artifacts: [
                { name: "dist", size_in_bytes: 20480, expired: false, created_at: "2026-10-30T10:00:00Z" },
                { name: "old", size_in_bytes: 1024, expired: true, created_at: "2026-09-01T10:00:00Z" },
            ],
        },
    });
    const text = ok(await h.call("checks", { action: "artifacts", repo: r.name, run_id: 101 }));
    assert.equal(text, "Run #101: 2 artifacts\ndist  20 KiB  2026-10-30T10:00\nold  1 KiB  2026-09-01T10:00  expired");
    assert.ok(h.gh.calls()[0]?.args.includes(`repos/${slug(r)}/actions/runs/101/artifacts?per_page=100`));
    h.gh.on("api", { json: { total_count: 0, artifacts: [] } });
    assert.match(
        ok(await h.call("checks", { action: "artifacts", repo: r.name, run_id: 101 })),
        /Run #101 has no artifacts\./,
    );
});

// ---- log ----------------------------------------------------------------------------------------------------------

const JOBS = {
    json: {
        databaseId: 101,
        name: "ci",
        status: "completed",
        conclusion: "failure",
        headBranch: "feature/one",
        headSha: SHA,
        event: "push",
        createdAt: "",
        url: "",
        jobs: [
            { databaseId: 11, name: "build", status: "completed", conclusion: "success", url: "" },
            { databaseId: 12, name: "unit tests", status: "completed", conclusion: "failure", url: "" },
        ],
    },
};

function jobLog(): string {
    const lines = Array.from(
        { length: 600 },
        (_, i) => `2026-10-30T10:00:${String(i % 60).padStart(2, "0")}.0000000Z line ${i + 1}`,
    );
    lines[598] = "2026-10-30T10:01:00.0000000Z \u001b[31m##[error]\u001b[0mProcess completed with exit code 1.";
    lines[10] = "2026-10-30T10:00:11.0000000Z export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 done";
    return `${lines.join("\n")}\n`;
}

test("log: the tail of the first failed job's log, without time stamps or colour, and scrubbed", async () => {
    const r = repo();
    h.gh.on("run view", JOBS);
    h.gh.on("api", { stdout: jobLog() }, ["actions/jobs/12/logs"]);
    const text = ok(await h.call("checks", { action: "log", repo: r.name, run_id: 101 }));
    const lines = text.split("\n");
    assert.equal(lines[0], "Run #101, job unit tests (failure): the last 80 lines; 520 earlier lines left out");
    assert.equal(lines.length, 81);
    assert.equal(lines.at(-1), "line 600");
    assert.doesNotMatch(text, /\u001b|2026-10-30T/);
    assert.match(lines.at(-2) ?? "", /^##\[error\]Process completed with exit code 1\.$/);
});

test("log: lines matching a search, with their line numbers, scrubbed of credentials", async () => {
    const r = repo();
    h.gh.on("run view", JOBS);
    h.gh.on("api", { stdout: jobLog() }, ["actions/jobs/12/logs"]);
    const text = ok(await h.call("checks", { action: "log", repo: r.name, run_id: 101, grep: "token|error" }));
    assert.match(
        text,
        /^Run #101, job unit tests \(failure\): 2 matching lines\n11: export TOKEN=\[redacted\] done\n599: ##\[error\]Process completed with exit code 1\.$/,
    );
    assert.doesNotMatch(text, /ghp_/);
    assert.match(
        ok(await h.call("checks", { action: "log", repo: r.name, run_id: 101, grep: "zzz-no-match" })),
        /no line matches zzz-no-match$/,
    );
    assert.match(
        (await h.call("checks", { action: "log", repo: r.name, run_id: 101, grep: "(" })).error?.message ?? "",
        /grep is not a valid regular expression/,
    );
});

test("log: never more than 400 lines, a named job, and a job that is not there", async () => {
    const r = repo();
    h.gh.on("run view", JOBS);
    h.gh.on("api", { stdout: jobLog() }, ["actions/jobs/11/logs"]);
    const text = ok(await h.call("checks", { action: "log", repo: r.name, run_id: 101, job: "build", tail: 400 }));
    assert.equal(text.split("\n").length, 401);
    assert.match(text.split("\n")[0] ?? "", /job build \(success\): the last 400 lines/);
    const missing = await h.call("checks", { action: "log", repo: r.name, run_id: 101, job: "deploy" });
    assert.match(
        missing.error?.message ?? "",
        /run 101 has no job called deploy; its jobs: build \(success\), unit tests \(failure\)/,
    );
});

test("log: without a run, the newest failed run of the branch; a run with no failed job is said so; an expired log too", async () => {
    const r = repo();
    h.gh.on("run list", { json: [{ databaseId: 101 }] });
    h.gh.on("run view", JOBS);
    h.gh.on("api", { code: 1, stderr: "gh: Gone (HTTP 410)\n" }, ["actions/jobs/12/logs"]);
    const expired = await h.call("checks", { action: "log", repo: r.name });
    assert.match(expired.error?.message ?? "", /the log of job 12 is not available/);
    const list = h.gh.callsOf("run list")[0]?.args ?? [];
    assert.deepEqual(list.slice(0, 8), ["run", "list", "--status", "failure", "--limit", "1", "--json", "databaseId"]);
    assert.equal(list[list.indexOf("--branch") + 1], "feature/one");
    h.gh.on("run view", {
        json: {
            ...JOBS.json,
            conclusion: "success",
            jobs: [{ databaseId: 11, name: "build", status: "completed", conclusion: "success", url: "" }],
        },
    });
    assert.match(
        (await h.call("checks", { action: "log", repo: r.name, run_id: 100 })).error?.message ?? "",
        /run 100 has no failed job; its jobs: build \(success\)/,
    );
    h.gh.on("run list", { json: [] });
    assert.match((await h.call("checks", { action: "log", repo: r.name })).error?.message ?? "", /no failed run found/);
});

// ---- rerun --------------------------------------------------------------------------------------------------------

test("rerun: the failed jobs by default; asks; the whole run when asked; a running run is refused", async () => {
    const r = repo();
    h.gh.on("run view", { json: { name: "CI", status: "completed", attempt: 1, headBranch: "feature/one" } });
    h.gh.on("run rerun", { stdout: "" });
    const result = await h.call("checks", { action: "rerun", repo: r.name, run_id: 101 });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
    assert.match(result.preview?.summary ?? "", /^rerun the failed jobs of run 101 \(CI, feature\/one\) in ci\d+$/);
    assert.deepEqual(h.gh.callsOf("run rerun")[0]?.args, ["run", "rerun", "101", "--failed", "-R", slug(r)]);
    assert.match(result.text, /^Started a rerun of the failed jobs of run #101 \(CI\)/);
    ok(await h.call("checks", { action: "rerun", repo: r.name, run_id: 101, failed_only: false }));
    assert.deepEqual(h.gh.callsOf("run rerun")[1]?.args, ["run", "rerun", "101", "-R", slug(r)]);
    h.gh.on("run view", { json: { name: "CI", status: "in_progress", attempt: 1, headBranch: "feature/one" } });
    assert.match(
        (await h.call("checks", { action: "rerun", repo: r.name, run_id: 101 })).error?.message ?? "",
        /run 101 is in_progress; a run can be rerun once it has completed/,
    );
});

test("rerun, the reply was lost: the attempt number says whether it started; nothing is rerun twice", async () => {
    const r = repo();
    h.gh.on("run view", [
        { json: { name: "CI", status: "completed", attempt: 1, headBranch: "b" } },
        { json: { name: "CI", status: "completed", attempt: 1, headBranch: "b" } },
        { json: { name: "CI", status: "queued", attempt: 2, headBranch: "b" } },
    ]);
    h.gh.on("run rerun", { code: 1, stderr: "HTTP 503 Service Unavailable\n" });
    assert.match(
        ok(await h.call("checks", { action: "rerun", repo: r.name, run_id: 101 })),
        /one check shows it went through/,
    );
    assert.equal(h.gh.callsOf("run rerun").length, 1);
});

// ---- watch --------------------------------------------------------------------------------------------------------

test("watch on a pull request: the head is fixed now, the watch starts at once, and its id comes back", async () => {
    const r = repo();
    h.gh.on("pr view", { json: { headRefOid: SHA, headRefName: "feature/one" } });
    const result = await h.call("checks", { action: "watch", repo: r.name, number: 42 });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["local", "write"]);
    assert.equal(result.preview, undefined, "a local write does not ask");
    assert.deepEqual(h.jig.started[0]?.spec, {
        repo: slug(r),
        pr: 42,
        sha: SHA,
        branch: "feature/one",
        finish: { kind: "required" },
    });
    assert.equal(h.jig.started[0]?.title, "checks of pull request 42");
    assert.deepEqual([h.jig.started[0]?.timeoutMinutes, h.jig.started[0]?.stallMinutes], [60, 30]);
    assert.equal(
        result.text,
        "Watching checks of pull request 42 as w1. One message arrives when the required checks all pass, or the first one fails. The watch tool lists and stops watches.",
    );
});

test("watch on a branch resolves the commit through the API; on a sha too", async () => {
    const r = repo();
    h.gh.on("api", { json: { sha: SHA } });
    ok(await h.call("checks", { action: "watch", repo: r.name }));
    assert.deepEqual(h.jig.started[0]?.spec, {
        repo: slug(r),
        sha: SHA,
        branch: "feature/one",
        finish: { kind: "required" },
    });
    assert.equal(h.jig.started[0]?.title, `checks of branch feature/one at ${"a".repeat(7)}`);
    ok(await h.call("checks", { action: "watch", repo: r.name, sha: "abc1234" }));
    assert.equal(h.jig.started[1]?.title, "checks of commit aaaaaaa");
    assert.ok(h.gh.calls().some((call) => call.args.includes(`repos/${slug(r)}/commits/abc1234`)));
});

test("watch finish lines: a named check, a run, approval, merge, a comment, a tag, a release", async () => {
    const r = repo();
    h.gh.on("pr view", { json: { headRefOid: SHA, headRefName: "feature/one" } });
    h.gh.on("api", { json: { sha: SHA } });
    ok(await h.call("checks", { action: "watch", repo: r.name, number: 42, check: "build-image" }));
    assert.deepEqual(h.jig.started[0]?.spec, {
        repo: slug(r),
        pr: 42,
        sha: SHA,
        branch: "feature/one",
        finish: { kind: "check", name: "build-image" },
    });
    assert.equal(h.jig.started[0]?.title, "check build-image of pull request 42");
    ok(await h.call("checks", { action: "watch", repo: r.name, run_id: 101 }));
    assert.deepEqual(h.jig.started[1]?.spec, { repo: slug(r), runId: 101, finish: { kind: "run" } });
    ok(await h.call("checks", { action: "watch", repo: r.name, number: 42, finish: "approved" }));
    assert.deepEqual((h.jig.started[2]?.spec as { finish: unknown }).finish, { kind: "pr", state: "approved" });
    assert.equal(h.jig.started[2]?.title, "approval of pull request 42");
    ok(await h.call("checks", { action: "watch", repo: r.name, number: 42, finish: "merged" }));
    assert.equal(h.jig.started[3]?.title, "merge of pull request 42");
    ok(
        await h.call("checks", {
            action: "watch",
            repo: r.name,
            number: 42,
            finish: "comment",
            pattern: "image: (\\S+)",
            bot: "ci-bot",
        }),
    );
    const comment = (
        h.jig.started[4]?.spec as { finish: { kind: string; pattern: string; bot: string; since: string } }
    ).finish;
    assert.deepEqual([comment.kind, comment.pattern, comment.bot], ["comment", "image: (\\S+)", "ci-bot"]);
    assert.ok(!Number.isNaN(Date.parse(comment.since)), "the comment finish remembers when the watch began");
    ok(await h.call("checks", { action: "watch", repo: r.name, finish: "tag", pattern: "^v1\\." }));
    assert.deepEqual(h.jig.started[5]?.spec, { repo: slug(r), finish: { kind: "tag", pattern: "^v1\\." } });
    ok(await h.call("checks", { action: "watch", repo: r.name, finish: "release", pattern: "^v1\\." }));
    assert.equal(h.jig.started[6]?.title, `a new release matching ^v1\\. in ${slug(r)}`);
});

test("watch refuses a finish line that lacks what it needs", async () => {
    const r = repo();
    const run = (input: Record<string, unknown>) => h.call("checks", { action: "watch", repo: r.name, ...input });
    assert.match((await run({ finish: "check" })).error?.message ?? "", /finish check needs check/);
    assert.match((await run({ finish: "run" })).error?.message ?? "", /run_id is required/);
    assert.match((await run({ finish: "approved" })).error?.message ?? "", /number is required/);
    assert.match((await run({ finish: "comment", number: 42 })).error?.message ?? "", /finish comment needs pattern/);
    assert.match(
        (await run({ finish: "tag", pattern: "(" })).error?.message ?? "",
        /pattern is not a valid regular expression/,
    );
    assert.equal(h.jig.started.length, 0);
});

test("the watch carries the limits git.watch sets", async () => {
    const r = repo();
    h.gh.on("api", { json: { sha: SHA } });
    h.jig.setSection("git", { watch: { timeoutMinutes: 10, stallMinutes: 3 } });
    ok(await h.call("checks", { action: "watch", repo: r.name }));
    assert.deepEqual([h.jig.started[0]?.timeoutMinutes, h.jig.started[0]?.stallMinutes], [10, 3]);
});
