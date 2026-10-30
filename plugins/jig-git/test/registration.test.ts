import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { withdrawJig } from "../../jig-core/src/client.ts";
import { GIT_ACTIONS } from "../src/git.ts";
import plugin from "../src/index.ts";
import { parameterNames } from "../src/params.ts";
import type { ActionTable } from "../src/params.ts";
import { PR_ACTIONS } from "../src/pr.ts";
import { RELEASE_ACTIONS } from "../src/release.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { installFakeJig } from "./support/fake-jig.ts";

let h: Harness;
before(() => {
    h = setupHarness();
});
after(() => h.cleanup());

const TABLES: Record<string, ActionTable> = {
    git: GIT_ACTIONS,
    pr: PR_ACTIONS,
    release: RELEASE_ACTIONS,
};

test("the plugin registers git, pr and release, and declares each to jig-core; it watches nothing and has no checks tool", () => {
    assert.deepEqual([...h.tools.keys()], ["git", "pr", "release"]);
    assert.deepEqual([...h.jig.declared.keys()], ["git", "pr", "release"]);
    assert.ok(h.jig.sections.has("git"), "the git section");
    assert.equal(h.jig.kinds.size, 0, "CI watches are jig-ops's: no watch kind is registered here");
});

test("every tool has a short description, a prompt line, and runs one call at a time", () => {
    for (const [name, tool] of h.tools) {
        assert.match(name, /^[a-zA-Z0-9_-]+$/);
        assert.ok(
            tool.description.length > 40 && tool.description.length < 400,
            `${name}: ${tool.description.length} characters`,
        );
        assert.ok(tool.promptSnippet && tool.promptSnippet.length < 100, name);
        assert.equal(tool.executionMode, "sequential", name);
        assert.equal(tool.exposure, undefined, "always loaded: the default exposure is direct");
        assert.equal((tool as unknown as { defaultActive?: boolean }).defaultActive, undefined);
    }
});

for (const [name, table] of Object.entries(TABLES)) {
    test(`${name}: the action enum is the table, the table and the schema name the same parameters, the description lists each action`, () => {
        const schema = h.tools.get(name)?.parameters as unknown as {
            properties: Record<string, { enum?: string[]; description?: string }>;
            additionalProperties: boolean;
        };
        assert.deepEqual(schema.properties.action?.enum, Object.keys(table));
        const used = parameterNames(table);
        const names = Object.keys(schema.properties).filter((key) => key !== "action");
        for (const parameter of used)
            assert.ok(
                names.includes(parameter),
                `${name}: the table names ${parameter}, which the schema does not have`,
            );
        for (const declared of names)
            assert.ok(used.has(declared), `${name}: the schema has ${declared}, which no action uses`);
        for (const [action, spec] of Object.entries(table)) {
            const params = [...(spec.required ?? []), ...(spec.optional ?? []).map((n) => `${n}?`)];
            assert.ok(
                (schema.properties.action?.description ?? "").includes(
                    `- ${action}${params.length > 0 ? ` {${params.join(", ")}}` : ""}: ${spec.summary}`,
                ),
                `${name} ${action}`,
            );
        }
        assert.equal(schema.additionalProperties, false, "an unknown parameter is refused");
    });
}

test("the schemas have no way to force-push, approve, delete a tag, or reset", () => {
    const git = h.tools.get("git")?.parameters as never;
    const pr = h.tools.get("pr")?.parameters as never;
    assert.equal(Check(git, { action: "push", force: true }), false);
    assert.equal(Check(git, { action: "push", force_with_lease: true }), true);
    assert.equal(Check(git, { action: "reset", hard: true }), false);
    assert.equal(Check(git, { action: "clean" }), false);
    assert.equal(Check(git, { action: "commit", message: "m", paths: ["a"], all: true }), false);
    assert.equal(Check(pr, { action: "approve", number: 1 }), false);
    assert.equal(Check(pr, { action: "review", number: 1, event: "approve", body: "x" }), false);
    assert.equal(Check(h.tools.get("release")?.parameters as never, { action: "tag_delete", tag: "v1" }), false);
    assert.equal(h.tools.has("checks"), false, "CI is the ci tool of jig-ops");
});

