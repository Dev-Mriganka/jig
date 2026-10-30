import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo, writeFile } from "./support/repos.ts";
import type { Fixture } from "./support/repos.ts";

let h: Harness;
let counter = 0;

before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

const BODY = "## What\nAdds x.\n\n## Why\nBecause the thing needs x.\n\n## Tested\nunit tests";

/** A clone of acme/<name> on feature/one with one commit, pushed or not. */
function featureRepo(pushed = true): Fixture {
    const r = makeRepo(h.sb, `svc${++counter}`, "acme");
    git(r.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    commitFile(r.dir, "x.ts", "x\n", "Add x");
    if (pushed) git(r.dir, "push", "-q", "-u", "origin", "feature/one");
    return r;
}

function prJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        number: 42,
        title: "Add the thing",
        state: "OPEN",
        isDraft: false,
        author: { login: "hp" },
        baseRefName: "main",
        headRefName: "feature/one",
        headRefOid: "1111111111111111111111111111111111111111",
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        statusCheckRollup: [
            { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
            { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
        ],
        url: "https://github.com/acme/svc/pull/42",
        body: "What changed and why.",
        labels: [{ name: "bug" }],
        reviewRequests: [{ login: "alice" }],
        autoMergeRequest: null,
        ...overrides,
    };
}

const writes = (verb: string) => h.gh.callsOf(`pr ${verb}`);

// ---- view and list ------------------------------------------------------------------------------------------------

test("view: title, state, branches, mergeability, review, checks, labels and the URL; gh is pinned with -R", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson() });
    const text = ok(await h.call("pr", { action: "view", repo: r.name, number: 42 }));
    assert.match(text, /^PR #42 Add the thing \[open\] by @hp in svc\d+\n/);
    assert.match(text, /feature\/one -> main at 1111111; mergeable: MERGEABLE; review: APPROVED/);
    assert.match(text, /checks: 1 pass, 1 fail, 0 pending, 0 skipped; failing: unit/);
    assert.match(text, /labels: bug\nreview requested from: alice\nhttps:\/\/github\.com\/acme\/svc\/pull\/42/);
    assert.match(text, /What changed and why\.$/);
    const call = h.gh.calls()[0]?.args ?? [];
    assert.deepEqual(call.slice(0, 4), ["pr", "view", "42", "--json"]);
    assert.deepEqual(call.slice(-2), ["-R", `acme/${r.name}`]);
});

test("view: without a number it selects the checked-out branch; auto-merge is shown; a failure is one line", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson({ autoMergeRequest: { mergeMethod: "SQUASH" } }) });
    assert.match(ok(await h.call("pr", { action: "view", repo: r.name })), /auto-merge on \(squash\)/);
    assert.equal(h.gh.calls()[0]?.args[2], "feature/one");
    h.gh.reset();
    h.gh.on("pr view", { code: 1, stderr: "HTTP 401: Bad credentials\nmore detail\n" });
    const failed = await h.call("pr", { action: "view", repo: r.name, number: 42 });
    assert.match(
        failed.error?.message ?? "",
        /^gh pr view failed: HTTP 401: Bad credentials; more detail \(gh is not signed in: run gh auth login yourself\)$/,
    );
});

test("view: a long body is cut and says by how much", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson({ body: "Long line. ".repeat(900) }) });
    const text = ok(await h.call("pr", { action: "view", repo: r.name, number: 42 }));
    assert.match(text, /\.\.\.\n\(\d+ more characters\)$/);
});

test("list: open by default; state, author and branch filters; the limit is capped", async () => {
    const r = featureRepo();
    h.gh.on("pr list", {
        json: [
            {
                number: 3,
                title: "Old",
                state: "OPEN",
                isDraft: true,
                headRefName: "feature/two",
                baseRefName: "main",
                url: "u",
                author: { login: "hp" },
            },
        ],
    });
    assert.match(
        ok(await h.call("pr", { action: "list", repo: r.name })),
        /^svc\d+: 1 pull request\n#3 open draft feature\/two -> main {2}Old {2}@hp$/,
    );
    assert.deepEqual(h.gh.calls()[0]?.args.slice(0, 7), ["pr", "list", "--state", "open", "--limit", "20", "--json"]);
    ok(
        await h.call("pr", {
            action: "list",
            repo: r.name,
            state: "merged",
            author: "@me",
            branch: "feature/two",
            limit: 50,
        }),
    );
    const args = h.gh.calls()[1]?.args ?? [];
    assert.equal(args[args.indexOf("--state") + 1], "merged");
    assert.ok(args.includes("--author=@me"));
    assert.equal(args[args.indexOf("--head") + 1], "feature/two");
    assert.equal(args[args.indexOf("--limit") + 1], "50");
    h.gh.on("pr list", { json: [] });
    assert.match(ok(await h.call("pr", { action: "list", repo: r.name })), /No pull requests match/);
    assert.match(
        (await h.call("pr", { action: "list", repo: r.name, state: "weird" })).error?.message ?? "",
        /Expected union value|state must be one of/,
    );
});

