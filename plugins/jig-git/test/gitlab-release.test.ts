// `release` on a GitLab project: releases listed or shown, and release_create. GitLab is a fake `glab` that answers `glab api`
// from answers written down in the shape of GitLab's REST API. Nothing here reaches a GitLab server. GitLab has no draft
// release, no pre-release flag and no generated notes: a call that asks for one is refused before anything is read.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { HEAD } from "./support/gitlab-answers.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { commitFile, git, makeRepo, teammateCommit } from "./support/repos.ts";
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
    path: string;
    base: string;
}

function project(): Project {
    const r = makeRepo(h.sb, `rel${++counter}`, "acme", "gitlab.com");
    const path = `acme/${r.name}`;
    return { r, path, base: `projects/${encodeURIComponent(path)}` };
}

const NOT_FOUND = { code: 1, stderr: "glab: 404 Not Found (HTTP 404)\n" };

const release = (path: string, tag: string, overrides: Record<string, unknown> = {}) => ({
    tag_name: tag,
    name: tag,
    description: "## Changes\n- one",
    created_at: "2026-10-01T09:00:00.000Z",
    released_at: "2026-10-01T10:00:00.000Z",
    upcoming_release: false,
    commit: { id: HEAD },
    assets: {
        count: 5,
        sources: [{ format: "zip", url: "https://gitlab.com/x.zip" }],
        links: [{ name: "installer.zip", url: "https://gitlab.com/i.zip" }],
    },
    _links: { self: `https://gitlab.com/${path}/-/releases/${tag}` },
    ...overrides,
});

const posts = () => h.glab.callsOf("api").filter((call) => call.args.includes("POST"));

// ---- releases -----------------------------------------------------------------------------------------------------

test("releases: newest first, with the day, whether it is upcoming, and a name that is not the tag", async () => {
    const p = project();
    h.glab.on("api", {
        json: [
            release(p.path, "v2.0.0", { name: "Two", released_at: "2026-10-20T10:00:00.000Z", upcoming_release: true }),
            release(p.path, "v1.0.0"),
        ],
    });
    assert.equal(
        ok(await h.call("release", { action: "releases", repo: p.r.name, n: 5 })),
        `${p.r.name}: 2 releases\nv2.0.0  2026-10-20  upcoming  Two\nv1.0.0  2026-10-01`,
    );
    assert.deepEqual(h.glab.callsOf("api")[0]?.args, [
        "api",
        "--hostname",
        "gitlab.com",
        `${p.base}/releases?per_page=5&order_by=released_at&sort=desc`,
    ]);
    assert.equal(h.gh.calls().length, 0);
    h.glab.reset();
    h.glab.on("api", { json: [] });
    assert.equal(ok(await h.call("release", { action: "releases", repo: p.r.name })), `No releases in ${p.r.name}.`);
});

test("releases: one in full, with its address, its asset links and the start of its notes; a tag with a slash is encoded", async () => {
    const p = project();
    h.glab.on("api", { json: release(p.path, "v1.0.0", { name: "First" }) });
    const text = ok(await h.call("release", { action: "releases", repo: p.r.name, tag: "v1.0.0" }));
    assert.equal(
        text,
        [
            'Release v1.0.0 "First", published 2026-10-01, target 1111111',
            `https://gitlab.com/${p.path}/-/releases/v1.0.0`,
            "assets: installer.zip",
            "",
            "## Changes\n- one",
        ].join("\n"),
    );
    h.glab.reset();
    h.glab.on("api", { json: release(p.path, "release/1.0", { assets: { links: [] }, upcoming_release: true }) });
    ok(await h.call("release", { action: "releases", repo: p.r.name, tag: "release/1.0" }));
    assert.deepEqual(h.glab.callsOf("api")[0]?.args.slice(-1), [`${p.base}/releases/release%2F1.0`]);
    h.glab.reset();
    h.glab.on("api", NOT_FOUND);
    assert.match(
        (await h.call("release", { action: "releases", repo: p.r.name, tag: "v9" })).error?.message ?? "",
        /^glab api \(release\) failed: glab: 404 Not Found \(HTTP 404\)/,
    );
});

// ---- release_create -----------------------------------------------------------------------------------------------

