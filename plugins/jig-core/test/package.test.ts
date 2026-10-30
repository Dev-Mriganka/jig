// The package manifest is how Pi finds the plugins: one that is missing simply never loads.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

test("the package manifest lists every plugin that has an entry point, and jig-core first", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        pi: { extensions: string[] };
    };
    const plugins = readdirSync(path.join(root, "plugins")).filter((name) =>
        existsSync(path.join(root, "plugins", name, "src", "index.ts")),
    );
    const listed = manifest.pi.extensions.map(
        (entry) => /^\.\/plugins\/([^/]+)\/src\/index\.ts$/.exec(entry)?.[1] ?? entry,
    );
    assert.deepEqual([...listed].sort(), [...plugins].sort());
    // Handlers run in load order, so jig-core's gate and result hook must come before every other plugin's.
    assert.equal(manifest.pi.extensions[0], "./plugins/jig-core/src/index.ts");
});
