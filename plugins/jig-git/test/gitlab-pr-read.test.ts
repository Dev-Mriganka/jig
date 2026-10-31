// `pr` on a GitLab project, read only: view, list and comments. GitLab is a fake `glab` that answers `glab api` from answers
// written down in the shape of GitLab's REST API (see support/gitlab-answers.ts). Nothing here reaches a GitLab server.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { did, diffNote, discussion, job, mr, note, person, stamp, threadNote } from "./support/gitlab-answers.ts";
import { commitFile, git, makeRepo } from "./support/repos.ts";
import type { Fixture } from "./support/repos.ts";

let h: Harness;
let counter = 0;

before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

interface Project {
    r: Fixture;
    /** The project's path, `acme/orders-apiN`. */
    path: string;
    /** `projects/acme%2Forders-apiN`, the start of every address. */
    base: string;
}

/** A clone of acme/orders-apiN on gitlab.com, on feature/one with one commit. */
function project(): Project {
    const r = makeRepo(h.sb, `orders-api${++counter}`, "acme", "gitlab.com");
    git(r.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    commitFile(r.dir, "x.ts", "x\n", "Add x");
    const path = `acme/${r.name}`;
    return { r, path, base: `projects/${encodeURIComponent(path)}` };
}

/** What a merge request of this project looks like, and the jobs of its pipeline. */
function serveMr(p: Project, overrides: Record<string, unknown> = {}, jobs: unknown[] = []): void {
    h.glab.on("api", { json: mr(overrides, p.path) }, [`=${p.base}/merge_requests/42`]);
    h.glab.on("api", { json: jobs }, [`${p.base}/pipelines/301/jobs`]);
}

const apiCalls = () => h.glab.callsOf("api").map((call) => call.args);

// ---- view ---------------------------------------------------------------------------------------------------------

test("view: title, state, branches, merge status, the checks of the pipeline, labels, reviewers and the URL, all through glab", async () => {
    const p = project();
    serveMr(p, {}, [
        job("build", "success"),
        job("unit", "failed"),
        job("lint", "failed", { allow_failure: true }),
        job("e2e", "skipped"),
        job("deploy", "manual"),
        job("slow", "running"),
    ]);
    const text = ok(await h.call("pr", { action: "view", repo: p.r.name, number: 42 }));
    assert.match(text, new RegExp(`^MR !42 Add the thing \\[opened\\] by @hp in ${p.r.name}\\n`));
    assert.match(text, /feature\/one -> main at 1111111; merge status: mergeable; pipeline #301 failed\n/);
    assert.match(
        text,
        /checks: 2 pass, 1 fail, 2 pending, 1 skipped; failing: unit\n/,
        "a job that may fail does not fail",
    );
    assert.match(
        text,
        /labels: bug\nreview requested from: alice\nhttps:\/\/gitlab\.example\.com\/acme\/orders-api\d+\/-\/merge_requests\/42/,
    );
    assert.match(text, /What changed and why\.$/);
    assert.deepEqual(apiCalls()[0], ["api", "--hostname", "gitlab.com", `${p.base}/merge_requests/42`]);
    assert.deepEqual(apiCalls()[1]?.slice(-1), [`${p.base}/pipelines/301/jobs?per_page=100`]);
    assert.equal(h.gh.calls().length, 0, "gh is not run for a GitLab project");
});

test("view: without a number it selects the open merge request of the checked-out branch", async () => {
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: [mr({}, p.path)] }, ["merge_requests?source_branch=feature%2Fone&state=opened"]);
    const text = ok(await h.call("pr", { action: "view", repo: p.r.name }));
    assert.match(text, /^MR !42 /);
    assert.deepEqual(apiCalls()[0], [
        "api",
        "--hostname",
        "gitlab.com",
        `${p.base}/merge_requests?source_branch=feature%2Fone&state=opened&per_page=5&order_by=updated_at&sort=desc`,
    ]);
});

test("view: a branch with only a merged merge request shows that one; a branch with none says so", async () => {
    const p = project();
    serveMr(p, { state: "merged" });
    h.glab.on("api", { json: [mr({ state: "merged" }, p.path)] }, ["state=all"]);
    h.glab.on("api", { json: [] }, ["state=opened"]);
    assert.match(
        ok(await h.call("pr", { action: "view", repo: p.r.name, branch: "feature/one" })),
        /^MR !42 .*\[merged\]/,
    );
    h.glab.reset();
    h.glab.on("api", { json: [] }, ["merge_requests?"]);
    const none = await h.call("pr", { action: "view", repo: p.r.name });
    assert.equal(
        none.error?.message,
        `no merge request for feature/one in ${p.r.name}: pass number, or open one with pr create`,
    );
});

