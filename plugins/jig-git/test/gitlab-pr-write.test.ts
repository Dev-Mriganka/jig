// `pr` writes on a GitLab project: create, edit, ready, comment, reply, resolve, review and merge. GitLab is a fake `glab` that
// answers `glab api` from answers written down in the shape of GitLab's REST API (see support/gitlab-answers.ts). Nothing here
// reaches a GitLab server. Each write is previewed, sent once with its JSON on standard input, and never repeated after a lost
// reply: one read says whether it went through.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { did, diffNote, discussion, HEAD, job, mr, note, person, threadNote } from "./support/gitlab-answers.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo } from "./support/repos.ts";

let h: Harness;
let counter = 0;

before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

const BODY = "## What\nAdds x.\n\n## Why\nBecause the thing needs x.\n\n## Tested\nunit tests";
const OTHER = "2222222222222222222222222222222222222222";

interface Project {
    r: ReturnType<typeof makeRepo>;
    path: string;
    /** `projects/acme%2Forders-apiN`. */
    base: string;
}

/** A clone of acme/orders-apiN on gitlab.com, on feature/one with one commit, pushed or not. */
function project(pushed = true): Project {
    const r = makeRepo(h.sb, `orders-api${++counter}`, "acme", "gitlab.com");
    git(r.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    commitFile(r.dir, "x.ts", "x\n", "Add x");
    if (pushed) git(r.dir, "push", "-q", "-u", "origin", "feature/one");
    const projectPath = `acme/${r.name}`;
    return { r, path: projectPath, base: `projects/${encodeURIComponent(projectPath)}` };
}

/** The merge request, and the jobs of its pipeline. */
function serveMr(
    p: Project,
    overrides: Record<string, unknown> = {},
    jobs: unknown[] = [job("build", "success"), job("unit", "failed")],
): void {
    h.glab.on("api", { json: mr(overrides, p.path) }, [`=${p.base}/merge_requests/42`]);
    h.glab.on("api", { json: jobs }, [`${p.base}/pipelines/301/jobs`]);
}

/** The requests that change something: those with a method. */
const writes = () => h.glab.callsOf("api").filter((call) => call.args.includes("-X"));
const methodOf = (args: string[]) => args[args.indexOf("-X") + 1];
const sentJson = (index = 0) => JSON.parse(writes()[index]?.stdin ?? "null") as unknown;
const events = () => h.announced.filter((entry) => entry.event === "jig-git:pushed").map((entry) => entry.payload);

// ---- create -------------------------------------------------------------------------------------------------------

test("create: the preview shows the title and the whole body; the run sends them as JSON on standard input", async () => {
    const p = project();
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { json: mr({ iid: 77 }, p.path) }, [`=${p.base}/merge_requests`, "=POST"]);
    const result = await h.call("pr", { action: "create", repo: p.r.name, title: "Add x", body: BODY });
    assert.deepEqual(
        [result.cls?.environment, result.cls?.effect, result.cls?.approval],
        ["external", "write", "review"],
    );
    assert.equal(result.preview?.format, "markdown");
    assert.equal(result.preview?.body, `# Add x\n\n${BODY}`);
    assert.match(
        result.preview?.summary ?? "",
        /^create a merge request feature\/one -> main at [0-9a-f]{7} in orders-api\d+$/,
    );
    assert.equal(writes().length, 1);
    assert.deepEqual(writes()[0]?.args, [
        "api",
        "--hostname",
        "gitlab.com",
        "-X",
        "POST",
        "--input",
        "-",
        `${p.base}/merge_requests`,
    ]);
    assert.deepEqual(sentJson(), {
        source_branch: "feature/one",
        target_branch: "main",
        title: "Add x",
        description: BODY,
    });
    assert.match(
        result.text,
        /^Created merge request !77 feature\/one -> main in orders-api\d+: https:\/\/gitlab\.example\.com\/acme\/orders-api\d+\/-\/merge_requests\/42/,
    );
    assert.deepEqual([...h.jig.facts.values()].at(-1)?.[0], { pr: 77 });
    assert.equal(h.gh.calls().length, 0);
});

test("create: a draft is a title with the prefix, another base is passed on, and a prefix that is there is not doubled", async () => {
    const p = project();
    git(p.r.dir, "branch", "-q", "release", "origin/main");
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { json: mr({ iid: 78 }, p.path) }, ["=POST"]);
    const result = await h.call("pr", {
        action: "create",
        repo: p.r.name,
        title: "T",
        body: BODY,
        base: "release",
        draft: true,
    });
    assert.match(result.preview?.summary ?? "", /feature\/one -> release \(draft\)/);
    assert.equal(result.preview?.body?.split("\n")[0], "# Draft: T");
    assert.deepEqual(sentJson(), {
        source_branch: "feature/one",
        target_branch: "release",
        title: "Draft: T",
        description: BODY,
    });
    h.glab.reset();
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { json: mr({ iid: 79 }, p.path) }, ["=POST"]);
    ok(await h.call("pr", { action: "create", repo: p.r.name, title: "Draft: T", body: BODY, draft: true }));
    assert.equal((sentJson() as { title: string }).title, "Draft: T");
});

