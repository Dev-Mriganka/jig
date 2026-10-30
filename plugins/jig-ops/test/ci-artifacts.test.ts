// The "artifact ready" rules and the event they publish. These were the tests of jig-git's artifact rules; the rules are now
// `ops.artifacts`, the event is `jig-ops:artifact-ready`, and a watch of any CI system tests them when it has passed.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { PollOutcome } from "../../jig-core/src/contract.ts";
import { ARTIFACT_EVENT, testArtifacts } from "../src/ci/artifacts.ts";
import type { ArtifactReady, ArtifactSources } from "../src/ci/artifacts.ts";
import type { GithubState } from "../src/ci/github-checks.ts";
import type { GithubSpec } from "../src/ci/github-watch.ts";
import type { Check } from "../src/ci/model.ts";
import type { ArtifactRule } from "../src/ci/settings.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { section } from "./support/section.ts";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const SHORT = "abcdef0";

/** Sources that answer from lists, and remember what was asked. */
function sources(
    parts: Partial<{
        checks: Check[];
        logs: Record<number, string>;
        comments: Awaited<ReturnType<ArtifactSources["comments"]>>;
        tags: Awaited<ReturnType<ArtifactSources["tags"]>>;
        releases: Awaited<ReturnType<ArtifactSources["releases"]>>;
    }>,
) {
    const asked: string[] = [];
    const source: ArtifactSources = {
        checks: async () => (asked.push("checks"), parts.checks ?? []),
        log: async (id) => (asked.push(`log ${id}`), parts.logs?.[id] ?? ""),
        comments: async () => (asked.push("comments"), parts.comments ?? []),
        tags: async () => (asked.push("tags"), parts.tags ?? []),
        releases: async () => (asked.push("releases"), parts.releases ?? []),
    };
    return { source, asked };
}

async function test_(
    rules: ArtifactRule[],
    parts: Parameters<typeof sources>[0],
    pr: number | null = 42,
): Promise<{ found: ArtifactReady[]; events: Array<[string, unknown]>; asked: string[] }> {
    const { source, asked } = sources(parts);
    const events: Array<[string, unknown]> = [];
    const found = await testArtifacts({
        repo: "acme/svc",
        pr: pr ?? undefined,
        sha: SHA,
        rules,
        sources: source,
        announce: (event, payload) => void events.push([event, payload]),
    });
    return { found, events, asked };
}

const build = (bucket: Check["bucket"], id = 9): Check => ({ name: "build-image", bucket, id });
const bot = (login: string, body: string) => ({ login, bot: true, body, createdAt: "2026-10-30T10:00:00Z", url: "u" });

test("a named job that succeeded for the head commit is an artifact; the event carries the repository, pull request, commit, kind and source", async () => {
    const { found, events, asked } = await test_([{ kind: "image", check: "build-image" }], {
        checks: [build("pass")],
    });
    assert.deepEqual(found, [{ repo: "acme/svc", pr: 42, sha: SHA, kind: "image", ref: SHORT, source: "check" }]);
    assert.deepEqual(events, [[ARTIFACT_EVENT, found[0]]]);
    assert.equal(ARTIFACT_EVENT, "jig-ops:artifact-ready");
    assert.deepEqual(asked, ["checks"]);
    assert.equal((await test_([{ kind: "image", check: "build-image" }], { checks: [build("fail")] })).found.length, 0);
    assert.equal(
        (await test_([{ kind: "image", check: "build-image" }], { checks: [build("pending")] })).found.length,
        0,
    );
    assert.equal((await test_([{ kind: "image", check: "build-image" }], { checks: [] })).found.length, 0);
});

test("a version read from the job's log must contain the short commit id; others belong to other builds", async () => {
    const log = [
        "2026-10-30T10:00:00.0000000Z pushed registry/app:1.1-1234567",
        "2026-10-30T10:00:01.0000000Z pushed registry/app:1.2-abcdef0",
        "2026-10-30T10:00:02.0000000Z pushed registry/app:1.3-abcdef0-extra",
    ].join("\n");
    const rule: ArtifactRule = { kind: "image", check: "build-image", log: "pushed (\\S+)" };
    const { found, asked } = await test_([rule], { checks: [build("pass", 9)], logs: { 9: log } });
    assert.deepEqual(
        found.map((a) => [a.kind, a.ref, a.source]),
        [["image", "registry/app:1.2-abcdef0", "log"]],
    );
    assert.deepEqual(asked, ["checks", "log 9"]);
    const other = await test_([rule], { checks: [build("pass", 9)], logs: { 9: "pushed registry/app:1.1-1234567\n" } });
    assert.deepEqual(other.found, [], "the only version in the log is of another commit");
    assert.deepEqual(other.events, []);
    const whole = await test_([{ kind: "image", check: "build-image", log: "registry/app:\\S+" }], {
        checks: [build("pass", 9)],
        logs: { 9: "built registry/app:2.0-abcdef0\n" },
    });
    assert.equal(whole.found[0]?.ref, "registry/app:2.0-abcdef0", "without a group the whole match is the version");
});

