// Which forge a repository is on: decided from the host of origin and from git.forges, never from a call. And the pieces that
// feed it: the remote's host and path, and the git.forges setting.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { settingsFrom, validateGitSection } from "../src/config.ts";
import { forgeOf, gitlabHome, UnknownForgeHost } from "../src/forge.ts";
import { parseRemotePath, resolveRepo } from "../src/repo.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { HEAD, mr } from "./support/gitlab-answers.ts";
import { commitFile, git, makeRepo } from "./support/repos.ts";

let h: Harness;
let counter = 0;
before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

/** A clone whose origin is `url`. Nothing here contacts a host: the URL is only read. */
async function repoAt(url: string | undefined) {
    const fixture = makeRepo(h.sb, `forge${++counter}`);
    if (url === undefined) git(fixture.dir, "remote", "remove", "origin");
    else git(fixture.dir, "remote", "set-url", "origin", url);
    return resolveRepo(fixture.name);
}

// ---- the remote ---------------------------------------------------------------------------------------------------

test("a remote URL gives its host and its whole path, with any number of groups, in every form git accepts", () => {
    for (const [url, host, path] of [
        ["https://gitlab.com/acme/orders-api.git", "gitlab.com", "acme/orders-api"],
        ["https://gitlab.example.com/acme/orders-api", "gitlab.example.com", "acme/orders-api"],
        ["https://oauth2:secret@gitlab.example.com/acme/orders-api.git", "gitlab.example.com", "acme/orders-api"],
        [
            "git@gitlab.example.com:platform/payments/orders-api.git",
            "gitlab.example.com",
            "platform/payments/orders-api",
        ],
        [
            "ssh://git@gitlab.example.com:2222/platform/payments/orders-api.git",
            "gitlab.example.com",
            "platform/payments/orders-api",
        ],
        ["ssh://git@altssh.gitlab.com:443/acme/orders-api.git", "altssh.gitlab.com", "acme/orders-api"],
        ["https://gitlab.example.com/a/b/c/d/e/orders-api/", "gitlab.example.com", "a/b/c/d/e/orders-api"],
        ["git://gitlab.example.com/acme/orders-api.git", "gitlab.example.com", "acme/orders-api"],
    ] as const) {
        assert.deepEqual(parseRemotePath(url), { host, path }, url);
    }
});

test("a remote with no host, no group, a part that could be an option or a step up, or too many groups gives nothing", () => {
    const tooDeep = `https://gitlab.example.com/${Array.from({ length: 21 }, (_, i) => `g${i}`).join("/")}`;
    for (const bad of [
        undefined,
        "",
        "/srv/git/orders-api.git",
        "../orders-api",
        "file:///srv/orders-api.git",
        "orders-api",
        "https://gitlab.example.com/orders-api.git",
        "https://gitlab.example.com/acme/../orders-api.git",
        "https://gitlab.example.com/acme/-evil",
        "https://gitlab.example.com/acme/.hidden",
        "https://gitlab.example.com/acme/a b",
        tooDeep,
    ])
        assert.equal(parseRemotePath(bad), undefined, String(bad));
});

// ---- the decision ---------------------------------------------------------------------------------------------------

test("github.com in every form is GitHub, and so is the configured clone host", async () => {
    const settings = settingsFrom({ cloneHost: "gh-work" });
    for (const url of [
        "git@github.com:acme/orders-api.git",
        "https://github.com/acme/orders-api.git",
        "ssh://git@ssh.github.com:443/acme/orders-api.git",
        "git@github.com-work:acme/orders-api.git",
        "git@gh-work:acme/orders-api.git",
        "git@GitHub.com:acme/orders-api.git",
    ])
        assert.deepEqual(await forgeOf(await repoAt(url), settings), { forge: "github" }, url);
});

test("gitlab.com and its alternate ssh host are GitLab on gitlab.com, with the project's whole path", async () => {
    const settings = settingsFrom({});
    assert.deepEqual(await forgeOf(await repoAt("git@gitlab.com:acme/orders-api.git"), settings), {
        forge: "gitlab",
        host: "gitlab.com",
        path: "acme/orders-api",
    });
    assert.deepEqual(
        await forgeOf(await repoAt("ssh://git@altssh.gitlab.com:443/acme/team/orders-api.git"), settings),
        {
            forge: "gitlab",
            host: "gitlab.com",
            path: "acme/team/orders-api",
        },
    );
    assert.deepEqual(await forgeOf(await repoAt("https://GitLab.com/acme/orders-api"), settings), {
        forge: "gitlab",
        host: "gitlab.com",
        path: "acme/orders-api",
    });
});

