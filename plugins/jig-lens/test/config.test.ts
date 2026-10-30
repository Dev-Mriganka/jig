import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, settingsFrom, validateLens } from "../src/config.ts";

test("a section with no fields, or with its fields set correctly, is valid", () => {
    assert.deepEqual(validateLens({}), []);
    assert.deepEqual(validateLens({ viewer: "grafana", port: 3300 }), []);
    assert.deepEqual(validateLens({ viewer: "datasette", port: 8001 }), []);
    assert.deepEqual(validateLens({ port: 1 }), []);
    assert.deepEqual(validateLens({ port: 65535 }), []);
});

test("a misspelt field is an error that names it, not a silent default", () => {
    assert.deepEqual(validateLens({ viewr: "grafana" }), ["lens.viewr: unknown field"]);
});

test("the section must be an object", () => {
    for (const raw of [null, "lens", ["grafana"], 3]) {
        assert.deepEqual(validateLens(raw), ["lens: must be an object"], JSON.stringify(raw));
    }
});

test("viewer is grafana or datasette, and the error names the key", () => {
    assert.deepEqual(validateLens({ viewer: "metabase" }), [`lens.viewer: must be "grafana" or "datasette"`]);
    assert.deepEqual(validateLens({ viewer: 3 }), [`lens.viewer: must be "grafana" or "datasette"`]);
});

test("port is a whole number from 1 to 65535, and the error names the key", () => {
    for (const port of [0, 65536, -1, 3300.5, "3300", null, Number.NaN]) {
        assert.deepEqual(validateLens({ port }), ["lens.port: must be a whole number from 1 to 65535"], String(port));
    }
});

test("every mistake is reported, not only the first", () => {
    assert.equal(validateLens({ viewer: "x", port: 0, extra: 1 }).length, 3);
});

test("the settings are the defaults for what is missing, absent or wrong", () => {
    assert.deepEqual(DEFAULT_SETTINGS, { viewer: "grafana", port: 3300 });
    assert.deepEqual(settingsFrom(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom(null), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom({}), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom({ port: 4000 }), { viewer: "grafana", port: 4000 });
    assert.deepEqual(settingsFrom({ viewer: "datasette" }), { viewer: "datasette", port: 3300 });
    assert.deepEqual(settingsFrom({ viewer: "nope", port: "x" }), DEFAULT_SETTINGS);
});
