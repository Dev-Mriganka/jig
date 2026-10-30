// How the plugin joins Pi and jig-core: the tool Pi gets, what jig-core is told, and that the tool fails closed without jig-core.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import plugin, { jigHttp } from "../src/index.ts";
import { METHODS, parameters } from "../src/params.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import { startFakeApi } from "./support/fake-api.ts";

function load(options = {}): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    void jigHttp(options)({ registerTool: (tool: ToolDefinition) => void tools.push(tool) } as unknown as ExtensionAPI);
    return tools;
}

describe("the extension", () => {
    test("is a function Pi can load, and registers one tool, `http`, with the schema of a call", () => {
        assert.equal(typeof plugin, "function");
        const jig = installFakeJig();
        try {
            const tools: ToolDefinition[] = [];
            void plugin({ registerTool: (tool: ToolDefinition) => void tools.push(tool) } as unknown as ExtensionAPI);
            assert.equal(tools.length, 1);
            const [tool] = tools;
            assert.equal(tool?.name, "http");
            assert.equal(tool?.label, "HTTP");
            assert.equal(tool?.parameters, parameters);
            const properties = (tool?.parameters as unknown as { properties: Record<string, { enum?: string[] }>; required: string[] });
            assert.deepEqual(Object.keys(properties.properties), ["target", "method", "path", "body", "headers", "timeoutSec"]);
            assert.deepEqual(properties.properties.method?.enum, [...METHODS]);
            assert.deepEqual(properties.required, ["target", "method", "path"]);
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
            const check = jig.sections.get("http");
            assert.ok(check, "the section is registered");
            const target = { baseUrl: "https://api.example.test", environment: "staging", auth: { none: true } };
            assert.deepEqual(check({ targets: { api: target } }), []);
            assert.equal(check({ targets: { api: { ...target, baseUrl: "http://api.example.test" } } }).length, 1);
            const declaration = jig.declared.get("http");
            assert.equal(declaration?.plugin, "jig-api");
            assert.equal(declaration?.tool, "http");
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
        assert.equal(first.declared.has("http"), false, "nothing was declared into the jig-core that went away");
        const jig = installFakeJig();
        try {
            assert.equal(jig.declared.get("http")?.plugin, "jig-api");
            assert.ok(jig.sections.has("http"));
        } finally {
            jig.remove();
        }
    });

    test("fails closed: without jig-core the tool does not run, and does not send anything", async () => {
        const api = await startFakeApi();
        const jig = installFakeJig();
        try {
            jig.setSection("http", { targets: { api: { baseUrl: api.origin, environment: "staging", allowPlainLocal: true, auth: { none: true } } } });
            const [tool] = load();
            jig.remove();
            assert.ok(tool);
            const input = { target: "api", method: "GET", path: "/x" };
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
        const text = fs.readFileSync(path.join(root, "plugins", "jig-api", "skills", "http", "SKILL.md"), "utf8");
        const [, head = ""] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];
        assert.match(head, /^name: http$/m);
        const description = /^description: (.*)$/m.exec(head)?.[1] ?? "";
        assert.ok(description.length > 40 && description.length <= 1024, description);
        assert.match(description, /Use when/);
    });
});
