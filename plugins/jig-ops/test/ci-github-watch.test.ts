// The GitHub half of the ops-ci watch kind, polled the way jig-core's engine polls it, against a fake `gh`. These were the tests of
// jig-git's `github` watch kind: the ETags, X-Poll-Interval, the finish lines and the failure details are as they were. The
// kind now takes the repository from the catalog (`acme/orders-api`), and its spec names the service.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { PollOutcome } from "../../jig-core/src/contract.ts";
import type { GithubState } from "../src/ci/github-checks.ts";
import { describeSpec } from "../src/ci/github-watch.ts";
import type { Finish, GithubSpec } from "../src/ci/github-watch.ts";
import type { GhReply } from "./support/fake-gh.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section } from "./support/section.ts";

let h: Harness;

beforeEach(() => {
    h = setupHarness();
    h.jig.publish();
});
afterEach(() => h.close());

/** The `ops` section with the watch settings and artifact rules a test sets. */
function configure(more: Record<string, unknown>): void {
    h.configure({ ...section(), ...more });
}

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const SLUG = "acme/orders-api";
const SERVICE = "orders-api";
const enc = encodeURIComponent;

const P = {
    runs: `repos/${SLUG}/commits/${SHA}/check-runs?per_page=100`,
    status: `repos/${SLUG}/commits/${SHA}/status?per_page=100`,
    repo: `repos/${SLUG}`,
    protection: (branch: string) => `repos/${SLUG}/branches/${enc(branch)}`,
    rules: (branch: string) => `repos/${SLUG}/rules/branches/${enc(branch)}`,
    pull: (n: number) => `repos/${SLUG}/pulls/${n}`,
    reviews: (n: number) => `repos/${SLUG}/pulls/${n}/reviews?per_page=100`,
    comments: (n: number, since: string) => `repos/${SLUG}/issues/${n}/comments?per_page=100&since=${enc(since)}`,
    allComments: (n: number) => `repos/${SLUG}/issues/${n}/comments?per_page=100`,
    tags: `repos/${SLUG}/tags?per_page=100`,
    releases: `repos/${SLUG}/releases?per_page=30`,
    run: (id: number) => `repos/${SLUG}/actions/runs/${id}`,
    jobs: (id: number) => `repos/${SLUG}/actions/runs/${id}/jobs?per_page=100`,
    log: (job: number) => `repos/${SLUG}/actions/jobs/${job}/logs`,
};

/** Serves a GitHub API path from the fake gh. */
function api(path: string, reply: GhReply | GhReply[]): void {
    h.gh.on("api", reply, [`=${path}`]);
}

const checkRun = (id: number, name: string, status: string, conclusion: string | null) => ({
    id,
    name,
    status,
    conclusion,
    html_url: `https://github.com/${SLUG}/actions/runs/1/job/${id}`,
});
const runs = (...items: ReturnType<typeof checkRun>[]): GhReply => ({
    json: { total_count: items.length, check_runs: items },
    etag: 'W/"runs-1"',
});
const noStatuses: GhReply = { json: { state: "pending", statuses: [] }, etag: 'W/"status-1"' };

/** Protection for `main`: build and unit are required. */
function protect(contexts: string[], branch = "main"): void {
    api(P.repo, { json: { default_branch: "main" } });
    api(P.protection(branch), { json: { protection: { required_status_checks: { contexts } } } });
    api(P.rules(branch), { json: [] });
}

async function poll(spec: GithubSpec, state?: GithubState): Promise<PollOutcome<GithubState>> {
    const kind = h.jig.kinds.get("ops-ci");
    assert.ok(kind, "the ops-ci watch kind is registered");
    const run = kind.poll as unknown as (
        s: unknown,
        st: unknown,
        signal: AbortSignal,
    ) => Promise<PollOutcome<GithubState>>;
    return run(spec, state, new AbortController().signal);
}

const required: Finish = { kind: "required" };
const spec = (finish: Finish = required, more: Partial<GithubSpec> = {}): GithubSpec => ({
    system: "github-actions",
    service: SERVICE,
    branch: "feature/one",
    sha: SHA,
    finish,
    ...more,
});

// ---- the kind -----------------------------------------------------------------------------------------------------

