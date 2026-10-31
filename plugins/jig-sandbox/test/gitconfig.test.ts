// Reading a git configuration just enough to find the settings that run a program, and taking them out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fullName, isDangerous, newDangerous, parseGitConfig, removeEntries } from "../src/gitconfig.ts";

const names = (text: string): string[] => parseGitConfig(text).map(fullName);

describe("parsing", () => {
    test("sections, subsections and plain keys", () => {
        const text =
            '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@example.com:a/b.git\n[branch "main"]\n\tmerge = refs/heads/main\n';
        assert.deepEqual(names(text), ["core.repositoryformatversion", "remote.origin.url", "branch.main.merge"]);
    });

    test("names are lower case for the section and the key, and the subsection keeps its case", () => {
        assert.deepEqual(names('[Core]\n  SshCommand = x\n[Filter "LFS"]\n  Clean = y\n'), [
            "core.sshcommand",
            "filter.LFS.clean",
        ]);
    });

    test("the old [section.subsection] spelling", () => {
        assert.deepEqual(names("[filter.lfs]\n\tclean = x\n"), ["filter.lfs.clean"]);
    });

    test("comments, blank lines and quotes", () => {
        const text = '# a\n; b\n[core]\n\n\tpager = "less -R" # shown\n\teditor = vi ; again\n';
        const entries = parseGitConfig(text);
        assert.equal(entries[0]?.value, "less -R");
        assert.equal(entries[1]?.value, "vi");
    });

    test("a bare key is true, and a value can continue over lines", () => {
        const entries = parseGitConfig("[core]\n\tbare\n\tpager = a \\\n\t  b\n");
        assert.equal(entries[0]?.value, undefined);
        assert.equal(entries[1]?.value, "a b");
        assert.equal(entries[1]?.first, 2);
        assert.equal(entries[1]?.last, 3);
    });

    test("a setting written after its header on the same line", () => {
        const entries = parseGitConfig("[core] pager = evil\n");
        assert.equal(entries[0]?.onHeader, true);
        assert.equal(fullName(entries[0] as never), "core.pager");
    });

    test("lines that are not git configuration are skipped", () => {
        assert.deepEqual(names("garbage\n[core]\n???\n\tbare = false\n"), ["core.bare"]);
        assert.deepEqual(names("\tpager = x\n"), [], "a setting before any section belongs to none");
    });
});

describe("what is dangerous", () => {
    const dangerous = (text: string): boolean => parseGitConfig(text).some(isDangerous);

    test("settings that run a program or redirect a remote", () => {
        for (const text of [
            "[core]\n\tfsmonitor = /tmp/x\n",
            "[core]\n\tfsmonitor = true\n",
            "[core]\n\tpager = evil\n",
            "[core]\n\teditor = evil\n",
            "[core]\n\tsshCommand = evil\n",
            "[core]\n\thooksPath = /tmp/hooks\n",
            "[core]\n\taskpass = x\n",
            "[alias]\n\tst = !evil\n",
            '[filter "x"]\n\tclean = evil\n',
            '[filter "x"]\n\tsmudge = evil\n',
            '[diff "x"]\n\ttextconv = evil\n',
            "[credential]\n\thelper = !evil\n",
            '[credential "https://example.com"]\n\thelper = evil\n',
            "[include]\n\tpath = /tmp/more\n",
            '[includeIf "gitdir:/x"]\n\tpath = /tmp/more\n',
            "[gpg]\n\tprogram = evil\n",
            '[url "ssh://evil/"]\n\tinsteadOf = https://example.com/\n',
        ]) {
            assert.equal(dangerous(text), true, text);
        }
    });

    test("ordinary settings are not", () => {
        for (const text of [
            "[core]\n\tbare = false\n\tfilemode = true\n\tfsmonitor = false\n",
            '[remote "origin"]\n\turl = git@example.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
            '[branch "main"]\n\tremote = origin\n',
            "[user]\n\tname = Me\n\temail = me@example.com\n",
            "[alias]\n\tco = checkout\n",
            "[core]\n\tautocrlf = input\n",
        ]) {
            assert.equal(dangerous(text), false, text);
        }
    });
});

describe("what a command added", () => {
    const before = parseGitConfig('[core]\n\tpager = less\n[remote "origin"]\n\turl = a\n');

    test("a dangerous setting that was there before is left alone", () => {
        const after = parseGitConfig(
            '[core]\n\tpager = less\n[remote "origin"]\n\turl = a\n[branch "x"]\n\tremote = origin\n',
        );
        assert.deepEqual(newDangerous(before, after), []);
    });

    test("a new dangerous setting is found, and a changed value is new", () => {
        const after = parseGitConfig('[core]\n\tpager = evil\n\tfsmonitor = x\n[remote "origin"]\n\turl = a\n');
        assert.deepEqual(newDangerous(before, after).map(fullName), ["core.pager", "core.fsmonitor"]);
    });

    test("a second copy of a setting that was there once is new", () => {
        const after = parseGitConfig('[core]\n\tpager = less\n\tpager = less\n[remote "origin"]\n\turl = a\n');
        assert.equal(newDangerous(before, after).length, 1);
    });

    test("taking them out keeps everything else as written", () => {
        const text =
            '# mine\n[core]\n\tbare = false\n\tpager = evil\n\tfsmonitor = /x \\\n\t  y\n[alias]\n\tco = checkout\n\tx = !evil\n[remote "origin"]\n\turl = a\n';
        const after = parseGitConfig(text);
        const fresh = newDangerous([], after);
        assert.deepEqual(fresh.map(fullName), ["core.pager", "core.fsmonitor", "alias.x"]);
        assert.equal(
            removeEntries(text, fresh),
            '# mine\n[core]\n\tbare = false\n[alias]\n\tco = checkout\n[remote "origin"]\n\turl = a\n',
        );
    });

    test("a setting on its header line is taken out and the header stays", () => {
        const text = "[core] pager = evil\n\tbare = false\n";
        assert.equal(removeEntries(text, newDangerous([], parseGitConfig(text))), "[core]\n\tbare = false\n");
    });
});