test("create: an open merge request for the branch is returned and nothing is created", async () => {
    const p = project();
    h.glab.on("api", { json: [mr({}, p.path)] }, ["merge_requests?source_branch="]);
    const result = await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY });
    assert.match(
        result.preview?.summary ?? "",
        /^merge request 42 is already open for feature\/one; nothing will be created$/,
    );
    assert.match(
        result.text,
        /^Merge request !42 is already open for feature\/one \(target main\): https:\/\/gitlab\.example\.com\/.*\. No new one was created\.$/,
    );
    assert.equal(writes().length, 0);
    assert.equal(h.jig.started.length, 0, "and it is not watched: pr watch does that");
});

test("create: a branch that is not pushed at its tip is refused before any write; so are a commit pushed after the preview and a head equal to the base", async () => {
    const p = project(false);
    h.glab.on("api", { json: [] });
    assert.match(
        (await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY })).error?.message ?? "",
        /^feature\/one is not pushed to origin at its local tip; run git push first/,
    );
    git(p.r.dir, "push", "-q", "-u", "origin", "feature/one");
    const result = await h.call(
        "pr",
        { action: "create", repo: p.r.name, title: "T", body: BODY },
        {
            between: () => {
                commitFile(p.r.dir, "late.ts", "l\n", "Late");
                git(p.r.dir, "push", "-q", "origin", "feature/one");
            },
        },
    );
    assert.match(
        result.error?.message ?? "",
        /pr create changed since the preview; run it again to see the new preview/,
    );
    assert.equal(writes().length, 0);
    assert.match(
        (await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY, base: "feature/one" })).error
            ?.message ?? "",
        /^head and base are both feature\/one; open the merge request from another branch$/,
    );
});

test("create: without a body the repository's merge request template is shown, and nothing is asked or sent", async () => {
    const p = project();
    fs.mkdirSync(path.join(p.r.dir, ".gitlab", "merge_request_templates"), { recursive: true });
    fs.writeFileSync(path.join(p.r.dir, ".gitlab", "merge_request_templates", "Default.md"), "## What\n\n## Why\n");
    const result = await h.call("pr", { action: "create", repo: p.r.name, title: "T" });
    assert.equal(
        result.error?.message,
        "pr create needs body: write the description.\nFill in this template:\n---\n## What\n\n## Why\n---",
    );
    assert.equal(h.glab.calls().length, 0);
    assert.match(
        (await h.call("pr", { action: "create", repo: p.r.name, title: "T\nsecond line", body: BODY })).error
            ?.message ?? "",
        /title must be one line/,
    );
});

test("create: git.prTitle must match the title as written, before the draft prefix is added; nothing is asked or sent otherwise", async () => {
    h.jig.setSection("git", { prTitle: "^PROJ-\\d+: " });
    const p = project();
    const refused = await h.call("pr", { action: "create", repo: p.r.name, title: "Add x", body: BODY });
    assert.equal(refused.error?.message, "the pull request title does not match git.prTitle (^PROJ-\\d+: )");
    assert.equal(refused.preview, undefined);
    assert.equal(h.glab.calls().length, 0);
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { json: mr({ iid: 80 }, p.path) }, ["=POST"]);
    ok(await h.call("pr", { action: "create", repo: p.r.name, title: "PROJ-1: Add x", body: BODY, draft: true }));
    assert.equal((sentJson() as { title: string }).title, "Draft: PROJ-1: Add x");
});

test("create announces the new merge request and starts a watch on its comments", async () => {
    const p = project(false);
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    ok(await h.call("git", { action: "push", repo: p.r.name }));
    const head = git(p.r.dir, "rev-parse", "HEAD");
    h.glab.on("api", { json: mr({ iid: 77 }, p.path) }, ["=POST"]);
    const result = await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY });
    assert.deepEqual(events(), [
        { repo: p.path, branch: "feature/one", sha: head },
        { repo: p.path, branch: "feature/one", sha: head, pr: 77 },
    ]);
    assert.deepEqual(
        h.jig.started.map((watch) => [watch.kind, watch.spec, watch.title]),
        [
            [
                "pr-comments",
                { slug: p.path, number: 77, forge: "gitlab", host: "gitlab.com" },
                `comments on merge request 77 in gitlab.com/${p.path}`,
            ],
        ],
    );
    assert.match(result.text, /\nWatching the comments on merge request 77 in acme\/orders-api\d+ as w1\./);
    assert.equal((result.details as { watch?: string }).watch, "w1");
});