test("a wrong call is refused with the usage line before anything runs", async () => {
    const before = h.jig.started_processes.length;
    assert.match(
        (await h.call("git", { action: "commit", message: "m", repo: "x", force: true })).error?.message ?? "",
        /^git commit does not use force\. Usage: git commit \{message, repo\?, paths\?, amend\?\}$/,
    );
    assert.match(
        (await h.call("git", { action: "branch", operation: "create" })).error?.message ?? "",
        /^git branch needs branch\. Usage: git branch \{operation, branch, repo\?, base\?\}$/,
    );
    assert.match(
        (await h.call("git", { action: "push", message: "x" })).error?.message ?? "",
        /^git push does not use message\. Usage: git push \{repo\?, branch\?, remote\?, force_with_lease\?\}$/,
    );
    assert.match(
        (await h.call("git", { action: "status", paths: ["a"] })).error?.message ?? "",
        /^git status does not use paths\. Usage: git status \{repo\?\}$/,
    );
    assert.match(
        (await h.call("git", { action: "drop" })).error?.message ?? "",
        /^git: unknown action "drop"; use one of status, diff, log, show, blame, branches, fetch, clone, branch, worktree, commit, stash, sync, merge, rebase, cherry_pick, restore, push$/,
    );
    assert.equal(h.jig.started_processes.length, before, "no program was started");
});

test("a preview refuses a wrong call too, so the user is not asked about it", async () => {
    const declaration = h.jig.declared.get("git");
    await assert.rejects(
        declaration?.preview?.({ action: "push", force: true }, new AbortController().signal) ?? Promise.resolve(),
        /git push does not use force/,
    );
});

test("the session start tells the plugin where Pi works, for the previews that get no context", () => {
    const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => void>();
    const pi = {
        registerTool: () => {},
        on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => void) =>
            void handlers.set(event, handler),
        events: { emit: () => {} },
    } as unknown as ExtensionAPI;
    plugin(pi);
    assert.ok(handlers.has("session_start"));
    handlers.get("session_start")?.({}, { cwd: h.sb.workspace });
});

test("when jig-core loads after the plugin, the declarations wait for it; and a tool without jig-core fails closed", async () => {
    const earlier = new Map<string, ToolDefinition>();
    const pi = {
        registerTool: (tool: ToolDefinition) => void earlier.set(tool.name, tool),
        on: () => () => {},
        events: { emit: () => {} },
    } as unknown as ExtensionAPI;
    h.jig.remove();
    plugin(pi);
    await assert.rejects(
        earlier
            .get("git")
            ?.execute("c1", { action: "status" } as never, undefined, undefined, { cwd: h.sb.workspace } as never) ??
            Promise.resolve(),
        /jig-core is not loaded: enable jig-core, which governs every Jig tool/,
    );
    const late = installFakeJig();
    assert.deepEqual(
        [...late.declared.keys()],
        ["git", "pr", "release"],
        "the queued declarations ran when jig-core loaded",
    );
    assert.ok(late.sections.has("git"));
    withdrawJig(late.api);
    // the harness's own fake is published again for the tests that follow
    installFakeJig();
});

// ---- the package --------------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the package manifest loads the plugin after jig-core and the skills of every plugin", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        pi: { extensions: string[]; skills: string[] };
    };
    const core = manifest.pi.extensions.indexOf("./plugins/jig-core/src/index.ts");
    const git = manifest.pi.extensions.indexOf("./plugins/jig-git/src/index.ts");
    assert.ok(core >= 0 && git > core, "jig-git comes after jig-core");
    assert.deepEqual(manifest.pi.skills, ["./plugins/*/skills"]);
});

test("the skill has a name and a description that says what it is for, and mentions its three tools and the ci tool of jig-ops", () => {
    const file = path.join(ROOT, "plugins", "jig-git", "skills", "git", "SKILL.md");
    const text = fs.readFileSync(file, "utf8");
    const front = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(front, "frontmatter with a name and a description");
    assert.equal(front?.[1], "git");
    assert.ok((front?.[2] ?? "").length > 80 && (front?.[2] ?? "").length <= 1024);
    for (const tool of ["`git`", "`pr`", "`release`", "`ci`"]) assert.ok(text.includes(tool), tool);
    assert.ok(!text.includes("`checks`"), "the checks tool is gone");
    assert.match(text, /status/i);
    assert.match(text, /jig-git:pushed/);
});