test("the ops-ci kind is registered with a 30 second interval, and describes what it watches", () => {
    const kind = h.jig.kinds.get("ops-ci");
    assert.deepEqual([kind?.kind, kind?.plugin, kind?.intervalMs], ["ops-ci", "jig-ops", 30_000]);
    assert.equal(describeSpec(spec()), "orders-api: required checks of branch feature/one at abcdef0");
    assert.equal(describeSpec(spec(required, { pr: 42 })), "orders-api: required checks of pull request 42 at abcdef0");
    assert.equal(
        describeSpec(spec({ kind: "check", name: "build-image" })),
        "orders-api: check build-image of branch feature/one at abcdef0",
    );
    assert.equal(
        describeSpec({ system: "github-actions", service: SERVICE, runId: 7, finish: { kind: "run" } }),
        "orders-api: run 7 of orders-api",
    );
    assert.equal(
        describeSpec({ system: "github-actions", service: SERVICE, pr: 42, finish: { kind: "pr", state: "merged" } }),
        "orders-api: merged state of pull request 42",
    );
    assert.equal(
        describeSpec({
            system: "github-actions",
            service: SERVICE,
            pr: 42,
            finish: { kind: "comment", pattern: "image", since: "x" },
        }),
        "orders-api: a comment matching image of pull request 42",
    );
    assert.equal(
        describeSpec({ system: "github-actions", service: SERVICE, finish: { kind: "tag", pattern: "^v" } }),
        "orders-api: a new tag matching ^v of orders-api",
    );
});

// ---- ETags --------------------------------------------------------------------------------------------------------

test("a 304 costs nothing: the answers held are used, nothing is asked again, and the state is the same", async () => {
    protect(["build", "unit"]);
    api(P.runs, runs(checkRun(1, "build", "completed", "success"), checkRun(2, "unit", "in_progress", null)));
    api(P.status, noStatuses);
    const first = await poll(spec());
    assert.equal(first.done, undefined);
    assert.equal(first.nextPollMs, 30_000);
    assert.equal(first.state.required?.join(","), "build,unit");
    assert.equal(first.state.answers[P.runs]?.etag, 'W/"runs-1"');
    const before = h.gh.calls().length;
    // GitHub says nothing changed: both reads come back 304. The branch protection is not read again.
    const second = await poll(spec(), JSON.parse(JSON.stringify(first.state)) as GithubState);
    assert.equal(second.done, undefined);
    assert.equal(second.state.polls, 2);
    assert.deepEqual({ ...second.state, polls: 1 }, first.state);
    const again = h.gh.calls().slice(before);
    assert.deepEqual(
        again.map((call) => call.args.find((arg) => arg.startsWith("repos/"))),
        [P.runs, P.status, P.repo],
    );
    const conditional = (path: string) =>
        again.find((call) => call.args.includes(path))?.args.filter((arg) => arg.startsWith("If-None-Match: "));
    assert.deepEqual(conditional(P.runs), ['If-None-Match: W/"runs-1"'], "each repeat carries the ETag it was given");
    assert.deepEqual(conditional(P.status), ['If-None-Match: W/"status-1"']);
});

test("a changed answer replaces the one held, and the watch can finish on it", async () => {
    protect(["build", "unit"]);
    api(P.status, noStatuses);
    api(P.runs, [
        runs(checkRun(1, "build", "completed", "success"), checkRun(2, "unit", "in_progress", null)),
        {
            ...runs(checkRun(1, "build", "completed", "success"), checkRun(2, "unit", "completed", "success")),
            etag: 'W/"runs-2"',
        },
    ]);
    const first = await poll(spec());
    assert.equal(first.done, undefined);
    const second = await poll(spec(), first.state);
    assert.equal(second.done?.outcome, "passed");
    assert.equal(second.state.answers[P.runs]?.etag, 'W/"runs-2"');
});

test("X-Poll-Interval is followed through nextPollMs, never below the configured interval", async () => {
    protect(["build"]);
    api(P.runs, { ...runs(checkRun(1, "build", "in_progress", null)), headers: { "X-Poll-Interval": "90" } });
    api(P.status, noStatuses);
    const slow = await poll(spec());
    assert.equal(slow.nextPollMs, 90_000);
    assert.equal(slow.state.pollSeconds, 90);
    configure({ watch: { pollSeconds: 120 } });
    assert.equal(
        (await poll(spec(), slow.state)).nextPollMs,
        120_000,
        "the configured interval wins when it is longer",
    );
    configure({ watch: { pollSeconds: 10 } });
    assert.equal((await poll(spec())).nextPollMs, 90_000, "GitHub's wish wins when it is longer");
});