// ---- comments -----------------------------------------------------------------------------------------------------

const THREADS = {
    data: {
        repository: {
            pullRequest: {
                number: 54,
                url: "https://github.com/acme/svc/pull/54",
                comments: {
                    totalCount: 1,
                    nodes: [
                        {
                            author: { login: "lead" },
                            body: "Please also update the docs.",
                            createdAt: "2026-10-01T10:00:00Z",
                            url: "u1",
                        },
                    ],
                },
                reviews: {
                    totalCount: 2,
                    nodes: [
                        {
                            author: { login: "reviewer-bot" },
                            state: "COMMENTED",
                            body: "Changes recommended",
                            submittedAt: "2026-10-02T09:00:00Z",
                            url: "u2",
                        },
                        {
                            author: { login: "other" },
                            state: "APPROVED",
                            body: "",
                            submittedAt: "2026-10-02T09:05:00Z",
                            url: "u3",
                        },
                    ],
                },
                reviewThreads: {
                    totalCount: 2,
                    nodes: [
                        {
                            id: "PRRT_kwDOAAAA1",
                            isResolved: false,
                            isOutdated: false,
                            path: "src/Service.java",
                            line: 66,
                            comments: {
                                nodes: [
                                    {
                                        author: { login: "reviewer-bot" },
                                        body: `Expired orders stay submittable: ${"detail ".repeat(80)}end`,
                                        createdAt: "2026-10-02T09:00:01Z",
                                        url: "t1",
                                    },
                                    {
                                        author: { login: "hp" },
                                        body: "agreed, fixing",
                                        createdAt: "2026-10-02T10:00:00Z",
                                        url: "t2",
                                    },
                                ],
                            },
                        },
                        {
                            id: "PRRT_kwDOAAAA2",
                            isResolved: true,
                            isOutdated: true,
                            path: "src/Repo.java",
                            line: null,
                            comments: {
                                nodes: [
                                    {
                                        author: { login: "lead" },
                                        body: "nit: rename",
                                        createdAt: "2026-10-02T09:30:00Z",
                                        url: "t3",
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    },
};

test("comments: the conversation, reviews and line-comment threads in time order, with thread ids and whole bodies", async () => {
    const r = featureRepo();
    h.gh.on("api graphql", { json: THREADS });
    const text = ok(await h.call("pr", { action: "comments", repo: r.name, number: 54 }));
    const lines = text.split("\n");
    assert.equal(lines[0], "pull request 54: 4 items");
    assert.match(lines[1] ?? "", /^2026-10-01T10:00 comment @lead$/);
    assert.match(text, /2026-10-02T09:00 review commented @reviewer-bot\n {4}Changes recommended/);
    assert.match(
        text,
        /thread PRRT_kwDOAAAA1 src\/Service\.java:66 \[unresolved\]\n {2}@reviewer-bot 2026-10-02T09:00\n {6}Expired orders/,
    );
    assert.match(text, /\n {2}reply @hp 2026-10-02T10:00\n {6}agreed, fixing\n/);
    assert.match(text, /thread PRRT_kwDOAAAA2 src\/Repo\.java \[resolved, outdated\]/);
    assert.ok(text.includes(`Expired orders stay submittable: ${"detail ".repeat(80)}end`), "the body is whole");
    assert.doesNotMatch(text, /review approved @other/, "a review without text is left out");
    const call = h.gh.callsOf("api graphql")[0];
    const request = JSON.parse(call?.stdin ?? "{}") as { query: string; variables: Record<string, unknown> };
    assert.deepEqual(request.variables, { owner: "acme", name: r.name, number: 54 });
    assert.match(request.query, /reviewThreads/);
});

test("comments: filtered by author, or only the unresolved threads", async () => {
    const r = featureRepo();
    h.gh.on("api graphql", { json: THREADS });
    const mine = ok(await h.call("pr", { action: "comments", repo: r.name, number: 54, author: "@HP" }));
    assert.match(mine, /^pull request 54: 1 item\nthread PRRT_kwDOAAAA1/);
    const open = ok(await h.call("pr", { action: "comments", repo: r.name, number: 54, unresolved: true }));
    assert.match(open, /^pull request 54: 1 item\nthread PRRT_kwDOAAAA1/);
    assert.doesNotMatch(open, /PRRT_kwDOAAAA2|Please also update/);
    h.gh.on("api graphql", {
        json: {
            data: {
                repository: {
                    pullRequest: {
                        ...THREADS.data.repository.pullRequest,
                        reviewThreads: { totalCount: 0, nodes: [] },
                    },
                },
            },
        },
    });
    assert.match(
        ok(await h.call("pr", { action: "comments", repo: r.name, number: 54, unresolved: true })),
        /nothing to show \(no unresolved threads\)/,
    );
});

test("comments: without a number the pull request of the checked-out branch is found first", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: { number: 54 } });
    h.gh.on("api graphql", { json: THREADS });
    ok(await h.call("pr", { action: "comments", repo: r.name }));
    assert.deepEqual(h.gh.callsOf("pr view")[0]?.args.slice(0, 5), ["pr", "view", "feature/one", "--json", "number"]);
});

// ---- create -------------------------------------------------------------------------------------------------------

test("create: the preview shows the title and the whole body; the run sends them with explicit arguments and the body on stdin", async () => {
    const r = featureRepo();
    h.gh.on("pr list", { json: [] });
    h.gh.on("pr create", { stdout: "https://github.com/acme/svc/pull/77\n" });
    const result = await h.call("pr", { action: "create", repo: r.name, title: "Add x", body: BODY });
    assert.deepEqual(
        [result.cls?.environment, result.cls?.effect, result.cls?.approval],
        ["external", "write", "review"],
    );
    assert.equal(result.preview?.format, "markdown");
    assert.equal(result.preview?.body, `# Add x\n\n${BODY}`);
    assert.match(
        result.preview?.summary ?? "",
        /^create a pull request feature\/one -> main at [0-9a-f]{7} in svc\d+$/,
    );
    const create = h.gh.callsOf("pr create");
    assert.equal(create.length, 1);
    assert.deepEqual(create[0]?.args, [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        "feature/one",
        "--title=Add x",
        "--body-file",
        "-",
        "-R",
        `acme/${r.name}`,
    ]);
    assert.equal(create[0]?.stdin, BODY);
    assert.match(
        result.text,
        /^Created pull request #77 feature\/one -> main in svc\d+: https:\/\/github\.com\/acme\/svc\/pull\/77/,
    );
    assert.deepEqual([...h.jig.facts.values()].at(-1)?.[0], { pr: 77 });
});

test("create: a draft and another base are passed on and shown", async () => {
    const r = featureRepo();
    git(r.dir, "branch", "-q", "release", "origin/main");
    h.gh.on("pr list", { json: [] });
    h.gh.on("pr create", { stdout: "https://github.com/acme/svc/pull/78\n" });
    const result = await h.call("pr", {
        action: "create",
        repo: r.name,
        title: "T",
        body: BODY,
        base: "release",
        draft: true,
    });
    assert.match(result.preview?.summary ?? "", /feature\/one -> release \(draft\)/);
    const args = h.gh.callsOf("pr create")[0]?.args ?? [];
    assert.ok(args.includes("--draft"));
    assert.equal(args[args.indexOf("--base") + 1], "release");
});

test("create: an open pull request for the branch is returned and nothing is created", async () => {
    const r = featureRepo();
    h.gh.on("pr list", {
        json: [
            {
                number: 7,
                title: "Add x",
                url: "https://github.com/acme/svc/pull/7",
                baseRefName: "main",
                headRefName: "feature/one",
            },
        ],
    });
    const result = await h.call("pr", { action: "create", repo: r.name, title: "Add x", body: BODY });
    assert.match(
        result.preview?.summary ?? "",
        /pull request 7 is already open for feature\/one; nothing will be created/,
    );
    assert.match(
        ok(result),
        /^Pull request #7 is already open for feature\/one \(base main\): https:\/\/github\.com\/acme\/svc\/pull\/7\. No new one was created\.$/,
    );
    assert.equal(writes("create").length, 0);
    assert.equal(h.jig.started.length, 0);
});

test("create: a branch that is not pushed at its tip is refused before any gh write", async () => {
    const r = featureRepo(false);
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "T", body: BODY })).error?.message ?? "",
        /feature\/one is not pushed to origin at its local tip; run git push first/,
    );
    const pushed = featureRepo();
    commitFile(pushed.dir, "y.ts", "y\n", "Unpushed");
    assert.match(
        (await h.call("pr", { action: "create", repo: pushed.name, title: "T", body: BODY })).error?.message ?? "",
        /not pushed to origin at its local tip/,
    );
    assert.equal(writes("create").length, 0);
});

test("create: a commit pushed after the preview is refused as changed since the preview", async () => {
    const r = featureRepo();
    h.gh.on("pr list", { json: [] });
    const result = await h.call(
        "pr",
        { action: "create", repo: r.name, title: "T", body: BODY },
        {
            between: () => {
                commitFile(r.dir, "late.ts", "l\n", "Late");
                git(r.dir, "push", "-q", "origin", "feature/one");
            },
        },
    );
    assert.match(
        result.error?.message ?? "",
        /pr create changed since the preview; run it again to see the new preview/,
    );
    assert.equal(writes("create").length, 0);
});

test("create: without a body the repository's template is shown, and nothing is asked of the user", async () => {
    const r = featureRepo();
    writeFile(r.dir, ".github/pull_request_template.md", "## Summary\n\n## Testing\n");
    const result = await h.call("pr", { action: "create", repo: r.name, title: "T" });
    assert.match(
        result.error?.message ?? "",
        /^pr create needs body: write the description\.\nFill in this template:\n---\n## Summary\n\n## Testing\n---$/,
    );
    // git.prTemplate names another file, which wins over the repository's own.
    writeFile(h.sb.root, "company-template.md", "Why:\nHow tested:\n");
    h.jig.setSection("git", { prTemplate: path.join(h.sb.root, "company-template.md") });
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "T" })).error?.message ?? "",
        /Fill in this template:\n---\nWhy:\nHow tested:\n---$/,
    );
    h.jig.setSection("git", undefined);
    fs.rmSync(path.join(r.dir, ".github"), { recursive: true });
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "T" })).error?.message ?? "",
        /^pr create needs body: write the description\.$/,
    );
});

