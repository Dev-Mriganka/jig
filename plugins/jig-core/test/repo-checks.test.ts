// The two checks of `npm run check` that read package.json (scripts/check-pinned-deps.mjs, scripts/check-runtime-deps.mjs): they pass on
// this repository, and each fails, naming the file and the line, on a small project that breaks the rule.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const folders: string[] = [];
afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Runs a script of scripts/ on a folder. */
function run(script: string, root: string): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), "--root", root], {
        encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A small project: package.json and the files, by path. */
function project(manifest: unknown, files: Record<string, string> = {}): string {
    const root = mkdtempSync(path.join(tmpdir(), "jig-repo-check-"));
    folders.push(root);
    mkdirSync(path.join(root, "plugins"));
    mkdirSync(path.join(root, "examples"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
    }
    return root;
}

describe("check-pinned-deps", () => {
    test("passes on this repository", () => {
        const { status, output } = run("check-pinned-deps.mjs", ROOT);
        assert.equal(status, 0, output);
    });

    test("fails on a range, a tag or a wildcard in dependencies, devDependencies and optionalDependencies, and names each", () => {
        const root = project({
            dependencies: { caret: "^1.2.3", tilde: "~1.2.3", exact: "1.2.3" },
            devDependencies: { tag: "latest", star: "*", pre: "1.2.3-beta.1" },
            optionalDependencies: { range: ">=1.0.0" },
        });
        const { status, output } = run("check-pinned-deps.mjs", root);
        assert.equal(status, 1);
        for (const name of [
            "dependencies.caret",
            "dependencies.tilde",
            "devDependencies.tag",
            "devDependencies.star",
        ]) {
            assert.match(output, new RegExp(`package.json: ${name.replace(".", "\\.")} is`), output);
        }
        assert.match(output, /devDependencies\.pre is "1\.2\.3-beta\.1"/);
        assert.match(output, /optionalDependencies\.range is ">=1\.0\.0"/);
        assert.doesNotMatch(output, /dependencies\.exact/);
    });

    test("lets peerDependencies be a range, and reads every package.json below the root", () => {
        const fine = project({ dependencies: { a: "1.0.0" }, peerDependencies: { host: "*" } });
        assert.equal(run("check-pinned-deps.mjs", fine).status, 0);
        const nested = project(
            { dependencies: {} },
            {
                "plugins/x/web/package.json": JSON.stringify({ devDependencies: { vite: "^8.0.0" } }),
                "plugins/x/node_modules/y/package.json": JSON.stringify({ dependencies: { z: "^1" } }),
            },
        );
        const { status, output } = run("check-pinned-deps.mjs", nested);
        assert.equal(status, 1);
        assert.match(output, /plugins\/x\/web\/package\.json: devDependencies\.vite is "\^8\.0\.0"/);
        assert.doesNotMatch(output, /node_modules/);
    });
});

describe("check-runtime-deps", () => {
    const manifest = {
        dependencies: { used: "1.0.0" },
        devDependencies: { tool: "1.0.0" },
        peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
    };

    test("passes on this repository", () => {
        const { status, output } = run("check-runtime-deps.mjs", ROOT);
        assert.equal(status, 0, output);
    });

    test("accepts a dependency, a subpath of one, a Node module with or without node:, and a Pi host package", () => {
        const root = project(manifest, {
            "plugins/p/src/index.ts": [
                'import { readFileSync } from "node:fs";',
                'import path from "path";',
                'import used from "used";',
                'import { x } from "used/sub/path";',
                'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
                'import { local } from "./local.ts";',
                "",
            ].join("\n"),
        });
        const { status, output } = run("check-runtime-deps.mjs", root);
        assert.equal(status, 0, output);
    });

    test("refuses a devDependency, a package that is nowhere, and a scoped subpath, naming the file and the line", () => {
        const root = project(manifest, {
            "plugins/p/src/index.ts": [
                'import used from "used";',
                'import typescript from "tool";',
                'export { thing } from "ghost";',
                'const later = await import("@scope/ghost/sub");',
                "",
            ].join("\n"),
            "examples/e/src/index.ts": 'import "other-ghost";\n',
        });
        const { status, output } = run("check-runtime-deps.mjs", root);
        assert.equal(status, 1);
        assert.match(output, /plugins\/p\/src\/index\.ts:2: imports "tool", a devDependency/);
        assert.match(output, /plugins\/p\/src\/index\.ts:3: imports "ghost", not in the root package\.json at all/);
        assert.match(output, /plugins\/p\/src\/index\.ts:4: imports "@scope\/ghost\/sub"/);
        assert.match(output, /examples\/e\/src\/index\.ts:1: imports "other-ghost"/);
        assert.doesNotMatch(output, /imports "used"/);
    });

    test("does not look at tests, the review page, docs or node_modules, but does look at any other folder of a plugin", () => {
        const root = project(manifest, {
            "plugins/p/test/a.test.ts": 'import "ghost";\n',
            "plugins/p/web/src/main.ts": 'import "ghost";\n',
            "plugins/p/docs/example.ts": 'import "ghost";\n',
            "plugins/p/node_modules/m/index.js": 'import "ghost";\n',
            "plugins/p/broker/broker.mjs": 'import "ghost";\n',
        });
        const { status, output } = run("check-runtime-deps.mjs", root);
        assert.equal(status, 1);
        assert.match(output, /plugins\/p\/broker\/broker\.mjs:1: imports "ghost"/);
        assert.doesNotMatch(output, /plugins\/p\/(test|web|docs|node_modules)/);
    });

    test("refuses a Pi host package listed in dependencies", () => {
        const root = project({
            dependencies: { "@earendil-works/pi-coding-agent": "1.4.0" },
            peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
        });
        const { status, output } = run("check-runtime-deps.mjs", root);
        assert.equal(status, 1);
        assert.match(output, /@earendil-works\/pi-coding-agent is a Pi host package, so it is a peerDependency/);
    });
});
