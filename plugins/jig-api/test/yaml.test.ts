// The one use of the `yaml` package: parsing text into plain data. Nothing in a file is run, a file that expands without bound is
// refused, and a message about a file never quotes it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Problem } from "../src/model.ts";
import { parseYaml } from "../src/sources/yaml.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function parsed(text: string): { value: unknown; problems: Problem[] } {
    const problems: Problem[] = [];
    return { value: parseYaml(text, "f.yml", problems), problems };
}

describe("reading YAML", () => {
    test("gives plain data", () => {
        assert.deepEqual(parsed("a: 1\nb:\n  - x\n  - y: true\nc: 'text'\n").value, {
            a: 1,
            b: ["x", { y: true }],
            c: "text",
        });
        assert.deepEqual(parsed('{"json": [1, 2]}').value, { json: [1, 2] }, "JSON is YAML");
    });

    test("never runs anything: a tag that names code is not code", () => {
        const { value } = parsed(
            'a: !!js/function "function () { globalThis.jigApiPwned = true }"\nb: !!python/object/apply:os.system ["echo no"]\n',
        );
        assert.equal((globalThis as { jigApiPwned?: unknown }).jigApiPwned, undefined);
        assert.ok(typeof value === "object" || value === undefined);
    });

    test("a file that expands without bound is refused", () => {
        const lines = ["a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9]"];
        for (let each = 0; each < 12; each++)
            lines.push(
                `${String.fromCharCode(98 + each)}: &${String.fromCharCode(98 + each)} [${Array.from({ length: 9 }, () => `*${String.fromCharCode(97 + each)}`).join(", ")}]`,
            );
        const { value, problems } = parsed(`${lines.join("\n")}\n`);
        assert.equal(value, undefined);
        assert.match(problems[0]?.message ?? "", /too many aliases|is not valid YAML/);
    });

    test("a repeated key is an error with its line, because one of the two values would be lost", () => {
        const { value, problems } = parsed("a: 1\nb: 2\na: 3\n");
        assert.equal(value, undefined);
        assert.deepEqual(problems, [
            { file: "f.yml", key: "line 3", message: "is not valid YAML (DUPLICATE_KEY)", level: "error" },
        ]);
    });

    test("a mistake names its line and a code, and never quotes the text", () => {
        const { problems } = parsed("token: CANARY-secret-value\nbad: [unclosed CANARY-secret-value\n");
        assert.equal(problems.length, 1);
        assert.doesNotMatch(JSON.stringify(problems), /CANARY/);
        assert.match(problems[0]?.key ?? "", /^line \d+$/);
    });
});

describe("the dependency", () => {
    test("only the module that parses imports it, and no source evaluates text", () => {
        const importers: string[] = [];
        const visit = (directory: string): void => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(full);
                else if (entry.name.endsWith(".ts")) {
                    const text = fs.readFileSync(full, "utf8");
                    if (/from "yaml"/.test(text)) importers.push(path.relative(SRC, full));
                    assert.doesNotMatch(
                        text.replace(/\/\/.*$/gm, ""),
                        /\beval\s*\(|new Function\s*\(/,
                        `${entry.name} evaluates text`,
                    );
                }
            }
        };
        visit(SRC);
        assert.deepEqual(importers, [path.join("sources", "yaml.ts")]);
    });

    test("the manifest pins it exactly, beside jig-review's three run-time dependencies and jig-mongo's driver", () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "..", "..", "..", "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
            "@hono/node-server",
            "hono",
            "ignore",
            "mongodb",
            "yaml",
        ]);
        assert.match(manifest.dependencies.yaml ?? "", /^\d+\.\d+\.\d+$/);
    });
});