test("create: head and base may not be the same branch, and the title is one line", async () => {
    const r = featureRepo();
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "T", body: BODY, base: "feature/one" })).error
            ?.message ?? "",
        /head and base are both feature\/one/,
    );
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "Two\nlines", body: BODY })).error?.message ?? "",
        /title must be one line/,
    );
});

test("create: git.prTitle must match the title; the message shows the pattern and nothing is asked or sent", async () => {
    const r = featureRepo();
    h.jig.setSection("git", { prTitle: "^[A-Z]+-\\d+: " });
    h.gh.on("pr list", { json: [] });
    h.gh.on("pr create", { stdout: "https://github.com/acme/svc/pull/77\n" });
    const refused = await h.call("pr", { action: "create", repo: r.name, title: "Add x", body: BODY });
    assert.equal(refused.error?.message, "the pull request title does not match git.prTitle (^[A-Z]+-\\d+: )");
    assert.equal(refused.preview, undefined, "no preview, so nobody is asked");
    assert.equal(h.gh.calls().length, 0, "and gh is not run at all");
    // A title that matches goes through as before.
    const result = await h.call("pr", { action: "create", repo: r.name, title: "PROJ-12: Add x", body: BODY });
    assert.equal(ok(result).startsWith("Created pull request #77"), true);
    assert.equal(h.gh.callsOf("pr create")[0]?.args.includes("--title=PROJ-12: Add x"), true);
    h.jig.setSection("git", undefined);
});

