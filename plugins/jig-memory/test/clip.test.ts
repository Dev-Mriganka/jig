import assert from "node:assert/strict";
import { test } from "node:test";
import { clipBytes } from "../src/clip.ts";

test("text that fits is returned as it is", () => {
    assert.equal(clipBytes("short", 10, "[cut]"), "short");
    assert.equal(clipBytes("exactly 10", 10, "[cut]"), "exactly 10");
});

test("a cut keeps the start and ends with the note, and the note counts toward the limit", () => {
    const clipped = clipBytes("a".repeat(100), 20, "[cut]");
    assert.equal(clipped, `${"a".repeat(15)}[cut]`);
    assert.ok(Buffer.byteLength(clipped) <= 20);
});

test("a cut never splits a character: a two-byte letter is kept whole or not at all", () => {
    const clipped = clipBytes("é".repeat(50), 11, "~");
    assert.equal(clipped, "ééééé~");
    assert.ok(Buffer.byteLength(clipped) <= 11);
    assert.doesNotMatch(clipped, /�/);
});
