// How the plugin meets Pi and jig-core: what it declares, the section it registers, the package manifest, the skill, and that the
// README (the specification) and the code say the same thing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { validateMongo } from "../src/config.ts";
import { ACTION_NAMES, ACTIONS } from "../src/params.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const plugin = path.join(root, "plugins", "jig-mongo");
const read = (...parts: string[]): string => fs.readFileSync(path.join(plugin, ...parts), "utf8");

let h: Harness;
beforeEach(() => void (h = setupHarness()));
afterEach(async () => h.close());

describe("what the plugin registers", () => {
    test("one tool, declared to jig-core with its classification and its preview, and the section it owns", () => {
        assert.equal(h.tool.name, "mongo");
        assert.deepEqual([...h.jig.declared.keys()], ["mongo"]);
        assert.equal(h.declaration.plugin, "jig-mongo");
        assert.equal(typeof h.declaration.classify, "function");
        assert.equal(typeof h.declaration.preview, "function");
        assert.equal(h.jig.sections.get("mongo"), validateMongo);
        assert.deepEqual(h.handlers.get("session_shutdown")?.length, 1);
    });

    test("loading reads nothing: no secret, no connection, no program, until a call is made", () => {
        assert.deepEqual(h.jig.resolved, []);
        assert.equal(h.connects.length, 0);
        assert.equal(h.jig.started.length, 0);
    });

    test("loading before jig-core waits for it, as Pi may load plugins in any order", async () => {
        h.jig.remove();
        const loaded = setupHarness();
        try {
            assert.ok(loaded.jig.declared.has("mongo"));
        } finally {
            await loaded.close();
        }
    });

    test("a section with a mistake reads as absent, so the tool does nothing until it is fixed", () => {
        h.jig.setSection("mongo", {
            connections: { staging: { uri: "mongodb://u:p@db.example.com", user: "a", password: "pass:x" } },
        });
        assert.throws(
            () => h.declaration.classify({ action: "databases", environment: "staging" }),
            /mongo is not set up/,
        );
        assert.ok(
            validateMongo({
                connections: { staging: { uri: "mongodb://u:p@db.example.com", user: "a", password: "pass:x" } },
            }).length > 0,
        );
    });
});

describe("the package", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        pi: { extensions: string[]; skills: string[] };
    };

    test("Pi loads the extension after jig-core, and finds the skill", () => {
        assert.ok(manifest.pi.extensions.includes("./plugins/jig-mongo/src/index.ts"));
        assert.ok(
            manifest.pi.extensions.indexOf("./plugins/jig-mongo/src/index.ts") >
                manifest.pi.extensions.indexOf("./plugins/jig-core/src/index.ts"),
        );
        assert.ok(manifest.pi.skills.includes("./plugins/*/skills"));
        assert.ok(fs.existsSync(path.join(plugin, "src", "index.ts")));
    });

    test("the driver is a runtime dependency at an exact version", () => {
        assert.match(manifest.dependencies.mongodb ?? "", /^\d+\.\d+\.\d+$/);
    });

    test("the skill has the frontmatter Pi needs: a name that is its folder, and a description that says when to use it", () => {
        const text = read("skills", "mongo", "SKILL.md");
        const [, head = ""] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];
        assert.match(head, /^name: mongo$/m);
        const description = /^description: (.*)$/m.exec(head)?.[1] ?? "";
        assert.ok(description.length > 40 && description.length <= 1024, description);
        assert.match(description, /Use when/);
    });

    test("the skill teaches what the README promises: count before find, explain, a preview for every write, never production", () => {
        const text = read("skills", "mongo", "SKILL.md");
        for (const phrase of [
            /Count before you find/,
            /Explain before you blame the database/,
            /preview/,
            /Never production/,
        ])
            assert.match(text, phrase);
    });
});

describe("the README is the specification", () => {
    const readme = read("README.md");

    test("every action is in the tool table, with its kind, and no other is", () => {
        const table = readme.split("## Tool: `mongo`")[1]?.split("## Access")[0] ?? "";
        const named = [...table.matchAll(/`([a-z-]+)`/g)]
            .map((match) => match[1] as string)
            .filter((name) => ACTION_NAMES.includes(name as never));
        assert.deepEqual([...new Set(named)].sort(), [...ACTION_NAMES].sort());
        for (const name of ACTION_NAMES) {
            const row = table.split("\n").find((line) => line.includes(`\`${name}\``)) ?? "";
            const kind =
                name === "aggregate"
                    ? /\| read, or write \|/
                    : ACTIONS[name].effect === "write"
                      ? /\| write \|/
                      : /\| read \|/;
            assert.match(row, kind, name);
        }
    });

    test("the configuration example is valid, and shows production with an allow list and a route", () => {
        const json = /```json\n([\s\S]*?)\n```/.exec(readme)?.[1] ?? "";
        const section = (JSON.parse(json) as { mongo: unknown }).mongo;
        assert.deepEqual(validateMongo(section), []);
        assert.match(json, /"allow"/);
        assert.match(json, /"via"/);
    });

    test("it is in the standard shape: short, with its detail in docs, and every link points at a file that exists", () => {
        assert.ok(readme.split("\n").length <= 150, `${readme.split("\n").length} lines`);
        for (const heading of [
            "## Tool: `mongo`",
            "## Access",
            "## Rules",
            "## Configure",
            "## Company part",
            "## Later",
            "## Layout",
            "## More detail",
        ]) {
            assert.ok(readme.includes(heading), heading);
        }
        for (const [, link = ""] of readme.matchAll(/\]\((docs\/[^)#]+\.md)/g))
            assert.ok(fs.existsSync(path.join(plugin, link)), link);
        for (const file of fs.readdirSync(path.join(plugin, "docs")))
            assert.ok(readme.includes(`docs/${file}`), `${file} is linked`);
    });

    test("the rules it states are the ones the code has", () => {
        assert.match(readme, /1000 documents/);
        assert.match(readme, /1 to 2000, default 20/);
        assert.match(readme, /`\*password\*`, `\*secret\*`, `\*token\*`, `\*apiKey\*`/);
    });
});

describe("nothing company-specific is in the plugin", () => {
    // The words are built from parts, so that this file does not hold them itself.
    const words = [
        ["von", "age"],
        ["pan", "ther"],
        ["q", "a7"],
        ["zu", "ora"],
        ["hd", "ap"],
        ["bss", "eng"],
        ["switch", "board"],
        ["voc", "al"],
        ["jump", "host"],
        ["broke", "r"],
    ].map((parts) => parts.join(""));

    test("no file of the plugin names a company, one of its systems, or a machine of the author", () => {
        const found: string[] = [];
        const visit = (folder: string): void => {
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                const full = path.join(folder, entry.name);
                if (entry.isDirectory()) visit(full);
                else if (new RegExp(words.join("|"), "i").test(fs.readFileSync(full, "utf8")))
                    found.push(path.relative(root, full));
            }
        };
        visit(plugin);
        assert.deepEqual(found, []);
    });
});
