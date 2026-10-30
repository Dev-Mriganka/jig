import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { branchPattern, gitSettings, matchesAny, settingsFrom, validateGitSection } from "../src/config.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

test("an empty section is valid and gives the defaults", () => {
    assert.deepEqual(validateGitSection({}), []);
    assert.deepEqual(settingsFrom({}), {
        base: undefined,
        protected: undefined,
        commitMessage: undefined,
        branchName: undefined,
        prTitle: undefined,
        prTemplate: undefined,
        cloneHost: "github.com",
    });
    assert.deepEqual(settingsFrom(undefined), settingsFrom({}));
});

test("every documented field is accepted", () => {
    const section = {
        base: "develop",
        protected: ["main", "release/*"],
        commitMessage: "^[A-Z]+-\\d+ ",
        branchName: "^feature/",
        prTitle: "^[A-Z]+-\\d+: ",
        prTemplate: "docs/pr.md",
        cloneHost: "gh-work",
    };
    assert.deepEqual(validateGitSection(section), []);
    const settings = settingsFrom(section);
    assert.equal(settings.base, "develop");
    assert.deepEqual(settings.protected, ["main", "release/*"]);
    assert.equal(settings.cloneHost, "gh-work");
    assert.equal(settings.prTitle, "^[A-Z]+-\\d+: ");
});

test("a field nobody defined is an error that names it, at any depth", () => {
    assert.deepEqual(validateGitSection({ baze: "main" }), ["git.baze is not a known field"]);
    assert.deepEqual(validateGitSection("main"), ["git must be an object"]);
    assert.deepEqual(validateGitSection([]), ["git must be an object"]);
});

test("the CI settings moved to jig-ops, and the error says where they are now", () => {
    assert.deepEqual(validateGitSection({ watch: { auto: false } }), [
        "git.watch moved to ops.watch, which jig-ops reads",
    ]);
    assert.deepEqual(validateGitSection({ artifacts: [{ kind: "tag", tag: "x" }] }), [
        "git.artifacts moved to ops.artifacts, which jig-ops reads",
    ]);
    assert.deepEqual(settingsFrom({ watch: { auto: false } }), settingsFrom({}), "and then the defaults apply");
});

test("values of the wrong type or range are errors that name the key", () => {
    const errors = (section: unknown) => validateGitSection(section);
    assert.deepEqual(errors({ base: "bad branch" }), ["git.base must be a branch name"]);
    assert.deepEqual(errors({ base: 3 }), ["git.base must be a branch name"]);
    assert.deepEqual(errors({ protected: "main" }), [
        "git.protected must be a list of branch names, where * matches any characters",
    ]);
    assert.deepEqual(errors({ protected: ["ok", "has space"] }), [
        "git.protected must be a list of branch names, where * matches any characters",
    ]);
    assert.match(errors({ commitMessage: "(" })[0] ?? "", /^git\.commitMessage is not a valid regular expression: /);
    assert.match(errors({ branchName: "[" })[0] ?? "", /^git\.branchName is not a valid regular expression: /);
    assert.deepEqual(errors({ branchName: "" }), ["git.branchName must be a non-empty regular expression"]);
    assert.match(errors({ prTitle: "(" })[0] ?? "", /^git\.prTitle is not a valid regular expression: /);
    assert.deepEqual(errors({ prTitle: "" }), ["git.prTitle must be a non-empty regular expression"]);
    assert.deepEqual(errors({ prTitle: 7 }), ["git.prTitle must be a non-empty regular expression"]);
    assert.deepEqual(errors({ prTemplate: "" }), ["git.prTemplate must be the path of a Markdown file"]);
    assert.deepEqual(errors({ cloneHost: "a b" }), [
        "git.cloneHost must be a host name or an ssh alias such as github.com",
    ]);
    assert.deepEqual(errors({ cloneHost: "-oProxyCommand=x" }), [
        "git.cloneHost must be a host name or an ssh alias such as github.com",
    ]);
});

test("every error is reported, not only the first", () => {
    assert.equal(validateGitSection({ baze: 1, base: "x y", watch: { pollSeconds: 0 } }).length, 3);
});

test("an invalid section is never half used: the defaults apply", () => {
    assert.deepEqual(settingsFrom({ base: "develop", baze: "typo" }), settingsFrom({}));
});

test("branch patterns: * matches any characters, everything else is literal", () => {
    assert.equal(branchPattern("release/*").test("release/1.2"), true);
    assert.equal(branchPattern("release/*").test("release/2026/10"), true);
    assert.equal(branchPattern("release/*").test("xrelease/1"), false);
    assert.equal(branchPattern("main").test("main"), true);
    assert.equal(branchPattern("main").test("mainline"), false);
    assert.equal(branchPattern("v1.0").test("v1x0"), false, "the dot is a dot");
    assert.equal(matchesAny(["main", "hotfix/*"], "hotfix/urgent"), true);
    assert.equal(matchesAny([], "main"), false);
});

// ---- through jig-core ---------------------------------------------------------------------------------------------

let h: Harness;
before(() => {
    h = setupHarness();
});
beforeEach(() => h.reset());
after(() => h.cleanup());

test("the plugin registers its section with jig-core, with the same checks", () => {
    const validate = h.jig.sections.get("git");
    assert.ok(validate, "the git section is registered");
    assert.deepEqual(validate({ baze: 1 }), validateGitSection({ baze: 1 }));
});

test("settings are read from jig-core when a call needs them, and an invalid section gives the defaults", () => {
    h.jig.setSection("git", { base: "develop", cloneHost: "gh-work" });
    assert.equal(gitSettings().base, "develop");
    assert.equal(gitSettings().cloneHost, "gh-work");
    h.jig.setSection("git", { base: "develop", baze: 1 });
    assert.equal(gitSettings().base, undefined, "jig-core hands over nothing for an invalid section");
    h.jig.setSection("git", undefined);
    assert.deepEqual(gitSettings(), settingsFrom({}));
});
