// Keeps the code maps true. A big plugin has `docs/code-map.md`: a table of every file of its `src/` with what it does and who calls it,
// and one call followed through the files. This test fails when a file of `src/` is missing from the map or the map lists a file that
// is not there, so a map cannot rot. (Whether a "called by" cell is right is not checked: the code is the judge of that.)
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const PLUGINS = path.resolve(import.meta.dirname, "../..");
/** The plugins that have a code map. A plugin that gets one is added here, and the last test below fails until it is. */
const MAPPED = ["jig-agents", "jig-api", "jig-core", "jig-ops", "jig-sandbox", "jig-workflow"];

/** Every `.ts` file under a folder, as a path relative to it with `/` separators. */
function sourceFiles(dir: string, base = dir): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full, base);
        return name.endsWith(".ts") ? [path.relative(base, full).split(path.sep).join("/")] : [];
    });
}

/** The files a map lists: the first cell of a table row, when it is a `.ts` path in backticks. */
function listed(map: string): string[] {
    return [...map.matchAll(/^\| `([^`]+\.ts)` \|/gm)].map((match) => match[1] as string);
}

describe("the code maps", () => {
    for (const plugin of MAPPED) {
        test(`${plugin}: every file of src/ is in its map, and every file in its map exists`, () => {
            const src = path.join(PLUGINS, plugin, "src");
            const map = readFileSync(path.join(PLUGINS, plugin, "docs/code-map.md"), "utf8");
            const rows = listed(map);
            const files = sourceFiles(src);
            assert.deepEqual(
                files.filter((file) => !rows.includes(file)),
                [],
                `files of ${plugin}/src that docs/code-map.md does not list`,
            );
            assert.deepEqual(
                rows.filter((file) => !existsSync(path.join(src, file))),
                [],
                `files that docs/code-map.md lists and ${plugin}/src does not have`,
            );
            assert.equal(new Set(rows).size, rows.length, "a file is listed twice");
        });

        test(`${plugin}: the README links its map`, () => {
            const readme = readFileSync(path.join(PLUGINS, plugin, "README.md"), "utf8");
            assert.match(readme, /\]\(docs\/code-map\.md\)/);
        });
    }

    test("every plugin that has a code map is in the list this test checks", () => {
        const withMap = readdirSync(PLUGINS).filter((name) => existsSync(path.join(PLUGINS, name, "docs/code-map.md")));
        assert.deepEqual(withMap.sort(), [...MAPPED].sort());
    });
});
