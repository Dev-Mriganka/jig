import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL, isObject, plural, printable, refuse, shown } from "../src/values.ts";

test("refuse throws a TypeError with the message as it is", () => {
    assert.throws(() => refuse("logs: no"), new TypeError("logs: no"));
});

test("control characters are the C0 and C1 ranges and the Unicode line separators", () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f, 0x2028, 0x2029]) {
        assert.ok(CONTROL.test(String.fromCharCode(code)), code.toString(16));
    }
    for (const text of ["a", " ", "~", " ", "é", "中", "\u{1F600}"]) assert.ok(!CONTROL.test(text), text);
});

test("shown quotes and shortens text, and says what a list or an object is", () => {
    assert.equal(shown("9d"), '"9d"');
    assert.equal(shown(""), '""');
    assert.equal(shown(5), "5");
    assert.equal(shown(undefined), "undefined");
    assert.equal(shown(["a"]), "a list");
    assert.equal(shown({ a: 1 }), "an object");
    assert.equal(shown("x".repeat(100)), `"${"x".repeat(40)}..."`);
});

test("shown and printable leave no control character in what they return", () => {
    const hostile = "a\u001b[31mb\u009b2Jc d\ne";
    for (const text of [shown(hostile), printable(hostile)]) assert.ok(!CONTROL.test(text), JSON.stringify(text));
    assert.equal(printable("bad\nname"), "bad?name");
    assert.equal(printable("a\u001b\u001b[b"), "a?[b", "a run of them is one mark");
    assert.equal(printable("x".repeat(50)), `${"x".repeat(40)}...`);
});

test("plural and isObject", () => {
    assert.equal(plural(1, "hit"), "1 hit");
    assert.equal(plural(0, "hit"), "0 hits");
    assert.equal(plural(2, "bucket"), "2 buckets");
    assert.ok(isObject({}) && isObject(Object.create(null)));
    assert.ok(!isObject(null) && !isObject([]) && !isObject("a") && !isObject(undefined));
});