test("the state is plain JSON and a watch resumed from it goes on where it was", async () => {
    protect(["build"]);
    api(P.runs, runs(checkRun(1, "build", "in_progress", null)));
    api(P.status, noStatuses);
    const first = await poll(spec());
    const saved = JSON.parse(JSON.stringify(first.state)) as GithubState;
    assert.deepEqual(saved, first.state);
    api(P.runs, { ...runs(checkRun(1, "build", "completed", "success")), etag: 'W/"runs-9"' });
    assert.equal((await poll(spec(), saved)).done?.outcome, "passed");
});

// ---- the required checks ------------------------------------------------------------------------------------------

test("required checks: it passes when the required ones pass, whatever an optional slow check is still doing", async () => {
    protect(["build", "unit"]);
    api(
        P.runs,
        runs(
            checkRun(1, "build", "completed", "success"),
            checkRun(2, "unit", "completed", "success"),
            checkRun(3, "e2e-slow", "in_progress", null),
        ),
    );
    api(P.status, noStatuses);
    const { done } = await poll(spec());
    assert.equal(done?.outcome, "passed");
    assert.equal(
        done?.summary,
        "Checks passed for branch feature/one at abcdef0: 2 pass, 0 fail, 0 pending, 0 skipped",
    );
    assert.deepEqual(done?.facts, { pass: 2, fail: 0, pending: 0, skipped: 0 });
    assert.deepEqual(done?.links, [
        `https://github.com/${SLUG}/actions/runs/1/job/1`,
        `https://github.com/${SLUG}/actions/runs/1/job/2`,
    ]);
});

test("required checks: one that has not been reported yet is pending, not passed", async () => {
    protect(["build", "unit"]);
    api(P.runs, runs(checkRun(1, "build", "completed", "success")));
    api(P.status, noStatuses);
    assert.equal((await poll(spec())).done, undefined);
});

test("required checks: nothing required means every check counts, and a pending one keeps the watch waiting", async () => {
    api(P.repo, { json: { default_branch: "main" } });
    api(P.protection("main"), {
        status: 404,
        stderr: "Branch not protected",
        json: { message: "Branch not protected" },
    });
    api(P.rules("main"), { json: [] });
    api(P.runs, runs(checkRun(1, "build", "completed", "success"), checkRun(3, "e2e", "queued", null)));
    api(P.status, noStatuses);
    const waiting = await poll(spec());
    assert.equal(waiting.done, undefined);
    assert.deepEqual(waiting.state.required, []);
    api(P.runs, {
        ...runs(checkRun(1, "build", "completed", "success"), checkRun(3, "e2e", "completed", "skipped")),
        etag: 'W/"2"',
    });
    const done = (await poll(spec(), waiting.state)).done;
    assert.equal(
        done?.summary,
        "Checks passed for branch feature/one at abcdef0: 1 pass, 0 fail, 0 pending, 1 skipped",
    );
});

test("required checks: a ruleset names required checks too", async () => {
    api(P.repo, { json: { default_branch: "main" } });
    api(P.protection("main"), { json: { protection: null } });
    api(P.rules("main"), {
        json: [
            { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } },
            { type: "deletion" },
        ],
    });
    api(P.runs, runs(checkRun(1, "build", "completed", "success"), checkRun(3, "other", "in_progress", null)));
    api(P.status, noStatuses);
    const outcome = await poll(spec());
    assert.deepEqual(outcome.state.required, ["build"]);
    assert.equal(outcome.done?.outcome, "passed");
});