test('create: git.watchComments "off" starts nothing, and a watch that cannot start is said without undoing the merge request', async () => {
    h.jig.setSection("git", { watchComments: "off" });
    const p = project();
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { json: mr({ iid: 81 }, p.path) }, ["=POST"]);
    assert.doesNotMatch(
        ok(await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY })),
        /Watching/,
    );
    assert.equal(h.jig.started.length, 0);
    h.jig.reset();
    const q = project();
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { json: mr({ iid: 82 }, q.path) }, ["=POST"]);
    const watches = h.jig.api.watches as unknown as { start: (...args: unknown[]) => string };
    const start = watches.start;
    watches.start = () => {
        throw new Error("a watch can be started only while a session is running");
    };
    try {
        const result = await h.call("pr", { action: "create", repo: q.r.name, title: "T", body: BODY });
        assert.match(
            ok(result),
            /\(The watch on its comments could not start: a watch can be started only while a session is running\. pr watch starts it\.\)$/,
        );
        assert.equal((result.details as { number: number }).number, 82);
    } finally {
        watches.start = start;
    }
});

test("create, the reply was lost and the merge request exists: one read says so, and nothing is created twice", async () => {
    const p = project();
    // The preview reads, the run plans again and reads, and only after the lost reply does the one check find the merge request.
    h.glab.on(
        "api",
        [{ json: [] }, { json: [] }, { json: [mr({ iid: 9 }, p.path)] }],
        ["merge_requests?source_branch="],
    );
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)\n" }, ["=POST"]);
    const text = ok(await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY }));
    assert.match(
        text,
        /^Created merge request !9 feature\/one -> main in orders-api\d+: https:\/\/gitlab\.example\.com\/.*\n\(The reply was lost \(glab: 502 Bad Gateway \(HTTP 502\)\); one check shows it went through\. Nothing was sent twice\.\)/,
    );
    assert.equal(writes().length, 1, "the create was sent once");
    assert.deepEqual(
        h.glab.calls().map((call) => (call.args.includes("-X") ? methodOf(call.args) : "GET")),
        ["GET", "GET", "POST", "GET"],
        "the reads of the two plans, the write, then exactly one read",
    );
    assert.equal((events().at(-1) as { pr: number }).pr, 9, "the merge request found by the check is announced, once");
    assert.equal(events().length, 1);
});

test("create, timed out and the merge request does not exist: one check says so and nothing is retried; a refusal is a failure with GitLab's reason", async () => {
    const p = project();
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { sleepMs: 5_000 }, ["=POST"]);
    h.jig.forceTimeout(300, (file, args) => file === "glab" && args.includes("POST"));
    const result = await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY });
    h.jig.forceTimeout(undefined);
    assert.match(
        result.error?.message ?? "",
        /^glab api \(create merge request\): the reply was lost \(timed out after 90 s\) and one check shows it did not go through\. Nothing was sent twice; run it again if you still want it\.$/,
    );
    assert.equal(writes().length, 1);
    assert.deepEqual(h.announced, [], "nothing is announced for a merge request that does not exist");
    h.glab.reset();
    h.glab.on("api", { json: [] }, ["merge_requests?source_branch="]);
    h.glab.on("api", { code: 1, stderr: "glab: 409 Conflict (HTTP 409)\n" }, ["=POST"]);
    const refused = await h.call("pr", { action: "create", repo: p.r.name, title: "T", body: BODY });
    assert.equal(refused.error?.message, "glab api (create merge request) failed: glab: 409 Conflict (HTTP 409)");
    assert.equal(h.glab.calls().length, 3, "nothing is read after a refusal that is not a lost reply");
});

// ---- edit and ready -----------------------------------------------------------------------------------------------

test("edit: the changed fields are shown and sent as JSON; reviewers are looked up and added to those there; at least one field is required", async () => {
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: [person("bob", { id: 12 })] }, ["users?username=bob"]);
    h.glab.on("api", { json: mr({}, p.path) }, ["=PUT"]);
    const result = await h.call("pr", {
        action: "edit",
        repo: p.r.name,
        number: 42,
        title: "New title",
        body: "New description",
        base: "release",
        labels: ["bug", "ui"],
        reviewers: ["@bob"],
    });
    assert.equal(
        result.preview?.summary,
        `edit the title, body, base, labels, reviewers of merge request 42 in ${p.r.name}`,
    );
    assert.equal(
        result.preview?.body,
        [
            "Title: New title",
            "Target branch: release",
            "Add labels: bug, ui (a label GitLab does not have yet is created)",
            "Request review from: @bob",
            "",
            "New description (replaces the whole old one):",
            "",
            "New description",
        ].join("\n"),
    );
    assert.deepEqual(writes()[0]?.args, [
        "api",
        "--hostname",
        "gitlab.com",
        "-X",
        "PUT",
        "--input",
        "-",
        `${p.base}/merge_requests/42`,
    ]);
    assert.deepEqual(sentJson(), {
        title: "New title",
        description: "New description",
        target_branch: "release",
        add_labels: "bug,ui",
        reviewer_ids: [11, 12],
    });
    assert.equal(result.text, `Edited the title, body, base, labels, reviewers of merge request !42 in ${p.r.name}.`);
    const none = await h.call("pr", { action: "edit", repo: p.r.name, number: 42 });
    assert.match(
        none.error?.message ?? "",
        /^pr edit needs title, body, base, labels or reviewers\. Usage: pr edit \{number, title\?/,
    );
});

