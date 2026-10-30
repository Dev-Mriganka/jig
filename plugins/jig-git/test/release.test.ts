import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
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

function repo(): Fixture {
    return makeRepo(h.sb, `rel${++counter}`, "acme");
}

const pushes = () => h.jig.started_processes.filter((p) => p.file === "git" && p.args[0] === "push");

// ---- tags ---------------------------------------------------------------------------------------------------------

test("tags: newest first, with the commit each points at; a pattern and a commit filter", async () => {
    const r = repo();
    git(r.dir, "tag", "-a", "-m", "First release", "v1.0.0");
    const second = commitFile(r.dir, "two.txt", "2\n", "Second");
    git(r.dir, "tag", "v1.1.0");
    commitFile(r.dir, "three.txt", "3\n", "Third");
    git(r.dir, "tag", "-a", "-m", "Next", "v2.0.0");
    const text = ok(await h.call("release", { action: "tags", repo: r.name }));
    const lines = text.split("\n");
    assert.match(lines[0] ?? "", /^rel\d+: 3 tags, newest first$/);
    assert.match(lines[1] ?? "", /^v2\.0\.0 {2}[0-9a-f]{7} {2}\d{4}-\d{2}-\d{2} {2}Next$/);
    assert.match(ok(await h.call("release", { action: "tags", repo: r.name, pattern: "v1.*" })), /^rel\d+: 2 tags/);
    const containing = ok(await h.call("release", { action: "tags", repo: r.name, contains: second }));
    assert.match(containing, /v1\.1\.0/);
    assert.match(containing, /v2\.0\.0/);
    assert.doesNotMatch(containing, /v1\.0\.0/);
    assert.match(
        ok(await h.call("release", { action: "tags", repo: r.name, pattern: "z*" })),
        /No tags match z\* in rel\d+\./,
    );
    assert.match(
        (await h.call("release", { action: "tags", repo: r.name, pattern: "--sort=x" })).error?.message ?? "",
        /pattern must be a glob/,
    );
});

test("tags: only n are shown, and the rest are counted", async () => {
    const r = repo();
    for (const tag of ["v1", "v2", "v3"]) {
        commitFile(r.dir, `${tag}.txt`, "x\n", `Commit ${tag}`);
        git(r.dir, "tag", tag);
    }
    const text = ok(await h.call("release", { action: "tags", repo: r.name, n: 2 }));
    assert.match(text, /3 tags, newest first\nv3 .*\nv2 .*\n\.\.\. 1 more$/);
});

// ---- releases -----------------------------------------------------------------------------------------------------

test("releases: listed, with the latest marked; one in full with its notes and assets", async () => {
    const r = repo();
    h.gh.on("release list", {
        json: [
            {
                name: "v1.1.0",
                tagName: "v1.1.0",
                isDraft: false,
                isPrerelease: false,
                isLatest: true,
                publishedAt: "2026-10-20T10:00:00Z",
            },
            {
                name: "Beta",
                tagName: "v1.2.0-rc1",
                isDraft: false,
                isPrerelease: true,
                isLatest: false,
                publishedAt: "2026-10-25T10:00:00Z",
            },
        ],
    });
    const text = ok(await h.call("release", { action: "releases", repo: r.name }));
    assert.equal(text, `${r.name}: 2 releases\nv1.1.0  2026-10-20  latest\nv1.2.0-rc1  2026-10-25  pre-release  Beta`);
    assert.deepEqual(h.gh.calls()[0]?.args.slice(0, 5), ["release", "list", "--limit", "20", "--json"]);
    h.gh.on("release view", {
        json: {
            name: "v1.1.0",
            tagName: "v1.1.0",
            isDraft: false,
            isPrerelease: false,
            publishedAt: "2026-10-20T10:00:00Z",
            url: "https://github.com/acme/svc/releases/tag/v1.1.0",
            targetCommitish: "main",
            body: "Fixes:\n- one",
            assets: [{ name: "dist.zip", size: 10 }],
        },
    });
    const one = ok(await h.call("release", { action: "releases", repo: r.name, tag: "v1.1.0" }));
    assert.equal(
        one,
        "Release v1.1.0, published 2026-10-20, target main\nhttps://github.com/acme/svc/releases/tag/v1.1.0\nassets: dist.zip\n\nFixes:\n- one",
    );
    h.gh.on("release list", { json: [] });
    assert.match(ok(await h.call("release", { action: "releases", repo: r.name })), /No releases in rel\d+\./);
});

