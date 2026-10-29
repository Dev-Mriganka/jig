// The guard that refuses a repository whose own configuration would make git run a command or redirect a remote.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { forgetCheckedConfigs, gitConfigRefusal, isDangerousKey, refusalFromList } from "../src/git-config-guard.ts";

/** Every dangerous key, as the configuration file spells it (section, optional subsection, variable) with a value. */
const DANGEROUS: Array<{ key: string; section: string; variable: string; subsection?: string; value: string }> = [
    { key: "core.sshcommand", section: "core", variable: "sshCommand", value: "evil" },
    { key: "core.fsmonitor", section: "core", variable: "fsmonitor", value: "evil-hook" },
    { key: "core.pager", section: "core", variable: "pager", value: "evil" },
    { key: "core.editor", section: "core", variable: "editor", value: "evil" },
    { key: "core.askpass", section: "core", variable: "askPass", value: "evil" },
    { key: "core.hookspath", section: "core", variable: "hooksPath", value: "/tmp/evil-hooks" },
    { key: "core.gitproxy", section: "core", variable: "gitProxy", value: "evil" },
    { key: "credential.helper", section: "credential", variable: "helper", value: "!evil" },
    { key: "credential.https://github.com.helper", section: "credential", subsection: "https://github.com", variable: "helper", value: "!evil" },
    { key: "filter.lfs.clean", section: "filter", subsection: "lfs", variable: "clean", value: "evil" },
    { key: "filter.lfs.smudge", section: "filter", subsection: "lfs", variable: "smudge", value: "evil" },
    { key: "filter.lfs.process", section: "filter", subsection: "lfs", variable: "process", value: "evil" },
    { key: "diff.pdf.textconv", section: "diff", subsection: "pdf", variable: "textconv", value: "evil" },
    { key: "diff.pdf.command", section: "diff", subsection: "pdf", variable: "command", value: "evil" },
    { key: "diff.external", section: "diff", variable: "external", value: "evil" },
    { key: "merge.ours.driver", section: "merge", subsection: "ours", variable: "driver", value: "evil" },
    { key: "url.https://evil.example/.insteadof", section: "url", subsection: "https://evil.example/", variable: "insteadOf", value: "https://github.com/" },
    { key: "url.https://evil.example/.pushinsteadof", section: "url", subsection: "https://evil.example/", variable: "pushInsteadOf", value: "https://github.com/" },
    { key: "protocol.ext.allow", section: "protocol", subsection: "ext", variable: "allow", value: "always" },
    { key: "protocol.allow", section: "protocol", variable: "allow", value: "always" },
    { key: "uploadpack.packobjectshook", section: "uploadpack", variable: "packObjectsHook", value: "evil" },
    { key: "gpg.program", section: "gpg", variable: "program", value: "evil" },
    { key: "gpg.ssh.program", section: "gpg", subsection: "ssh", variable: "program", value: "evil" },
    { key: "sequence.editor", section: "sequence", variable: "editor", value: "evil" },
    { key: "include.path", section: "include", variable: "path", value: "../elsewhere.cfg" },
    { key: "includeif.gitdir:/.path", section: "includeIf", subsection: "gitdir:/", variable: "path", value: "../elsewhere.cfg" },
];

const SAFE = ["remote.origin.url", "remote.origin.fetch", "branch.main.remote", "branch.main.merge", "user.name", "user.email", "core.bare", "core.autocrlf", "pull.rebase", "push.default", "alias.st", "core.filemode"];

describe("which keys are dangerous", () => {
    for (const entry of DANGEROUS) {
        test(`${entry.key} is`, () => {
            assert.equal(isDangerousKey(entry.key, entry.value), true);
        });
    }

    test("ordinary workspace keys are not", () => {
        for (const key of SAFE) assert.equal(isDangerousKey(key, "x"), false, key);
    });

    test("key case does not matter, as in git", () => {
        assert.equal(isDangerousKey("CORE.SSHCOMMAND", "x"), true);
        assert.equal(isDangerousKey("Url.X.InsteadOf", "x"), true);
        assert.equal(isDangerousKey("Credential.Helper", "x"), true);
    });

    test("core.fsmonitor is safe when false (any spelling), dangerous otherwise", () => {
        for (const value of ["false", "False", "no", "off", "0", "", undefined]) {
            // A bare key (no value) is true in git, so it is the one that is not safe.
            assert.equal(isDangerousKey("core.fsmonitor", value), value === undefined, String(value));
        }
        for (const value of ["true", "yes", "on", "1", "/path/to/hook"]) assert.equal(isDangerousKey("core.fsmonitor", value), true, value);
    });
});

