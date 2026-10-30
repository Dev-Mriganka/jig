// The plugin as Pi loads it: the entry, what it registers, what it is allowed to import, and where it is listed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import factory, { lens } from "../src/index.ts";
import { ownViewerDir } from "../src/paths.ts";
import { FakePi } from "./support.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SRC = path.resolve(import.meta.dirname, "../src");

test("the default export is the factory Pi loads, and it only registers", () => {
    assert.equal(typeof factory, "function");
    const pi = new FakePi();
    factory(pi.api);
    assert.deepEqual([...pi.commands.keys()], ["lens"]);
    assert.deepEqual([...pi.handlers.keys()], ["agent_end"]);
    assert.deepEqual([...pi.renderers.keys()], ["jig-lens-summary"]);
    assert.deepEqual([pi.notices, pi.entries, pi.sent], [[], [], []]);
});

test("lens() makes a factory that registers the command, the import and the renderer of the summary", () => {
    const pi = new FakePi();
    lens()(pi.api);
    assert.deepEqual([...pi.commands.keys()], ["lens"]);
    assert.deepEqual([...pi.handlers.keys()], ["agent_end"]);
    assert.deepEqual([...pi.renderers.keys()], ["jig-lens-summary"]);
});

test("the extension is listed in the package, after jig-core, and every listed file exists", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        pi: { extensions: string[] };
    };
    const listed = manifest.pi.extensions;
    assert.ok(listed.includes("./plugins/jig-lens/src/index.ts"));
    assert.ok(listed.indexOf("./plugins/jig-core/src/index.ts") < listed.indexOf("./plugins/jig-lens/src/index.ts"));
    for (const extension of listed) assert.ok(existsSync(path.join(ROOT, extension)), extension);
});

test("the viewer files are found beside the source", () => {
    const viewer = ownViewerDir();
    assert.equal(viewer, path.resolve(SRC, "../viewer"));
    for (const file of [
        "grafana/provisioning/datasources/jig.yaml",
        "grafana/provisioning/dashboards/jig.yaml",
        "datasette/metadata.json",
    ]) {
        assert.ok(existsSync(path.join(viewer, file)), file);
    }
});

test("it reaches jig-core only through its client, contract and kit, the way plugins are meant to", () => {
    const allowed = new Set(["client.ts", "contract.ts"]);
    let found = 0;
    for (const name of readdirSync(SRC)) {
        for (const match of readFileSync(path.join(SRC, name), "utf8").matchAll(
            /from "(\.\.\/\.\.\/jig-core\/[^"]+)"/g,
        )) {
            found++;
            const target = match[1] ?? "";
            assert.ok(
                allowed.has(path.basename(target)) || /\/jig-core\/src\/kit\/[a-z-]+\.ts$/.test(target),
                `${name} imports ${target}`,
            );
        }
    }
    assert.ok(found >= 1, "and it does use the client");
});

test("it needs nothing that is not in Node or Pi: no package of its own", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
    };
    // The packages of the repository are jig-api's `yaml`, jig-review's `hono`, `@hono/node-server` and `ignore`, and
    // jig-mongo's driver, and jig-sandbox's runtime; no other plugin imports them (checked below).
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
        "@anthropic-ai/sandbox-runtime",
        "@hono/node-server",
        "hono",
        "ignore",
        "mongodb",
        "socks",
        "yaml",
    ]);
    for (const name of readdirSync(SRC)) {
        for (const match of readFileSync(path.join(SRC, name), "utf8").matchAll(
            /^import (?:type )?(?:[^"]+ from )?"([^"]+)"/gm,
        )) {
            const source = match[1] ?? "";
            const fine =
                source.startsWith("node:") ||
                source.startsWith("./") ||
                source.startsWith("../../jig-core/") ||
                source === "@earendil-works/pi-coding-agent" ||
                source === "@earendil-works/pi-tui";
            assert.ok(fine, `${name} imports ${source}`);
        }
    }
});

test("Pi is imported for its types only, except by display.ts, which draws with pi-tui's Box and Text, and usage-dashboard.ts, which reads keys", () => {
    const drawing: Record<string, string[]> = {};
    for (const name of readdirSync(SRC)) {
        for (const line of readFileSync(path.join(SRC, name), "utf8").split("\n")) {
            if (!line.includes("@earendil-works/") || line.startsWith("import type ")) continue;
            (drawing[name] ??= []).push(line);
        }
    }
    assert.deepEqual(drawing, {
        "display.ts": ['import { Box, Text } from "@earendil-works/pi-tui";'],
        "usage-dashboard.ts": ['import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";'],
    });
});

test("nothing but display.ts and the usage view reaches pi-tui, and the view is loaded only when /lens usage runs", () => {
    const importers = readdirSync(SRC).filter((name) =>
        /from "@earendil-works\/pi-tui"/.test(readFileSync(path.join(SRC, name), "utf8")),
    );
    assert.deepEqual(importers, ["display.ts", "usage-dashboard.ts"]);
    // So the rest of the plugin loads without any of Pi: the view is imported when the command runs, and nowhere else.
    for (const name of readdirSync(SRC)) {
        const text = readFileSync(path.join(SRC, name), "utf8");
        assert.doesNotMatch(text, /^import [^\n]*"\.\/usage-dashboard\.ts"/m, `${name} imports the view at load`);
    }
    assert.match(readFileSync(path.join(SRC, "lens.ts"), "utf8"), /await import\("\.\/usage-dashboard\.ts"\)/);
});

test("the importer only opens record files for reading", () => {
    // Every other write of the plugin is to the index, the viewer's log or the folders under the lens folder.
    const text = readFileSync(path.join(SRC, "import.ts"), "utf8");
    assert.match(text, /openSync\(join\(folder, name\), "r"\)/);
    assert.doesNotMatch(
        text,
        /writeFileSync|appendFileSync|writeSync|unlinkSync|rmSync|renameSync|truncateSync|chmodSync/,
    );
});