test("a bot's comment on the pull request: the named bot, or any bot; a person's comment is not an artifact", async () => {
    const rule: ArtifactRule = { kind: "image", comment: "image: (\\S+)", bot: "ci-bot" };
    const comments = [
        { login: "hp", bot: false, body: `image: fake-${SHORT}`, createdAt: "", url: "" },
        bot("other-bot", `image: other-${SHORT}`),
        bot("ci-bot", "image: old-1234567"),
        bot("ci-bot", `image: app:1.2-${SHORT}`),
    ];
    assert.equal((await test_([rule], { comments })).found[0]?.ref, `app:1.2-${SHORT}`);
    assert.equal((await test_([rule], { comments })).found[0]?.source, "comment");
    assert.equal(
        (await test_([{ kind: "image", comment: "image: (\\S+)" }], { comments })).found[0]?.ref,
        `other-${SHORT}`,
        "without a name, the first bot that matches",
    );
    assert.equal((await test_([rule], { comments }, null)).found.length, 0, "comments belong to a pull request");
});

test("a new tag that matches, on the watched commit or carrying its id; a release by its tag", async () => {
    const tags = [
        { name: "v1.0.0", sha: "1".repeat(40) },
        { name: "v1.1.0", sha: SHA },
        { name: `build-${SHORT}`, sha: "2".repeat(40) },
    ];
    assert.deepEqual(
        (await test_([{ kind: "tag", tag: "^v1\\." }], { tags })).found.map((a) => [a.ref, a.source]),
        [["v1.1.0", "tag"]],
    );
    assert.deepEqual(
        (await test_([{ kind: "tag", tag: "^build-" }], { tags })).found.map((a) => a.ref),
        [`build-${SHORT}`],
    );
    assert.equal((await test_([{ kind: "tag", tag: "^v2" }], { tags })).found.length, 0);
    const releases = [
        { tag: "v1.1.0", name: "One one", url: "u" },
        { tag: "v0.9.0", name: "Old", url: "u" },
    ];
    const release = await test_([{ kind: "release", tag: "^v" }], { tags, releases });
    assert.deepEqual(
        release.found.map((a) => [a.kind, a.ref, a.source]),
        [["release", "v1.1.0", "release"]],
    );
});

test("the same artifact is announced once, and every rule is tested", async () => {
    const rules: ArtifactRule[] = [
        { kind: "image", check: "build-image" },
        { kind: "image", check: "build-image" },
        { kind: "tag", tag: "^v1\\." },
    ];
    const { found, events } = await test_(rules, { checks: [build("pass")], tags: [{ name: "v1.1.0", sha: SHA }] });
    assert.equal(found.length, 2);
    assert.equal(events.length, 2);
});

// ---- as part of a watch -------------------------------------------------------------------------------------------

let h: Harness;
beforeEach(() => {
    h = setupHarness();
    h.jig.publish();
});
afterEach(() => h.close());

/** The `ops` section with these artifact rules (none when `rules` is undefined). */
function rules(list: ArtifactRule[] | undefined): void {
    h.configure({ ...section(), ...(list === undefined ? {} : { artifacts: list }) });
}

const SLUG = "acme/orders-api";
const api = (path: string, reply: Parameters<Harness["gh"]["on"]>[1]) => h.gh.on("api", reply, [`=${path}`]);
const run = (id: number, name: string, conclusion: string | null) => ({
    id,
    name,
    status: conclusion ? "completed" : "in_progress",
    conclusion,
    html_url: `https://github.com/${SLUG}/actions/runs/1/job/${id}`,
});

async function poll(spec: GithubSpec): Promise<PollOutcome<GithubState>> {
    const kind = h.jig.kinds.get("ops-ci") as unknown as {
        poll(s: unknown, st: unknown, signal: AbortSignal): Promise<unknown>;
    };
    return (await kind.poll(spec, undefined, new AbortController().signal)) as PollOutcome<GithubState>;
}

const spec: GithubSpec = {
    system: "github-actions",
    service: "orders-api",
    pr: 42,
    branch: "feature/one",
    sha: SHA,
    finish: { kind: "required" },
};