test("edit: a draft stays a draft when its title is changed, and a reviewer GitLab does not know is refused before anyone is asked", async () => {
    const p = project();
    serveMr(p, { title: "Draft: Old", draft: true });
    h.glab.on("api", { json: mr({}, p.path) }, ["=PUT"]);
    const result = await h.call("pr", { action: "edit", repo: p.r.name, number: 42, title: "New" });
    assert.equal(result.preview?.body, "Title: Draft: New");
    assert.deepEqual(sentJson(), { title: "Draft: New" });
    h.glab.on("api", { json: [] }, ["users?username=zed"]);
    const unknown = await h.call("pr", { action: "edit", repo: p.r.name, number: 42, reviewers: ["zed"] });
    assert.equal(unknown.error?.message, 'GitLab has no user "zed" to request a review from');
    assert.equal(unknown.preview, undefined);
    assert.equal(writes().length, 1);
});

test("edit: git.prTitle applies to a new title and to nothing else", async () => {
    h.jig.setSection("git", { prTitle: "^PROJ-\\d+: " });
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: mr({}, p.path) }, ["=PUT"]);
    assert.match(
        (await h.call("pr", { action: "edit", repo: p.r.name, number: 42, title: "No ticket" })).error?.message ?? "",
        /does not match git\.prTitle \(\^PROJ-\\d\+: \)/,
    );
    ok(await h.call("pr", { action: "edit", repo: p.r.name, number: 42, body: "Only the body" }));
    ok(await h.call("pr", { action: "edit", repo: p.r.name, number: 42, title: "PROJ-7: Fine" }));
    assert.equal(writes().length, 2);
});

test("edit, the reply was lost: one read compares the fields, and the request is not sent again", async () => {
    const p = project();
    serveMr(p);
    // The preview and the run read the merge request as it is; the one check after the lost reply reads it as it became.
    h.glab.on(
        "api",
        [{ json: mr({}, p.path) }, { json: mr({}, p.path) }, { json: mr({ title: "New title" }, p.path) }],
        [`=${p.base}/merge_requests/42`],
    );
    // The write goes to the same address, so its answer is registered last: the latest answer that fits is the one given.
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=PUT"]);
    assert.match(
        ok(await h.call("pr", { action: "edit", repo: p.r.name, number: 42, title: "New title" })),
        /^Edited the title of merge request !42 in orders-api\d+\.\n\(The reply was lost \(glab: 502 Bad Gateway \(HTTP 502\)\); one check shows it went through\. Nothing was sent twice\.\)$/,
    );
    assert.equal(writes().length, 1);
    h.glab.reset();
    serveMr(p);
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=PUT"]);
    assert.match(
        (await h.call("pr", { action: "edit", repo: p.r.name, number: 42, title: "Another" })).error?.message ?? "",
        /one check shows it did not go through\. Nothing was sent twice; run it again/,
    );
    assert.equal(writes().length, 1);
});

