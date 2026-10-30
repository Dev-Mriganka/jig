// Your palettes on disk: written, rewritten, removed, and left alone when they are not provably this plugin's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { build, derive, themeText } from "../src/build.ts";
import type { PaletteSpec } from "../src/config.ts";
import { PALETTES } from "../src/palettes.ts";
import { syncPalettes } from "../src/write.ts";
import type { KnownTheme } from "../src/write.ts";
import { tempAgentDir } from "./support.ts";

const sea: PaletteSpec = { base: "jig-signal", vars: { accent: "#4FD6BE", heading: "#C099FF" }, colors: { mdCode: "#FFB454" } };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const textOf = (name: string, spec: PaletteSpec) => themeText(build(derive(PALETTES[spec.base]!, spec), name));
const BUILTIN: KnownTheme[] = [{ name: "dark", path: "/pi/dark.json" }, { name: "light", path: "/pi/light.json" }, { name: "system", path: undefined }];

function sync(dir: string, palettes: Record<string, PaletteSpec>, known: KnownTheme[] = BUILTIN) {
    return syncPalettes({ agentDir: dir, palettes, known });
}
const themeFile = (dir: string, name: string) => path.join(dir, "themes", `${name}.json`);
const manifest = (dir: string) => JSON.parse(readFileSync(path.join(dir, "jig-theme", "written.json"), "utf8")) as Record<string, string>;

test("with no palettes and nothing written before, nothing is created", (t) => {
    const dir = tempAgentDir(t);
    const result = sync(dir, {});
    assert.deepEqual(result, { written: [], changed: [], owned: [], removed: [], problems: [] });
    assert.deepEqual(readdirSync(dir), []);
});

test("a new palette is written as a Pi theme named after it, and its hash is recorded", (t) => {
    const dir = tempAgentDir(t);
    const result = sync(dir, { sea });
    assert.deepEqual(result, { written: ["sea"], changed: [], owned: ["sea"], removed: [], problems: [] });
    const text = readFileSync(themeFile(dir, "sea"), "utf8");
    assert.equal(text, textOf("sea", sea));
    const theme = JSON.parse(text) as { name: string; vars: Record<string, string>; colors: Record<string, string> };
    assert.equal(theme.name, "sea");
    assert.equal(theme.vars.accent, "#4FD6BE");
    assert.equal(theme.colors.mdCode, "#FFB454");
    assert.deepEqual(manifest(dir), { sea: sha(text) });
    assert.equal(statSync(themeFile(dir, "sea")).mode & 0o777, 0o644);
    assert.equal(statSync(path.join(dir, "jig-theme", "written.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(path.join(dir, "themes")), ["sea.json"], "no temporary file is left behind");
});

test("a second start with the same palette writes nothing", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea });
    const before = statSync(themeFile(dir, "sea")).mtimeMs;
    const result = sync(dir, { sea });
    assert.deepEqual(result, { written: [], changed: [], owned: ["sea"], removed: [], problems: [] });
    assert.equal(statSync(themeFile(dir, "sea")).mtimeMs, before);
});

test("a changed palette is written over its own file, and said to be a change of a file that existed", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea });
    const next: PaletteSpec = { ...sea, vars: { accent: "#112233" } };
    const result = sync(dir, { sea: next });
    assert.deepEqual(result, { written: ["sea"], changed: ["sea"], owned: ["sea"], removed: [], problems: [] });
    const text = readFileSync(themeFile(dir, "sea"), "utf8");
    assert.equal(text, textOf("sea", next));
    assert.deepEqual(manifest(dir), { sea: sha(text) });
});

test("a file you changed by hand is left as it is, and said", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea });
    writeFileSync(themeFile(dir, "sea"), `${readFileSync(themeFile(dir, "sea"), "utf8")}\n`);
    const mine = readFileSync(themeFile(dir, "sea"), "utf8");
    const result = sync(dir, { sea: { ...sea, vars: { accent: "#112233" } } });
    assert.deepEqual(result.problems, ["themes/sea.json was changed by hand; jig-theme leaves it"]);
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.owned, []);
    assert.equal(readFileSync(themeFile(dir, "sea"), "utf8"), mine);
});

