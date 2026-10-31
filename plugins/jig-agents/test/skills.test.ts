// Which skills a child sees: none, the ones listed, or by default those that follow the role's tools. A skill belongs to a plugin by the
// folder it is in, or by the tool its front matter says it extends.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    bodyOf,
    followsTools,
    frontMatterOf,
    listSkills,
    MAX_PRELOAD_BYTES,
    pluginOf,
    promptWith,
    readPreloads,
    resolveSkills,
    toolsNamedBy,
} from "../src/skills.ts";
import type { DeclaredTools, SkillInfo } from "../src/skills.ts";

let root: string;
beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "jig-agents-skills-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A skill file, with the extra front matter lines given. Returns its path. */
function skill(folder: string, name: string, extra: string[] = [], body = "How to do it.\n"): string {
    const dir = path.join(root, folder, name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    writeFileSync(
        file,
        `---\nname: ${name}\ndescription: About ${name}. Use it when asked.\n${extra.join("\n")}\n---\n${body}`,
    );
    return file;
}

const DECLARED: DeclaredTools = [
    { tool: "git", plugin: "jig-git" },
    { tool: "pr", plugin: "jig-git" },
    { tool: "logs", plugin: "jig-logs" },
    { tool: "jira", plugin: "jig-jira" },
    { tool: "subagent", plugin: "jig-agents" },
];
const info = (name: string, over: Partial<SkillInfo> = {}): SkillInfo => ({
    name,
    file: `/x/${name}/SKILL.md`,
    ...over,
});

describe("the front matter field", () => {
    test("metadata.jig-tool names the tools a skill extends, in the block form", () => {
        assert.deepEqual(toolsNamedBy("name: a\nmetadata:\n  jig-tool: jira"), ["jira"]);
        assert.deepEqual(toolsNamedBy("name: a\nmetadata:\n  author: me\n  jig-tool: jira, pr\n  version: 1"), [
            "jira",
            "pr",
        ]);
        assert.deepEqual(toolsNamedBy('metadata:\n    jig-tool: "jira"\n'), ["jira"]);
    });

    test("and in the one-line form", () => {
        assert.deepEqual(toolsNamedBy("metadata: { jig-tool: jira }"), ["jira"]);
        assert.deepEqual(toolsNamedBy("metadata: { author: me, jig-tool: 'jira, pr' }"), ["jira", "pr"]);
    });

    test("a field that is missing, empty, outside metadata or not a tool name names nothing", () => {
        assert.equal(toolsNamedBy("name: a\ndescription: d"), undefined);
        assert.equal(toolsNamedBy("metadata:\n  author: me"), undefined);
        assert.equal(toolsNamedBy("metadata:\n  jig-tool:"), undefined);
        assert.equal(toolsNamedBy("jig-tool: jira"), undefined, "a top-level key is not the field");
        assert.equal(toolsNamedBy("metadata:\n  jig-tool: not a tool"), undefined);
        assert.equal(toolsNamedBy("metadata:\n  jig-tool: -x"), undefined);
        assert.equal(toolsNamedBy("other:\n  jig-tool: jira"), undefined);
    });

    test("the front matter is cut the way Pi cuts it, and the body is what follows", () => {
        const text = "---\nname: a\ndescription: d\n---\n\n# Title\n\nBody.\n";
        assert.equal(frontMatterOf(text), "name: a\ndescription: d");
        assert.equal(bodyOf(text), "# Title\n\nBody.");
        assert.equal(frontMatterOf("no front matter"), undefined);
        assert.equal(bodyOf("no front matter\n"), "no front matter");
        assert.equal(frontMatterOf("\uFEFF---\nname: a\n---\nx"), "name: a");
        assert.equal(bodyOf("---\r\nname: a\r\n---\r\nbody\r\n"), "body");
    });

    test("Pi's own parser accepts a skill with the field, which is why it is the field", async () => {
        const file = skill("acme", "acme-jira", ["metadata:", "  jig-tool: jira"]);
        const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
        const loaded = loadSkillsFromDir({ dir: path.dirname(path.dirname(file)), source: "test" });
        assert.deepEqual(loaded.diagnostics, []);
        assert.deepEqual(
            loaded.skills.map((entry) => entry.name),
            ["acme-jira"],
        );
    });
});

describe("whose skill it is", () => {
    test("a skill in plugins/<plugin>/skills belongs to that plugin, and any other does not", () => {
        assert.equal(pluginOf("/pkg/plugins/jig-git/skills/git/SKILL.md"), "jig-git");
        assert.equal(pluginOf("C:\\pkg\\plugins\\jig-ops\\skills\\ci\\SKILL.md"), "jig-ops");
        assert.equal(pluginOf("/home/me/.pi/agent/skills/mine/SKILL.md"), undefined);
        assert.equal(pluginOf("/pkg/examples/jig-acme/skills/acme-jira/SKILL.md"), undefined);
        assert.equal(pluginOf("/pkg/plugins/jig-git/src/skills/x.md"), undefined);
    });

    test("a skill follows the tools of its plugin, or the tools its front matter names, which come first", () => {
        const gitSkill = info("git", { plugin: "jig-git" });
        assert.equal(followsTools(gitSkill, ["read", "git"], DECLARED), true);
        assert.equal(followsTools(gitSkill, ["read", "pr"], DECLARED), true, "any tool of the plugin");
        assert.equal(followsTools(gitSkill, ["read", "logs"], DECLARED), false);
        const company = info("acme-jira", { tools: ["jira"] });
        assert.equal(followsTools(company, ["read", "jira"], DECLARED), true);
        assert.equal(followsTools(company, ["read", "git"], DECLARED), false);
        const overridden = info("git", { plugin: "jig-git", tools: ["logs"] });
        assert.equal(followsTools(overridden, ["git"], DECLARED), false, "the front matter wins over the folder");
        assert.equal(followsTools(overridden, ["logs"], DECLARED), true);
    });

    test("a skill with no known owner is always seen: no plugin, no field, or a plugin that declared no tool", () => {
        assert.equal(followsTools(info("mine"), ["read"], DECLARED), true);
        assert.equal(followsTools(info("x", { plugin: "jig-memory" }), ["read"], DECLARED), true);
        assert.equal(followsTools(info("git", { plugin: "jig-git" }), ["read"], []), true, "jig-core could not say");
    });
});

describe("the skills a role sees", () => {
    const all = [
        info("git", { plugin: "jig-git" }),
        info("logs", { plugin: "jig-logs" }),
        info("jira", { plugin: "jig-jira" }),
        info("subagent", { plugin: "jig-agents" }),
        info("acme-jira", { tools: ["jira"] }),
        info("house-style"),
    ];
    const names = (resolved: { visible: SkillInfo[] }): string[] => resolved.visible.map((entry) => entry.name);

    test("by default they follow the tools: a scout with git and logs sees those two, the ownerless one, and no other", () => {
        const resolved = resolveSkills(undefined, ["read", "grep", "git", "logs", "bash"], all, DECLARED);
        assert.deepEqual(names(resolved), ["git", "logs", "house-style"]);
        assert.equal(resolved.basis, "those that follow the tools");
    });

    test("a company skill that names a tool is seen with it and only with it", () => {
        assert.deepEqual(names(resolveSkills(undefined, ["jira"], all, DECLARED)), [
            "jira",
            "acme-jira",
            "house-style",
        ]);
        assert.ok(!names(resolveSkills(undefined, ["git"], all, DECLARED)).includes("acme-jira"));
    });

    test("a role that has the subagent tool sees the subagent skill, and a child, which has not, does not", () => {
        assert.ok(names(resolveSkills(undefined, ["subagent"], all, DECLARED)).includes("subagent"));
        assert.ok(!names(resolveSkills(undefined, ["git", "logs"], all, DECLARED)).includes("subagent"));
    });

    test("a role with no tools list sees every skill", () => {
        const resolved = resolveSkills(undefined, undefined, all, DECLARED);
        assert.equal(resolved.visible.length, all.length);
        assert.equal(resolved.basis, "every skill (no tools list)");
    });

    test("none is none, whatever the tools are", () => {
        assert.deepEqual(resolveSkills("none", ["git"], all, DECLARED), { visible: [], basis: "none", missing: [] });
    });

    test("a list is exactly those skills, in the order given, tools or not; names the session lacks are reported", () => {
        const resolved = resolveSkills(["house-style", "logs", "ghost"], ["git"], all, DECLARED);
        assert.deepEqual(names(resolved), ["house-style", "logs"]);
        assert.deepEqual(resolved.missing, ["ghost"]);
        assert.equal(resolved.basis, "the ones listed");
    });
});

describe("listing the skills Pi found", () => {
    function piWith(commands: unknown[] | Error): ExtensionAPI {
        return {
            getCommands() {
                if (commands instanceof Error) throw commands;
                return commands;
            },
        } as unknown as ExtensionAPI;
    }

    test("takes the skill commands with the path Pi gives, the plugin from the folder and the tools from the front matter", () => {
        const company = skill("home", "acme-jira", ["metadata:", "  jig-tool: jira"]);
        const plain = skill("home", "house-style");
        const owned = skill("pkg/plugins/jig-git/skills", "git");
        const listed = listSkills(
            piWith([
                { name: "jig", source: "extension", sourceInfo: { path: "/x/index.ts" } },
                { name: "skill:acme-jira", source: "skill", sourceInfo: { path: company } },
                { name: "skill:house-style", source: "skill", sourceInfo: { path: plain } },
                { name: "skill:git", source: "skill", sourceInfo: { path: owned } },
                { name: "skill:broken", source: "skill", sourceInfo: { path: "relative/SKILL.md" } },
                { name: "review", source: "prompt", sourceInfo: { path: plain } },
            ]),
        );
        assert.deepEqual(listed, [
            { name: "acme-jira", file: company, tools: ["jira"] },
            { name: "house-style", file: plain },
            { name: "git", file: owned, plugin: "jig-git" },
        ]);
    });

    test("a parent that cannot list its commands has no skills to give, and a missing file is a skill with no field", () => {
        assert.deepEqual(listSkills(piWith(new Error("no commands"))), []);
        const gone = path.join(root, "gone", "SKILL.md");
        assert.deepEqual(listSkills(piWith([{ name: "skill:gone", source: "skill", sourceInfo: { path: gone } }])), [
            { name: "gone", file: gone },
        ]);
    });
});

describe("preloading", () => {
    test("the whole skill without its front matter is read, with the folder its paths are relative to", () => {
        const file = skill("home", "git", [], "# Git\n\nRead `references/x.md`.\n");
        const { loaded, problems } = readPreloads(["git"], [info("git", { file })]);
        assert.deepEqual(problems, []);
        assert.deepEqual(loaded, [{ name: "git", dir: path.dirname(file), body: "# Git\n\nRead `references/x.md`." }]);
    });

    test("a skill the role does not see cannot be preloaded, and the problem lists what it does see", () => {
        const { loaded, problems } = readPreloads(["logs"], [info("git")]);
        assert.deepEqual(loaded, []);
        assert.match(
            problems[0] ?? "",
            /preload: the skill logs is not one this role sees \(git\); a preloaded skill must also be visible/,
        );
        assert.match(readPreloads(["logs"], []).problems[0] ?? "", /it sees none/);
    });

    test("a file that is too long or cannot be read is a problem", () => {
        const big = skill("home", "big", [], "x".repeat(MAX_PRELOAD_BYTES));
        assert.match(readPreloads(["big"], [info("big", { file: big })]).problems[0] ?? "", /longer than 64 KiB/);
        assert.match(
            readPreloads(["gone"], [info("gone", { file: path.join(root, "nope") })]).problems[0] ?? "",
            /cannot be read/,
        );
    });

    test("the prompt is the role's, then each skill under its own heading", () => {
        const text = promptWith("You review.", [{ name: "git", dir: "/s/git", body: "Use the git tool." }]);
        assert.match(text, /^You review\.\n\n## Skill: git\n\nThis is the whole skill, already loaded\./);
        assert.match(text, /relative to its folder, \/s\/git\.\n\nUse the git tool\.$/);
        assert.equal(promptWith("You review.", []), "You review.");
    });
});
