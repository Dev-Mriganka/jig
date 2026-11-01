// The import boundary. A plugin's code (`src/`) may import its own files and, from another plugin, only jig-core's public parts:
// `src/contract.ts`, `src/client.ts` and the stateless helpers in `src/kit/`. Those are what docs/compatibility.md promises to company
// plugins; every other file of jig-core is internal and may change in any commit. A plugin that reached into another's code would
// break when that code moved, and would make a plugin that works alone depend on another one. Tests (`test/`) are not held to this.
//
// The check reads the import statements of every `.ts` file under plugins/*/src and examples/*/src. It measured, when it was written,
// that every cross-plugin import was already one of those public parts, so there are no exceptions to list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importsOf } from "../../../scripts/imports.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/** jig-core's public files, relative to the repository: the contract, the client, and every file directly in the kit. */
function isPublic(target: string): boolean {
    const parts = target.split("/");
    if (parts[0] !== "plugins" || parts[1] !== "jig-core" || parts[2] !== "src") return false;
    if (parts.length === 4) return parts[3] === "contract.ts" || parts[3] === "client.ts";
    return parts.length === 5 && parts[3] === "kit" && (parts[4] ?? "").endsWith(".ts");
}

/** Every `.ts` file under a folder, skipping node_modules. */
function sourceFiles(folder: string): string[] {
    return readdirSync(folder).flatMap((name) => {
        const full = path.join(folder, name);
        if (name === "node_modules") return [];
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return name.endsWith(".ts") ? [full] : [];
    });
}

/** The imports that break the rule, each as a message that names the file, the import and the rule. */
function violations(root: string): string[] {
    const found: string[] = [];
    for (const group of ["plugins", "examples"]) {
        for (const plugin of readdirSync(path.join(root, group))) {
            const src = path.join(root, group, plugin, "src");
            let files: string[];
            try {
                files = sourceFiles(src);
            } catch {
                continue; // a plugin with no src folder
            }
            for (const file of files) {
                const relative = path.relative(root, file).split(path.sep).join("/");
                for (const { specifier, line } of importsOf(readFileSync(file, "utf8"))) {
                    if (!specifier.startsWith(".")) continue;
                    const target = path
                        .relative(root, path.resolve(path.dirname(file), specifier))
                        .split(path.sep)
                        .join("/");
                    const own = `${group}/${plugin}/`;
                    if (target.startsWith(own) || isPublic(target)) continue;
                    found.push(
                        `${relative}:${line} imports "${specifier}" (${target}): a plugin may import another plugin's code only when it is jig-core's contract.ts, client.ts or a file of kit/ (docs/compatibility.md, "What is public")`,
                    );
                }
            }
        }
    }
    return found;
}

test("no plugin imports another plugin's code, except jig-core's contract, client and kit", () => {
    assert.deepEqual(violations(ROOT), []);
});

test("docs/compatibility.md names the public parts this rule allows", () => {
    const text = readFileSync(path.join(ROOT, "docs/compatibility.md"), "utf8");
    for (const part of [
        "plugins/jig-core/src/contract.ts",
        "plugins/jig-core/src/client.ts",
        "plugins/jig-core/src/kit/",
    ]) {
        assert.ok(text.includes(`\`${part}\``), `docs/compatibility.md does not name ${part}`);
    }
});

test("the check finds a plugin reaching into another's internals, and says which file, which import and which rule", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jig-boundary-"));
    try {
        const put = (file: string, text: string): void => {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            writeFileSync(path.join(root, file), text);
        };
        put("plugins/jig-core/src/contract.ts", "export type X = string;\n");
        put("plugins/jig-core/src/client.ts", "export const jig = 1;\n");
        put("plugins/jig-core/src/kit/values.ts", "export const isObject = 1;\n");
        put("plugins/jig-core/src/kit/deeper/more.ts", "export const m = 1;\n");
        put("plugins/jig-core/src/records.ts", "export const records = 1;\n");
        put("plugins/jig-a/src/own.ts", "export const own = 1;\n");
        put(
            "plugins/jig-a/src/fine.ts",
            [
                'import type { X } from "../../jig-core/src/contract.ts";',
                'import { jig } from "../../jig-core/src/client.ts";',
                'import { isObject } from "../../jig-core/src/kit/values.ts";',
                'import { own } from "./own.ts";',
                'import path from "node:path";',
                "",
            ].join("\n"),
        );
        put(
            "plugins/jig-a/src/bad.ts",
            [
                'import { records } from "../../jig-core/src/records.ts";',
                "import {",
                "    m,",
                '} from "../../jig-core/src/kit/deeper/more.ts";',
                'export * from "../../jig-b/src/other.ts";',
                'const later = await import("../../jig-core/src/gate.ts");',
                'import { outside } from "../../../test/support/it.ts";',
                "",
            ].join("\n"),
        );
        put("plugins/jig-b/src/other.ts", "export const other = 1;\n");
        put(
            "examples/jig-acme/src/jig/types.ts",
            'export type * from "../../../../plugins/jig-core/src/contract.ts";\n',
        );
        put("examples/jig-acme/src/bad.ts", 'import { x } from "../../../plugins/jig-core/src/state.ts";\n');
        const found = violations(root);
        assert.equal(found.length, 6, found.join("\n"));
        assert.match(
            found.find((message) => message.startsWith("examples/")) ?? "",
            /^examples\/jig-acme\/src\/bad\.ts:1 imports "\.\.\/\.\.\/\.\.\/plugins\/jig-core\/src\/state\.ts" \(plugins\/jig-core\/src\/state\.ts\): a plugin may import another plugin's code only when/,
        );
        assert.ok(
            found.some((message) =>
                message.startsWith('plugins/jig-a/src/bad.ts:1 imports "../../jig-core/src/records.ts"'),
            ),
        );
        assert.ok(
            found.some((message) =>
                message.startsWith('plugins/jig-a/src/bad.ts:4 imports "../../jig-core/src/kit/deeper/more.ts"'),
            ),
        );
        assert.ok(
            found.some((message) =>
                message.startsWith('plugins/jig-a/src/bad.ts:5 imports "../../jig-b/src/other.ts"'),
            ),
        );
        assert.ok(
            found.some((message) =>
                message.startsWith('plugins/jig-a/src/bad.ts:6 imports "../../jig-core/src/gate.ts"'),
            ),
        );
        assert.ok(
            found.some((message) =>
                message.startsWith('plugins/jig-a/src/bad.ts:7 imports "../../../test/support/it.ts"'),
            ),
        );
        assert.ok(found.every((message) => message.includes("docs/compatibility.md")));
        assert.ok(!found.some((message) => message.includes("fine.ts") || message.includes("types.ts")));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