test("create: without git.prTitle any one-line title is fine, and the rule is checked before the body is asked for", async () => {
    const r = featureRepo();
    h.jig.setSection("git", { prTitle: "^PROJ-" });
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "Add x" })).error?.message ?? "",
        /^the pull request title does not match git\.prTitle \(\^PROJ-\)$/,
    );
    h.jig.setSection("git", undefined);
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, title: "Add x" })).error?.message ?? "",
        /^pr create needs body/,
    );
});

test("create announces the new pull request, so a watch on the pushed commit can follow it as a pull request", async () => {
    const r = featureRepo(false);
    h.gh.on("pr list", { json: [] });
    ok(await h.call("git", { action: "push", repo: r.name }));
    const head = git(r.dir, "rev-parse", "HEAD");
    h.gh.on("pr create", { stdout: "https://github.com/acme/svc/pull/77\n" });
    const text = ok(await h.call("pr", { action: "create", repo: r.name, title: "T", body: BODY }));
    const events = h.announced.filter((entry) => entry.event === "jig-git:pushed").map((entry) => entry.payload);
    assert.deepEqual(events, [
        { repo: `acme/${r.name}`, branch: "feature/one", sha: head },
        { repo: `acme/${r.name}`, branch: "feature/one", sha: head, pr: 77 },
    ]);
    assert.equal(h.jig.started.length, 0, "jig-git starts no watch");
    assert.doesNotMatch(text, /Watching/);
});

// ---- a lost reply -------------------------------------------------------------------------------------------------

test("create, the reply was lost and the pull request exists: one pr list says so, nothing is created twice", async () => {
    const r = featureRepo();
    // The preview reads, the run plans again and reads, and only after the lost reply does the one check find the pull request.
    const found = {
        number: 9,
        title: "T",
        url: "https://github.com/acme/svc/pull/9",
        baseRefName: "main",
        headRefName: "feature/one",
    };
    h.gh.on("pr list", [{ json: [] }, { json: [] }, { json: [found] }]);
    h.gh.on("pr create", {
        code: 1,
        stderr: 'Post "https://api.github.com/graphql": context deadline exceeded (Client.Timeout exceeded while awaiting headers)\n',
    });
    const text = ok(await h.call("pr", { action: "create", repo: r.name, title: "T", body: BODY }));
    assert.match(
        text,
        /^Created pull request #9 feature\/one -> main in svc\d+: https:\/\/github\.com\/acme\/svc\/pull\/9\n\(The reply was lost \(Post .*deadline exceeded.*\); one check shows it went through\. Nothing was sent twice\.\)/,
    );
    assert.equal(writes("create").length, 1, "the create was sent once");
    const order = h.gh.calls().map((call) => call.args.slice(0, 2).join(" "));
    assert.deepEqual(
        order,
        ["pr list", "pr list", "pr create", "pr list"],
        "the reads of the two plans, the write, then exactly one read",
    );
    const events = h.announced.filter((entry) => entry.event === "jig-git:pushed").map((entry) => entry.payload);
    assert.equal((events.at(-1) as { pr: number }).pr, 9, "the pull request found by the check is announced, once");
    assert.equal(events.length, 1);
});