test("a file that is not in the record is not overwritten: you wrote it", (t) => {
    const dir = tempAgentDir(t);
    mkdirSync(path.join(dir, "themes"));
    writeFileSync(themeFile(dir, "sea"), '{"name":"sea","colors":{}}\n');
    const result = sync(dir, { sea });
    assert.deepEqual(result.problems, ["themes/sea.json is not one jig-theme wrote; jig-theme leaves it"]);
    assert.equal(readFileSync(themeFile(dir, "sea"), "utf8"), '{"name":"sea","colors":{}}\n');
    assert.equal(existsSync(path.join(dir, "jig-theme", "written.json")), false, "nothing was written, so nothing is recorded");
});

test("a file that holds exactly what would be written is taken as this plugin's", (t) => {
    const dir = tempAgentDir(t);
    mkdirSync(path.join(dir, "themes"));
    writeFileSync(themeFile(dir, "sea"), textOf("sea", sea));
    const result = sync(dir, { sea });
    assert.deepEqual(result, { written: [], changed: [], owned: ["sea"], removed: [], problems: [] });
    assert.deepEqual(manifest(dir), { sea: sha(textOf("sea", sea)) });
});

test("a palette removed from the config has its file deleted, when the file is still what was written", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea, dusk: { base: "jig-orchid", vars: {}, colors: {} } });
    const result = sync(dir, { dusk: { base: "jig-orchid", vars: {}, colors: {} } });
    assert.deepEqual(result.removed, ["sea"]);
    assert.equal(existsSync(themeFile(dir, "sea")), false);
    assert.equal(existsSync(themeFile(dir, "dusk")), true);
    assert.deepEqual(Object.keys(manifest(dir)), ["dusk"]);
});

test("a removed palette whose file you changed is kept, said once, and no longer tracked", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea });
    writeFileSync(themeFile(dir, "sea"), "{}\n");
    const first = sync(dir, {});
    assert.deepEqual(first.problems, ["themes/sea.json was changed by hand; jig-theme leaves it"]);
    assert.equal(readFileSync(themeFile(dir, "sea"), "utf8"), "{}\n");
    assert.deepEqual(manifest(dir), {}, "the file is yours now");
    assert.deepEqual(sync(dir, {}).problems, [], "so it is not said again");
});

test("a removed palette whose file is already gone is forgotten", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea });
    unlinkSync(themeFile(dir, "sea"));
    const result = sync(dir, {});
    assert.deepEqual(result, { written: [], changed: [], owned: [], removed: [], problems: [] });
    assert.deepEqual(manifest(dir), {});
});

test("a link into your dotfiles is never replaced or deleted", (t) => {
    const dir = tempAgentDir(t);
    const target = path.join(dir, "elsewhere.json");
    writeFileSync(target, "{}\n");
    mkdirSync(path.join(dir, "themes"));
    symlinkSync(target, themeFile(dir, "sea"));
    assert.deepEqual(sync(dir, { sea }).problems, ["themes/sea.json is not a plain file; jig-theme leaves it"]);
    assert.equal(readFileSync(target, "utf8"), "{}\n");
    assert.deepEqual(sync(dir, {}).problems, [], "nothing was recorded, so nothing is deleted or said");
    assert.equal(existsSync(themeFile(dir, "sea")), true);
});

test("a name that another theme has is not taken: a project's theme, or one Pi ships", (t) => {
    const dir = tempAgentDir(t);
    const known: KnownTheme[] = [...BUILTIN, { name: "sea", path: "/project/.pi/themes/sea.json" }];
    const result = sync(dir, { sea }, known);
    assert.deepEqual(result.problems, ['the theme name "sea" is taken by another theme; jig-theme does not write it']);
    assert.equal(existsSync(themeFile(dir, "sea")), false);
    // Its own file, listed under its own path, is not another theme.
    const mine = sync(dir, { sea });
    assert.deepEqual(mine.written, ["sea"]);
    const again = sync(dir, { sea }, [...BUILTIN, { name: "sea", path: themeFile(dir, "sea") }]);
    assert.deepEqual(again, { written: [], changed: [], owned: ["sea"], removed: [], problems: [] });
});

