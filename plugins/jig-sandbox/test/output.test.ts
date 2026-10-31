// Cleaning a command's output: control sequences out, credential values replaced, chunks cut anywhere.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createOutputCleaner } from "../src/output.ts";

const ESC = "\u001b";

/** Everything the cleaner shows for these chunks, and the pieces as they came. */
function run(chunks: Array<string | Buffer>, values: string[] = []): { all: string; pieces: string[] } {
    const cleaner = createOutputCleaner(values);
    const pieces = chunks.map((chunk) => cleaner.push(Buffer.from(chunk)).toString("utf8"));
    pieces.push(cleaner.end().toString("utf8"));
    return { all: pieces.join(""), pieces };
}

describe("control sequences", () => {
    test("colours, cursor moves and the window title are removed, the text stays", () => {
        assert.equal(run([`${ESC}[31mred${ESC}[0m plain ${ESC}[2J${ESC}[1;1H done`]).all, "red plain  done");
        assert.equal(run([`${ESC}]0;evil title\u0007after`]).all, "after");
        assert.equal(run([`${ESC}]52;c;ZXZpbA==${ESC}\\after`]).all, "after");
        assert.equal(run([`${ESC}Pq data${ESC}\\after`]).all, "after");
        assert.equal(run([`a${ESC}7b${ESC}8c`]).all, "abc");
        assert.equal(run(["a\u009b31mb"]).all, "ab");
    });

    test("a sequence cut between two chunks is still removed", () => {
        const { all, pieces } = run([`ab${ESC}`, "[3", "1mcd", `${ESC}]0;ti`, "tle\u0007ef"]);
        assert.equal(all, "abcdef");
        assert.ok(pieces.every((piece) => !piece.includes(ESC)));
    });

    test("tab, newline and carriage return stay; other control characters go", () => {
        assert.equal(run(["a\tb\r\nc\u0000d\u0007e\u0008f\u007fg"]).all, "a\tb\r\ncdefg");
    });

    test("a lone escape, and a sequence that never ends, do not swallow the output", () => {
        assert.equal(run([`a${ESC}`]).all, "a");
        assert.equal(run([`b${ESC}[31`]).all, "b");
        assert.equal(
            run([`${ESC}[31`, "\u0001 text"]).all,
            "[31 text",
            "garbage that cannot be a sequence is not held for ever",
        );
    });

    test("text outside sequences, with accents and emoji, is untouched whatever the chunks", () => {
        const text = "héllo wörld 日本語 😀 ok";
        const bytes = Buffer.from(text);
        const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9, 20), bytes.subarray(20)];
        assert.equal(run(chunks).all, text);
    });
});

describe("credential values", () => {
    const value = "ghs_0123456789abcdef";

    test("a value in the output is replaced", () => {
        assert.equal(run([`token is ${value}!`], [value]).all, "token is [redacted]!");
        assert.equal(run([`${value} ${value}`], [value]).all, "[redacted] [redacted]");
    });

    test("a value cut between chunks is replaced, and nothing of it is shown before", () => {
        const { all, pieces } = run(["token is ghs_0123", "456789abcdef and more"], [value]);
        assert.equal(all, "token is [redacted] and more");
        assert.ok(pieces.every((piece) => !piece.includes("ghs_")));
    });

    test("the start of a value at the very end waits, and is shown at the end if it was not one", () => {
        const { all, pieces } = run(["almost ghs_0123"], [value]);
        assert.equal(pieces[0], "almost ");
        assert.equal(all, "almost ghs_0123");
    });

    test("the longest value wins when one holds another", () => {
        assert.equal(
            run(
                ["abcdefgh12345678"],
                ["abcdefgh", "abcdefgh12345678"].sort((a, b) => b.length - a.length),
            ).all,
            "[redacted]",
        );
    });

    test("with no values, nothing is held back", () => {
        assert.equal(run(["plain "]).pieces[0], "plain ");
    });
});