test("create, timed out and the pull request does not exist: one check says so and nothing is retried", async () => {
    const r = featureRepo();
    h.gh.on("pr list", { json: [] });
    h.gh.on("pr create", { sleepMs: 5_000 });
    h.jig.forceTimeout(300, (file, args) => file === "gh" && args[0] === "pr" && args[1] === "create");
    const result = await h.call("pr", { action: "create", repo: r.name, title: "T", body: BODY });
    h.jig.forceTimeout(undefined);
    assert.match(
        result.error?.message ?? "",
        /^gh pr create: the reply was lost \(timed out after 90 s\) and one check shows it did not go through\. Nothing was sent twice; run it again if you still want it\.$/,
    );
    assert.equal(writes("create").length, 1);
    assert.deepEqual(h.announced, [], "nothing is announced for a pull request that does not exist");
});

test("a definite refusal is a failure with gh's reason, and nothing is checked", async () => {
    const r = featureRepo();
    h.gh.on("pr list", { json: [] });
    h.gh.on("pr create", {
        code: 1,
        stderr: "GraphQL: A pull request already exists for acme:feature/one. (createPullRequest)\n",
    });
    const result = await h.call("pr", { action: "create", repo: r.name, title: "T", body: BODY });
    assert.match(result.error?.message ?? "", /^gh pr create failed: GraphQL: A pull request already exists/);
    assert.deepEqual(
        h.gh.calls().map((call) => call.args.slice(0, 2).join(" ")),
        ["pr list", "pr list", "pr create"],
        "nothing is read after a refusal that is not a lost reply",
    );
});

// ---- edit, ready, comment -----------------------------------------------------------------------------------------

