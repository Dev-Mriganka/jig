// Evidence from outside the plugin: review and CI events (checked on arrival), and the pull request gh shows.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { Forge } from "../src/forge.ts";
import { ciFromEvent, ciRecord, parseJobs, parseRollup, readPullRequest, reviewFromEvent } from "../src/sources.ts";
import { GREEN_JOBS, glabAnswers, jobJson, mrJson, NOW, fakeHost, ok, PASSED, prJson, tempFolder } from "./support.ts";
import type { RunScript } from "./support.ts";

const HEAD = "a".repeat(40);

describe("a review that was approved", () => {
    const event = (over: Record<string, unknown> = {}) => ({
        reviewId: "2026-10-30T10-00-00Z",
        scope: "branch",
        ticket: "PROJ-123",
        repos: [{ repo: "orders-api", root: "/w/orders-api", head: HEAD }],
        covered: true,
        files: [],
        method: "passkey",
        ...over,
    });

    test("is recorded for a bound repository, with its commit", () => {
        const record = reviewFromEvent(event(), "PROJ-123", ["/w/orders-api", "/w/billing"], "/w", NOW);
        assert.deepEqual(record, {
            reviewId: "2026-10-30T10-00-00Z",
            at: NOW.toISOString(),
            repos: [{ root: "/w/orders-api", head: HEAD }],
        });
    });

    test("the repository's path from Pi's folder will do when the event has no root", () => {
        const noRoot = event({
            repos: [
                { repo: "orders-api", head: HEAD },
                { repo: "", head: HEAD },
            ],
        });
        const record = reviewFromEvent(noRoot, "PROJ-123", ["/w/orders-api", "/w"], "/w", NOW);
        assert.deepEqual(
            record?.repos.map((r) => r.root),
            ["/w/orders-api", "/w"],
        );
    });

    test("a repository that is not bound is not recorded, and nothing is recorded when none is", () => {
        const record = reviewFromEvent(
            event({
                repos: [
                    { root: "/w/orders-api", head: HEAD },
                    { root: "/w/other", head: HEAD },
                ],
            }),
            "PROJ-123",
            ["/w/orders-api"],
            "/w",
            NOW,
        );
        assert.deepEqual(record?.repos, [{ root: "/w/orders-api", head: HEAD }]);
        assert.equal(reviewFromEvent(event(), "PROJ-123", ["/w/other"], "/w", NOW), undefined);
    });

    test("an approval that covers no commit counts for nothing", () => {
        assert.equal(reviewFromEvent(event({ covered: false }), "PROJ-123", ["/w/orders-api"], "/w", NOW), undefined);
        assert.equal(reviewFromEvent(event({ covered: "yes" }), "PROJ-123", ["/w/orders-api"], "/w", NOW), undefined);
    });

    test("a review for another ticket is not this ticket's; one for no ticket is by folder alone", () => {
        assert.equal(
            reviewFromEvent(event({ ticket: "PROJ-999" }), "PROJ-123", ["/w/orders-api"], "/w", NOW),
            undefined,
        );
        const { ticket: _ticket, ...folderScope } = event();
        assert.ok(reviewFromEvent(folderScope, "PROJ-123", ["/w/orders-api"], "/w", NOW));
    });

    test("anything that is not a full commit, or not an event, is dropped", () => {
        for (const bad of [
            null,
            "x",
            [],
            event({ repos: "x" }),
            event({ reviewId: "" }),
            event({ repos: [{ root: "/w/orders-api", head: "abc123" }] }),
            event({ repos: [{ root: "/w/orders-api", head: "A".repeat(40) }] }),
        ]) {
            assert.equal(
                reviewFromEvent(bad, "PROJ-123", ["/w/orders-api"], "/w", NOW),
                undefined,
                JSON.stringify(bad),
            );
        }
    });

    test("a root that is a link to a bound repository is the bound repository", (t) => {
        const folder = tempFolder(t);
        mkdirSync(path.join(folder, "real"));
        symlinkSync(path.join(folder, "real"), path.join(folder, "link"));
        const record = reviewFromEvent(
            event({ repos: [{ root: path.join(folder, "link"), head: HEAD }] }),
            "PROJ-123",
            [path.join(folder, "real")],
            folder,
            NOW,
        );
        assert.equal(record?.repos[0]?.root, path.join(folder, "real"));
    });
});