test("view: a draft, a conflict, auto-merge and a merge request without a pipeline are told", async () => {
    const p = project();
    serveMr(p, {
        title: "Draft: Add the thing",
        draft: true,
        has_conflicts: true,
        detailed_merge_status: "conflict",
        merge_when_pipeline_succeeds: true,
        head_pipeline: null,
        reviewers: [],
        labels: [],
    });
    const text = ok(await h.call("pr", { action: "view", repo: p.r.name, number: 42 }));
    assert.match(text, /^MR !42 Draft: Add the thing \[opened, draft\]/);
    assert.match(
        text,
        /merge status: conflict\nchecks: none \(no pipeline\)\nauto-merge on \(when the pipeline succeeds\)\n/,
    );
    assert.doesNotMatch(text, /labels:|review requested/);
    assert.equal(apiCalls().length, 1, "no pipeline, no request for its jobs");
});

test("view: a long body is cut and says by how much; a failure is one line, and a missing sign-in says how to mend it", async () => {
    const p = project();
    serveMr(p, { description: "Long line. ".repeat(900) });
    assert.match(
        ok(await h.call("pr", { action: "view", repo: p.r.name, number: 42 })),
        /\.\.\.\n\(\d+ more characters\)$/,
    );
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 401 Unauthorized (HTTP 401)\nmore detail\n" });
    const failed = await h.call("pr", { action: "view", repo: p.r.name, number: 42 });
    assert.equal(
        failed.error?.message,
        "glab api (merge request) failed: glab: 401 Unauthorized (HTTP 401); more detail (glab is not signed in for gitlab.com: run glab auth login --hostname gitlab.com yourself)",
    );
});

test("view: a project in a subgroup of a self-hosted GitLab is asked for by its whole path on its own host", async () => {
    h.jig.setSection("git", { forges: { "gitlab.example.com": "gitlab" } });
    const r = makeRepo(h.sb, `orders-api${++counter}`, "platform/payments", "gitlab.example.com");
    const base = `projects/${encodeURIComponent(`platform/payments/${r.name}`)}`;
    h.glab.on("api", { json: mr({}, `platform/payments/${r.name}`) }, [`=${base}/merge_requests/42`]);
    h.glab.on("api", { json: [] }, [`${base}/pipelines/301/jobs`]);
    assert.match(ok(await h.call("pr", { action: "view", repo: r.name, number: 42 })), /^MR !42 /);
    assert.deepEqual(apiCalls()[0], ["api", "--hostname", "gitlab.example.com", `${base}/merge_requests/42`]);
    assert.ok(base.includes("platform%2Fpayments%2F"));
});

// ---- list ---------------------------------------------------------------------------------------------------------

const row = (iid: number, overrides: Record<string, unknown> = {}) => ({
    iid,
    title: "Old",
    state: "opened",
    draft: false,
    source_branch: "feature/two",
    target_branch: "main",
    author: person("hp"),
    web_url: "u",
    ...overrides,
});

test("list: open by default, with the draft prefix left off the title", async () => {
    const p = project();
    h.glab.on("api", {
        json: [row(3, { draft: true, title: "Draft: Old" }), row(4, { title: "Fresh", author: null })],
    });
    assert.equal(
        ok(await h.call("pr", { action: "list", repo: p.r.name })),
        `${p.r.name}: 2 merge requests\n!3 opened draft feature/two -> main  Old  @hp\n!4 opened feature/two -> main  Fresh`,
    );
    assert.deepEqual(apiCalls()[0], [
        "api",
        "--hostname",
        "gitlab.com",
        `${p.base}/merge_requests?state=opened&per_page=20&order_by=updated_at&sort=desc`,
    ]);
    h.glab.reset();
    h.glab.on("api", { json: [] });
    assert.match(ok(await h.call("pr", { action: "list", repo: p.r.name })), /^No merge requests match in /);
});

test("list: state, author, branch and limit become GitLab's filters; @me is the merge requests you created; the limit is capped", async () => {
    const p = project();
    h.glab.on("api", { json: [] });
    ok(
        await h.call("pr", {
            action: "list",
            repo: p.r.name,
            state: "merged",
            author: "@me",
            branch: "feature/two",
            limit: 99,
        }),
    );
    ok(await h.call("pr", { action: "list", repo: p.r.name, state: "all", author: "@alice" }));
    ok(await h.call("pr", { action: "list", repo: p.r.name, state: "closed", limit: 1 }));
    assert.deepEqual(
        apiCalls().map((args) => args.at(-1)),
        [
            `${p.base}/merge_requests?state=merged&per_page=50&order_by=updated_at&sort=desc&scope=created_by_me&source_branch=feature%2Ftwo`,
            `${p.base}/merge_requests?state=all&per_page=20&order_by=updated_at&sort=desc&author_username=alice`,
            `${p.base}/merge_requests?state=closed&per_page=1&order_by=updated_at&sort=desc`,
        ],
    );
    assert.match(
        (await h.call("pr", { action: "list", repo: p.r.name, state: "weird" })).error?.message ?? "",
        /Expected union value|state must be one of/,
    );
});