test("a record that cannot be read means no file counts as written, and a new record is made", (t) => {
    const dir = tempAgentDir(t);
    sync(dir, { sea });
    writeFileSync(path.join(dir, "jig-theme", "written.json"), "{not json");
    const before = readFileSync(themeFile(dir, "sea"), "utf8");
    const result = sync(dir, { sea, dusk: { base: "jig-mono", vars: {}, colors: {} } });
    assert.match(result.problems[0] ?? "", /^jig-theme\/written\.json cannot be read/);
    // sea.json holds what would be written, so it is taken again; dusk is new.
    assert.deepEqual(result.owned.sort(), ["dusk", "sea"]);
    assert.equal(readFileSync(themeFile(dir, "sea"), "utf8"), before);
    assert.deepEqual(Object.keys(manifest(dir)).sort(), ["dusk", "sea"]);
});

test("a record that is broken and no palettes: nothing is said and nothing is touched", (t) => {
    const dir = tempAgentDir(t);
    mkdirSync(path.join(dir, "jig-theme"));
    writeFileSync(path.join(dir, "jig-theme", "written.json"), "{not json");
    assert.deepEqual(sync(dir, {}).problems, []);
    assert.equal(readFileSync(path.join(dir, "jig-theme", "written.json"), "utf8"), "{not json");
});

test("a record entry that is not a safe name or a hash is ignored, and never leads out of the themes folder", (t) => {
    const dir = tempAgentDir(t);
    const outside = path.join(dir, "outside.json");
    writeFileSync(outside, "{}\n");
    mkdirSync(path.join(dir, "jig-theme"));
    writeFileSync(
        path.join(dir, "jig-theme", "written.json"),
        JSON.stringify({ "../outside": sha("{}\n"), "sea/../../outside": sha("{}\n"), ok: "not a hash", constructor: sha("x") }),
    );
    const result = sync(dir, {});
    assert.deepEqual(result.removed, []);
    assert.equal(readFileSync(outside, "utf8"), "{}\n");
});

test("a palette called like an object property is an ordinary palette", (t) => {
    const dir = tempAgentDir(t);
    const spec: PaletteSpec = { base: "jig-mono", vars: {}, colors: {} };
    assert.deepEqual(sync(dir, { constructor: spec }).written, ["constructor"]);
    assert.deepEqual(sync(dir, {}).removed, ["constructor"]);
});

test("what is said never holds a colour", (t) => {
    const dir = tempAgentDir(t);
    const loud: PaletteSpec = { base: "jig-lime", vars: { accent: "#ABCDEF" }, colors: { mdCode: "#FEDCBA" } };
    sync(dir, { sea: loud });
    writeFileSync(themeFile(dir, "sea"), "{}\n");
    const said = [...sync(dir, { sea: loud }).problems, ...sync(dir, {}).problems].join("\n");
    assert.match(said, /changed by hand/);
    assert.doesNotMatch(said, /ABCDEF|FEDCBA/i);
});

test("a folder that cannot be written to is a problem in words, not a crash", (t) => {
    const dir = tempAgentDir(t);
    writeFileSync(path.join(dir, "themes"), "a file where the folder should be");
    const result = sync(dir, { sea });
    assert.deepEqual(result.written, []);
    assert.match(result.problems.join("\n"), /themes\/sea\.json could not be written \((EEXIST|ENOTDIR)\)/);
});

test("a palette whose base is not one of the six is skipped, not written", (t) => {
    const dir = tempAgentDir(t);
    const result = sync(dir, { sea: { base: "nope", vars: {}, colors: {} } });
    assert.deepEqual(result.written, []);
    assert.equal(existsSync(themeFile(dir, "sea")), false);
});