describe("a CI watch that ended", () => {
    const event = (over: Record<string, unknown> = {}) => ({
        repo: "Acme/Orders-API",
        service: "orders-api",
        system: "github-actions",
        sha: HEAD,
        outcome: "passed",
        finish: "required",
        summary: "ok",
        ...over,
    });

    test("is recorded by repository (lower case) and commit", () => {
        const found = ciFromEvent(event());
        assert.deepEqual(found, { repo: "acme/orders-api", sha: HEAD, outcome: "passed", finish: "required" });
        assert.deepEqual(ciRecord(found as never, NOW), { ...found, at: NOW.toISOString() });
    });

    test("only a finish line that covers the required checks says anything about them", () => {
        for (const finish of ["required", "pipeline", "jobs", "build", "stages"])
            assert.ok(ciFromEvent(event({ finish })), finish);
        for (const finish of ["check", "run", "pr", "comment", "tag", "release", "other", 3]) {
            assert.equal(ciFromEvent(event({ finish })), undefined, String(finish));
        }
    });

    test("a GitLab project's whole path is a repository, groups and all", () => {
        const found = ciFromEvent(
            event({ repo: "Platform/Payments/Orders-API", system: "gitlab", finish: "pipeline" }),
        );
        assert.deepEqual(found, {
            repo: "platform/payments/orders-api",
            sha: HEAD,
            outcome: "passed",
            finish: "pipeline",
        });
        assert.equal(ciFromEvent(event({ repo: `${"a/".repeat(20)}b` })), undefined, "twenty-one parts is too many");
    });

    test("no commit, a short one, another outcome or another shape is dropped", () => {
        for (const bad of [
            null,
            "x",
            event({ sha: undefined }),
            event({ sha: "abc" }),
            event({ outcome: "timed-out" }),
            event({ repo: "no-slash" }),
            event({ repo: 3 }),
        ]) {
            assert.equal(ciFromEvent(bad), undefined, JSON.stringify(bad));
        }
    });
});

describe("the roll-up of checks", () => {
    test("check runs by their status and conclusion, statuses by their state", () => {
        const rollup = [
            ...PASSED,
            { status: "COMPLETED", conclusion: "NEUTRAL" },
            { status: "COMPLETED", conclusion: "SKIPPED" },
            { status: "IN_PROGRESS", conclusion: "" },
            { status: "QUEUED" },
            { status: "COMPLETED", conclusion: "FAILURE" },
            { status: "COMPLETED", conclusion: "CANCELLED" },
            { state: "PENDING" },
            { state: "EXPECTED" },
            { state: "ERROR" },
            "junk",
        ];
        assert.deepEqual(parseRollup(rollup), { pass: 4, fail: 3, pending: 4, total: 11 });
        assert.deepEqual(parseRollup(null), { pass: 0, fail: 0, pending: 0, total: 0 });
    });
});

describe("reading the pull request", () => {
    const read = (run: RunScript | undefined) =>
        readPullRequest(fakeHost({ run }), "/w/orders-api", "feature/PROJ-1", HEAD);

    test("gh pr view is run in the repository, read-only, and its answer is kept", async () => {
        const host = fakeHost({ run: () => ok(prJson({ headRefOid: HEAD, statusCheckRollup: PASSED })) });
        const seen = await readPullRequest(host, "/w/orders-api", "feature/PROJ-1", HEAD);
        assert.deepEqual(host.ran, [
            {
                file: "gh",
                args: ["pr", "view", "--json", "number,state,isDraft,headRefOid,url,statusCheckRollup"],
                cwd: "/w/orders-api",
            },
        ]);
        assert.deepEqual(seen, {
            at: NOW.toISOString(),
            branch: "feature/PROJ-1",
            head: HEAD,
            pr: {
                number: 7,
                state: "OPEN",
                isDraft: false,
                headRefOid: HEAD,
                url: "https://github.example.com/acme/orders-api/pull/7",
            },
            checks: { pass: 2, fail: 0, pending: 0, total: 2 },
        });
    });

    test("a branch with no pull request is a reading with none, not an error", async () => {
        const seen = await read(() => ok("", 1, 'no pull requests found for branch "feature/PROJ-1"'));
        assert.equal(seen.pr, undefined);
        assert.equal(seen.error, undefined);
    });

    test("gh failing, missing or giving nonsense is an error with a reason", async () => {
        assert.match(
            (await read(() => ok("", 4, "To get started with GitHub CLI, please run: gh auth login"))).error ?? "",
            /gh auth login/,
        );
        assert.match((await read(() => ok("", 1, ""))).error ?? "", /gh exited 1/);
        assert.match(
            (
                await read(() => {
                    throw new Error("gh was not found");
                })
            ).error ?? "",
            /gh was not found/,
        );
        assert.match((await read(() => ok("not json"))).error ?? "", /Unexpected token|not valid|JSON/i);
        assert.match((await read(() => ok("[]"))).error ?? "", /does not read/);
    });
});

