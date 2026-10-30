// How the plugin joins Pi and jig-core: the tool Pi gets, what jig-core is told, and that the tool fails closed without jig-core.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import plugin, { jigJira } from "../src/index.ts";
import { ACTION_NAMES, parameters } from "../src/params.ts";
import { installFakeJig } from "./support/fake-jig.ts";

function load(options = {}): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    void jigJira(options)({ registerTool: (tool: ToolDefinition) => void tools.push(tool) } as unknown as ExtensionAPI);
    return tools;
}

describe("the extension", () => {
    test("is a function Pi can load, and registers one tool, `jira`, with the schema of its actions", () => {
        assert.equal(typeof plugin, "function");
        const jig = installFakeJig();
        try {
            const tools: ToolDefinition[] = [];
            void plugin({ registerTool: (tool: ToolDefinition) => void tools.push(tool) } as unknown as ExtensionAPI);
            assert.equal(tools.length, 1);
            const [tool] = tools;
            assert.equal(tool?.name, "jira");
            assert.equal(tool?.label, "Jira");
            assert.equal(tool?.parameters, parameters);
            assert.deepEqual(
                (tool!.parameters as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum,
                ACTION_NAMES,
            );
            assert.equal(
                tool?.executionMode,
                "sequential",
                "a comment is on the issue before the transition that follows it",
            );
            assert.equal(typeof tool?.execute, "function");
        } finally {
            jig.remove();
        }
    });

    test("keeps its descriptions short", () => {
        const jig = installFakeJig();
        try {
            const [tool] = load();
            assert.ok((tool?.description ?? "").length <= 200, tool?.description ?? "");
            assert.ok((tool?.promptSnippet ?? "").length <= 120, tool?.promptSnippet ?? "");
            assert.equal(tool?.promptGuidelines, undefined, "the skill carries the conventions");
        } finally {
            jig.remove();
        }
    });

    test("tells jig-core its section and its tool, which is declared as a jig-jira tool", () => {
        const jig = installFakeJig();
        try {
            load();
            const check = jig.sections.get("jira");
            assert.ok(check, "the section is registered");
            assert.deepEqual(check({ site: "https://example.test", auth: { token: "pass:x/y" } }), []);
            assert.deepEqual(check({ site: "http://example.test", auth: { token: "pass:x/y" } }).length, 1);
            const declaration = jig.declared.get("jira");
            assert.equal(declaration?.plugin, "jig-jira");
            assert.equal(declaration?.tool, "jira");
        } finally {
            jig.remove();
        }
    });

    test("may load before jig-core: what it tells jig-core waits until jig-core is there", () => {
        const first = installFakeJig();
        first.remove();
        load();
        assert.equal(first.declared.has("jira"), false, "nothing was declared into the jig-core that went away");
        const jig = installFakeJig();
        try {
            assert.equal(jig.declared.get("jira")?.plugin, "jig-jira");
            assert.ok(jig.sections.has("jira"));
        } finally {
            jig.remove();
        }
    });

    test("fails closed: without jig-core the tool does not run, and does not send anything", async () => {
        const jig = installFakeJig();
        let fetched = false;
        const [tool] = load({
            fetch: (async () => {
                fetched = true;
                return new Response("{}");
            }) as typeof fetch,
        });
        jig.remove();
        assert.ok(tool);
        await assert.rejects(
            tool.execute("call-1", { action: "get", key: "PROJ-1" } as never, undefined, undefined, {} as never),
            /jig-core is not loaded/,
        );
        assert.equal(fetched, false);
    });
});

describe("the package", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        pi: { extensions: string[]; skills: string[] };
    };

    test("Pi loads the extension and finds the skill", () => {
        assert.ok(manifest.pi.extensions.includes("./plugins/jig-jira/src/index.ts"));
        assert.ok(manifest.pi.skills.includes("./plugins/*/skills"));
        assert.ok(fs.existsSync(path.join(root, "plugins", "jig-jira", "src", "index.ts")));
    });

    test("the skill has the frontmatter Pi needs: a name that is its folder, and a description that says when to use it", () => {
        const text = fs.readFileSync(path.join(root, "plugins", "jig-jira", "skills", "jira", "SKILL.md"), "utf8");
        const [, head = ""] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];
        assert.match(head, /^name: jira$/m);
        const description = /^description: (.*)$/m.exec(head)?.[1] ?? "";
        assert.ok(description.length > 40 && description.length <= 1024, description);
        assert.match(description, /Use when/);
    });
});