test("required checks fail fast: the first required failure ends the watch, with its link and the lines around its first error", async () => {
    protect(["build", "unit"]);
    api(
        P.runs,
        runs(
            checkRun(1, "build", "in_progress", null),
            checkRun(2, "unit", "completed", "failure"),
            checkRun(3, "lint", "completed", "failure"),
        ),
    );
    api(P.status, noStatuses);
    const log = [
        "2026-10-30T10:00:00.0000000Z setup",
        "2026-10-30T10:00:01.0000000Z Run npm test",
        "2026-10-30T10:00:02.0000000Z FAIL src/a.test.ts",
        "2026-10-30T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
        "2026-10-30T10:00:04.0000000Z cleanup",
    ].join("\n");
    api(P.log(2), { stdout: log });
    const { done } = await poll(spec());
    assert.equal(done?.outcome, "failed");
    assert.equal(done?.summary, "Check unit failed for branch feature/one at abcdef0");
    assert.equal(
        done?.details,
        "unit:\nsetup\nRun npm test\nFAIL src/a.test.ts\n##[error]Process completed with exit code 1.\ncleanup",
    );
    assert.deepEqual(done?.links, [`https://github.com/${SLUG}/actions/runs/1/job/2`]);
    assert.equal(done?.facts?.fail, 1);
});

test("a failure of a check that is not required does not end the watch", async () => {
    protect(["build"]);
    api(P.runs, runs(checkRun(1, "build", "in_progress", null), checkRun(3, "lint", "completed", "failure")));
    api(P.status, noStatuses);
    assert.equal((await poll(spec())).done, undefined);
});

test("a check an app ran, with no job log, is described by its own title", async () => {
    protect(["scan"]);
    api(P.runs, {
        json: {
            total_count: 1,
            check_runs: [
                {
                    id: 5,
                    name: "scan",
                    status: "completed",
                    conclusion: "failure",
                    html_url: "https://scan.example/5",
                    output: { title: "3 vulnerabilities found" },
                },
            ],
        },
    });
    api(P.status, noStatuses);
    api(P.log(5), { code: 1, stderr: "gh: Not Found (HTTP 404)" });
    const { done } = await poll(spec());
    assert.equal(done?.details, "scan: 3 vulnerabilities found");
});

test("commit statuses count as checks: a failing one ends the watch", async () => {
    protect(["ci/legacy"]);
    api(P.runs, runs());
    api(P.status, {
        json: {
            state: "failure",
            statuses: [
                {
                    context: "ci/legacy",
                    state: "failure",
                    target_url: "https://legacy.example/1",
                    description: "Build broke",
                },
            ],
        },
    });
    const { done } = await poll(spec());
    assert.equal(done?.summary, "Check ci/legacy failed for branch feature/one at abcdef0");
    assert.deepEqual(done?.links, ["https://legacy.example/1"]);
    assert.equal(done?.details, "ci/legacy: Build broke");
});

test("a pull request watch reads the required checks of the pull request's base, and ends when the head moves on", async () => {
    api(P.pull(42), {
        json: { head: { sha: SHA }, base: { ref: "release" }, state: "open", merged: false, html_url: "u" },
    });
    api(P.protection("release"), { json: { protection: { required_status_checks: { contexts: ["build"] } } } });
    api(P.rules("release"), { json: [] });
    api(P.runs, runs(checkRun(1, "build", "completed", "success")));
    api(P.status, noStatuses);
    const done = (await poll(spec(required, { pr: 42 }))).done;
    assert.equal(done?.summary, "Checks passed for pull request 42 at abcdef0: 1 pass, 0 fail, 0 pending, 0 skipped");
    api(P.pull(42), {
        json: { head: { sha: "f".repeat(40) }, base: { ref: "release" }, state: "open", merged: false, html_url: "u" },
        etag: 'W/"moved"',
    });
    const moved = (await poll(spec(required, { pr: 42 }))).done;
    assert.equal(moved?.outcome, "stopped");
    assert.equal(moved?.summary, `Pull request 42 moved on to ${"f".repeat(7)}; this watch followed abcdef0`);
});

test("more than 100 check runs are read page by page", async () => {
    protect(["check-150"]);
    const page = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) =>
            checkRun(from + i, `check-${from + i}`, "completed", "success"),
        );
    api(P.runs, { json: { total_count: 150, check_runs: page(1, 100) } });
    api(`${P.runs}&page=2`, { json: { total_count: 150, check_runs: page(101, 150) } });
    api(P.status, noStatuses);
    assert.equal((await poll(spec())).done?.outcome, "passed");
});

// ---- a named check ------------------------------------------------------------------------------------------------