test("ready: takes the draft prefix off the title; a merge request that is ready is left alone; a lost reply is checked once", async () => {
    const p = project();
    serveMr(p, { title: "Draft: Add the thing", draft: true });
    h.glab.on("api", { json: mr({}, p.path) }, ["=PUT"]);
    const result = await h.call("pr", { action: "ready", repo: p.r.name, number: 42 });
    assert.equal(result.preview?.summary, `mark merge request 42 in ${p.r.name} ready for review`);
    assert.deepEqual(sentJson(), { title: "Add the thing" });
    assert.equal(result.text, `Merge request !42 in ${p.r.name} is ready for review.`);
    h.glab.reset();
    serveMr(p);
    const already = await h.call("pr", { action: "ready", repo: p.r.name, number: 42 });
    assert.match(already.preview?.summary ?? "", /is already ready for review; nothing will be changed$/);
    assert.match(already.text, /was already ready for review\.$/);
    assert.equal(writes().length, 0);
    h.glab.reset();
    serveMr(p, { state: "merged" });
    assert.match(
        (await h.call("pr", { action: "ready", repo: p.r.name, number: 42 })).error?.message ?? "",
        /merge request 42 is merged, not open/,
    );
    h.glab.reset();
    h.glab.on(
        "api",
        [
            { json: mr({ title: "Draft: X", draft: true }, p.path) },
            { json: mr({ title: "Draft: X", draft: true }, p.path) },
            { json: mr({}, p.path) },
        ],
        [`=${p.base}/merge_requests/42`],
    );
    h.glab.on("api", { code: 1, stderr: "glab: 504 Gateway Timeout (HTTP 504)" }, ["=PUT"]);
    assert.match(
        ok(await h.call("pr", { action: "ready", repo: p.r.name, number: 42 })),
        /^Merge request !42 in orders-api\d+ is ready for review\.\n\(The reply was lost/,
    );
    assert.equal(writes().length, 1);
});

// ---- comment, reply, resolve, review ------------------------------------------------------------------------------

test("comment: the text is shown, then sent as JSON; the result names the note", async () => {
    const p = project();
    h.glab.on("api", { json: note(6001, "hp", "Thanks, fixed") }, ["=POST"]);
    const result = await h.call("pr", { action: "comment", repo: p.r.name, number: 42, body: "Thanks, fixed" });
    assert.equal(result.preview?.summary, `comment on merge request 42 in ${p.r.name}`);
    assert.equal(result.preview?.body, "Thanks, fixed");
    assert.deepEqual(writes()[0]?.args.slice(-1), [`${p.base}/merge_requests/42/notes`]);
    assert.deepEqual(sentJson(), { body: "Thanks, fixed" });
    assert.equal(
        result.text,
        `Commented on merge request !42 in ${p.r.name}: https://gitlab.com/${p.path}/-/merge_requests/42#note_6001`,
    );
});

test("comment, the reply was lost: a note with the same text, made after the call began, counts as posted; one that was there before does not", async () => {
    const p = project();
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=POST"]);
    const posted = note(6002, "hp", "Same text", { created_at: new Date(Date.now() + 1000).toISOString() });
    h.glab.on("api", { json: [posted, note(6001, "x", "Other")] }, ["/notes?sort=desc"]);
    assert.match(
        ok(await h.call("pr", { action: "comment", repo: p.r.name, number: 42, body: "Same text" })),
        new RegExp(
            `^Commented on merge request !42 in ${p.r.name}: https://gitlab.com/${p.path}/-/merge_requests/42#note_6002\\n\\(The reply was lost`,
        ),
    );
    assert.equal(writes().length, 1);
    assert.deepEqual(h.glab.callsOf("api").at(-1)?.args.slice(-1), [
        `${p.base}/merge_requests/42/notes?sort=desc&order_by=created_at&per_page=10`,
    ]);
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=POST"]);
    h.glab.on("api", { json: [note(6002, "hp", "Same text", { created_at: "2020-01-01T00:00:00.000Z" })] }, [
        "/notes?sort=desc",
    ]);
    assert.match(
        (await h.call("pr", { action: "comment", repo: p.r.name, number: 42, body: "Same text" })).error?.message ?? "",
        /one check shows it did not go through/,
    );
});

test("a write that is cancelled is treated as a lost reply: the one check still runs, though the call was cancelled", async () => {
    const p = project();
    h.glab.on("api", { sleepMs: 5_000, json: {} }, ["=POST"]);
    h.glab.on(
        "api",
        { json: [note(6003, "hp", "Late words", { created_at: new Date(Date.now() + 60_000).toISOString() })] },
        ["/notes?sort=desc"],
    );
    const controller = new AbortController();
    // Esc is pressed once glab has the request.
    void (async () => {
        while (writes().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
    })();
    const result = await h.call(
        "pr",
        { action: "comment", repo: p.r.name, number: 42, body: "Late words" },
        { signal: controller.signal },
    );
    assert.match(
        ok(result),
        /^Commented on merge request !42 .*\n\(The reply was lost \(the call was cancelled\); one check shows it went through/,
    );
    assert.equal(writes().length, 1);
});

test("reply and resolve go to the discussion, named by the merge request and its id", async () => {
    const p = project();
    const thread = `42:${did(2)}`;
    h.glab.on("api", { json: note(6004, "hp", "agreed, fixing") }, ["=POST"]);
    const reply = await h.call("pr", { action: "reply", repo: p.r.name, thread, body: "agreed, fixing" });
    assert.equal(reply.preview?.summary, `reply in thread ${thread} of merge request 42 in ${p.r.name}`);
    assert.deepEqual(writes()[0]?.args.slice(-1), [`${p.base}/merge_requests/42/discussions/${did(2)}/notes`]);
    assert.deepEqual(sentJson(), { body: "agreed, fixing" });
    assert.equal(reply.text, `Replied in thread ${thread}: https://gitlab.com/${p.path}/-/merge_requests/42#note_6004`);

    h.glab.reset();
    h.glab.on("api", { json: discussion(did(2), [diffNote(7001, "alice", "Here"), diffNote(7002, "hp", "agreed")]) }, [
        `=${p.base}/merge_requests/42/discussions/${did(2)}`,
    ]);
    h.glab.on(
        "api",
        {
            json: discussion(did(2), [
                diffNote(7001, "alice", "Here", { resolved: true }),
                diffNote(7002, "hp", "agreed", { resolved: true }),
            ]),
        },
        ["=PUT"],
    );
    const resolved = await h.call("pr", { action: "resolve", repo: p.r.name, thread });
    assert.equal(resolved.preview?.summary, `resolve thread ${thread}`);
    assert.equal(resolved.text, `Resolved thread ${thread}.`);
    assert.deepEqual(writes()[0]?.args.slice(-1), [`${p.base}/merge_requests/42/discussions/${did(2)}`]);
    assert.deepEqual(sentJson(), { resolved: true });
});

test("resolve: a thread that is resolved already, or is a plain comment, is not written to; a PUT that resolved nothing is an error", async () => {
    const p = project();
    const thread = `42:${did(3)}`;
    h.glab.on("api", { json: discussion(did(3), [threadNote(8001, "bob", "Retry?", { resolved: true })]) });
    const done = await h.call("pr", { action: "resolve", repo: p.r.name, thread });
    assert.match(done.preview?.summary ?? "", /is already resolved; nothing will be changed$/);
    assert.equal(done.text, `Thread ${thread} was already resolved.`);
    assert.equal(writes().length, 0);
    h.glab.reset();
    h.glab.on("api", { json: discussion(did(4), [note(5001, "lead", "Docs?")], true) });
    assert.match(
        (await h.call("pr", { action: "resolve", repo: p.r.name, thread: `42:${did(4)}` })).error?.message ?? "",
        /is a plain comment, not a thread that can be resolved/,
    );
    h.glab.reset();
    h.glab.on("api", { json: discussion(did(3), [threadNote(8001, "bob", "Retry?")]) });
    assert.match(
        (await h.call("pr", { action: "resolve", repo: p.r.name, thread })).error?.message ?? "",
        /GitLab did not resolve thread 42:0+3; pr comments shows where it stands/,
    );
});

test("reply and resolve, the reply was lost: one look at the thread decides", async () => {
    const p = project();
    const thread = `42:${did(2)}`;
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=POST"]);
    h.glab.on(
        "api",
        {
            json: discussion(did(2), [
                diffNote(7001, "alice", "Here"),
                diffNote(7003, "hp", "On it", { created_at: new Date(Date.now() + 1000).toISOString() }),
            ]),
        },
        [`=${p.base}/merge_requests/42/discussions/${did(2)}`],
    );
    assert.match(
        ok(await h.call("pr", { action: "reply", repo: p.r.name, thread, body: "On it" })),
        new RegExp(`^Replied in thread ${thread}: .*#note_7003\\n\\(The reply was lost`),
    );
    assert.equal(writes().length, 1);
    h.glab.reset();
    const open = discussion(did(2), [diffNote(7001, "alice", "Here")]);
    h.glab.on(
        "api",
        [
            { json: open },
            { json: open },
            { json: discussion(did(2), [diffNote(7001, "alice", "Here", { resolved: true })]) },
        ],
        [`=${p.base}/merge_requests/42/discussions/${did(2)}`],
    );
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=PUT"]);
    assert.match(
        ok(await h.call("pr", { action: "resolve", repo: p.r.name, thread })),
        /^Resolved thread 42:0+2\.\n\(The reply was lost/,
    );
    assert.equal(writes().length, 1);
});

test("a thread id has the shape the forge gives: a GitHub one on a GitLab project is refused in one line, and a GitLab one needs its project", async () => {
    const p = project();
    const wrong = await h.call("pr", { action: "reply", repo: p.r.name, thread: "PRRT_kwDOAAAA1", body: "x" });
    assert.match(
        wrong.error?.message ?? "",
        /^thread must be a GitLab thread id such as 42:6a9c1750b37d513a43987b574953fceb50b03ce7/,
    );
    assert.match(
        (await h.call("pr", { action: "resolve", repo: p.r.name, thread: "42:zz" })).error?.message ?? "",
        /^thread must be a GitLab thread id/,
    );
    assert.equal(h.glab.calls().length, 0);
    assert.equal(h.gh.calls().length, 0);
    // Pi was started in the workspace, which is no repository: a GitLab thread has no project to belong to.
    const nowhere = await h.call("pr", { action: "reply", thread: `42:${did(2)}`, body: "x" });
    assert.match(nowhere.error?.message ?? "", /^repo is required: Pi was not started inside a git repository/);
});

test("review: a comment or a request for changes is published with the state; pending draft comments stop it; approving is not possible", async () => {
    const p = project();
    h.glab.on("api", { json: [] }, [`=${p.base}/merge_requests/42/draft_notes`]);
    const posted = (body: string) => note(6005, "hp", body, { created_at: new Date(Date.now() + 1000).toISOString() });
    h.glab.on("api", { json: [posted("Needs a test for the refund path.")] }, ["/notes?sort=desc"]);
    h.glab.on("api", { stdout: "" }, ["=POST", "bulk_publish"]);
    const changes = await h.call("pr", {
        action: "review",
        repo: p.r.name,
        number: 42,
        event: "request_changes",
        body: "Needs a test for the refund path.",
    });
    assert.equal(changes.preview?.summary, `send a request for changes on merge request 42 in ${p.r.name}`);
    assert.equal(changes.text, `Sent a request for changes on merge request !42 in ${p.r.name}.`);
    assert.deepEqual(writes()[0]?.args.slice(-1), [`${p.base}/merge_requests/42/draft_notes/bulk_publish`]);
    assert.deepEqual(sentJson(), { note: "Needs a test for the refund path.", reviewer_state: "requested_changes" });
    h.glab.reset();
    h.glab.on("api", { json: [] }, [`=${p.base}/merge_requests/42/draft_notes`]);
    h.glab.on("api", { json: [posted("Looks reasonable.")] }, ["/notes?sort=desc"]);
    h.glab.on("api", { stdout: "" }, ["=POST", "bulk_publish"]);
    ok(
        await h.call("pr", {
            action: "review",
            repo: p.r.name,
            number: 42,
            event: "comment",
            body: "Looks reasonable.",
        }),
    );
    assert.deepEqual(sentJson(), { note: "Looks reasonable.", reviewer_state: "reviewed" });
    h.glab.reset();
    h.glab.on(
        "api",
        {
            json: [
                { id: 1, note: "half a thought" },
                { id: 2, note: "another" },
            ],
        },
        [`=${p.base}/merge_requests/42/draft_notes`],
    );
    const pending = await h.call("pr", { action: "review", repo: p.r.name, number: 42, event: "comment", body: "x" });
    assert.equal(
        pending.error?.message,
        "the signed-in GitLab user has 2 pending draft comments on merge request 42, and a review would publish them too; publish or delete them in GitLab first",
    );
    assert.equal(writes().length, 0);
    const approve = await h.call("pr", { action: "review", repo: p.r.name, number: 42, event: "approve", body: "x" });
    assert.ok(approve.error, "approving is refused");
    assert.match(
        (await h.call("pr", { action: "review", repo: p.r.name, number: 42, event: undefined, body: "x" })).error
            ?.message ?? "",
        /needs event/,
    );
});

test("review: GitLab accepting the request without the review appearing is said, not called sent; a lost reply is settled by one read", async () => {
    const p = project();
    h.glab.on("api", { json: [] }, [`=${p.base}/merge_requests/42/draft_notes`]);
    h.glab.on("api", { json: [] }, ["/notes?sort=desc"]);
    h.glab.on("api", { stdout: "" }, ["=POST", "bulk_publish"]);
    const unseen = await h.call("pr", {
        action: "review",
        repo: p.r.name,
        number: 42,
        event: "comment",
        body: "Hello",
    });
    assert.match(
        unseen.error?.message ?? "",
        /^glab api \(review\): GitLab accepted the request, but one check does not show the review on merge request 42\. Nothing was sent twice/,
    );
    assert.equal(writes().length, 1);
    h.glab.reset();
    h.glab.on("api", { json: [] }, [`=${p.base}/merge_requests/42/draft_notes`]);
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=POST", "bulk_publish"]);
    h.glab.on("api", { json: [note(6006, "hp", "Hello", { created_at: new Date(Date.now() + 1000).toISOString() })] }, [
        "/notes?sort=desc",
    ]);
    assert.match(
        ok(await h.call("pr", { action: "review", repo: p.r.name, number: 42, event: "comment", body: "Hello" })),
        /^Sent a review comment on merge request !42 in orders-api\d+\.\n\(The reply was lost/,
    );
    assert.equal(writes().length, 1);
});

// ---- merge --------------------------------------------------------------------------------------------------------

test("merge: the preview shows the title, method, checks and head; the run pins the head and says squash or not", async () => {
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: mr({ state: "merged" }, p.path) }, ["=PUT"]);
    const result = await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "squash" });
    assert.match(
        result.preview?.summary ?? "",
        /^squash-merge merge request 42 into main in orders-api\d+: Add the thing \(head 1111111\)$/,
    );
    assert.equal(
        result.preview?.body,
        [
            "Add the thing",
            "From feature/one at 1111111 into main, by squash.",
            "Checks: 1 pass, 1 fail, 0 pending, 0 skipped. Merge status: mergeable.",
            "It merges only while the head is still 1111111.",
        ].join("\n"),
    );
    assert.equal(result.preview?.format, "text");
    assert.deepEqual(result.cls && [result.cls.environment, result.cls.effect, result.cls.approval], [
        "external",
        "write",
        undefined,
    ]);
    assert.deepEqual(writes()[0]?.args, [
        "api",
        "--hostname",
        "gitlab.com",
        "-X",
        "PUT",
        "--input",
        "-",
        `${p.base}/merge_requests/42/merge`,
    ]);
    assert.deepEqual(sentJson(), { sha: HEAD, squash: true });
    assert.match(result.text, /^Merged merge request !42 into main \(squash\) at 1111111 in orders-api\d+\.$/);
    h.glab.reset();
    serveMr(p);
    h.glab.on("api", { json: mr({ state: "merged" }, p.path) }, ["=PUT"]);
    ok(await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge" }));
    assert.deepEqual(sentJson(), { sha: HEAD, squash: false });
});

test("merge: auto-merge is a different request, and says so", async () => {
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: mr({ merge_when_pipeline_succeeds: true }, p.path) }, ["=PUT"]);
    const result = await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "squash", auto: true });
    assert.match(result.preview?.summary ?? "", /^turn on auto-merge \(squash\) for merge request 42 into main/);
    assert.deepEqual(sentJson(), { sha: HEAD, squash: true, auto_merge: true });
    assert.match(
        result.text,
        /^Auto-merge is on for merge request !42 \(squash\) in orders-api\d+: it merges when its pipeline succeeds\.$/,
    );
});

