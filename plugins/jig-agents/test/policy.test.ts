// A role with configuration laid over it: what limits the child (writes, actions, ask) only narrows, and what only chooses what the
// child reads (skills, preload, context, thinking) is replaced. Configuration has no way to widen a file.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { settingsFrom, validateAgents } from "../src/config.ts";
import { effectiveRole, intersection, policyOf, union } from "../src/policy.ts";
import { parseRole } from "../src/roles.ts";
import type { Role } from "../src/roles.ts";

const role = (lines: string[] = [], name = "scout"): Role =>
    parseRole(
        `---\ndescription: d\ntools: read, git, jira, bash\nwrites: false\n${lines.join("\n")}\n---\nYou do the work.\n`,
        `/roles/${name}.md`,
        name,
    );

describe("actions: configuration narrows the file's, and cannot add to them", () => {
    test("a tool in both keeps the actions both list", () => {
        const e = effectiveRole(role(["actions: git status|log|diff|show"]), {
            actions: { git: ["log", "show", "push"] },
        });
        assert.deepEqual(e.actions, { git: ["log", "show"] });
        assert.equal(e.from.actions, "file and configuration");
    });

    test("an action only configuration lists is not added: push stays refused", () => {
        const e = effectiveRole(role(["actions: git status"]), { actions: { git: ["push"] } });
        assert.deepEqual(e.actions, { git: [] });
        assert.deepEqual(policyOf(e).actions, { git: [] });
    });

    test("a tool the file does not list is narrowed by configuration's list alone", () => {
        const e = effectiveRole(role(["actions: git status"]), { actions: { jira: ["get"] } });
        assert.deepEqual(e.actions, { git: ["status"], jira: ["get"] });
    });

    test("without configuration the file's actions stand, and with neither there are none", () => {
        assert.deepEqual(effectiveRole(role(["actions: git status|log"]), undefined).actions, {
            git: ["status", "log"],
        });
        assert.equal(effectiveRole(role(["actions: git status|log"]), undefined).from.actions, "file");
        const none = effectiveRole(role(), {});
        assert.deepEqual(none.actions, {});
        assert.equal(none.from.actions, "default");
    });

    test("the lists are copies: laying configuration over a role does not change the role", () => {
        const base = role(["actions: git status|log"]);
        effectiveRole(base, { actions: { git: ["log"] } });
        assert.deepEqual(base.actions, { git: ["status", "log"] });
    });
});

describe("ask: configuration adds to the file's", () => {
    test("both lists count, once each", () => {
        const e = effectiveRole(role(["ask: git push|merge"]), {
            ask: { git: ["push", "rebase"], jira: ["transition"] },
        });
        assert.deepEqual(e.ask, { git: ["push", "merge", "rebase"], jira: ["transition"] });
        assert.equal(e.from.ask, "file and configuration");
    });

    test("it is never fewer than the file's", () => {
        assert.deepEqual(effectiveRole(role(["ask: git push"]), { ask: { git: ["merge"] } }).ask.git, [
            "push",
            "merge",
        ]);
    });
});

describe("writes is the file's, whatever configuration says", () => {
    test("a role that does not write in its file does not write in the effective role or the policy", () => {
        const e = effectiveRole(role(), { actions: { git: ["status"] } });
        assert.equal(e.writes, false);
        assert.equal(policyOf(e).writes, false);
    });

    test("configuration has no writes field: the section refuses it and says where it belongs", () => {
        const errors = validateAgents({ roles: { scout: { writes: true } } });
        assert.equal(errors.length, 1);
        assert.match(errors[0] ?? "", /agents\.roles\.scout\.writes: whether a role writes is in its agent file/);
        // A section with the field is invalid as a whole, so the plugin reads no settings from it at all.
        assert.deepEqual(settingsFrom({ roles: { scout: { writes: true } } }).roles, {});
    });

    test("tools, description and prompt are the file's too", () => {
        for (const field of ["tools", "description", "prompt", "name"]) {
            const errors = validateAgents({ roles: { scout: { [field]: "x" } } });
            assert.match(errors[0] ?? "", new RegExp(`agents\\.roles\\.scout\\.${field}: .*(agent file|key)`), field);
        }
    });

    test("a writes: true role stays a writer, and the policy says so", () => {
        const writer = parseRole("---\ndescription: d\nwrites: true\n---\nbody\n", "/w.md", "writer");
        assert.equal(policyOf(effectiveRole(writer, { actions: { git: ["status"] } })).writes, true);
    });
});

describe("what the child reads: configuration replaces the file's value", () => {
    test("skills, preload, context and thinking", () => {
        const file = role(["skills: git, jira", "preload: git", "context: none", "thinking: low"]);
        const e = effectiveRole(file, { skills: ["jira"], preload: ["jira"], context: "project", thinking: "high" });
        assert.deepEqual([e.skills, e.preload, e.context, e.thinking], [["jira"], ["jira"], "project", "high"]);
        assert.deepEqual(Object.values(e.from).slice(2), [
            "configuration",
            "configuration",
            "configuration",
            "configuration",
        ]);
    });

    test("the file's values stand when configuration has none, and the defaults are the open ones", () => {
        const e = effectiveRole(role(["skills: none", "context: none", "thinking: low"]), {});
        assert.deepEqual([e.skills, e.preload, e.context, e.thinking], ["none", [], "none", "low"]);
        assert.deepEqual(
            [e.from.skills, e.from.preload, e.from.context, e.from.thinking],
            ["file", "default", "file", "file"],
        );
        const bare = effectiveRole(role(), undefined);
        assert.deepEqual(
            [bare.skills, bare.preload, bare.context, bare.thinking],
            [undefined, [], "project", undefined],
        );
    });

    test("configuration can say none where the file lists skills", () => {
        assert.equal(effectiveRole(role(["skills: git"]), { skills: "none" }).skills, "none");
    });
});

describe("the two ways of joining lists", () => {
    test("intersection keeps the first list's order and only what both have", () => {
        assert.deepEqual(intersection(["a", "b", "c"], ["c", "a", "z"]), ["a", "c"]);
        assert.deepEqual(intersection(["a"], []), []);
    });

    test("union keeps everything once", () => {
        assert.deepEqual(union(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
    });
});