test("a named check: pending until it completes, then its own result decides, whatever else failed", async () => {
    api(P.status, noStatuses);
    api(P.runs, runs(checkRun(1, "unit", "completed", "failure"), checkRun(9, "build-image", "in_progress", null)));
    const named = spec({ kind: "check", name: "build-image" });
    assert.equal((await poll(named)).done, undefined, "unit failed, but the image build is what is waited for");
    api(P.runs, runs(checkRun(1, "unit", "completed", "failure"), checkRun(9, "build-image", "completed", "success")));
    const passed = (await poll(named)).done;
    assert.equal(
        passed?.summary,
        "Check build-image passed for branch feature/one at abcdef0: 1 pass, 0 fail, 0 pending, 0 skipped",
    );
    api(P.runs, runs(checkRun(9, "build-image", "completed", "timed_out")));
    assert.equal(
        (await poll(named)).done?.summary,
        "Check build-image ended as timed_out for branch feature/one at abcdef0",
    );
    api(P.runs, runs(checkRun(9, "build-image", "completed", "skipped")));
    assert.equal((await poll(named)).done?.summary, "Check build-image was skipped for branch feature/one at abcdef0");
    api(P.runs, runs(checkRun(1, "unit", "completed", "success")));
    assert.equal((await poll(named)).done, undefined, "a check that does not exist yet is waited for");
});

// ---- a run --------------------------------------------------------------------------------------------------------

test("a run: a failed job ends the watch at once; a completed run decides", async () => {
    const runSpec: GithubSpec = { system: "github-actions", service: SERVICE, runId: 7, finish: { kind: "run" } };
    api(P.run(7), {
        json: {
            status: "in_progress",
            conclusion: null,
            name: "CI",
            html_url: `https://github.com/${SLUG}/actions/runs/7`,
            head_sha: SHA,
        },
    });
    api(P.jobs(7), {
        json: { jobs: [checkRun(21, "build", "completed", "success"), checkRun(22, "test", "in_progress", null)] },
    });
    assert.equal((await poll(runSpec)).done, undefined);
    api(P.jobs(7), {
        json: { jobs: [checkRun(21, "build", "completed", "success"), checkRun(22, "test", "completed", "failure")] },
        etag: 'W/"j2"',
    });
    api(P.log(22), { stdout: "2026-10-30T10:00:00.0000000Z ##[error]boom" });
    const failed = (await poll(runSpec)).done;
    assert.equal(failed?.summary, "Run 7 (CI): job test failed");
    assert.equal(failed?.details, "test:\n##[error]boom");
    api(P.run(7), {
        json: { status: "completed", conclusion: "success", name: "CI", html_url: "u", head_sha: SHA },
        etag: 'W/"r2"',
    });
    api(P.jobs(7), {
        json: { jobs: [checkRun(21, "build", "completed", "success"), checkRun(22, "test", "completed", "success")] },
        etag: 'W/"j3"',
    });
    const passed = (await poll(runSpec)).done;
    assert.equal(passed?.summary, `Run 7 (CI) succeeded at abcdef0: 2 pass, 0 fail, 0 pending, 0 skipped`);
    api(P.run(7), {
        json: { status: "completed", conclusion: "cancelled", name: "CI", html_url: "u", head_sha: SHA },
        etag: 'W/"r3"',
    });
    api(P.jobs(7), { json: { jobs: [] }, etag: 'W/"j4"' });
    assert.equal((await poll(runSpec)).done?.summary, "Run 7 (CI) ended as cancelled");
});

// ---- a pull request's state ---------------------------------------------------------------------------------------

const pull = (extra: Record<string, unknown> = {}): GhReply => ({
    json: {
        head: { sha: SHA },
        base: { ref: "main" },
        state: "open",
        merged: false,
        html_url: `https://github.com/${SLUG}/pull/42`,
        ...extra,
    },
});
const review = (login: string, state: string, body = "") => ({
    user: { login },
    state,
    body,
    html_url: `https://github.com/${SLUG}/pull/42#r-${login}`,
});

