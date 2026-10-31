// jig-git against real GitHub, read only. A small public repository is cloned with git over https (the plugin's own `clone` goes
// over ssh and needs a key GitHub knows, which a test run does not have), then the plugin fetches it and reads it, and `gh` with
// the run's token reads pull requests and releases of public repositories. Nothing is pushed, created, commented or merged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { describeIt } from "../../../../test/support/it.ts";
import { ok, setupHarness } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";
import { git, setEnv } from "../support/repos.ts";

/** A repository of a few files, with two tags and two releases, small enough to clone in a moment. */
const SMALL = "actions/hello-world-docker-action";
/** A well-known repository with thousands of pull requests and releases; only read through `gh`. */
const BIG = "cli/cli";

describeIt(
    "jig-git against GitHub: git over https",
    {
        service: "github",
        variables: ["JIG_IT_GITHUB"],
        hint: "network access to github.com (set JIG_IT_GITHUB=1)",
    },
    () => {
        let h: Harness;
        const workspace = () => h.sb.workspace;

        before(() => {
            h = setupHarness(true);
            const ssh = execFileSync("ssh", ["-V"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
            console.log(`${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()}; ${ssh}`);
            git(workspace(), "clone", "--quiet", `https://github.com/${SMALL}.git`, "small");
        });

        after(() => h?.cleanup());

        test("fetch brings the branches and tags of the real remote, and says what it did", async () => {
            const result = await h.call("git", { action: "fetch", repo: "small" });
            ok(result);
            assert.deepEqual(result.cls, { action: "fetch", environment: "local", effect: "read" });
        });

        test("log, branches and status read the real history", async () => {
            const log = ok(await h.call("git", { action: "log", repo: "small", n: 3 }));
            const lines = log.split("\n").filter(Boolean);
            assert.ok(lines.length >= 3, log);
            assert.match(lines.at(-1) ?? "", /^[0-9a-f]{7,} /);
            const branches = ok(await h.call("git", { action: "branches", repo: "small", remotes: true }));
            assert.match(branches, /origin\/main/);
            const status = ok(await h.call("git", { action: "status", repo: "small" }));
            assert.match(status, /main/);
        });

        test("release tags reads the tags that came with the clone, newest first", async () => {
            const text = ok(await h.call("release", { action: "tags", repo: "small" }));
            assert.match(text, /^small: 2 tags, newest first\n/);
            assert.match(text, /\nv2 {2}[0-9a-f]{7} {2}\d{4}-\d{2}-\d{2}/);
            assert.match(text, /\nv1 {2}[0-9a-f]{7} {2}\d{4}-\d{2}-\d{2}/);
        });

        test("clone goes over ssh only: GitHub does not know a key a run does not have, and nothing is left behind", async () => {
            // Like a machine whose keys GitHub does not know: no agent, no default key, and the server's host key taken as new.
            const noKey = path.join(workspace(), "ssh-without-a-key");
            fs.writeFileSync(
                noKey,
                `#!/bin/sh\nexec ssh -F /dev/null -i /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(workspace(), "known_hosts")} "$@"\n`,
                { mode: 0o755 },
            );
            setEnv("GIT_SSH", noKey);
            setEnv("SSH_AUTH_SOCK", "");
            const result = await h.call("git", { action: "clone", repo: SMALL, dir: "cloned" });
            assert.match(
                result.error?.message ?? "",
                /SSH authentication to github\.com failed|SSH does not know the host key of github\.com/,
            );
            assert.equal(fs.existsSync(path.join(workspace(), "cloned")), false);
            assert.deepEqual(
                fs.readdirSync(workspace()).filter((name) => name.startsWith(".jig-clone-")),
                [],
                "the half-made clone was removed",
            );
        });

        test("a repository that is not on github.com cannot be cloned, and the tool never reaches another host", async () => {
            const result = await h.call("git", { action: "clone", repo: "https://example.com/acme/svc", dir: "other" });
            assert.match(result.error?.message ?? "", /only github\.com repositories can be cloned/);
        });
    },
);

describeIt(
    "jig-git against GitHub: pull requests and releases through gh",
    {
        service: "github-gh",
        variables: ["JIG_IT_GITHUB"],
        hint: "network access to github.com and a signed-in gh (set JIG_IT_GITHUB=1 and GH_TOKEN)",
    },
    () => {
        let h: Harness;
        const workspace = () => h.sb.workspace;

        /** A repository with nothing in it but an origin: `pr` and `release` read GitHub for the repository origin names. */
        const withOrigin = (name: string, slug: string): void => {
            const folder = path.join(workspace(), name);
            fs.mkdirSync(folder);
            git(folder, "init", "--quiet");
            git(folder, "remote", "add", "origin", `https://github.com/${slug}.git`);
        };

        before(() => {
            h = setupHarness(true);
            withOrigin("big", BIG);
            withOrigin("small-remote", SMALL);
            console.log(execFileSync("gh", ["--version"], { encoding: "utf8" }).split("\n")[0]);
        });

        after(() => h?.cleanup());

        test("pr list reads merged pull requests of a well-known repository", async () => {
            const result = await h.call("pr", { action: "list", repo: "big", state: "merged", limit: 3 });
            const text = ok(result);
            assert.deepEqual(result.cls, { action: "list", environment: "external", effect: "read" });
            const rows = text.split("\n").filter((line) => /^#\d+ /.test(line));
            assert.equal(rows.length, 3, text);
        });

        test("pr view reads one pull request in full: its state, branches, checks and body", async () => {
            const text = ok(await h.call("pr", { action: "view", repo: "big", number: 1 }));
            assert.match(text, /^PR #1 interactive pr list \[merged\] by @\S+ in /);
            assert.match(text, /https:\/\/github\.com\/cli\/cli\/pull\/1/);
        });

        test("pr comments reads the conversation of a pull request through GraphQL, with thread ids", async () => {
            const text = ok(await h.call("pr", { action: "comments", repo: "big", number: 1 }));
            assert.match(text, /^pull request 1: \d+ items?/);
        });

        test("pr view of a pull request that does not exist is one line naming the call", async () => {
            const result = await h.call("pr", { action: "view", repo: "big", number: 99999999 });
            assert.match(result.error?.message ?? "", /^gh pr view failed: .*(Could not resolve|not found|404)/i);
        });

        test("release releases lists the releases of a repository, and shows one in full", async () => {
            const list = ok(await h.call("release", { action: "releases", repo: "small-remote" }));
            assert.match(list, /^small-remote: 2 releases\n/);
            assert.match(list, /\nv2 {2}\d{4}-\d{2}-\d{2}/);
            const one = ok(await h.call("release", { action: "releases", repo: "small-remote", tag: "v1" }));
            assert.match(one, /v1/);
            const many = ok(await h.call("release", { action: "releases", repo: "big", n: 3 }));
            assert.match(many, /^big: 3 releases\n/);
            assert.match(many, /\nv2\.\d+\.\d+ {2}\d{4}-\d{2}-\d{2}/);
        });

        test("every action here is a read, and no write was classified as one", async () => {
            for (const [name, action] of [
                ["pr", "list"],
                ["pr", "view"],
                ["pr", "comments"],
                ["release", "releases"],
                ["release", "tags"],
                ["git", "fetch"],
            ] as const) {
                const cls = h.jig.declared.get(name)?.classify({ action, repo: "big" });
                assert.equal(cls?.effect, "read", `${name} ${action}`);
            }
            for (const [name, action, extra] of [
                ["pr", "merge", { number: 1, method: "squash" }],
                ["pr", "comment", { number: 1, body: "x" }],
                ["release", "release_create", { tag: "v9" }],
            ] as const) {
                const cls = h.jig.declared.get(name)?.classify({ action, repo: "big", ...extra });
                assert.equal(cls?.effect, "write", `${name} ${action}`);
            }
        });
    },
);
