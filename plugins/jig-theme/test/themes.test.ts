// The committed theme files: they are what the builder makes now, they have every role Pi's schema requires and no key it
// does not know, and Pi's own validator accepts them.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { piHostDir } from "../../../test/support/pi-host-dir.mjs";
import { build, themeText } from "../src/build.ts";
import { PALETTE_NAMES, PALETTES } from "../src/palettes.ts";
import { BACKGROUND_ROLES, ROLES } from "../src/roles.ts";

const THEMES = path.resolve(import.meta.dirname, "../themes");

/** Pi's schema of a theme file, read from the Pi these tests run in. */
const schema = JSON.parse(readFileSync(path.join(piHostDir, "schemas/theme.schema.json"), "utf8")) as {
    required: string[];
    properties: { colors: { required: string[]; properties: Record<string, unknown> }; export: { properties: Record<string, unknown> } } & Record<string, unknown>;
};

test("the themes folder has the six palettes and nothing else", () => {
    assert.deepEqual(readdirSync(THEMES).sort(), PALETTE_NAMES.map((name) => `${name}.json`).sort());
});

test("each committed file is what the builder makes now: run scripts/build-themes.ts after a change", () => {
    for (const [name, palette] of Object.entries(PALETTES)) {
        const committed = readFileSync(path.join(THEMES, `${name}.json`), "utf8");
        assert.equal(committed, themeText(build(palette, name)), `${name}.json is out of date`);
    }
});

test("the role list is Pi's: the same roles, with the same ones required", () => {
    const known = Object.keys(schema.properties.colors.properties);
    assert.deepEqual([...ROLES].sort(), known.sort(), "a Pi release added or removed a role");
    assert.equal(schema.properties.colors.required.length, 51);
    assert.ok(BACKGROUND_ROLES.every((role) => ROLES.includes(role)));
});

test("each file has every role the schema requires, no key it does not know, and its name", () => {
    const topLevel = Object.keys(schema.properties);
    const known = Object.keys(schema.properties.colors.properties);
    for (const name of PALETTE_NAMES) {
        const theme = JSON.parse(readFileSync(path.join(THEMES, `${name}.json`), "utf8")) as Record<string, Record<string, unknown>>;
        for (const key of Object.keys(theme)) assert.ok(topLevel.includes(key), `${name}: unknown key ${key}`);
        for (const key of schema.required) assert.ok(key in theme, `${name}: missing ${key}`);
        assert.equal(theme.name, name);
        const colors = theme.colors as Record<string, unknown>;
        for (const role of schema.properties.colors.required) assert.ok(role in colors, `${name}: missing role ${role}`);
        for (const role of Object.keys(colors)) assert.ok(known.includes(role), `${name}: unknown role ${role}`);
        for (const key of Object.keys(theme.export as object)) {
            assert.ok(key in schema.properties.export.properties, `${name}: unknown export key ${key}`);
        }
    }
});

test("Pi's own validator accepts every file", async () => {
    const { validateThemeJson } = (await import(
        pathToFileURL(path.join(piHostDir, "dist/modes/interactive/theme/theme-schema.js")).href
    )) as { validateThemeJson(label: string, json: unknown): unknown };
    for (const name of PALETTE_NAMES) {
        const json = JSON.parse(readFileSync(path.join(THEMES, `${name}.json`), "utf8")) as unknown;
        assert.doesNotThrow(() => validateThemeJson(name, json), name);
    }
});

test("Pi's validator refuses what the builder must never write: an unknown role or a missing one", async () => {
    const { validateThemeJson } = (await import(
        pathToFileURL(path.join(piHostDir, "dist/modes/interactive/theme/theme-schema.js")).href
    )) as { validateThemeJson(label: string, json: unknown): unknown };
    const theme = build(PALETTES["jig-lime"]!, "probe") as unknown as { colors: Record<string, unknown> };
    assert.throws(() => validateThemeJson("probe", { ...theme, colors: { ...theme.colors, notARole: "#fff" } }));
    const { accent: _accent, ...fewer } = theme.colors;
    assert.throws(() => validateThemeJson("probe", { ...theme, colors: fewer }));
});
