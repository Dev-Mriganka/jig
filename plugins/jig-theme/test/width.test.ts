import assert from "node:assert/strict";
import { test } from "node:test";
import { cellWidth, clean, fit, plain } from "../src/width.ts";

test("plain text drops escapes, turns control characters into spaces and squeezes spaces", () => {
    assert.equal(plain("a\u001b[31mred\u001b[0m b"), "ared b");
    assert.equal(plain("\u001b]8;;http://x\u0007link\u001b]8;;\u0007"), "link");
    assert.equal(plain("a\tb\nc\u0000d"), "a b c d");
    assert.equal(plain("  spaced   out  "), "spaced out");
    assert.equal(plain(undefined), "");
    assert.equal(plain(null), "");
    assert.equal(plain(42), "42");
    assert.equal(plain("x".repeat(50), 10), "xxxxxxxxxx");
});

test("clean also removes bidirectional controls and lone surrogates", () => {
    assert.equal(clean("a‮b⁦c"), "abc");
    assert.equal(clean("a\ud800b"), "ab");
});

test("a cell is a column: letters one, wide characters and emoji two, marks none", () => {
    assert.equal(cellWidth("abc"), 3);
    assert.equal(cellWidth("日本"), 4);
    assert.equal(cellWidth("é"), 1);
    assert.equal(cellWidth("é"), 1, "a combining mark takes no cell");
    assert.equal(cellWidth("👩‍💻"), 2, "an emoji sequence is one wide cell pair");
    assert.equal(cellWidth("\u001b[31mred\u001b[0m"), 3, "escapes take no cell");
    assert.equal(cellWidth(""), 0);
});

test("fit cuts to the width with an ellipsis in the last cell, and never splits a character", () => {
    assert.equal(fit("hello", 10), "hello");
    assert.equal(fit("hello", 5), "hello");
    assert.equal(fit("hello", 4), "hel…");
    assert.equal(fit("hello", 1), "…");
    assert.equal(fit("hello", 0), "");
    assert.equal(fit("日本語", 5), "日本…");
    assert.equal(fit("日本語", 4), "日…");
    assert.ok(cellWidth(fit("👩‍💻 team", 3)) <= 3);
});
