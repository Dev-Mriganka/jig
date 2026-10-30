// How the plugin joins Pi and jig-core: the tool Pi gets, what jig-core is told, and that the tool fails closed without jig-core.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import plugin, { jigApi } from "../src/index.ts";
import { METHODS } from "../src/engine/plan.ts";
import { ACTION_NAMES, parameters } from "../src/params.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import { startFakeApi } from "./support/fake-api.ts";

/** The part of Pi that the plugin uses at load: it takes a tool and a command. */
function fakePi(tools: ToolDefinition[], commands: string[] = []): ExtensionAPI {
    return { registerTool: (tool: ToolDefinition) => void tools.push(tool), registerCommand: (name: string) => void commands.push(name) } as unknown as ExtensionAPI;
}

function load(options = {}): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    void jigApi(options)(fakePi(tools));
    return tools;
}

describe("the extension", () => {
    test("is a function Pi can load, and registers one tool, `api`, with the schema of a call", () => {
        assert.equal(typeof plugin, "function");
        const jig = installFakeJig();
        try {
            const tools: ToolDefinition[] = [];
            const commands: string[] = [];
            void plugin(fakePi(tools, commands));
            assert.equal(tools.length, 1);
            assert.deepEqual(commands, ["api"], "and one command, /api, which refreshes what is kept in a service");
            const [tool] = tools;
            assert.equal(tool?.name, "api");
            assert.equal(tool?.label, "API");
            assert.equal(tool?.parameters, parameters);
            const properties = (tool?.parameters as unknown as { properties: Record<string, { enum?: string[] }>; required: string[] });
            assert.deepEqual(
                Object.keys(properties.properties),
                ["action", "collection", "folder", "request", "text", "environment", "variables", "method", "url", "body", "headers", "timeoutSec"],
            );
            assert.deepEqual(properties.properties.action?.enum, [...ACTION_NAMES]);
            assert.deepEqual([...ACTION_NAMES], ["list", "show", "run", "run-folder", "call"]);
            assert.deepEqual(properties.properties.method?.enum, [...METHODS]);
            assert.deepEqual(properties.required, ["action"]);
            assert.equal(tool?.executionMode, "sequential", "a write is done before the read that checks it");
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

    test("tells jig-core its section and its tool, which is declared as a jig-api tool", () => {
        const jig = installFakeJig();
        try {
            load();
            const check = jig.sections.get("api");
            assert.ok(check, "the section is registered");
            assert.deepEqual(check({ collections: { orders: { http: "/work/orders/http" } } }), []);
            assert.equal(check({ collections: { orders: { http: "relative/path" } } }).length, 1);
            assert.equal(jig.sections.has("http"), false, "the old section is gone");
            const declaration = jig.declared.get("api");
            assert.equal(declaration?.plugin, "jig-api");
            assert.equal(declaration?.tool, "api");
            assert.equal(typeof declaration?.preview, "function");
            assert.equal(declaration?.masksOwnResults, undefined, "jig-core masks production results");
        } finally {
            jig.remove();
        }
    });

    test("may load before jig-core: what it tells jig-core waits until jig-core is there", () => {
        const first = installFakeJig();
        first.remove();
        load();
        assert.equal(first.declared.has("api"), false, "nothing was declared into the jig-core that went away");
        const jig = installFakeJig();
        try {
            assert.equal(jig.declared.get("api")?.plugin, "jig-api");
            assert.ok(jig.sections.has("api"));
        } finally {
            jig.remove();
        }
    });

    test("fails closed: without jig-core the tool does not run, and does not send anything", async () => {
        const api = await startFakeApi();
        const jig = installFakeJig();
        try {
            jig.setSection("api", { collections: { orders: { http: "/work/orders/http" } }, allowPlainLocal: true });
            const [tool] = load();
            jig.remove();
            assert.ok(tool);
            const input = { action: "list" };
            await assert.rejects(tool.execute("call-1", input as never, undefined, undefined, {} as never), /jig-core is not loaded/);
            assert.equal(api.requests.length, 0);
        } finally {
            jig.remove();
            await api.close();
        }
    });
});

describe("the package", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { pi: { extensions: string[]; skills: string[] } };

    test("Pi loads the extension and finds the skill", () => {
        assert.ok(manifest.pi.extensions.includes("./plugins/jig-api/src/index.ts"));
        assert.ok(manifest.pi.skills.includes("./plugins/*/skills"));
        assert.ok(fs.existsSync(path.join(root, "plugins", "jig-api", "src", "index.ts")));
    });

    test("the skill has the frontmatter Pi needs: a name that is its folder, and a description that says when to use it", () => {
        const text = fs.readFileSync(path.join(root, "plugins", "jig-api", "skills", "api", "SKILL.md"), "utf8");
        const [, head = ""] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];
        assert.match(head, /^name: api$/m);
        const description = /^description: (.*)$/m.exec(head)?.[1] ?? "";
        assert.ok(description.length > 40 && description.length <= 1024, description);
        assert.match(description, /Use when/);
    });
});