// ---- tag_create ---------------------------------------------------------------------------------------------------

test("tag_create: an annotated tag at HEAD, or at a target; local, so it does not ask", async () => {
    const r = repo();
    const result = await h.call("release", {
        action: "tag_create",
        repo: r.name,
        tag: "v1.0.0",
        message: "First release",
    });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["local", "write"]);
    assert.equal(result.preview, undefined);
    assert.match(
        result.text,
        /^Created the annotated tag v1\.0\.0 at [0-9a-f]{7} in rel\d+\. It is local until tag_push sends it\.$/,
    );
    assert.equal(git(r.dir, "cat-file", "-t", "v1.0.0"), "tag", "annotated");
    assert.equal(git(r.dir, "tag", "-l", "--format=%(contents:subject)", "v1.0.0"), "First release");
    const second = commitFile(r.dir, "two.txt", "2\n", "Second");
    commitFile(r.dir, "three.txt", "3\n", "Third");
    ok(
        await h.call("release", {
            action: "tag_create",
            repo: r.name,
            tag: "v1.1.0",
            message: "Second release",
            target: second,
        }),
    );
    assert.equal(git(r.dir, "rev-list", "-n1", "v1.1.0"), second);
});

test("tag_create: an existing tag is never moved; names and targets are checked", async () => {
    const r = repo();
    git(r.dir, "tag", "v1");
    assert.match(
        (await h.call("release", { action: "tag_create", repo: r.name, tag: "v1", message: "again" })).error?.message ??
            "",
        /tag v1 already exists in rel\d+; a tag is never moved or deleted from here/,
    );
    assert.match(
        (await h.call("release", { action: "tag_create", repo: r.name, tag: "-x", message: "m" })).error?.message ?? "",
        /not a valid branch name|not a valid/,
    );
    assert.match(
        (await h.call("release", { action: "tag_create", repo: r.name, tag: "v2", message: "m", target: "nope" })).error
            ?.message ?? "",
        /nope is not a commit/,
    );
    assert.match(
        (await h.call("release", { action: "tag_create", repo: r.name, tag: "v2", message: " " })).error?.message ?? "",
        /message is required/,
    );
});

// ---- tag_push -----------------------------------------------------------------------------------------------------

test("tag_push: the preview names the tag and the commit; the push sends only that tag", async () => {
    const r = repo();
    ok(await h.call("release", { action: "tag_create", repo: r.name, tag: "v1.0.0", message: "First release" }));
    const result = await h.call("release", { action: "tag_push", repo: r.name, tag: "v1.0.0" });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
    assert.match(result.preview?.summary ?? "", /^push the tag v1\.0\.0 \([0-9a-f]{7}\) to origin from rel\d+$/);
    assert.match(result.preview?.body ?? "", /^Tag v1\.0\.0 points at [0-9a-f]{7}: Initial commit$/);
    assert.match(result.text, /^Pushed the tag v1\.0\.0 \([0-9a-f]{7}\) to origin from rel\d+\.$/);
    assert.equal(git(r.origin, "cat-file", "-t", "v1.0.0"), "tag");
    assert.deepEqual(
        pushes().map((p) => p.args.slice(-1)[0]),
        ["refs/tags/v1.0.0:refs/tags/v1.0.0"],
    );
    assert.ok(!pushes().some((p) => p.args.some((arg) => /force|--delete|^\+/.test(arg))));
});