describe("reading the listing of `git config --list --null --show-origin --show-scope`", () => {
    const entry = (scope: string, origin: string, key: string, value?: string) => `${scope}\0${origin}\0${key}${value === undefined ? "" : `\n${value}`}\0`;

    test("a dangerous local key is refused in one line that names the file and the key", () => {
        const listing = entry("global", "file:/home/u/.gitconfig", "user.name", "u") + entry("local", "file:.git/config", "core.sshCommand", "evil");
        const refusal = refusalFromList(listing, "/work/repo");
        assert.equal(refusal, "/work/repo/.git/config sets core.sshCommand, which would run with your credentials: remove it (git config --unset core.sshCommand) or ask the user");
        assert.equal(refusal?.split("\n").length, 1);
    });

    test("a per-worktree key is refused too", () => {
        assert.match(refusalFromList(entry("worktree", "file:.git/config.worktree", "core.hooksPath", "/x"), "/r") ?? "", /config\.worktree sets core\.hooksPath/);
    });

    test("keys from the global and system configuration and the command line are not the repository's", () => {
        const listing = entry("global", "file:/home/u/.gitconfig", "core.sshCommand", "my-ssh")
            + entry("system", "file:/etc/gitconfig", "credential.helper", "store")
            + entry("command", "command line:", "core.hooksPath", "/dev/null");
        assert.equal(refusalFromList(listing, "/r"), undefined);
    });

    test("a key with odd characters is quoted in the hint", () => {
        const refusal = refusalFromList(entry("local", "file:.git/config", "url.https://evil.example/.insteadOf", "x"), "/r") ?? "";
        assert.match(refusal, /git config --unset 'url\.https:\/\/evil\.example\/\.insteadOf'/);
    });

    test("a clean listing is fine", () => {
        assert.equal(refusalFromList(entry("local", "file:.git/config", "remote.origin.url", "git@example.com:x/y.git") + entry("local", "file:.git/config", "core.fsmonitor", "false"), "/r"), undefined);
        assert.equal(refusalFromList("", "/r"), undefined);
    });
});

describe("checking a repository on disk", () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env });
    let root: string;
    let counter = 0;
    before(() => { root = mkdtempSync(path.join(tmpdir(), "jig-guard-")); });
    after(() => rmSync(root, { recursive: true, force: true }));
    beforeEach(() => forgetCheckedConfigs());

    function repository(): string {
        const dir = path.join(root, `repo${counter++}`);
        mkdirSync(dir, { recursive: true });
        git(dir, "init", "-q", "-b", "main");
        return dir;
    }
    const list = (cwd: string) => git(cwd, "config", "--list", "--null", "--show-origin", "--show-scope");
    const plant = (repo: string, header: string, variable: string, value: string) => appendFileSync(path.join(repo, ".git", "config"), `${header}\n\t${variable} = ${value}\n`);

    test("a normal configuration passes", () => {
        const repo = repository();
        git(repo, "remote", "add", "origin", "git@example.com:team/project.git");
        git(repo, "config", "user.name", "x");
        git(repo, "config", "branch.main.remote", "origin");
        git(repo, "config", "core.fsmonitor", "false");
        git(repo, "config", "alias.st", "status");
        assert.equal(gitConfigRefusal(repo, list), undefined);
    });

    for (const entry of DANGEROUS) {
        test(`${entry.key} planted in .git/config is refused`, () => {
            const repo = repository();
            plant(repo, entry.subsection === undefined ? `[${entry.section}]` : `[${entry.section} "${entry.subsection}"]`, entry.variable, entry.value);
            const refusal = gitConfigRefusal(repo, list) ?? "";
            assert.ok(refusal.startsWith(`${path.join(repo, ".git", "config")} sets ${entry.key},`), refusal);
            assert.ok(refusal.endsWith(") or ask the user"), refusal);
        });
    }

    test("a subdirectory of the repository is the same repository", () => {
        const repo = repository();
        plant(repo, "[core]", "sshCommand", "evil");
        mkdirSync(path.join(repo, "sub", "deeper"), { recursive: true });
        assert.match(gitConfigRefusal(path.join(repo, "sub", "deeper"), list) ?? "", /core\.sshcommand/i);
    });

    test("a linked worktree shares the main repository's configuration", () => {
        const repo = repository();
        git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "--allow-empty", "-q", "-m", "first");
        const linked = path.join(root, `linked${counter++}`);
        git(repo, "worktree", "add", "-q", linked);
        plant(repo, "[core]", "sshCommand", "evil");
        assert.match(gitConfigRefusal(linked, list) ?? "", /core\.sshcommand/i);
    });

    test("outside any repository there is nothing to refuse", () => {
        const elsewhere = path.join(root, `plain${counter++}`);
        mkdirSync(elsewhere);
        assert.equal(gitConfigRefusal(elsewhere, () => { throw new Error("must not be asked"); }), undefined);
    });

    test("when the configuration cannot be listed, the real call fails for the same reason", () => {
        assert.equal(gitConfigRefusal(repository(), () => undefined), undefined);
    });

    test("the answer is remembered until the configuration changes", () => {
        const repo = repository();
        let asked = 0;
        const counted = (cwd: string) => { asked++; return list(cwd); };
        assert.equal(gitConfigRefusal(repo, counted), undefined);
        assert.equal(gitConfigRefusal(repo, counted), undefined);
        assert.equal(asked, 1, "the second call came from the cache");
        plant(repo, "[core]", "sshCommand", "evil");
        assert.match(gitConfigRefusal(repo, counted) ?? "", /sshcommand/i);
        assert.equal(asked, 2, "the change was noticed");
        writeFileSync(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n");
        assert.equal(gitConfigRefusal(repo, counted), undefined);
        assert.equal(asked, 3);
    });
});
