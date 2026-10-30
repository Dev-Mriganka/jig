// How the plugin meets Pi and jig-core: what its factory registers, what the tool tells the model about itself, the
// package that loads it, its skill, and the one rule about what it may import.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { withdrawJig } from "../../jig-core/src/client.ts";
import { validateLogsSection } from "../src/config.ts";
import plugin from "../src/index.ts";
import { USAGE } from "../src/params.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import { logsSection } from "./support/world.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = path.join(ROOT, "plugins", "jig-logs", "src");

/** A Pi that only records what the plugin registers. */
function fakePi() {
    const tools = new Map<string, ToolDefinition>();
    const pi = { registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    return { pi, tools };
}

test("the plugin registers one tool, logs, and declares it and its section to jig-core", () => {
    const jig = installFakeJig();
    try {
        const { pi, tools } = fakePi();
        plugin(pi);
        assert.deepEqual([...tools.keys()], ["logs"]);
        assert.deepEqual([...jig.declared.keys()], ["logs"]);
        assert.equal(jig.declared.get("logs")?.plugin, "jig-logs");
        const check = jig.sections.get("logs");
        assert.ok(check, "the logs section");
        assert.deepEqual(check({ backend: 1 }), validateLogsSection({ backend: 1 }), "the same checks");
        assert.deepEqual(check(logsSection()), []);
    } finally {
        jig.remove();
    }
});

test("the tool says what it is in few words, and runs like any other tool", () => {
    const { pi, tools } = fakePi();
    plugin(pi);
    const tool = tools.get("logs") as ToolDefinition;
    assert.match(tool.name, /^[a-zA-Z0-9_-]+$/);
    assert.ok(tool.description.length > 40 && tool.description.length < 400, `${tool.description.length} characters`);
    assert.match(tool.description, /match, exclude and around/, "how to pick lines is in the description");
    assert.match(tool.description, /only reads/);
    assert.ok(tool.promptSnippet && tool.promptSnippet.length < 100);
    const guidelines = tool.promptGuidelines ?? [];
    assert.ok(guidelines.length >= 1 && guidelines.length <= 2);
    assert.ok(guidelines.every((line) => line.length < 140 && !line.includes("\n") && line.startsWith("logs: ")));
    assert.match(guidelines.join(" "), /narrow window/);
    assert.equal(tool.exposure, undefined, "always loaded: the default exposure is direct");
    assert.equal((tool as unknown as { defaultActive?: boolean }).defaultActive, undefined);
    assert.equal(tool.executionMode, undefined, "searches may run side by side: they only read");
});

test("the schema lists exactly the parameters the usage line names, and refuses any other", () => {
    const { pi, tools } = fakePi();
    plugin(pi);
    const schema = (tools.get("logs") as ToolDefinition).parameters as unknown as {
        properties: Record<string, { enum?: string[]; description?: string }>;
        required?: string[];
        additionalProperties: boolean;
    };
    const names = Object.keys(schema.properties);
    const used = USAGE.replace(/^Usage: logs \{/, "")
        .replace(/\}$/, "")
        .replace("phrase or query", "phrase, query")
        .split(", ");
    assert.deepEqual([...names].sort(), used.map((name) => name.replace(/\?$/, "")).sort());
    assert.deepEqual(
        schema.required,
        ["environment"],
        "everything else is optional: phrase or query is checked by the tool",
    );
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.order?.enum, ["asc", "desc"]);
    for (const [name, property] of Object.entries(schema.properties)) {
        assert.ok(
            (property.description ?? "").length > 10 && (property.description ?? "").length < 140,
            `${name}: one short line`,
        );
    }
    assert.equal(Check(schema as never, { phrase: "x", environment: "staging", index: "other" }), false);
});

test("when jig-core loads after the plugin, the declarations wait for it; and a tool without jig-core fails closed", async () => {
    const { pi, tools } = fakePi();
    plugin(pi);
    await assert.rejects(
        (tools.get("logs") as ToolDefinition).execute(
            "c1",
            { phrase: "x", environment: "staging" } as never,
            undefined,
            undefined,
            {} as never,
        ),
        /jig-core is not loaded: enable jig-core, which governs every Jig tool/,
    );
    const late = installFakeJig();
    try {
        assert.deepEqual([...late.declared.keys()], ["logs"], "the queued declaration ran when jig-core loaded");
        assert.ok(late.sections.has("logs"));
    } finally {
        withdrawJig(late.api);
    }
});

