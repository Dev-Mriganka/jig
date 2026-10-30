import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
    branchPattern,
    DEFAULT_WATCH,
    gitSettings,
    matchesAny,
    settingsFrom,
    validateGitSection,
} from "../src/config.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

test("an empty section is valid and gives the defaults", () => {
    assert.deepEqual(validateGitSection({}), []);
    assert.deepEqual(settingsFrom({}), {
        base: undefined,
        protected: undefined,
        commitMessage: undefined,
        branchName: undefined,
        prTemplate: undefined,
        cloneHost: "github.com",
        watch: DEFAULT_WATCH,
        artifacts: [],
    });
    assert.deepEqual(DEFAULT_WATCH, { auto: true, pollSeconds: 30, stallMinutes: 30, timeoutMinutes: 60 });
    assert.deepEqual(settingsFrom(undefined).watch, DEFAULT_WATCH);
});

test("every documented field is accepted", () => {
    const section = {
        base: "develop",
        protected: ["main", "release/*"],
        commitMessage: "^[A-Z]+-\\d+ ",
        branchName: "^feature/",
        prTemplate: "docs/pr.md",
        cloneHost: "gh-work",
        watch: { auto: false, pollSeconds: 45, stallMinutes: 10, timeoutMinutes: 20 },
        artifacts: [
            { kind: "image", check: "build-image", log: "pushed (\\S+)" },
            { kind: "image", comment: "image: (\\S+)", bot: "ci-bot" },
            { kind: "tag", tag: "^v\\d+" },
            { kind: "release", tag: "^v\\d+" },
        ],
    };
    assert.deepEqual(validateGitSection(section), []);
    const settings = settingsFrom(section);
    assert.equal(settings.base, "develop");
    assert.deepEqual(settings.protected, ["main", "release/*"]);
    assert.equal(settings.cloneHost, "gh-work");
    assert.deepEqual(settings.watch, { auto: false, pollSeconds: 45, stallMinutes: 10, timeoutMinutes: 20 });
    assert.equal(settings.artifacts.length, 4);
});

test("watch fields that are left out keep their defaults", () => {
    assert.deepEqual(settingsFrom({ watch: { pollSeconds: 60 } }).watch, {
        auto: true,
        pollSeconds: 60,
        stallMinutes: 30,
        timeoutMinutes: 60,
    });
});

test("a field nobody defined is an error that names it, at any depth", () => {
    assert.deepEqual(validateGitSection({ baze: "main" }), ["git.baze is not a known field"]);
    assert.deepEqual(validateGitSection({ watch: { pollSecs: 30 } }), ["git.watch.pollSecs is not a known field"]);
    assert.deepEqual(validateGitSection({ artifacts: [{ kind: "tag", tag: "x", chek: "y" }] }), [
        "git.artifacts[0].chek is not a known field",
    ]);
    assert.deepEqual(validateGitSection("main"), ["git must be an object"]);
    assert.deepEqual(validateGitSection([]), ["git must be an object"]);
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
    assert.deepEqual(errors({ prTemplate: "" }), ["git.prTemplate must be the path of a Markdown file"]);
    assert.deepEqual(errors({ cloneHost: "a b" }), [
        "git.cloneHost must be a host name or an ssh alias such as github.com",
    ]);
    assert.deepEqual(errors({ cloneHost: "-oProxyCommand=x" }), [
        "git.cloneHost must be a host name or an ssh alias such as github.com",
    ]);
    assert.deepEqual(errors({ watch: "yes" }), ["git.watch must be an object"]);
    assert.deepEqual(errors({ watch: { auto: "yes" } }), ["git.watch.auto must be true or false"]);
    assert.deepEqual(errors({ watch: { pollSeconds: 1 } }), ["git.watch.pollSeconds must be a number from 5 to 3600"]);
    assert.deepEqual(errors({ watch: { stallMinutes: 0 } }), [
        "git.watch.stallMinutes must be a number from 1 to 1440",
    ]);
    assert.deepEqual(errors({ watch: { timeoutMinutes: "60" } }), [
        "git.watch.timeoutMinutes must be a number from 1 to 1440",
    ]);
    assert.deepEqual(errors({ artifacts: {} }), ["git.artifacts must be a list of rules"]);
});

test("every error is reported, not only the first", () => {
    assert.equal(validateGitSection({ baze: 1, base: "x y", watch: { pollSeconds: 0 } }).length, 3);
});

test("an artifact rule has exactly one place to look, and the parts that go together", () => {
    const rule = (value: unknown) => validateGitSection({ artifacts: [value] });
    assert.deepEqual(rule({ kind: "image" }), [
        "git.artifacts[0] needs exactly one of check, comment and tag (found none)",
    ]);
    assert.deepEqual(rule({ kind: "image", check: "a", tag: "b" }), [
        "git.artifacts[0] needs exactly one of check, comment and tag (found check, tag)",
        "git.artifacts[0].tag names tags or releases, so kind must be tag or release",
    ]);
    assert.deepEqual(rule({ kind: "volume", check: "a" }), [
        "git.artifacts[0].kind must be one of image, tag, release",
    ]);
    assert.deepEqual(rule({ kind: "image", comment: "x", log: "y" }), [
        "git.artifacts[0].log needs check: it is read from that job's log",
    ]);
    assert.deepEqual(rule({ kind: "image", check: "a", bot: "ci" }), [
        "git.artifacts[0].bot needs comment: it limits whose comments are read",
    ]);
    assert.deepEqual(rule({ kind: "image", check: "" }), ["git.artifacts[0].check must be a job name"]);
    assert.match(
        rule({ kind: "image", check: "a", log: "(" })[0] ?? "",
        /^git\.artifacts\[0\]\.log is not a valid regular expression/,
    );
    assert.match(
        rule({ kind: "tag", tag: "(" })[0] ?? "",
        /^git\.artifacts\[0\]\.tag is not a valid regular expression/,
    );
    assert.deepEqual(rule("check"), ["git.artifacts[0] must be an object"]);
});

test("an invalid section is never half used: the defaults apply", () => {
    assert.deepEqual(settingsFrom({ base: "develop", baze: "typo" }), settingsFrom({}));
    assert.equal(settingsFrom({ watch: { auto: "no" } }).watch.auto, true);
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
    h.jig.setSection("git", { base: "develop", watch: { pollSeconds: 10 } });
    assert.equal(gitSettings().base, "develop");
    assert.equal(gitSettings().watch.pollSeconds, 10);
    h.jig.setSection("git", { base: "develop", baze: 1 });
    assert.equal(gitSettings().base, undefined, "jig-core hands over nothing for an invalid section");
    h.jig.setSection("git", undefined);
    assert.deepEqual(gitSettings().watch, DEFAULT_WATCH);
});