test("release_create: the preview shows the tag, the target and the notes; the run sends them as JSON with the ref of a new tag", async () => {
    const p = project();
    h.glab.on("api", { json: release(p.path, "v1.0.0") }, ["=POST"]);
    h.glab.on("api", NOT_FOUND, [`=${p.base}/releases/v1.0.0`]);
    const result = await h.call("release", {
        action: "release_create",
        repo: p.r.name,
        tag: "v1.0.0",
        title: "Version 1",
        notes: "## Changes\n- one",
        target: "main",
    });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
    assert.match(
        result.preview?.summary ?? "",
        /^create the release v1\.0\.0 on a new tag v1\.0\.0 at main in acme\/rel\d+$/,
    );
    assert.equal(result.preview?.format, "markdown");
    assert.equal(result.preview?.body, "# Version 1\n\n## Changes\n- one");
    assert.deepEqual(posts()[0]?.args, [
        "api",
        "--hostname",
        "gitlab.com",
        "-X",
        "POST",
        "--input",
        "-",
        `${p.base}/releases`,
    ]);
    assert.deepEqual(JSON.parse(posts()[0]?.stdin ?? ""), {
        tag_name: "v1.0.0",
        name: "Version 1",
        description: "## Changes\n- one",
        ref: "main",
    });
    assert.equal(
        result.text,
        `Created the release v1.0.0 in ${p.path}: https://gitlab.com/${p.path}/-/releases/v1.0.0`,
    );
    assert.equal(h.gh.calls().length, 0);
});

test("release_create: without a target the new tag is made at the head of the base; an existing tag on the remote is used as it is", async () => {
    const p = project();
    h.glab.on("api", { json: release(p.path, "v2") }, ["=POST"]);
    h.glab.on("api", NOT_FOUND, [`=${p.base}/releases/v2`]);
    const result = await h.call("release", { action: "release_create", repo: p.r.name, tag: "v2" });
    assert.match(result.preview?.summary ?? "", /on a new tag v2 at the head of main in /);
    assert.deepEqual(JSON.parse(posts()[0]?.stdin ?? ""), { tag_name: "v2", name: "v2", ref: "main" });
    h.glab.reset();
    ok(await h.call("release", { action: "tag_create", repo: p.r.name, tag: "v3", message: "m" }));
    ok(await h.call("release", { action: "tag_push", repo: p.r.name, tag: "v3" }));
    h.glab.on("api", { json: release(p.path, "v3") }, ["=POST"]);
    h.glab.on("api", NOT_FOUND, [`=${p.base}/releases/v3`]);
    const existing = await h.call("release", {
        action: "release_create",
        repo: p.r.name,
        tag: "v3",
        notes: "n",
        target: "main",
    });
    assert.match(existing.preview?.summary ?? "", /^create the release v3 on the existing tag v3 \([0-9a-f]{7}\) in /);
    assert.deepEqual(JSON.parse(posts()[0]?.stdin ?? ""), { tag_name: "v3", name: "v3", description: "n" });
});

test("release_create: a release that exists is refused; so is a change after the preview; so is a read that fails", async () => {
    const p = project();
    h.glab.on("api", { json: release(p.path, "v1") }, [`=${p.base}/releases/v1`]);
    assert.equal(
        (await h.call("release", { action: "release_create", repo: p.r.name, tag: "v1" })).error?.message,
        `a release for v1 already exists in ${p.path}`,
    );
    h.glab.on("api", NOT_FOUND, [`=${p.base}/releases/v2`]);
    h.glab.on("api", { json: release(p.path, "v2") }, ["=POST"]);
    const moved = await h.call(
        "release",
        { action: "release_create", repo: p.r.name, tag: "v2", notes: "n" },
        {
            between: () => {
                teammateCommit(h.sb, p.r, "main", "late.txt", "Main moved");
                git(p.r.dir, "fetch", "-q", "origin");
            },
        },
    );
    assert.match(
        moved.error?.message ?? "",
        /release release_create changed since the preview; run it again to see the new preview/,
    );
    assert.equal(posts().length, 0);
    h.glab.on("api", { code: 1, stderr: "glab: 401 Unauthorized (HTTP 401)\n" }, [`=${p.base}/releases/v4`]);
    assert.match(
        (await h.call("release", { action: "release_create", repo: p.r.name, tag: "v4" })).error?.message ?? "",
        /^glab api \(release\) failed: glab: 401 Unauthorized \(HTTP 401\) \(glab is not signed in for gitlab\.com: run glab auth login --hostname gitlab\.com yourself\)$/,
    );
});