test("a self-hosted GitLab is the forge git.forges says, compared without regard to case", async () => {
    const settings = settingsFrom({ forges: { "GitLab.Example.com": "gitlab" } });
    assert.deepEqual(await forgeOf(await repoAt("git@gitlab.example.com:platform/payments/orders-api.git"), settings), {
        forge: "gitlab",
        host: "gitlab.example.com",
        path: "platform/payments/orders-api",
    });
    assert.deepEqual(await forgeOf(await repoAt("https://gitlab.example.com/acme/orders-api.git"), settings), {
        forge: "gitlab",
        host: "gitlab.example.com",
        path: "acme/orders-api",
    });
});

test("a host set to github is GitHub: that is how a GitHub Enterprise Server host stops being refused", async () => {
    const settings = settingsFrom({ forges: { "ghe.example.com": "github" } });
    assert.deepEqual(await forgeOf(await repoAt("git@ghe.example.com:acme/orders-api.git"), settings), {
        forge: "github",
    });
});

test("an origin that names no host stays on GitHub, as it always did: gh reads the repository's own remotes", async () => {
    const settings = settingsFrom({});
    assert.deepEqual(await forgeOf(await repoAt("/srv/git/orders-api.git"), settings), { forge: "github" });
    assert.deepEqual(await forgeOf(await repoAt(undefined), settings), { forge: "github" });
});

test("any other host is refused in one line that names the host and the setting that fixes it", async () => {
    const repo = await repoAt("git@git.example.com:acme/orders-api.git");
    await assert.rejects(
        forgeOf(repo, settingsFrom({})),
        (error: Error) =>
            error instanceof UnknownForgeHost &&
            error.message ===
                `origin of ${repo.name} is on git.example.com, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": { "git.example.com": "gitlab" } }, or, when it is an ssh alias for a real host, "git": { "forges": { "git.example.com": { "forge": "github", "host": "github.com" } } }`,
    );
    assert.equal(await gitlabHome(repo, settingsFrom({})), undefined, "and gitlabHome says no, as it is not GitLab");
    assert.deepEqual(await gitlabHome(repo, settingsFrom({ forges: { "git.example.com": "gitlab" } })), {
        forge: "gitlab",
        host: "git.example.com",
        path: "acme/orders-api",
    });
});

test("a repository that jig-core refuses is refused, not taken for one that is not on GitLab", async () => {
    const repo = await repoAt("git@gitlab.com:acme/orders-api.git");
    h.jig.refuseGit("the repository's config would run a command");
    await assert.rejects(gitlabHome(repo, settingsFrom({})), /would run a command/);
});

// ---- the setting --------------------------------------------------------------------------------------------------

test("git.forges is optional, and absent from the settings when nothing is configured", () => {
    assert.deepEqual(validateGitSection({}), []);
    assert.equal("forges" in settingsFrom({}), false);
    assert.equal("forges" in settingsFrom({ forges: {} }), false);
    assert.deepEqual(settingsFrom({ forges: { "GitLab.Example.com": "gitlab", "ghe.example.com": "github" } }).forges, {
        "gitlab.example.com": "gitlab",
        "ghe.example.com": "github",
    });
});