// ---- comments -----------------------------------------------------------------------------------------------------

/** What the discussions of a merge request hold: a comment, a thread on a line with a reply, a resolved thread, a system note. */
const DISCUSSIONS = [
    discussion(did(1), [note(5001, "lead", "Please also update the docs.")], true),
    discussion(did(2), [
        diffNote(7001, "alice", `Expired orders stay submittable: ${"detail ".repeat(80)}end`),
        diffNote(7002, "hp", "agreed, fixing"),
    ]),
    discussion(did(3), [threadNote(8001, "bob", "Is the retry needed?", { resolved: true })]),
    discussion(did(4), [note(9001, "hp", "added 1 commit", { system: true })], true),
    discussion(did(5), [note(9002, "renovate-bot", "")], true),
];

test("comments: single comments and threads together, with the thread ids that pr reply takes; system notes are not comments", async () => {
    const p = project();
    h.glab.on("api", { json: DISCUSSIONS }, ["discussions?per_page=100&page=1"]);
    const text = ok(await h.call("pr", { action: "comments", repo: p.r.name, number: 42 }));
    const lines = text.split("\n");
    assert.equal(lines[0], "merge request 42: 3 items");
    assert.equal(lines[1], `${stamp(5001).slice(0, 16)} comment @lead (thread 42:${did(1)})`);
    assert.equal(lines[2], "    Please also update the docs.");
    assert.equal(lines[3], `thread 42:${did(2)} src/orders.ts:42 [unresolved]`);
    assert.equal(lines[4], `  @alice ${stamp(7001).slice(0, 16)}`);
    assert.match(lines[5] ?? "", /^ {6}Expired orders stay submittable: detail detail/);
    assert.equal(lines[6], `  reply @hp ${stamp(7002).slice(0, 16)}`);
    assert.equal(lines[7], "      agreed, fixing");
    assert.equal(lines[8], `thread 42:${did(3)} [resolved]`);
    assert.equal(lines[9], `  @bob ${stamp(8001).slice(0, 16)}`);
    assert.doesNotMatch(text, /added 1 commit/);
    assert.equal(
        (h.glab.callsOf("api")[0]?.args ?? []).at(-1),
        `${p.base}/merge_requests/42/discussions?per_page=100&page=1`,
    );
});

test("comments: unresolved keeps the open threads; author keeps the threads a person took part in", async () => {
    const p = project();
    h.glab.on("api", { json: DISCUSSIONS }, ["discussions"]);
    const open = ok(await h.call("pr", { action: "comments", repo: p.r.name, number: 42, unresolved: true }));
    assert.match(open, /^merge request 42: 1 item\nthread 42:0+2 src\/orders\.ts:42 \[unresolved\]/);
    assert.doesNotMatch(open, /Please also update|\[resolved\]/);
    const alice = ok(await h.call("pr", { action: "comments", repo: p.r.name, number: 42, author: "@Alice" }));
    assert.match(alice, /^merge request 42: 1 item\nthread 42:0+2 /);
    assert.match(alice, /reply @hp/, "the whole thread is shown");
    const none = ok(
        await h.call("pr", { action: "comments", repo: p.r.name, number: 42, unresolved: true, author: "lead" }),
    );
    assert.equal(none, "merge request 42: nothing to show (no unresolved threads).");
});

test("comments: a branch finds its merge request; nothing to show is said", async () => {
    const p = project();
    h.glab.on("api", { json: [] }, ["discussions"]);
    h.glab.on("api", { json: [mr({}, p.path)] }, ["merge_requests?source_branch=feature%2Fone&state=opened"]);
    assert.equal(ok(await h.call("pr", { action: "comments", repo: p.r.name })), "merge request 42: nothing to show.");
});

test("comments: pages are followed up to five, and a longer list says only the first 500 threads are read", async () => {
    const p = project();
    h.glab.on("api", { json: [DISCUSSIONS[0]], headers: { "X-Next-Page": "9" } }, ["discussions"]);
    const text = ok(await h.call("pr", { action: "comments", repo: p.r.name, number: 42 }));
    assert.equal(h.glab.callsOf("api").length, 5);
    assert.match(text, /\n\(GitLab holds more than 500 threads; only the first 500 are read\)$/);
    h.glab.reset();
    h.glab.on("api", { json: [DISCUSSIONS[0]], headers: { "X-Next-Page": "" } }, ["page=1"]);
    assert.doesNotMatch(
        ok(await h.call("pr", { action: "comments", repo: p.r.name, number: 42 })),
        /GitLab holds more/,
    );
});

test("comments: a note with no author is told from 'unknown'", async () => {
    const p = project();
    h.glab.on("api", { json: [discussion(did(1), [note(5001, "x", "orphan", { author: null })], true)] });
    assert.match(
        ok(await h.call("pr", { action: "comments", repo: p.r.name, number: 42 })),
        /comment @unknown \(thread/,
    );
});
