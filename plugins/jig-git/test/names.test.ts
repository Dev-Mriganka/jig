import assert from "node:assert/strict";
import { test } from "node:test";
import {
    checkBody,
    checkBranch,
    checkCommitMessage,
    checkLine,
    checkNumber,
    checkPath,
    checkPaths,
    checkRange,
    checkRemote,
    checkRev,
    checkTag,
    checkTitle,
    checkWords,
} from "../src/names.ts";

test("branch names: ordinary names pass; option-like, traversal and lock names fail", () => {
    assert.equal(checkBranch("feature/add-thing"), "feature/add-thing");
    assert.equal(checkBranch("release/1.2.0"), "release/1.2.0");
    for (const bad of [
        "-x",
        "--upload-pack=evil",
        "../x",
        "a//b",
        "a..b",
        "x.lock",
        ".hidden",
        "a/.b",
        "trailing/",
        "a b",
        "a@{1}",
        "",
        "a".repeat(201),
        "a~1",
        "a^b",
        "a:b",
        "a*",
    ]) {
        assert.throws(
            () => checkBranch(bad),
            /not a valid branch name|is required/,
            `expected ${JSON.stringify(bad)} to be refused`,
        );
    }
    assert.throws(() => checkBranch(undefined), /branch is required/);
    assert.throws(() => checkBranch("-x", "base"), /base "-x" is not a valid branch name/);
    assert.equal(checkTag("v1.2.3"), "v1.2.3");
    assert.throws(() => checkTag("-v1"), /tag "-v1" is not a valid branch name|not a valid/);
});

test("revisions and ranges: names git understands, never an option", () => {
    for (const ok of [
        "HEAD",
        "HEAD~2",
        "HEAD^",
        "origin/main",
        "abc1234",
        "v1.2.3",
        "@{upstream}",
        "main@{1}",
        "feature/x^{commit}",
    ])
        assert.equal(checkRev(ok), ok);
    for (const bad of ["-x", "--output=/tmp/x", "a b", "a..b", "a:b", "", "x".repeat(201), "a;b", "$(x)", "a\nb"])
        assert.throws(() => checkRev(bad), /is not a valid revision|is required/, JSON.stringify(bad));
    for (const ok of ["a..b", "a...b", "origin/main..HEAD", "HEAD~3", "..b", "a.."]) assert.equal(checkRange(ok), ok);
    for (const bad of ["a..b..c", "--output=x", "-x..y", "a b..c", "a....b", "", "x..;"])
        assert.throws(() => checkRange(bad), /is not a valid range|is required/, JSON.stringify(bad));
});

test("remotes are plain names", () => {
    assert.equal(checkRemote("origin"), "origin");
    assert.equal(checkRemote("my-fork.1"), "my-fork.1");
    for (const bad of ["-x", "a b", "", "a/b", "--upload-pack=x"])
        assert.throws(() => checkRemote(bad), /not a valid remote name/);
});

test("paths: plain repo-relative files only; no magic, traversal, absolute, or the whole repository", () => {
    assert.deepEqual(checkPaths(["./src/a.ts", "src//b.ts", "src/a.ts"]), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(
        checkPaths(["*.txt", "a b.ts"]),
        ["*.txt", "a b.ts"],
        "a star is a file name, because git is given literal pathspecs",
    );
    for (const bad of [
        [],
        ["."],
        ["./"],
        ["/etc/passwd"],
        [":(glob)*"],
        [":/x"],
        ["-rf"],
        ["../x"],
        ["a/../../x"],
        [".git/config"],
        [".git"],
        ["a\nb"],
        [""],
        "a.ts",
        undefined,
    ]) {
        assert.throws(() => checkPaths(bad), /paths/, `expected ${JSON.stringify(bad)} to be refused`);
    }
    assert.throws(() => checkPaths(Array.from({ length: 101 }, (_, i) => `f${i}`)), /at most 100/);
    assert.equal(checkPath("src/a.ts"), "src/a.ts");
    assert.throws(() => checkPath(undefined), /path is required/);
    assert.throws(() => checkPath("../x"), /path: "\.\.\/x" must stay inside the repository/);
});

test("commit messages are required and trimmed; there is no other rule here, git.commitMessage is the rule", () => {
    assert.equal(checkCommitMessage("  Fix the thing  \n\nBody.  "), "Fix the thing  \n\nBody.");
    assert.throws(() => checkCommitMessage("   "), /message is required/);
    assert.throws(() => checkCommitMessage("Fix\0x"), /NUL/);
    assert.throws(() => checkCommitMessage("x".repeat(10_001)), /too long/);
    assert.doesNotThrow(() => checkCommitMessage("Fix\n\nCo-Authored-By: Someone <x@example.invalid>"));
});

test("titles are one line; bodies are required", () => {
    assert.equal(checkTitle("  Add thing  "), "Add thing");
    assert.throws(() => checkTitle("Add\nthing"), /one line/);
    assert.throws(() => checkTitle(""), /title is required/);
    assert.throws(() => checkTitle("x".repeat(257)), /one line of at most 256/);
    assert.equal(checkBody("Why\n\nand how"), "Why\n\nand how");
    assert.throws(() => checkBody("  "), /body is required/);
    assert.throws(() => checkBody("a\0b"), /NUL/);
    assert.throws(() => checkBody("x", "notes") && checkBody(" ", "notes"), /notes is required/);
});

test("numbers are positive whole numbers", () => {
    assert.equal(checkNumber(42), 42);
    for (const bad of [0, -1, 1.5, "42", undefined, 1e10, NaN])
        assert.throws(() => checkNumber(bad), /number is required/);
    assert.throws(() => checkNumber(0, "run_id"), /run_id is required/);
});

test("one-line text and short lists of names", () => {
    assert.equal(checkLine("hp", "author"), "hp");
    for (const bad of ["", "a\nb", "x".repeat(301), "a\0b"]) assert.throws(() => checkLine(bad, "author"), /author/);
    assert.deepEqual(checkWords([" bug ", "p1"], "labels"), ["bug", "p1"]);
    for (const bad of [[], [""], ["a,b"], ["a\nb"], "bug", Array.from({ length: 31 }, () => "x")])
        assert.throws(() => checkWords(bad, "labels"), /labels/);
});