test("git.forges must map host names to github or gitlab", () => {
    const message =
        'git.forges must map host names to "github" or "gitlab", such as { "gitlab.example.com": "gitlab" }, ' +
        'or to { "forge": ..., "host": ... } when the host is an ssh alias for a real one, such as ' +
        '{ "github.com-work": { "forge": "github", "host": "github.com" } }';
    for (const bad of [
        "gitlab.example.com",
        ["gitlab.example.com"],
        { "gitlab.example.com": "bitbucket" },
        { "gitlab.example.com": true },
        { "gitlab.example.com": { forge: "bitbucket" } },
        { "gitlab.example.com": { host: "gitlab.example.com" } },
        { "gitlab.example.com": { forge: "gitlab", host: "https://gitlab.example.com" } },
        { "gitlab.example.com": { forge: "gitlab", host: "gitlab.example.com:8443" } },
        { "gitlab.example.com": { forge: "gitlab", host: "-x" } },
        { "gitlab.example.com": { forge: "gitlab", host: 7 } },
        { "gitlab.example.com": { forge: "gitlab", token: "x" } },
        { "gitlab.example.com:8443": "gitlab" },
        { "-gitlab.example.com": "gitlab" },
        { "": "gitlab" },
    ])
        assert.deepEqual(validateGitSection({ forges: bad }), [message], JSON.stringify(bad));
    assert.deepEqual(validateGitSection({ forges: { "gitlab.example.com": "gitlab" } }), []);
    assert.deepEqual(
        validateGitSection({
            forges: {
                "github.com-work": { forge: "github", host: "github.com" },
                "gl-work": { forge: "gitlab" },
                "ghe-alias": "github",
            },
        }),
        [],
    );
    assert.equal(
        "forges" in settingsFrom({ forges: "gitlab.example.com" }),
        false,
        "an invalid section gives the defaults",
    );
});

test("an entry may be an object with the real host; the host names are kept in lower case, and the string form is unchanged", () => {
    const forges = settingsFrom({
        forges: {
            "GH-Work": { forge: "github", host: "GitHub.com" },
            "gl-work": { forge: "gitlab" },
            "ghe.example.com": "github",
        },
    }).forges;
    assert.deepEqual(forges, {
        "gh-work": { forge: "github", host: "github.com" },
        "gl-work": { forge: "gitlab" },
        "ghe.example.com": "github",
    });
});

// ---- an ssh alias for a real host ---------------------------------------------------------------------------------

test("an alias mapped to a real host is the forge it says, and gh and glab are told the real host", async () => {
    const settings = settingsFrom({
        forges: {
            "gh-work": { forge: "github", host: "github.com" },
            "ghe-alias": { forge: "github", host: "ghe.example.com" },
            "gl-work": { forge: "gitlab", host: "gitlab.example.com" },
            "gl-same": { forge: "gitlab" },
        },
    });
    assert.deepEqual(await forgeOf(await repoAt("git@gh-work:acme/orders-api.git"), settings), {
        forge: "github",
        host: "github.com",
    });
    assert.deepEqual(await forgeOf(await repoAt("git@ghe-alias:acme/orders-api.git"), settings), {
        forge: "github",
        host: "ghe.example.com",
    });
    assert.deepEqual(await forgeOf(await repoAt("git@gl-work:platform/payments/orders-api.git"), settings), {
        forge: "gitlab",
        host: "gitlab.example.com",
        path: "platform/payments/orders-api",
    });
    assert.deepEqual(await forgeOf(await repoAt("git@gl-same:acme/orders-api.git"), settings), {
        forge: "gitlab",
        host: "gl-same",
        path: "acme/orders-api",
    });
});

test("an alias that git.forges does not map is refused in one line that shows the object form", async () => {
    const repo = await repoAt("git@gh-work:acme/orders-api.git");
    const message =
        "origin of " +
        repo.name +
        ' is on gh-work, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": { "gh-work": "gitlab" } }, ' +
        'or, when it is an ssh alias for a real host, "git": { "forges": { "gh-work": { "forge": "github", "host": "github.com" } } }';
    await assert.rejects(forgeOf(repo, settingsFrom({})), { message });
    assert.equal(message.includes("\n"), false, "one line");
});