test("edit: the changed fields are shown and sent; the body goes on stdin; at least one is required", async () => {
    const r = featureRepo();
    h.gh.on("pr edit", { stdout: "https://github.com/acme/svc/pull/42\n" });
    const result = await h.call("pr", {
        action: "edit",
        repo: r.name,
        number: 42,
        title: "New title",
        body: BODY,
        base: "main",
        labels: ["bug", "p1"],
        reviewers: ["alice"],
    });
    assert.equal(result.preview?.format, "markdown");
    assert.equal(result.cls?.approval, "review");
    assert.match(
        result.preview?.body ?? "",
        /^Title: New title\nBase: main\nAdd labels: bug, p1\nRequest review from: alice\n\nNew description \(replaces the whole old one\):\n\n## What/,
    );
    assert.match(
        result.preview?.summary ?? "",
        /^edit the title, body, base, labels, reviewers of pull request 42 in svc\d+$/,
    );
    assert.deepEqual(h.gh.callsOf("pr edit")[0]?.args, [
        "pr",
        "edit",
        "42",
        "--title=New title",
        "--base",
        "main",
        "--add-label=bug,p1",
        "--add-reviewer=alice",
        "--body-file",
        "-",
        "-R",
        `acme/${r.name}`,
    ]);
    assert.equal(h.gh.callsOf("pr edit")[0]?.stdin, BODY);
    assert.match(result.text, /^Edited the title, body, base, labels, reviewers of pull request #42/);
    assert.match(
        (await h.call("pr", { action: "edit", repo: r.name, number: 42 })).error?.message ?? "",
        /pr edit needs title, body, base, labels or reviewers/,
    );
});

test("edit: git.prTitle applies to a new title and to nothing else", async () => {
    const r = featureRepo();
    h.jig.setSection("git", { prTitle: "^[A-Z]+-\\d+: " });
    h.gh.on("pr edit", { stdout: "https://github.com/acme/svc/pull/42\n" });
    const refused = await h.call("pr", { action: "edit", repo: r.name, number: 42, title: "New title" });
    assert.equal(refused.error?.message, "the pull request title does not match git.prTitle (^[A-Z]+-\\d+: )");
    assert.equal(refused.preview, undefined);
    assert.equal(h.gh.calls().length, 0);
    // A matching title goes through; so does an edit that leaves the title alone, whatever the old title was.
    const edited = await h.call("pr", { action: "edit", repo: r.name, number: 42, title: "PROJ-7: New title" });
    assert.match(ok(edited), /^Edited the title of pull request #42/);
    const labelled = await h.call("pr", { action: "edit", repo: r.name, number: 42, labels: ["bug"] });
    assert.match(ok(labelled), /^Edited the labels of pull request #42/);
    assert.equal(h.gh.callsOf("pr edit").length, 2);
    h.jig.setSection("git", undefined);
});

test("edit, the reply was lost: one view compares the fields", async () => {
    const r = featureRepo();
    h.gh.on("pr edit", { code: 1, stderr: "Post: unexpected EOF\n" });
    h.gh.on("pr view", {
        json: { title: "New title", body: "x", baseRefName: "main", labels: [], reviewRequests: [] },
    });
    const text = ok(await h.call("pr", { action: "edit", repo: r.name, number: 42, title: "New title" }));
    assert.match(text, /\(The reply was lost \(Post: unexpected EOF\); one check shows it went through/);
    h.gh.reset();
    h.gh.on("pr edit", { code: 1, stderr: "HTTP 502 Bad Gateway\n" });
    h.gh.on("pr view", {
        json: { title: "Old title", body: "x", baseRefName: "main", labels: [], reviewRequests: [] },
    });
    const result = await h.call("pr", { action: "edit", repo: r.name, number: 42, title: "New title" });
    assert.match(result.error?.message ?? "", /one check shows it did not go through/);
    assert.equal(h.gh.callsOf("pr edit").length, 1);
});

test("ready: marks a draft ready, and a lost reply is checked once", async () => {
    const r = featureRepo();
    h.gh.on("pr ready", { stdout: "" });
    assert.match(
        ok(await h.call("pr", { action: "ready", repo: r.name, number: 42 })),
        /^Pull request #42 in svc\d+ is ready for review\.$/,
    );
    h.gh.reset();
    h.gh.on("pr ready", { code: 1, stderr: "connection reset by peer" });
    h.gh.on("pr view", { json: { isDraft: false } });
    assert.match(
        ok(await h.call("pr", { action: "ready", repo: r.name, number: 42 })),
        /one check shows it went through/,
    );
});

test("comment: the text is shown, then sent on stdin; the result names the comment", async () => {
    const r = featureRepo();
    h.gh.on("pr comment", { stdout: "https://github.com/acme/svc/pull/42#issuecomment-1\n" });
    const result = await h.call("pr", { action: "comment", repo: r.name, number: 42, body: "Looks good" });
    assert.equal(result.preview?.body, "Looks good");
    assert.equal(result.preview?.format, "markdown");
    assert.deepEqual(h.gh.callsOf("pr comment")[0]?.args, [
        "pr",
        "comment",
        "42",
        "--body-file",
        "-",
        "-R",
        `acme/${r.name}`,
    ]);
    assert.equal(h.gh.callsOf("pr comment")[0]?.stdin, "Looks good");
    assert.match(
        result.text,
        /^Commented on pull request #42 in svc\d+: https:\/\/github\.com\/acme\/svc\/pull\/42#issuecomment-1$/,
    );
    assert.match(
        (await h.call("pr", { action: "comment", repo: r.name, number: 42, body: " " })).error?.message ?? "",
        /body is required/,
    );
});

test("comment, the reply was lost: a comment with the same text, made after the call began, counts as posted", async () => {
    const r = featureRepo();
    h.gh.on("pr comment", { code: 1, stderr: "HTTP 504 Gateway Timeout\n" });
    const soon = new Date(Date.now() + 60_000).toISOString();
    h.gh.on("pr view", {
        json: {
            comments: [
                { body: "Looks good", createdAt: soon, url: "https://github.com/acme/svc/pull/42#issuecomment-9" },
            ],
        },
    });
    assert.match(
        ok(await h.call("pr", { action: "comment", repo: r.name, number: 42, body: "Looks good" })),
        /^Commented on pull request #42 in svc\d+: https:\/\/github\.com\/acme\/svc\/pull\/42#issuecomment-9\n\(The reply was lost/,
    );
    h.gh.reset();
    h.gh.on("pr comment", { code: 1, stderr: "HTTP 504 Gateway Timeout\n" });
    h.gh.on("pr view", { json: { comments: [{ body: "Looks good", createdAt: "2020-01-01T00:00:00Z", url: "old" }] } });
    const old = await h.call("pr", { action: "comment", repo: r.name, number: 42, body: "Looks good" });
    assert.match(
        old.error?.message ?? "",
        /one check shows it did not go through/,
        "an older comment with the same text is not this one",
    );
    assert.equal(h.gh.callsOf("pr comment").length, 1);
});

test("a write that is cancelled is treated as a lost reply: the one check still runs, though the call was cancelled", async () => {
    const r = featureRepo();
    h.gh.on("pr comment", { sleepMs: 10_000 });
    const later = new Date(Date.now() + 60_000).toISOString();
    h.gh.on("pr view", {
        json: {
            comments: [
                { body: "Looks good", createdAt: later, url: "https://github.com/acme/svc/pull/42#issuecomment-5" },
            ],
        },
    });
    const controller = new AbortController();
    // Esc is pressed once gh has the request.
    void (async () => {
        while (h.gh.callsOf("pr comment").length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
    })();
    const result = await h.call(
        "pr",
        { action: "comment", repo: r.name, number: 42, body: "Looks good" },
        { signal: controller.signal },
    );
    assert.match(
        ok(result),
        /^Commented on pull request #42 in svc\d+: .*issuecomment-5\n\(The reply was lost \(the call was cancelled\); one check shows it went through\./,
    );
    assert.equal(h.gh.callsOf("pr comment").length, 1);
    assert.equal(h.gh.callsOf("pr view").length, 1, "exactly one check");
});

// ---- reply, resolve, review ---------------------------------------------------------------------------------------

test("reply and resolve go through GraphQL with the thread id as a variable, on stdin", async () => {
    h.gh.on(
        "api graphql",
        {
            json: {
                data: {
                    addPullRequestReviewThreadReply: {
                        comment: { url: "https://github.com/acme/svc/pull/42#discussion_r1" },
                    },
                },
            },
        },
        ["addPullRequestReviewThreadReply"],
    );
    h.gh.on("api graphql", { json: { data: { resolveReviewThread: { thread: { isResolved: true } } } } }, [
        "resolveReviewThread",
    ]);
    const reply = await h.call("pr", { action: "reply", thread: "PRRT_kwDOAAAA1", body: "Fixed in the next commit." });
    assert.equal(reply.cls?.approval, "review");
    assert.equal(reply.preview?.body, "Fixed in the next commit.");
    assert.match(
        reply.text,
        /^Replied in review thread PRRT_kwDOAAAA1: https:\/\/github\.com\/acme\/svc\/pull\/42#discussion_r1$/,
    );
    const sent = JSON.parse(h.gh.callsOf("api graphql")[0]?.stdin ?? "{}") as {
        query: string;
        variables: Record<string, string>;
    };
    assert.deepEqual(sent.variables, { thread: "PRRT_kwDOAAAA1", body: "Fixed in the next commit." });
    assert.match(
        ok(await h.call("pr", { action: "resolve", thread: "PRRT_kwDOAAAA1" })),
        /^Resolved review thread PRRT_kwDOAAAA1\.$/,
    );
    assert.match(
        (await h.call("pr", { action: "reply", thread: "bad id!", body: "x" })).error?.message ?? "",
        /thread must be a review thread id/,
    );
});

test("reply, the reply was lost: one look at the thread decides", async () => {
    h.gh.on("api graphql", { code: 1, stderr: "connection reset by peer" }, ["addPullRequestReviewThreadReply"]);
    const later = new Date(Date.now() + 60_000).toISOString();
    h.gh.on(
        "api graphql",
        {
            json: {
                data: { node: { comments: { nodes: [{ body: "Fixed.", url: "https://x/r1", createdAt: later }] } } },
            },
        },
        ["PullRequestReviewThread {"],
    );
    assert.match(
        ok(await h.call("pr", { action: "reply", thread: "PRRT_kwDOAAAA1", body: "Fixed." })),
        /^Replied in review thread PRRT_kwDOAAAA1: https:\/\/x\/r1\n\(The reply was lost/,
    );
    assert.equal(h.gh.callsOf("api graphql").length, 2, "the write, then one read");
});

test("review: a comment or a request for changes; approving is not possible", async () => {
    const r = featureRepo();
    h.gh.on("pr review", { stdout: "" });
    const result = await h.call("pr", {
        action: "review",
        repo: r.name,
        number: 42,
        event: "request_changes",
        body: "Please rename.",
    });
    assert.equal(result.cls?.approval, "review");
    assert.deepEqual(h.gh.callsOf("pr review")[0]?.args.slice(0, 5), [
        "pr",
        "review",
        "42",
        "--request-changes",
        "--body-file",
    ]);
    assert.equal(h.gh.callsOf("pr review")[0]?.stdin, "Please rename.");
    assert.match(result.text, /^Sent a request for changes on pull request #42/);
    ok(await h.call("pr", { action: "review", repo: r.name, number: 42, event: "comment", body: "Thoughts." }));
    assert.equal(h.gh.callsOf("pr review")[1]?.args[3], "--comment");
    const approve = await h.call("pr", { action: "review", repo: r.name, number: 42, event: "approve", body: "LGTM" });
    assert.match(approve.error?.message ?? "", /never approves: approval stays with a person/);
    assert.equal(h.gh.callsOf("pr review").length, 2);
    const event = (h.tools.get("pr")!.parameters as unknown as { properties: { event: { enum: string[] } } }).properties
        .event;
    assert.deepEqual(event.enum, ["comment", "request_changes"], "the schema has no way to approve");
});

// ---- merge --------------------------------------------------------------------------------------------------------

test("merge: the preview shows the title, method and head; the run pins the head and nothing else", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson() });
    h.gh.on("pr merge", { stdout: "" });
    const result = await h.call("pr", { action: "merge", repo: r.name, number: 42, method: "squash" });
    assert.equal(result.cls?.approval, undefined);
    assert.match(
        result.preview?.summary ?? "",
        /^squash-merge pull request 42 into main in svc\d+: Add the thing \(head 1111111\)$/,
    );
    assert.match(
        result.preview?.body ?? "",
        /^Add the thing\nFrom feature\/one at 1111111 into main, by squash\.\nChecks: 1 pass, 1 fail, 0 pending, 0 skipped\. Review: APPROVED\.\nIt merges only while the head is still 1111111\.$/,
    );
    assert.deepEqual(h.gh.callsOf("pr merge")[0]?.args, [
        "pr",
        "merge",
        "42",
        "--squash",
        "--match-head-commit",
        "1111111111111111111111111111111111111111",
        "-R",
        `acme/${r.name}`,
    ]);
    assert.match(result.text, /^Merged pull request #42 into main \(squash\) at 1111111 in svc\d+\.$/);
});

test("merge: auto-merge is a different request, and says so", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson() });
    h.gh.on("pr merge", { stdout: "" });
    const result = await h.call("pr", { action: "merge", repo: r.name, number: 42, method: "rebase", auto: true });
    assert.match(result.preview?.summary ?? "", /^turn on auto-merge \(rebase\) for pull request 42/);
    assert.ok(h.gh.callsOf("pr merge")[0]?.args.includes("--auto"));
    assert.match(result.text, /^Auto-merge is on for pull request #42 \(rebase\)/);
});

test("merge: a head that moves after the preview is refused, and nothing is merged", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson() });
    h.gh.on("pr merge", { stdout: "" });
    const result = await h.call(
        "pr",
        { action: "merge", repo: r.name, number: 42, method: "merge" },
        {
            between: () =>
                h.gh.on("pr view", { json: prJson({ headRefOid: "2222222222222222222222222222222222222222" }) }),
        },
    );
    assert.match(
        result.error?.message ?? "",
        /pr merge changed since the preview; run it again to see the new preview/,
    );
    assert.equal(writes("merge").length, 0);
});