// ---- the package ----------------------------------------------------------------------------------------------

test("the package manifest loads the plugin after jig-core, and the skills of every plugin", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        pi: { extensions: string[]; skills: string[] };
    };
    const core = manifest.pi.extensions.indexOf("./plugins/jig-core/src/index.ts");
    const logs = manifest.pi.extensions.indexOf("./plugins/jig-logs/src/index.ts");
    assert.ok(core >= 0 && logs > core, "jig-logs comes after jig-core");
    assert.deepEqual(manifest.pi.skills, ["./plugins/*/skills"]);
    assert.ok(fs.existsSync(path.join(ROOT, manifest.pi.extensions[logs] as string)));
});

test("the skill has a name and a description that say what it is for, and teaches the way to search", () => {
    const text = fs.readFileSync(path.join(ROOT, "plugins", "jig-logs", "skills", "logs", "SKILL.md"), "utf8");
    const front = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(front, "frontmatter with a name and a description");
    assert.equal(front?.[1], "logs");
    assert.ok((front?.[2] ?? "").length > 80 && (front?.[2] ?? "").length <= 1024);
    assert.ok(text.length <= 3500, `${text.length} characters`);
    for (const word of [
        "phrase",
        "query",
        "window",
        "widen",
        "match",
        "exclude",
        "around",
        "chars",
        "offset",
        "order",
        "partial",
        "masked",
    ]) {
        assert.match(text, new RegExp(`\\b${word}\\b`, "i"), `the skill teaches ${word}`);
    }
    assert.match(text, /narrow/i);
    assert.match(text, /not hidden/);
    assert.match(text, /Never tell\s+the user something is unavailable because it is masked/);
});

// ---- the one rule about imports ------------------------------------------------------------------------------

const sources = fs
    .readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: fs.readFileSync(path.join(SRC, file), "utf8") }));

test("the plugin reaches jig-core only through its contract, its client and its kit of stateless helpers", () => {
    assert.ok(sources.length >= 10);
    for (const { file, text } of sources) {
        for (const match of text.matchAll(
            /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm,
        )) {
            const specifier = match[1] as string;
            if (specifier.includes("jig-core")) {
                assert.match(
                    specifier,
                    /^\.\.\/\.\.\/jig-core\/src\/(?:contract|client|kit\/[a-z-]+)\.ts$/,
                    `${file}: ${specifier}`,
                );
            }
        }
    }
});

test("imports: relative ones end in .ts, and bare ones are built-ins or host packages", () => {
    const host = /^(?:typebox(?:\/\w+)?|@earendil-works\/pi-(?:coding-agent|tui|ai))$/;
    for (const { file, text } of sources) {
        for (const match of text.matchAll(
            /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm,
        )) {
            const specifier = match[1] as string;
            if (specifier.startsWith("."))
                assert.ok(specifier.endsWith(".ts"), `${file}: ${specifier} must end in .ts`);
            else
                assert.ok(
                    specifier.startsWith("node:") || host.test(specifier),
                    `${file}: ${specifier} is not a built-in or host package`,
                );
        }
    }
});

test("the plugin adds no run-time dependency", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
    };
    // The packages of the repository are jig-api's `yaml`, jig-review's `hono`, `@hono/node-server` and `ignore`, and
    // jig-mongo's driver.
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
        "@hono/node-server",
        "hono",
        "ignore",
        "mongodb",
        "socks",
        "yaml",
    ]);
});

test("type-erasable TypeScript only: no enums, namespaces, import = or parameter properties", () => {
    for (const { file, text } of sources) {
        assert.ok(!/^\s*(?:export\s+)?(?:const\s+)?enum\s/m.test(text), `${file}: enum`);
        assert.ok(!/^\s*(?:export\s+)?(?:declare\s+)?namespace\s/m.test(text), `${file}: namespace`);
        assert.ok(!/^\s*import\s+\w+\s*=/m.test(text), `${file}: import =`);
        assert.ok(
            !/constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s/.test(text),
            `${file}: parameter property`,
        );
    }
});