describe("the jobs of a GitLab pipeline", () => {
    test("count as the roll-up of GitHub's checks does: a job that may fail does not fail, an unfinished one is pending", () => {
        const jobs = [
            jobJson("build", "success"),
            jobJson("docs", "skipped"),
            jobJson("flaky", "failed", { allow_failure: true }),
            jobJson("test", "failed"),
            jobJson("e2e", "canceled"),
            jobJson("deploy", "manual"),
            jobJson("lint", "running"),
            jobJson("queued", "pending"),
            jobJson("later", "created"),
            jobJson("strange", "quantum"),
            "junk",
        ];
        assert.deepEqual(parseJobs(jobs), { pass: 3, fail: 3, pending: 4, total: 10 });
        assert.deepEqual(parseJobs(null), { pass: 0, fail: 0, pending: 0, total: 0 });
    });
});

describe("reading the merge request on GitLab", () => {
    const forge: Forge = { forge: "gitlab", host: "gitlab.example.com", path: "platform/payments/orders-api" };
    const PROJECT = "projects/platform%2Fpayments%2Forders-api";
    const sha = "0".repeat(40);

    test("glab api asks for the merge request of the branch, then the jobs of its pipeline, in the repository", async () => {
        const host = fakeHost({
            run: glabAnswers([
                ["pipelines/301/jobs", GREEN_JOBS],
                ["merge_requests", [mrJson({ sha, source_branch: "feature/PROJ-1" })]],
            ]),
        });
        const seen = await readPullRequest(host, "/w/orders-api", "feature/PROJ-1", sha, undefined, forge);
        assert.deepEqual(
            host.ran.map((run) => [run.file, run.args, run.cwd]),
            [
                [
                    "glab",
                    [
                        "api",
                        "--hostname",
                        "gitlab.example.com",
                        `${PROJECT}/merge_requests?source_branch=feature%2FPROJ-1&state=opened&per_page=5&order_by=updated_at&sort=desc`,
                    ],
                    "/w/orders-api",
                ],
                [
                    "glab",
                    ["api", "--hostname", "gitlab.example.com", `${PROJECT}/pipelines/301/jobs?per_page=100`],
                    "/w/orders-api",
                ],
            ],
        );
        assert.deepEqual(seen, {
            at: NOW.toISOString(),
            branch: "feature/PROJ-1",
            head: sha,
            pr: {
                number: 42,
                state: "OPEN",
                isDraft: false,
                headRefOid: sha,
                url: "https://gitlab.example.com/platform/payments/orders-api/-/merge_requests/42",
            },
            checks: { pass: 3, fail: 0, pending: 0, total: 3 },
        });
    });

    test("states are written as GitHub's are, and a draft is a flag or a title prefix", async () => {
        const read = async (over: Record<string, unknown>) => {
            const host = fakeHost({
                run: glabAnswers([
                    ["pipelines/301/jobs", GREEN_JOBS],
                    [/state=opened/, []],
                    ["merge_requests", [mrJson(over)]],
                ]),
            });
            return (await readPullRequest(host, "/w/orders-api", "main", sha, undefined, forge)).pr;
        };
        assert.equal((await read({ state: "merged" }))?.state, "MERGED");
        assert.equal((await read({ state: "closed" }))?.state, "CLOSED");
        assert.equal((await read({ state: "locked" }))?.state, "LOCKED");
        const host = fakeHost({
            run: glabAnswers([
                ["pipelines/301/jobs", GREEN_JOBS],
                ["merge_requests", [mrJson({ draft: true })]],
            ]),
        });
        assert.equal((await readPullRequest(host, "/w", "main", sha, undefined, forge)).pr?.isDraft, true);
        const prefixed = fakeHost({
            run: glabAnswers([
                ["pipelines/301/jobs", GREEN_JOBS],
                ["merge_requests", [mrJson({ title: "Draft: PROJ-1: x" })]],
            ]),
        });
        assert.equal((await readPullRequest(prefixed, "/w", "main", sha, undefined, forge)).pr?.isDraft, true);
    });

    test("no merge request for the branch is not an error; one from a fork with the same branch name is not the branch's own", async () => {
        const none = fakeHost({ run: glabAnswers([["merge_requests", []]]) });
        const seen = await readPullRequest(none, "/w", "main", sha, undefined, forge);
        assert.deepEqual([seen.pr, seen.error], [undefined, undefined]);
        const fork = fakeHost({
            run: glabAnswers([["merge_requests", [mrJson({ source_project_id: 99, target_project_id: 7 })]]]),
        });
        assert.equal((await readPullRequest(fork, "/w", "main", sha, undefined, forge)).pr, undefined);
    });

    test("a pipeline of an older commit says nothing about this head: there are no checks yet", async () => {
        const host = fakeHost({
            run: glabAnswers([
                ["pipelines/301/jobs", GREEN_JOBS],
                [
                    "merge_requests",
                    [mrJson({ sha, head_pipeline: { id: 301, sha: "b".repeat(40), status: "success" } })],
                ],
            ]),
        });
        const seen = await readPullRequest(host, "/w", "main", sha, undefined, forge);
        assert.deepEqual(seen.checks, { pass: 0, fail: 0, pending: 0, total: 0 });
        assert.equal(host.ran.length, 1, "only the merge request was asked for, and not the jobs of the old pipeline");
    });

    test("a request without a pipeline has no checks", async () => {
        const host = fakeHost({ run: glabAnswers([["merge_requests", [mrJson({ head_pipeline: null })]]]) });
        const seen = await readPullRequest(host, "/w", "main", sha, undefined, forge);
        assert.deepEqual(seen.checks, { pass: 0, fail: 0, pending: 0, total: 0 });
    });

    test("a failed job is counted, and a running one is pending", async () => {
        const host = fakeHost({
            run: glabAnswers([
                [
                    "pipelines/301/jobs",
                    [jobJson("build", "success"), jobJson("test", "failed"), jobJson("e2e", "running")],
                ],
                ["merge_requests", [mrJson()]],
            ]),
        });
        assert.deepEqual((await readPullRequest(host, "/w", "main", sha, undefined, forge)).checks, {
            pass: 1,
            fail: 1,
            pending: 1,
            total: 3,
        });
    });

    test("glab failing is a reason, and a missing sign-in says how to mend it", async () => {
        const broken = fakeHost({ run: () => ok("", 1, "glab: 404 Not Found (HTTP 404)\n") });
        assert.equal(
            (await readPullRequest(broken, "/w", "main", sha, undefined, forge)).error,
            "glab: 404 Not Found (HTTP 404)",
        );
        const signedOut = fakeHost({ run: () => ok("", 1, "glab: 401 Unauthorized (HTTP 401)\n") });
        assert.equal(
            (await readPullRequest(signedOut, "/w", "main", sha, undefined, forge)).error,
            "glab: 401 Unauthorized (HTTP 401) (glab is not signed in for gitlab.example.com: run glab auth login --hostname gitlab.example.com yourself)",
        );
        const html = fakeHost({ run: () => ok("<html>maintenance</html>") });
        assert.equal(
            (await readPullRequest(html, "/w", "main", sha, undefined, forge)).error,
            "glab api gave an answer that is not JSON",
        );
        const absent = fakeHost({});
        assert.match(
            (await readPullRequest(absent, "/w", "main", sha, undefined, forge)).error ?? "",
            /no program glab/,
        );
    });
});

describe("reading the pull request of a repository whose origin is an alias", () => {
    test("gh is told the real repository and the branch, since the alias is for git alone", async () => {
        const host = fakeHost({ run: () => ok(prJson({ headRefOid: HEAD })) });
        await readPullRequest(host, "/w/orders-api", "feature/PROJ-1", HEAD, undefined, {
            forge: "github",
            repo: "github.com/acme/orders-api",
        });
        assert.deepEqual(host.ran[0]?.args, [
            "pr",
            "view",
            "feature/PROJ-1",
            "-R",
            "github.com/acme/orders-api",
            "--json",
            "number,state,isDraft,headRefOid,url,statusCheckRollup",
        ]);
    });
});