test("approved: someone approved and nobody asks for changes", async () => {
    const approval: GithubSpec = {
        system: "github-actions",
        service: SERVICE,
        pr: 42,
        finish: { kind: "pr", state: "approved" },
    };
    api(P.pull(42), pull());
    api(P.reviews(42), { json: [review("alice", "COMMENTED", "thoughts")] });
    assert.equal((await poll(approval)).done, undefined);
    api(P.reviews(42), { json: [review("alice", "APPROVED"), review("bob", "COMMENTED")], etag: 'W/"2"' });
    assert.equal((await poll(approval)).done?.summary, "Pull request 42 was approved by alice");
    api(P.reviews(42), {
        json: [
            review("alice", "APPROVED"),
            review("alice", "CHANGES_REQUESTED", "Please rename it."),
            review("bob", "APPROVED"),
        ],
        etag: 'W/"3"',
    });
    const changes = (await poll(approval)).done;
    assert.equal(changes?.outcome, "failed");
    assert.equal(changes?.summary, "Changes were requested on pull request 42 by alice");
    assert.equal(changes?.details, "Please rename it.");
    api(P.reviews(42), { json: [review("alice", "CHANGES_REQUESTED"), review("alice", "APPROVED")], etag: 'W/"4"' });
    assert.equal((await poll(approval)).done?.outcome, "passed", "the latest review of each person decides");
});

test("merged: waits while open, passes when merged, fails when closed without a merge", async () => {
    const merge: GithubSpec = {
        system: "github-actions",
        service: SERVICE,
        pr: 42,
        finish: { kind: "pr", state: "merged" },
    };
    api(P.pull(42), pull());
    assert.equal((await poll(merge)).done, undefined);
    assert.equal(
        h.gh.calls().filter((call) => call.args.some((arg) => arg.includes("/reviews"))).length,
        0,
        "reviews are not read for a merge",
    );
    api(P.pull(42), { ...pull({ merged: true, state: "closed" }), etag: 'W/"m"' });
    assert.equal((await poll(merge)).done?.summary, "Pull request 42 was merged into main");
    api(P.pull(42), { ...pull({ state: "closed" }), etag: 'W/"c"' });
    assert.equal((await poll(merge)).done?.summary, "Pull request 42 was closed without merging");
});

// ---- a comment ----------------------------------------------------------------------------------------------------

const comment = (login: string, type: string, body: string, createdAt: string) => ({
    user: { login, type },
    body,
    created_at: createdAt,
    html_url: `https://github.com/${SLUG}/pull/42#c-${login}`,
});

test("a bot comment that matches the pattern, made after the watch began", async () => {
    const since = "2026-10-30T10:00:00.000Z";
    const watch: GithubSpec = {
        system: "github-actions",
        service: SERVICE,
        pr: 42,
        finish: { kind: "comment", pattern: "image: (\\S+)", since },
    };
    api(P.comments(42, since), {
        json: [
            comment("ci-bot", "Bot", "image: old:1.0-abc", "2026-10-30T09:00:00Z"),
            comment("hp", "User", "image: fake:1", "2026-10-30T10:05:00Z"),
            comment("ci-bot", "Bot", "build started", "2026-10-30T10:06:00Z"),
        ],
    });
    assert.equal(
        (await poll(watch)).done,
        undefined,
        "an older comment, a person, and a bot with other words do not count",
    );
    api(P.comments(42, since), {
        json: [comment("ci-bot", "Bot", "image: registry/app:1.2-abcdef0", "2026-10-30T10:07:00Z")],
        etag: 'W/"2"',
    });
    const done = (await poll(watch)).done;
    assert.equal(done?.outcome, "passed");
    assert.equal(done?.summary, "A comment by ci-bot on pull request 42 matches image: (\\S+)");
    assert.equal(done?.details, "image: registry/app:1.2-abcdef0");
    const named: GithubSpec = { ...watch, finish: { kind: "comment", pattern: "image", bot: "other-bot", since } };
    assert.equal((await poll(named)).done, undefined, "only the named bot counts when one is named");
});

// ---- a tag or a release -------------------------------------------------------------------------------------------