test("release_create: a draft, a pre-release and generated notes have no GitLab equivalent, and are refused in one line before anything is read or asked", async () => {
    const p = project();
    const call = (more: Record<string, unknown>) =>
        h.call("release", { action: "release_create", repo: p.r.name, tag: "v1", ...more });
    const draft = await call({ draft: true });
    assert.equal(
        draft.error?.message,
        "release_create: GitLab has no draft releases; create the release when it is ready (a release dated in the future shows as upcoming)",
    );
    assert.equal(draft.preview, undefined, "nobody was asked");
    assert.equal(
        (await call({ prerelease: true })).error?.message,
        "release_create: GitLab has no pre-release flag; say it in the title or the notes",
    );
    assert.equal(
        (await call({ generate_notes: true })).error?.message,
        "release_create: GitLab does not write release notes; write them in notes, or use its changelog API to generate them",
    );
    assert.equal(h.glab.calls().length, 0);
    assert.equal(h.gh.calls().length, 0);
    assert.equal(posts().length, 0);
});

test("release_create, the reply was lost: one read of the release decides, and the request is not sent again", async () => {
    const p = project();
    h.glab.on("api", [NOT_FOUND, NOT_FOUND, { json: release(p.path, "v5") }], [`=${p.base}/releases/v5`]);
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)\n" }, ["=POST"]);
    const text = ok(await h.call("release", { action: "release_create", repo: p.r.name, tag: "v5", notes: "n" }));
    assert.match(
        text,
        new RegExp(
            `^Created the release v5 in ${p.path}: https://gitlab.com/${p.path}/-/releases/v5\\n\\(The reply was lost`,
        ),
    );
    assert.equal(posts().length, 1);
    assert.equal(
        h.glab.callsOf("api").filter((call) => call.args.at(-1)?.endsWith("/releases/v5")).length,
        3,
        "two plans and one check",
    );
    h.glab.reset();
    h.glab.on("api", NOT_FOUND, [`=${p.base}/releases/v6`]);
    h.glab.on("api", { code: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)\n" }, ["=POST"]);
    assert.match(
        (await h.call("release", { action: "release_create", repo: p.r.name, tag: "v6" })).error?.message ?? "",
        /^glab api \(create release\): the reply was lost \(glab: 502 Bad Gateway \(HTTP 502\)\) and one check shows it did not go through/,
    );
});

// ---- tags, and hosts that are not known ---------------------------------------------------------------------------

test("tags are git: they work on a GitLab project with neither glab nor gh", async () => {
    const p = project();
    ok(await h.call("release", { action: "tag_create", repo: p.r.name, tag: "v1.0.0", message: "First" }));
    assert.match(
        ok(await h.call("release", { action: "tag_push", repo: p.r.name, tag: "v1.0.0" })),
        /^Pushed the tag v1\.0\.0/,
    );
    assert.match(ok(await h.call("release", { action: "tags", repo: p.r.name })), /: 1 tag, newest first\nv1\.0\.0 /);
    assert.equal(h.glab.calls().length, 0);
    assert.equal(h.gh.calls().length, 0);
});

test("on a host that is not known the releases are refused, and the tags still work", async () => {
    const r = makeRepo(h.sb, `rel${++counter}`, "acme", "gitlab.example.com");
    const message = `origin of ${r.name} is on gitlab.example.com, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": { "gitlab.example.com": "gitlab" } }`;
    assert.equal((await h.call("release", { action: "releases", repo: r.name })).error?.message, message);
    assert.equal(
        (await h.call("release", { action: "release_create", repo: r.name, tag: "v1" })).error?.message,
        message,
    );
    commitFile(r.dir, "a.txt", "a\n", "A");
    ok(await h.call("release", { action: "tag_create", repo: r.name, tag: "v1", message: "m" }));
    assert.equal(h.glab.calls().length, 0);
    assert.equal(h.gh.calls().length, 0);
});