test("merge: a pull request that is a draft, closed, conflicting, or lacks a method is refused", async () => {
    const r = featureRepo();
    const run = (overrides: Record<string, unknown>, input: Record<string, unknown> = {}) => {
        h.gh.on("pr view", { json: prJson(overrides) });
        return h.call("pr", { action: "merge", repo: r.name, number: 42, method: "merge", ...input });
    };
    assert.match(
        (await run({ isDraft: true })).error?.message ?? "",
        /pull request 42 is a draft; mark it ready for review first/,
    );
    assert.match((await run({ state: "MERGED" })).error?.message ?? "", /pull request 42 is merged, not open/);
    assert.match((await run({ mergeable: "CONFLICTING" })).error?.message ?? "", /conflicts with main/);
    assert.match(
        (await run({}, { method: undefined })).error?.message ?? "",
        /^pr merge needs method\. Usage: pr merge \{number, method, repo\?, auto\?\}$/,
    );
    assert.equal(writes("merge").length, 0);
});

test("merge: gh's refusal is one line; a lost reply is settled by one view", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson() });
    h.gh.on("pr merge", {
        code: 1,
        stderr: "Pull request is not mergeable: the base branch policy prohibits the merge.\nsecond line\n",
    });
    const refused = await h.call("pr", { action: "merge", repo: r.name, number: 42, method: "merge" });
    assert.match(
        refused.error?.message ?? "",
        /^gh pr merge failed: Pull request is not mergeable: the base branch policy prohibits the merge\.; second line$/,
    );
    h.gh.reset();
    h.gh.on("pr view", [{ json: prJson() }, { json: prJson() }, { json: { state: "MERGED", autoMergeRequest: null } }]);
    h.gh.on("pr merge", { code: 1, stderr: "HTTP 504 Gateway Timeout\n" });
    const lost = ok(await h.call("pr", { action: "merge", repo: r.name, number: 42, method: "merge" }));
    assert.match(lost, /^Merged pull request #42 into main \(merge\).*\n\(The reply was lost/);
    assert.equal(writes("merge").length, 1);
});