test("tag_push: a tag that is already there is not sent again; a tag that points elsewhere is refused", async () => {
    const r = repo();
    ok(await h.call("release", { action: "tag_create", repo: r.name, tag: "v1", message: "m" }));
    ok(await h.call("release", { action: "tag_push", repo: r.name, tag: "v1" }));
    const again = await h.call("release", { action: "tag_push", repo: r.name, tag: "v1" });
    assert.match(again.preview?.summary ?? "", /; it is already there$/);
    assert.match(ok(again), /already has v1 at [0-9a-f]{7}; nothing to push\./);
    assert.equal(pushes().length, 1);
    // A teammate's tag of the same name on another commit.
    const sha = teammateCommit(h.sb, r, "main", "other.txt", "Other");
    git(r.dir, "fetch", "-q", "origin");
    git(r.dir, "tag", "-a", "-m", "mine", "v2", "main");
    const other = `${h.sb.root}/other-tagger`;
    git(h.sb.root, "clone", "-q", r.origin, other);
    git(other, "tag", "-a", "-m", "theirs", "v2", sha);
    git(other, "push", "-q", "origin", "v2");
    const clash = await h.call("release", { action: "tag_push", repo: r.name, tag: "v2" });
    assert.match(
        clash.error?.message ?? "",
        /origin already has a tag v2 that points elsewhere; a pushed tag is never forced or deleted from here/,
    );
    assert.match(
        (await h.call("release", { action: "tag_push", repo: r.name, tag: "missing" })).error?.message ?? "",
        /tag missing does not exist in rel\d+; tag_create makes it/,
    );
});

test("tag_push, the reply was lost: one ls-remote says whether the tag is there", async () => {
    const r = repo();
    ok(await h.call("release", { action: "tag_create", repo: r.name, tag: "v1", message: "m" }));
    h.jig.loseGitReply(
        (args) => args[0] === "push",
        { code: 128, stderr: "fatal: the remote end hung up unexpectedly" },
        true,
    );
    const text = ok(await h.call("release", { action: "tag_push", repo: r.name, tag: "v1" }));
    assert.match(
        text,
        /^Pushed the tag v1 .*\(The reply was lost \(fatal: the remote end hung up unexpectedly\); one check shows origin has it\. Nothing was sent twice\.\)$/,
    );
    assert.equal(pushes().length, 1);
    ok(await h.call("release", { action: "tag_create", repo: r.name, tag: "v2", message: "m" }));
    h.jig.loseGitReply((args) => args[0] === "push", { code: 128, stderr: "connection reset by peer" }, false);
    const missing = await h.call("release", { action: "tag_push", repo: r.name, tag: "v2" });
    assert.match(
        missing.error?.message ?? "",
        /the reply was lost \(connection reset by peer\) and origin does not have v2\. Nothing was sent twice/,
    );
});

// ---- release_create -----------------------------------------------------------------------------------------------

const NO_RELEASE = { code: 1, stderr: "release not found\n" };

test("release_create: the preview shows the tag, the target and the notes; the notes go on stdin", async () => {
    const r = repo();
    h.gh.on("release view", NO_RELEASE);
    h.gh.on("release create", { stdout: "https://github.com/acme/svc/releases/tag/v1.0.0\n" });
    const result = await h.call("release", {
        action: "release_create",
        repo: r.name,
        tag: "v1.0.0",
        title: "Version 1",
        notes: "## Changes\n- one",
        target: "main",
        prerelease: true,
    });
    assert.deepEqual([result.cls?.environment, result.cls?.effect], ["external", "write"]);
    assert.match(
        result.preview?.summary ?? "",
        /^create the release v1\.0\.0 \(pre-release\) on a new tag v1\.0\.0 at main in acme\/rel\d+$/,
    );
    assert.equal(result.preview?.format, "markdown");
    assert.equal(result.preview?.body, "# Version 1\n\n## Changes\n- one");
    assert.deepEqual(h.gh.callsOf("release create")[0]?.args, [
        "release",
        "create",
        "v1.0.0",
        "--title=Version 1",
        "--notes-file",
        "-",
        "--target",
        "main",
        "--prerelease",
        "-R",
        `acme/${r.name}`,
    ]);
    assert.equal(h.gh.callsOf("release create")[0]?.stdin, "## Changes\n- one");
    assert.match(
        result.text,
        /^Created the release v1\.0\.0 in acme\/rel\d+: https:\/\/github\.com\/acme\/svc\/releases\/tag\/v1\.0\.0$/,
    );
});