test("merge: a head that moves after the preview is refused, and nothing is merged", async () => {
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: mr({ state: "merged" }, p.path) }, ["=PUT"]);
    const result = await h.call(
        "pr",
        { action: "merge", repo: p.r.name, number: 42, method: "merge" },
        { between: () => serveMr(p, { sha: OTHER }) },
    );
    assert.match(
        result.error?.message ?? "",
        /pr merge changed since the preview; run it again to see the new preview/,
    );
    assert.equal(writes().length, 0);
});

test("merge: a draft, a closed or merged request, a conflict, a missing head, a missing method and a rebase are refused before anyone is asked", async () => {
    const p = project();
    const merge = (more: Record<string, unknown> = {}) =>
        h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge", ...more });
    serveMr(p, { draft: true, title: "Draft: Add the thing" });
    assert.match((await merge()).error?.message ?? "", /^merge request 42 is a draft; mark it ready for review first$/);
    serveMr(p, { state: "closed" });
    assert.match((await merge()).error?.message ?? "", /^merge request 42 is closed, not open$/);
    serveMr(p, { state: "merged" });
    assert.match((await merge()).error?.message ?? "", /^merge request 42 is merged, not open$/);
    serveMr(p, { has_conflicts: true });
    assert.match(
        (await merge()).error?.message ?? "",
        /^merge request 42 conflicts with main; resolve the conflicts on feature\/one first$/,
    );
    serveMr(p, { detailed_merge_status: "conflict" });
    assert.match((await merge()).error?.message ?? "", /conflicts with main/);
    serveMr(p, { sha: null });
    assert.match(
        (await merge()).error?.message ?? "",
        /^GitLab did not say which commit merge request 42 is at, so the merge cannot be pinned$/,
    );
    assert.match(
        (await h.call("pr", { action: "merge", repo: p.r.name, number: 42 })).error?.message ?? "",
        /needs method|method is required/,
    );
    h.glab.reset();
    const rebase = await merge({ method: "rebase" });
    assert.equal(
        rebase.error?.message,
        "pr merge: GitLab does not rebase as part of a merge; the project's merge method (fast-forward or semi-linear) decides. Run glab mr rebase 42 yourself, then merge",
    );
    assert.equal(h.glab.calls().length, 0, "the refusal needs no read");
    assert.equal(writes().length, 0);
});