test("merge into the default branch is an ordinary write: it asks, and the preview names the base", async () => {
    const r = featureRepo();
    h.gh.on("pr view", { json: prJson() });
    h.gh.on("pr merge", { stdout: "" });
    const result = await h.call("pr", { action: "merge", repo: r.name, number: 42, method: "merge" });
    assert.ok(result.preview);
    assert.match(result.preview?.summary ?? "", /into main/);
});

// ---- the shape of every call --------------------------------------------------------------------------------------

test("a call the action does not take, or lacks what it needs, is refused with the usage line", async () => {
    const r = featureRepo();
    assert.match(
        (await h.call("pr", { action: "view", repo: r.name, body: "x" })).error?.message ?? "",
        /^pr view does not use body\. Usage: pr view \{repo\?, number\?, branch\?\}$/,
    );
    assert.match(
        (await h.call("pr", { action: "create", repo: r.name, body: "x" })).error?.message ?? "",
        /^pr create needs title\. Usage: pr create \{title, repo\?, body\?, branch\?, base\?, draft\?\}$/,
    );
    assert.match(
        (await h.call("pr", { action: "approve" })).error?.message ?? "",
        /^pr: unknown action "approve"; use one of view, list, comments, create, edit, ready, comment, reply, resolve, review, merge$/,
    );
    assert.equal(h.gh.calls().length, 0, "no gh call was made");
});