test("release_create: an existing tag on the remote is used, and a draft with generated notes is asked for", async () => {
    const r = repo();
    ok(await h.call("release", { action: "tag_create", repo: r.name, tag: "v1", message: "m" }));
    ok(await h.call("release", { action: "tag_push", repo: r.name, tag: "v1" }));
    h.gh.on("release view", NO_RELEASE);
    h.gh.on("release create", { stdout: "https://github.com/acme/svc/releases/tag/v1\n" });
    const result = await h.call("release", {
        action: "release_create",
        repo: r.name,
        tag: "v1",
        generate_notes: true,
        draft: true,
        target: "main",
    });
    assert.match(
        result.preview?.summary ?? "",
        /^create the release v1 \(draft\) on the existing tag v1 \([0-9a-f]{7}\) in /,
    );
    assert.match(result.preview?.body ?? "", /^# v1\n\n\(GitHub writes the notes\.\)$/);
    const args = h.gh.callsOf("release create")[0]?.args ?? [];
    assert.ok(args.includes("--generate-notes") && args.includes("--draft"));
    assert.ok(!args.includes("--target"), "the tag exists, so there is no target to give");
});

test("release_create: a release that exists is refused; so is a change after the preview", async () => {
    const r = repo();
    h.gh.on("release view", { json: { url: "https://github.com/acme/svc/releases/tag/v1" } });
    assert.match(
        (await h.call("release", { action: "release_create", repo: r.name, tag: "v1" })).error?.message ?? "",
        /a release for v1 already exists in acme\/rel\d+/,
    );
    h.gh.on("release view", NO_RELEASE);
    h.gh.on("release create", { stdout: "" });
    const moved = await h.call(
        "release",
        { action: "release_create", repo: r.name, tag: "v2", notes: "n" },
        {
            between: () => {
                teammateCommit(h.sb, r, "main", "late.txt", "Main moved");
                git(r.dir, "fetch", "-q", "origin");
            },
        },
    );
    assert.match(
        moved.error?.message ?? "",
        /release release_create changed since the preview; run it again to see the new preview/,
    );
    assert.equal(h.gh.callsOf("release create").length, 0);
});

test("release_create, the reply was lost: one view of the release decides", async () => {
    const r = repo();
    h.gh.on("release view", [NO_RELEASE, NO_RELEASE, { json: { url: "https://github.com/acme/svc/releases/tag/v3" } }]);
    h.gh.on("release create", { code: 1, stderr: "Post: context deadline exceeded\n" });
    const text = ok(await h.call("release", { action: "release_create", repo: r.name, tag: "v3", notes: "n" }));
    assert.match(
        text,
        /^Created the release v3 in acme\/rel\d+: https:\/\/github\.com\/acme\/svc\/releases\/tag\/v3\n\(The reply was lost/,
    );
    assert.equal(h.gh.callsOf("release create").length, 1);
    assert.equal(h.gh.callsOf("release view").length, 3, "two plans and one check");
});

test("a call the action does not take is refused with the usage line", async () => {
    const r = repo();
    assert.match(
        (await h.call("release", { action: "tag_create", repo: r.name, tag: "v1" })).error?.message ?? "",
        /^release tag_create needs message\. Usage: release tag_create \{tag, message, repo\?, target\?\}$/,
    );
    assert.match(
        (await h.call("release", { action: "tags", repo: r.name, notes: "x" })).error?.message ?? "",
        /^release tags does not use notes\. Usage: release tags \{repo\?, pattern\?, contains\?, n\?\}$/,
    );
    assert.match(
        (await h.call("release", { action: "tag_delete", tag: "v1" })).error?.message ?? "",
        /^release: unknown action "tag_delete"; use one of tags, releases, tag_create, tag_push, release_create$/,
    );
});
