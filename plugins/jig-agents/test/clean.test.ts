// Text from a child is cleaned before it is shown: escape sequences, control characters and look-alike tricks go; line breaks stay.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { oneLine, shaped, stripControl, tailLines } from "../src/clean.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("stripControl", () => {
    test("removes colour, cursor and screen codes", () => {
        assert.equal(stripControl(`${ESC}[31mred${ESC}[0m plain`), "red plain");
        assert.equal(stripControl(`a${ESC}[2Jb${ESC}[10;20Hc`), "abc");
        assert.equal(stripControl(`${ESC}[?25lhidden${ESC}[?25h`), "hidden");
    });

    test("removes window titles, hyperlinks and string sequences up to their terminator, or to the end when there is none", () => {
        assert.equal(stripControl(`x${ESC}]0;title${BEL}y`), "xy");
        assert.equal(stripControl(`x${ESC}]8;;http://example.com${ESC}\\link${ESC}]8;;${ESC}\\y`), "xlinky");
        assert.equal(stripControl(`x${ESC}Pdevice control${ESC}\\y`), "xy");
        assert.equal(stripControl(`keep${ESC}]0;never ends`), "keep");
    });

    test("removes the 8-bit forms and other controls, and a lone escape", () => {
        assert.equal(stripControl(`a${String.fromCharCode(0x9b)}31mb`), "ab");
        assert.equal(
            stripControl(`a${String.fromCharCode(0)}${String.fromCharCode(8)}${String.fromCharCode(127)}b`),
            "ab",
        );
        assert.equal(stripControl(`a${ESC}b`), "a");
        assert.equal(stripControl(`a${ESC}`), "a");
    });

    test("turns carriage returns and Unicode line separators into line breaks, so a line cannot be redrawn", () => {
        assert.equal(stripControl("fake header\rreal text"), "fake header\nreal text");
        assert.equal(stripControl("a\r\nb"), "a\nb");
        assert.equal(stripControl(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`), "a\nb\nc");
    });

    test("removes bidirectional overrides and zero-width marks that can reorder or hide words, and turns tabs into spaces", () => {
        assert.equal(
            stripControl(
                `ab${String.fromCharCode(0x202e)}cd${String.fromCharCode(0x200b)}e${String.fromCharCode(0xfeff)}`,
            ),
            "abcde",
        );
        assert.equal(stripControl("a\tb"), "a b");
    });

    test("leaves ordinary text, including accents and emoji, alone", () => {
        assert.equal(
            stripControl("Zażółć gęślą jaźń 日本語 🙂\nsecond line"),
            "Zażółć gęślą jaźń 日本語 🙂\nsecond line",
        );
    });
});

describe("oneLine, shaped and tailLines", () => {
    test("oneLine folds to one line and cuts with dots", () => {
        assert.equal(oneLine("a\n  b\t c"), "a b c");
        assert.equal(oneLine("x".repeat(30), 10), "xxxxxxx...");
    });

    test("shaped indents every line, cuts each, and says how many lines it left out", () => {
        const text = ["one", "two", "x".repeat(50), "four"].join("\n");
        assert.equal(
            shaped(text, { indent: "> ", maxLines: 3, maxLineChars: 10 }),
            ["> one", "> two", "> xxxxxxx...", "> (1 more line not shown)"].join("\n"),
        );
        assert.equal(shaped("a\n\n\n"), "a");
        assert.equal(shaped("a\nb\nc", { maxLines: 1 }), "a\n(2 more lines not shown)");
    });

    test("tailLines gives the last non-empty lines", () => {
        assert.deepEqual(tailLines("a\n\nb\nc\nd\n", 2), ["c", "d"]);
        assert.deepEqual(tailLines(`${ESC}[31mred${ESC}[0m\nx`, 5), ["red", "x"]);
    });
});