test("merge: GitLab's refusals are one line with what to do; a lost reply is settled by one read; a merge that did not happen is not called one", async () => {
    const p = project();
    serveMr(p);
    for (const [status, text] of [
        [405, /GitLab will not merge it now: a pipeline, an approval or an open thread is still required/],
        [409, /the head moved since you looked, so its sha no longer matches; run pr merge again/],
        [422, /GitLab could not merge the branch: a conflict, or the target moved/],
    ] as const) {
        h.glab.on("api", { code: 1, stderr: `glab: ${status} Refused (HTTP ${status})` }, ["=PUT"]);
        assert.match(
            (await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge" })).error?.message ?? "",
            text,
        );
    }
    assert.equal(writes().length, 3, "each was sent once, and nothing was read after");
    h.glab.reset();
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)" }, ["=PUT"]);
    h.glab.on(
        "api",
        [{ json: mr({}, p.path) }, { json: mr({}, p.path) }, { json: mr({ state: "merged" }, p.path) }],
        [`=${p.base}/merge_requests/42`],
    );
    h.glab.on("api", { json: [] }, [`${p.base}/pipelines/301/jobs`]);
    assert.match(
        ok(await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge" })),
        /^Merged merge request !42 into main \(merge\) at 1111111 in orders-api\d+\.\n\(The reply was lost/,
    );
    assert.equal(writes().length, 1);
    h.glab.reset();
    serveMr(p);
    h.glab.on("api", { json: mr({ state: "opened", merge_when_pipeline_succeeds: true }, p.path) }, ["=PUT"]);
    assert.match(
        ok(await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge" })),
        /^GitLab accepted the merge of !42 in orders-api\d+, but it shows opened and set to merge when its pipeline succeeds; pr view shows where it stands\.$/,
    );
});

test("merge into the default branch is an ordinary write: it asks, and the preview names the target", async () => {
    const p = project();
    serveMr(p);
    h.glab.on("api", { json: mr({ state: "merged" }, p.path) }, ["=PUT"]);
    const result = await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge" });
    assert.ok(result.preview, "the call asked");
    assert.match(result.preview?.summary ?? "", / into main in /);
});

test("a call the action does not take, or lacks what it needs, is refused with the usage line", async () => {
    const p = project();
    assert.match(
        (await h.call("pr", { action: "comment", repo: p.r.name, number: 42 })).error?.message ?? "",
        /^pr comment needs body\. Usage: pr comment \{number, body, repo\?\}$/,
    );
    assert.match(
        (await h.call("pr", { action: "merge", repo: p.r.name, number: 42, method: "merge", draft: true })).error
            ?.message ?? "",
        /^pr merge does not use draft\./,
    );
    assert.equal(h.glab.calls().length, 0);
});
