// Evidence from outside the plugin: review and CI events (checked on arrival), and the pull request gh shows.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { ciFromEvent, ciRecord, parseRollup, readPullRequest, reviewFromEvent } from "../src/sources.ts";
import { NOW, fakeHost, ok, PASSED, prJson, tempFolder } from "./support.ts";
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
