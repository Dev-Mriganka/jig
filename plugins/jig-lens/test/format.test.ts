// The units and columns the summary is written in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, clean, clip, duration, label, money, percent, plural, table, tokens } from "../src/format.ts";

test("money has two decimals, and four under a cent so that a cheap turn is not free", () => {
    assert.equal(money(0), "$0.00");
    assert.equal(money(1.234), "$1.23");
    assert.equal(money(0.07), "$0.07");
    assert.equal(money(0.01), "$0.01");
    assert.equal(money(0.0042), "$0.0042");
    assert.equal(money(0.00001), "$0.0000", "below a hundredth of a cent it is shown as nothing, not hidden");
    assert.equal(money(12.5), "$12.50");
    assert.equal(money(1234.567), "$1234.57");
});

test("tokens are counted in thousands and millions, with one decimal until three digits", () => {
    assert.equal(tokens(0), "0");
    assert.equal(tokens(850), "850");
    assert.equal(tokens(999), "999");
    assert.equal(tokens(1000), "1.0k");
    assert.equal(tokens(12_345), "12.3k");
    assert.equal(tokens(99_949), "99.9k");
    assert.equal(tokens(99_950), "100k");
    assert.equal(tokens(123_456), "123k");
    assert.equal(tokens(999_499), "999k");
    assert.equal(tokens(999_500), "1.0M", "never 1000k");
    assert.equal(tokens(1_234_567), "1.2M");
    assert.equal(tokens(123_456_789), "123M");
});

test("durations read as a person says them: ms, seconds, minutes and seconds, hours and minutes", () => {
    assert.equal(duration(0), "0ms");
    assert.equal(duration(850), "850ms");
    assert.equal(duration(999.6), "1.0s", "rounds up to a second, not to 1000ms");
    assert.equal(duration(1000), "1.0s");
    assert.equal(duration(4200), "4.2s");
    assert.equal(duration(9949), "9.9s");
    assert.equal(duration(9950), "10s", "never 10.0s");
    assert.equal(duration(12_000), "12s");
    assert.equal(duration(59_400), "59s");
    assert.equal(duration(59_600), "1m", "never 60s");
    assert.equal(duration(60_000), "1m");
    assert.equal(duration(250_000), "4m 10s");
    assert.equal(duration(3_599_000), "59m 59s");
    assert.equal(duration(3_600_000), "1h");
    assert.equal(duration(3_900_000), "1h 5m");
    assert.equal(duration(90_000_000), "25h");
});

test("a percentage is a whole number, and nothing over nothing is 0%", () => {
    assert.equal(percent(91, 100), "91%");
    assert.equal(percent(12_000, 13_000), "92%");
    assert.equal(percent(1, 3), "33%");
    assert.equal(percent(0, 5), "0%");
    assert.equal(percent(5, 0), "0%");
});

test("how long ago is counted in the largest unit that fits", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const at = (secondsBefore: number) => now.getTime() / 1000 - secondsBefore;
    assert.equal(ago(at(-30), now), "just now", "a clock a little ahead is not a negative age");
    assert.equal(ago(at(0), now), "just now");
    assert.equal(ago(at(45), now), "45s ago");
    assert.equal(ago(at(12 * 60), now), "12m ago");
    assert.equal(ago(at(3 * 3600 + 59), now), "3h ago");
    assert.equal(ago(at(47 * 3600), now), "47h ago");
    assert.equal(ago(at(48 * 3600), now), "2d ago");
});

test("plural counts one of a thing and several", () => {
    assert.equal(plural(0, "call"), "0 calls");
    assert.equal(plural(1, "call"), "1 call");
    assert.equal(plural(2, "call"), "2 calls");
    assert.equal(plural(1, "index", "indexes"), "1 index");
    assert.equal(plural(2, "index", "indexes"), "2 indexes");
});

test("text from the records cannot move the cursor or reorder a line: control characters become ?", () => {
    assert.equal(clean("bash"), "bash");
    assert.equal(clean("a\u001b[31mred\u001b[0m"), "a?[31mred?[0m", "an escape sequence is not passed on");
    assert.equal(clean("tab\there\nnew"), "tab?here?new");
    assert.equal(clean("c1\u009bcode"), "c1?code");
    assert.equal(clean("evil‮txt"), "evil?txt", "a right-to-left override would reorder what follows");
    assert.equal(clean("PROJ-12 über"), "PROJ-12 über", "ordinary letters stay");
});

test("a long name is cut with an ellipsis, and a short one is left alone", () => {
    assert.equal(clip("short", 10), "short");
    assert.equal(clip("exactly-ten", 11), "exactly-ten");
    assert.equal(clip("twelve chars", 8), "twelve …");
    assert.equal(label("x".repeat(40)), `${"x".repeat(27)}…`, "28 characters by default");
    assert.equal(label("a\u001bb", 5), "a?b");
});

test("a table lines its columns up, and pads no further than the last column", () => {
    assert.deepEqual(
        table([
            ["bash", "5 of 40", "tool 4"],
            ["git push", "12 of 100", "tool 12"],
        ]),
        ["bash      5 of 40    tool 4", "git push  12 of 100  tool 12"],
    );
});

test("numbers can be right-aligned, and so can the last column", () => {
    assert.deepEqual(
        table(
            [
                ["a", "$1.00"],
                ["bb", "$12.50"],
            ],
            [1],
        ),
        ["a    $1.00", "bb  $12.50"],
    );
});

test("short rows and empty cells are allowed, and trailing space is trimmed", () => {
    assert.deepEqual(
        table([
            ["by model", "model-a", "$0.07"],
            ["", "model-b"],
            ["", "", ""],
        ]),
        ["by model  model-a  $0.07", "          model-b", ""],
    );
    assert.deepEqual(table([]), []);
});
