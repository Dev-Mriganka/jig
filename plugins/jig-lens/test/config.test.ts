import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, settingsFrom, validateLens } from "../src/config.ts";

test("a section with no fields, or with its port set correctly, is valid", () => {
    assert.deepEqual(validateLens({}), []);
    assert.deepEqual(validateLens({ port: 3300 }), []);
    assert.deepEqual(validateLens({ port: 8001 }), []);
    assert.deepEqual(validateLens({ port: 1 }), []);
    assert.deepEqual(validateLens({ port: 65535 }), []);
});

test("a misspelt field is an error that names it, not a silent default", () => {
    assert.deepEqual(validateLens({ prot: 3300 }), ["lens.prot: unknown field"]);
});

test("the section must be an object", () => {
    for (const raw of [null, "lens", [3300], 3]) {
        assert.deepEqual(validateLens(raw), ["lens: must be an object"], JSON.stringify(raw));
    }
});

test("viewer was a setting once: it is refused, and the error says what chooses the viewer now", () => {
    for (const viewer of ["grafana", "datasette", "metabase", 3]) {
        assert.deepEqual(
            validateLens({ viewer }),
            ["lens.viewer: removed, because /lens grafana and /lens datasette choose the viewer; delete it"],
            String(viewer),
        );
    }
});

test("port is a whole number from 1 to 65535, and the error names the key", () => {
    for (const port of [0, 65536, -1, 3300.5, "3300", null, Number.NaN]) {
        assert.deepEqual(validateLens({ port }), ["lens.port: must be a whole number from 1 to 65535"], String(port));
    }
});

test("every mistake is reported, not only the first", () => {
    assert.equal(validateLens({ viewer: "x", port: 0, extra: 1 }).length, 3);
});

test("the settings are the default for what is missing, absent or wrong", () => {
    assert.deepEqual(DEFAULT_SETTINGS, { port: 3300 });
    assert.deepEqual(settingsFrom(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom(null), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom({}), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom({ port: 4000 }), { port: 4000 });
    assert.deepEqual(settingsFrom({ port: "x" }), DEFAULT_SETTINGS);
});

test("settings carry nothing but the port", () => {
    assert.deepEqual(settingsFrom({ port: 4000, viewer: "datasette" }), { port: 4000 });
});