/** A clone on feature/one whose origin is an ssh alias; nothing contacts it, the URL is only read. */
function aliasRepo(alias: string, owner = "acme") {
    const r = makeRepo(h.sb, `alias${++counter}`);
    git(r.dir, "remote", "set-url", "origin", `git@${alias}:${owner}/${r.name}.git`);
    git(r.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    return r;
}

const prView = {
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
    statusCheckRollup: [],
    url: "https://github.com/acme/svc/pull/42",
    body: "What changed.",
    labels: [],
    reviewRequests: [],
    autoMergeRequest: null,
};

test("an alias mapped to github.com works for pr view and for release reads, with the alias nowhere in a gh command", async () => {
    h.jig.setSection("git", { forges: { "gh-work": { forge: "github", host: "github.com" } } });
    const r = aliasRepo("gh-work");
    h.gh.on("pr view", { json: prView });
    assert.match(ok(await h.call("pr", { action: "view", repo: r.name, number: 42 })), /^PR #42 /);
    h.gh.on("release list", { json: [] });
    assert.match(
        ok(await h.call("release", { action: "releases", repo: r.name })),
        new RegExp(`No releases in ${r.name}`),
    );
    h.gh.on("release view", {
        json: {
            name: "v1",
            tagName: "v1",
            isDraft: false,
            isPrerelease: false,
            publishedAt: "2026-10-20T10:00:00Z",
            url: "https://github.com/acme/svc/releases/tag/v1",
            targetCommitish: "main",
            body: "",
            assets: [],
        },
    });
    assert.match(ok(await h.call("release", { action: "releases", repo: r.name, tag: "v1" })), /^Release v1, /);
    const calls = h.gh.calls();
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.equal(call.args[call.args.indexOf("-R") + 1], `acme/${r.name}`, call.args.join(" "));
        assert.equal(
            call.args.some((word) => word.includes("gh-work")),
            false,
            "the alias is for git alone",
        );
        assert.equal(call.host, undefined, "github.com is gh's own default");
    }
});

test("an alias that is not mapped runs nothing, for pr and for release", async () => {
    const r = aliasRepo("gh-work");
    h.gh.on("pr", { json: [] });
    const refusals = [
        await h.call("pr", { action: "view", repo: r.name, number: 42 }),
        await h.call("release", { action: "releases", repo: r.name }),
    ];
    for (const result of refusals) {
        assert.match(result.error?.message ?? "", /is on gh-work, which jig-git does not know as GitHub or GitLab/);
        assert.match(result.error?.message ?? "", /"gh-work": \{ "forge": "github", "host": "github\.com" \}/);
    }
    assert.equal(h.gh.calls().length, 0);
});

test("an alias for a GitHub Enterprise Server host names the real host to gh, and gh api is told it too", async () => {
    h.jig.setSection("git", { forges: { "ghe-alias": { forge: "github", host: "ghe.example.com" } } });
    const r = aliasRepo("ghe-alias");
    h.gh.on("pr view", { json: prView });
    ok(await h.call("pr", { action: "view", repo: r.name, number: 42 }));
    const view = h.gh.callsOf("pr view")[0];
    assert.equal(view?.args[view.args.indexOf("-R") + 1], `ghe.example.com/acme/${r.name}`);
    h.gh.on("api", {
        json: {
            data: {
                repository: {
                    pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } },
                },
            },
        },
    });
    await h.call("pr", { action: "comments", repo: r.name, number: 42 });
    const api = h.gh.callsOf("api")[0];
    assert.equal(api?.host, "ghe.example.com", "gh api graphql is told the real host");
});

test("an alias for a self-hosted GitLab is asked for on the real host", async () => {
    h.jig.setSection("git", { forges: { "gl-work": { forge: "gitlab", host: "gitlab.example.com" } } });
    const r = aliasRepo("gl-work", "platform/payments");
    const base = `projects/${encodeURIComponent(`platform/payments/${r.name}`)}`;
    h.glab.on("api", { json: mr({}, `platform/payments/${r.name}`) }, [`=${base}/merge_requests/42`]);
    h.glab.on("api", { json: [] }, [`${base}/pipelines/301/jobs`]);
    assert.match(ok(await h.call("pr", { action: "view", repo: r.name, number: 42 })), /^MR !42 /);
    assert.deepEqual(h.glab.calls()[0]?.args.slice(0, 3), ["api", "--hostname", "gitlab.example.com"]);
    assert.equal(h.gh.calls().length, 0);
});

test("a host set to github as a word is a GitHub Enterprise Server host, and gh is told it by name", async () => {
    h.jig.setSection("git", { forges: { "ghe.example.com": "github" } });
    const r = aliasRepo("ghe.example.com");
    h.gh.on("pr view", { json: prView });
    ok(await h.call("pr", { action: "view", repo: r.name, number: 42 }));
    const view = h.gh.callsOf("pr view")[0];
    assert.equal(view?.args[view.args.indexOf("-R") + 1], `ghe.example.com/acme/${r.name}`);
});