test("a new tag: what exists on the first poll is old news, a new one that matches ends the watch", async () => {
    const watch: GithubSpec = {
        system: "github-actions",
        service: SERVICE,
        finish: { kind: "tag", pattern: "^v1\\." },
    };
    api(P.tags, {
        json: [
            { name: "v1.0.0", commit: { sha: "1".repeat(40) } },
            { name: "v0.9", commit: { sha: "2".repeat(40) } },
        ],
    });
    const first = await poll(watch);
    assert.equal(first.done, undefined);
    assert.deepEqual(first.state.known, ["v1.0.0", "v0.9"]);
    api(P.tags, {
        json: [
            { name: "v2.0.0", commit: { sha: "3".repeat(40) } },
            { name: "v1.0.0", commit: { sha: "1".repeat(40) } },
            { name: "v0.9", commit: { sha: "2".repeat(40) } },
        ],
        etag: 'W/"t2"',
    });
    assert.equal((await poll(watch, first.state)).done, undefined, "a new tag that does not match");
    api(P.tags, {
        json: [
            { name: "v1.1.0", commit: { sha: "4".repeat(40) } },
            { name: "v1.0.0", commit: { sha: "1".repeat(40) } },
        ],
        etag: 'W/"t3"',
    });
    assert.equal((await poll(watch, first.state)).done?.summary, "A new tag v1.1.0 matches ^v1\\. in acme/orders-api");
});

test("a tag on the watched commit counts at once; a new release is found by its tag", async () => {
    api(P.tags, { json: [{ name: "v1.0.0", commit: { sha: SHA } }] });
    assert.equal(
        (
            await poll({
                system: "github-actions",
                service: SERVICE,
                sha: SHA,
                finish: { kind: "tag", pattern: "^v1\\." },
            })
        ).done?.outcome,
        "passed",
    );
    api(P.tags, { json: [] });
    api(P.releases, {
        json: [
            {
                tag_name: "v1.0.0",
                name: "One",
                html_url: "https://github.com/acme/orders-api/releases/tag/v1.0.0",
                draft: false,
            },
            { tag_name: "v1.1.0", name: "Draft", html_url: "d", draft: true },
        ],
    });
    const watch: GithubSpec = {
        system: "github-actions",
        service: SERVICE,
        finish: { kind: "release", pattern: "^v1\\." },
    };
    const first = await poll(watch);
    assert.equal(first.done, undefined);
    api(P.releases, {
        json: [
            {
                tag_name: "v1.2.0",
                name: "Two",
                html_url: "https://github.com/acme/orders-api/releases/tag/v1.2.0",
                draft: false,
            },
            { tag_name: "v1.0.0", name: "One", html_url: "x", draft: false },
        ],
        etag: 'W/"r2"',
    });
    const done = (await poll(watch, first.state)).done;
    assert.equal(done?.summary, "A new release v1.2.0 matches ^v1\\. in acme/orders-api");
    assert.deepEqual(done?.links, ["https://github.com/acme/orders-api/releases/tag/v1.2.0"]);
});

// ---- errors -------------------------------------------------------------------------------------------------------

test("a poll that cannot be answered throws, so the engine counts it and pauses the watch after three", async () => {
    protect(["build"]);
    api(P.status, noStatuses);
    api(P.runs, { status: 401, stderr: "Bad credentials", json: { message: "Bad credentials" } });
    await assert.rejects(
        poll(spec()),
        /^Error: GitHub answered HTTP 401 for repos\/acme\/orders-api\/commits\/[0-9a-f]+\/check-runs\?per_page=100: Bad credentials \(gh is not signed in: run gh auth login yourself\)$/,
    );
    api(P.runs, { status: 403, stderr: "rate limit", json: { message: "API rate limit exceeded" } });
    await assert.rejects(poll(spec()), /HTTP 403.*API rate limit exceeded/);
    api(P.pull(42), { status: 404, stderr: "Not Found", json: { message: "Not Found" } });
    await assert.rejects(
        poll(spec(required, { pr: 42 })),
        /^Error: pull request 42 was not found in acme\/orders-api$/,
    );
    h.gh.reset();
    api(P.runs, { code: 1, stderr: 'Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host' });
    await assert.rejects(poll(spec()), /dial tcp: lookup api\.github\.com: no such host/);
});

test("a watch with no commit to look at says what it needs", async () => {
    await assert.rejects(
        poll({ system: "github-actions", service: SERVICE, finish: required }),
        /no commit to watch in acme\/orders-api: the watch needs a pull request, a branch or a sha/,
    );
});