function serve(checkRuns: ReturnType<typeof run>[]): void {
    api(`repos/${SLUG}/pulls/42`, {
        json: { head: { sha: SHA }, base: { ref: "main" }, state: "open", merged: false, html_url: "u" },
    });
    api(`repos/${SLUG}`, { json: { default_branch: "main" } });
    api(`repos/${SLUG}/branches/main`, {
        json: { protection: { required_status_checks: { contexts: ["build-image"] } } },
    });
    api(`repos/${SLUG}/rules/branches/main`, { json: [] });
    api(`repos/${SLUG}/commits/${SHA}/status?per_page=100`, { json: { statuses: [] } });
    api(`repos/${SLUG}/commits/${SHA}/check-runs?per_page=100`, {
        json: { total_count: checkRuns.length, check_runs: checkRuns },
    });
}

test("when a watch passes, the artifact rules in git.artifacts are tested and the event is published", async () => {
    rules([{ kind: "image", check: "build-image", log: "pushed (\\S+)" }]);
    serve([run(9, "build-image", "success")]);
    api(`repos/${SLUG}/actions/jobs/9/logs`, {
        stdout: `2026-10-30T10:00:00.0000000Z pushed registry/app:1.2-${SHORT}\n`,
    });
    const { done } = await poll(spec);
    assert.equal(done?.outcome, "passed");
    assert.equal(done?.details, `Ready: image registry/app:1.2-${SHORT}`);
    assert.equal(done?.facts?.artifacts, 1);
    assert.deepEqual(h.bus.emitted, [
        {
            event: "jig-ops:artifact-ready",
            payload: { repo: SLUG, pr: 42, sha: SHA, kind: "image", ref: `registry/app:1.2-${SHORT}`, source: "log" },
        },
    ]);
});

test("a version of another commit in the log is ignored: no event, no mention", async () => {
    rules([{ kind: "image", check: "build-image", log: "pushed (\\S+)" }]);
    serve([run(9, "build-image", "success")]);
    api(`repos/${SLUG}/actions/jobs/9/logs`, {
        stdout: "2026-10-30T10:00:00.0000000Z pushed registry/app:1.2-1234567\n",
    });
    const { done } = await poll(spec);
    assert.equal(done?.outcome, "passed");
    assert.equal(done?.details, undefined);
    assert.deepEqual(h.bus.emitted, []);
});

test("a watch that fails publishes nothing, and without rules nothing is read", async () => {
    rules([{ kind: "image", check: "build-image" }]);
    serve([run(9, "build-image", "failure")]);
    api(`repos/${SLUG}/actions/jobs/9/logs`, { stdout: "boom" });
    assert.equal((await poll(spec)).done?.outcome, "failed");
    assert.deepEqual(h.bus.emitted, []);
    rules(undefined);
    h.gh.reset();
    serve([run(9, "build-image", "success")]);
    assert.equal((await poll(spec)).done?.outcome, "passed");
    assert.deepEqual(h.bus.emitted, []);
});

test("a rule that cannot be tested does not lose the result: the watch still reports, with a note", async () => {
    rules([{ kind: "image", check: "build-image", log: "pushed (\\S+)" }]);
    serve([run(9, "build-image", "success")]);
    api(`repos/${SLUG}/actions/jobs/9/logs`, { code: 1, stderr: "gh: Gone (HTTP 410)" });
    const { done } = await poll(spec);
    assert.equal(done?.outcome, "passed");
    assert.match(done?.details ?? "", /^The artifact rules could not be tested: the log of job 9 is not available/);
});

test("a comment watch ends the same way: the comment is an artifact when a rule says so", async () => {
    const since = "2026-10-30T10:00:00.000Z";
    rules([{ kind: "image", comment: "image: (\\S+)", bot: "ci-bot" }]);
    const comment = {
        user: { login: "ci-bot", type: "Bot" },
        body: `image: registry/app:1.2-${SHORT}`,
        created_at: "2026-10-30T10:05:00Z",
        html_url: "c",
    };
    api(`repos/${SLUG}/issues/42/comments?per_page=100&since=${encodeURIComponent(since)}`, { json: [comment] });
    api(`repos/${SLUG}/issues/42/comments?per_page=100`, { json: [comment] });
    const { done } = await poll({
        system: "github-actions",
        service: "orders-api",
        pr: 42,
        sha: SHA,
        finish: { kind: "comment", pattern: "image: ", since },
    });
    assert.equal(done?.outcome, "passed");
    assert.equal(h.bus.emitted[0]?.event, "jig-ops:artifact-ready");
    assert.equal((h.bus.emitted[0]?.payload as ArtifactReady).source, "comment");
});
