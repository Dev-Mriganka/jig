// Which forge a repository is on: decided from the host of origin and from git.forges, never from a call. And the pieces that
// feed it: the remote's host and path, and the git.forges setting.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { settingsFrom, validateGitSection } from "../src/config.ts";
import { forgeOf, gitlabHome, UnknownForgeHost } from "../src/forge.ts";
import { parseRemotePath, resolveRepo } from "../src/repo.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { git, makeRepo } from "./support/repos.ts";

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
                `origin of ${repo.name} is on git.example.com, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": { "git.example.com": "gitlab" } }`,
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
        'git.forges must map host names to "github" or "gitlab", such as { "gitlab.example.com": "gitlab" }';
    for (const bad of [
        "gitlab.example.com",
        ["gitlab.example.com"],
        { "gitlab.example.com": "bitbucket" },
        { "gitlab.example.com": true },
        { "gitlab.example.com:8443": "gitlab" },
        { "-gitlab.example.com": "gitlab" },
        { "": "gitlab" },
    ])
        assert.deepEqual(validateGitSection({ forges: bad }), [message], JSON.stringify(bad));
    assert.deepEqual(validateGitSection({ forges: { "gitlab.example.com": "gitlab" } }), []);
    assert.equal(
        "forges" in settingsFrom({ forges: "gitlab.example.com" }),
        false,
        "an invalid section gives the defaults",
    );
});
