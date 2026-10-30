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

test("it reaches jig-core only through its client and contract, the way plugins are meant to", () => {
    const allowed = new Set(["client.ts", "contract.ts"]);
    let found = 0;
    for (const name of readdirSync(SRC)) {
        for (const match of readFileSync(path.join(SRC, name), "utf8").matchAll(
            /from "(\.\.\/\.\.\/jig-core\/[^"]+)"/g,
        )) {
            found++;
            assert.ok(allowed.has(path.basename(match[1] ?? "")), `${name} imports ${match[1]}`);
        }
    }
    assert.ok(found >= 1, "and it does use the client");
});

test("it needs nothing that is not in Node or Pi: no package of its own", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    // The packages of the repository are jig-api's `yaml` and jig-mongo's driver, which no other plugin imports (checked below).
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["mongodb", "yaml"]);
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

test("Pi is imported for its types only, except by display.ts, which draws with pi-tui's Box and Text", () => {
    let drawing = 0;
    for (const name of readdirSync(SRC)) {
        for (const line of readFileSync(path.join(SRC, name), "utf8").split("\n")) {
            if (!line.includes("@earendil-works/") || line.startsWith("import type ")) continue;
            assert.equal(name, "display.ts", `${name}: ${line}`);
            assert.match(line, /^import \{ Box, Text \} from "@earendil-works\/pi-tui";$/);
            drawing++;
        }
    }
    assert.equal(drawing, 1);
});

test("nothing but the entry and display modules reaches pi-tui, so the rest loads without any of Pi", () => {
    const importers = readdirSync(SRC).filter((name) =>
        /from "@earendil-works\/pi-tui"/.test(readFileSync(path.join(SRC, name), "utf8")),
    );
    assert.deepEqual(importers, ["display.ts"]);
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