// ---- the tools follow the repository ------------------------------------------------------------------------------

/** A clone on feature/one with a commit, whose origin is `git@<host>:<owner>/<name>.git`. */
function featureRepo(owner: string, host: "github.com" | "gitlab.com" | "gitlab.example.com") {
    const r = makeRepo(h.sb, `route${++counter}`, owner, host);
    git(r.dir, "switch", "-q", "-c", "feature/one", "--no-track", "origin/main");
    commitFile(r.dir, "x.ts", "x\n", "Add x");
    return r;
}

const GITHUB_PR = {
    number: 42,
    title: "Add the thing",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/one",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [],
    url: "https://github.com/acme/svc/pull/42",
    body: "",
};

test("a GitHub repository goes through gh, a GitLab one through glab, and neither starts the other's program", async () => {
    const hub = featureRepo("acme", "github.com");
    h.gh.on("pr view", { json: GITHUB_PR });
    assert.match(ok(await h.call("pr", { action: "view", repo: hub.name, number: 42 })), /^PR #42 /);
    assert.equal(h.glab.calls().length, 0);
    const lab = featureRepo("acme", "gitlab.com");
    h.glab.on("api", { json: mr({}, `acme/${lab.name}`) }, [
        `=projects/${encodeURIComponent(`acme/${lab.name}`)}/merge_requests/42`,
    ]);
    h.glab.on("api", { json: [] }, ["pipelines"]);
    assert.match(ok(await h.call("pr", { action: "view", repo: lab.name, number: 42 })), /^MR !42 /);
    assert.equal(h.gh.callsOf("pr").length, 1, "gh was not asked again");
});

test("the model cannot choose the forge: no parameter names it, and a call cannot reach glab for a GitHub repository", async () => {
    const hub = featureRepo("acme", "github.com");
    h.gh.on("pr view", { json: GITHUB_PR });
    const tool = h.tools.get("pr")?.parameters as unknown as { properties: Record<string, unknown> };
    for (const name of ["forge", "host", "gitlab", "project", "provider"])
        assert.equal(name in tool.properties, false, name);
    const refused = await h.call("pr", { action: "view", repo: hub.name, number: 42, forge: "gitlab" });
    assert.match(refused.error?.message ?? "", /pr view does not use forge/);
    ok(await h.call("pr", { action: "view", repo: hub.name, number: 42 }));
    assert.equal(h.glab.calls().length, 0);
});

test("a self-hosted GitLab needs git.forges: without it the pr tool refuses the repository, and nothing is run", async () => {
    const r = featureRepo("acme", "gitlab.example.com");
    h.glab.on("api", { json: [] });
    h.gh.on("pr", { json: [] });
    for (const input of [
        { action: "view", number: 42 },
        { action: "list" },
        { action: "comments", number: 42 },
        { action: "create", title: "t", body: "b" },
        { action: "edit", number: 42, title: "t" },
        { action: "ready", number: 42 },
        { action: "comment", number: 42, body: "b" },
        { action: "review", number: 42, event: "comment", body: "b" },
        { action: "merge", number: 42, method: "merge" },
        { action: "watch", number: 42 },
    ]) {
        const result = await h.call("pr", { ...input, repo: r.name });
        assert.equal(
            result.error?.message,
            `origin of ${r.name} is on gitlab.example.com, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": { "gitlab.example.com": "gitlab" } }, or, when it is an ssh alias for a real host, "git": { "forges": { "gitlab.example.com": { "forge": "github", "host": "github.com" } } }`,
            input.action,
        );
    }
    assert.equal(h.glab.calls().length, 0);
    assert.equal(h.gh.calls().length, 0);
    h.jig.setSection("git", { forges: { "gitlab.example.com": "gitlab" } });
    h.glab.on("api", { json: mr({}, `acme/${r.name}`) }, [
        `=projects/${encodeURIComponent(`acme/${r.name}`)}/merge_requests/42`,
    ]);
    h.glab.on("api", { json: [] }, ["pipelines"]);
    assert.match(ok(await h.call("pr", { action: "view", repo: r.name, number: 42 })), /^MR !42 /);
});
