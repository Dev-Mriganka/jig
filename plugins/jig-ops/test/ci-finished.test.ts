// "The CI of a commit ended": when a watch reaches its finish line it publishes `jig-ops:ci-finished`, which names the repository
// and the commit, because the watch's own result is one line and names neither. jig-workflow's `checks-pass` listens for it.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WatchResult } from "../../jig-core/src/contract.ts";
import { announceFinished, CI_FINISHED_EVENT } from "../src/ci/finished.ts";
import type { CiFinished } from "../src/ci/finished.ts";
import type { GithubSpec } from "../src/ci/github-watch.ts";
import type { GitlabSpec } from "../src/ci/gitlab-watch.ts";
import type { JenkinsSpec } from "../src/ci/jenkins-watch.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section } from "./support/section.ts";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const SLUG = "acme/orders-api";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
    h.jig.publish();
    h.configure(section());
});
afterEach(() => h.close());

const events = () => h.bus.emitted.filter((entry) => entry.event === CI_FINISHED_EVENT);
const api = (path: string, reply: Parameters<Harness["gh"]["on"]>[1]) => h.gh.on("api", reply, [`=${path}`]);

const spec: GithubSpec = {
    system: "github-actions",
    service: "orders-api",
    pr: 42,
    branch: "feature/one",
    sha: SHA,
    finish: { kind: "required" },
};

/** A pull request at SHA whose one required check ended as `conclusion`. */
function serve(conclusion: string): void {
    api(`repos/${SLUG}/pulls/42`, {
        json: { head: { sha: SHA }, base: { ref: "main" }, state: "open", merged: false, html_url: "u" },
    });
    api(`repos/${SLUG}`, { json: { default_branch: "main" } });
    api(`repos/${SLUG}/branches/main`, {
        json: { protection: { required_status_checks: { contexts: ["build"] } } },
    });
    api(`repos/${SLUG}/rules/branches/main`, { json: [] });
    api(`repos/${SLUG}/commits/${SHA}/status?per_page=100`, { json: { statuses: [] } });
    api(`repos/${SLUG}/commits/${SHA}/check-runs?per_page=100`, {
        json: {
            total_count: 1,
            check_runs: [
                { id: 9, name: "build", status: "completed", conclusion, html_url: "https://ci.example.test/9" },
            ],
        },
    });
}

async function poll(watched: GithubSpec = spec): Promise<WatchResult | undefined> {
    const kind = h.jig.kinds.get("ops-ci") as unknown as {
        poll(s: unknown, st: unknown, signal: AbortSignal): Promise<{ done?: WatchResult }>;
    };
    return (await kind.poll(watched, undefined, new AbortController().signal)).done;
}

test("a watch that passes publishes the repository, the commit, the pull request and the finish line", async () => {
    serve("success");
    const done = await poll();
    assert.equal(done?.outcome, "passed");
    assert.equal(CI_FINISHED_EVENT, "jig-ops:ci-finished");
    assert.deepEqual(
        events().map((entry) => entry.payload),
        [
            {
                repo: SLUG,
                service: "orders-api",
                system: "github-actions",
                sha: SHA,
                branch: "feature/one",
                pr: 42,
                finish: "required",
                outcome: "passed",
                summary: done?.summary,
            } satisfies CiFinished,
        ],
    );
});

test("a watch that fails publishes it too, so the other side can tell failed from not yet", async () => {
    serve("failure");
    const done = await poll();
    assert.equal(done?.outcome, "failed");
    assert.equal((events()[0]?.payload as CiFinished | undefined)?.outcome, "failed");
});

test("a watch with no commit to tie it to publishes nothing", async () => {
    serve("success");
    const { sha: _sha, ...withoutCommit } = spec;
    const done = await poll(withoutCommit);
    assert.equal(done?.outcome, "passed");
    assert.deepEqual(events(), []);
});

test("a watch that is still waiting publishes nothing", async () => {
    serve("success");
    api(`repos/${SLUG}/commits/${SHA}/check-runs?per_page=100`, {
        json: {
            total_count: 1,
            check_runs: [{ id: 9, name: "build", status: "in_progress", conclusion: null, html_url: "u" }],
        },
    });
    assert.equal(await poll(), undefined);
    assert.deepEqual(events(), []);
});

describe("what the event says, for each system", () => {
    const done: WatchResult = { outcome: "passed", summary: "ok" };
    const publish = (
        service: { name: string; repo?: string },
        watched: GithubSpec | GitlabSpec | JenkinsSpec,
        result = done,
    ) => {
        const published: Array<[string, unknown]> = [];
        announceFinished((event, payload) => void published.push([event, payload]), service, watched, result);
        return published.map(([, payload]) => payload as CiFinished);
    };

    test("GitLab: the branch is the ref; Jenkins has no branch or pull request", () => {
        const gitlab: GitlabSpec = {
            system: "gitlab",
            service: "s",
            ref: "main",
            sha: SHA,
            finish: { kind: "pipeline" },
            since: 1,
        };
        const jenkins: JenkinsSpec = {
            system: "jenkins",
            service: "s",
            sha: SHA,
            finish: { kind: "stages", names: ["Build"] },
            since: 1,
        };
        assert.deepEqual(publish({ name: "s", repo: "acme/s" }, gitlab)[0], {
            repo: "acme/s",
            service: "s",
            system: "gitlab",
            sha: SHA,
            branch: "main",
            finish: "pipeline",
            outcome: "passed",
            summary: "ok",
        });
        const found = publish({ name: "s", repo: "acme/s" }, jenkins)[0];
        assert.equal(found?.finish, "stages");
        assert.equal("branch" in (found ?? {}), false);
        assert.equal("pr" in (found ?? {}), false);
    });

    test("a service with no repo, and a result that is not passed or failed, publish nothing", () => {
        const gitlab: GitlabSpec = { system: "gitlab", service: "s", sha: SHA, finish: { kind: "pipeline" }, since: 1 };
        assert.deepEqual(publish({ name: "s" }, gitlab), []);
        for (const outcome of ["timed-out", "stopped", "error"] as const) {
            assert.deepEqual(publish({ name: "s", repo: "acme/s" }, gitlab, { outcome, summary: "x" }), [], outcome);
        }
    });

    test("a listener that throws does not change the result", () => {
        const gitlab: GitlabSpec = { system: "gitlab", service: "s", sha: SHA, finish: { kind: "pipeline" }, since: 1 };
        assert.doesNotThrow(() =>
            announceFinished(
                () => {
                    throw new Error("a listener broke");
                },
                { name: "s", repo: "acme/s" },
                gitlab,
                done,
            ),
        );
    });
});
