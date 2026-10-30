import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, clipFragment, closedOffMarkers } from "../src/clip.ts";

const MAX = 300;
const json = JSON.stringify({
    accountId: "8a1234",
    requests: Array.from({ length: 12 }, (_, i) => ({ chargeNumber: `C-${i}`, quantity: 3, price: 19.99 })),
});

function clipped(text: string): string {
    const out = clip(text, MAX);
    assert.ok(out.length <= MAX, `${out.length} > ${MAX}`);
    return out;
}

test("short text is unchanged", () => {
    assert.equal(clip("short", MAX), "short");
});

test("plain text is cut at the limit", () => {
    const out = clipped(`start ${"x".repeat(400)}`);
    assert.equal(out.length, MAX);
    assert.ok(out.endsWith("x…"));
});

test("JSON open at the limit is dropped whole and shown as {…} or […]", () => {
    assert.equal(clipped(`Batch request: ${json}`), "Batch request: {…}");
    assert.equal(clipped(`items ${JSON.stringify(JSON.parse(json).requests)}`), "items […]");
    assert.equal(clipped(json), "{…}");
});

test("JSON that closes before the limit is kept", () => {
    const out = clipped(`ok {"success":true} then ${"y".repeat(400)}`);
    assert.ok(out.startsWith('ok {"success":true} then y'));
});

test("JSON serialised into a string once is dropped whole", () => {
    const escaped = JSON.stringify(json).slice(1, -1);
    assert.equal(clipped(`payload=${escaped}`), "payload={…}");
    assert.equal(clipped(`body {"payload":"${escaped}"}`), "body {…}");
});

test("quotes inside strings do not end the string early", () => {
    const value = `5\\" screen ${"z".repeat(400)}`;
    assert.equal(clipped(`desc {"name":"${value}"}`), "desc {…}");
});

test("a quoted key=value open at the limit is dropped whole", () => {
    assert.equal(clipped(`status=ok name="${"Casey Sample ".repeat(30)}"`), "status=ok name=…");
    assert.equal(clipped(`status=ok note='${"a b ".repeat(100)}'`), "status=ok note=…");
});

test("a word at the limit is dropped whole, so phone numbers and escapes are never half shown", () => {
    const phone = clipped(`${"w ".repeat(144)}phone=+1-555-123-4567 more`);
    assert.ok(phone.endsWith("w…"), phone);
    const url = clipped(`${"u ".repeat(100)}GET /v1/x?q=${"%41".repeat(100)}`);
    assert.ok(!/%[0-9A-F]?…$/.test(url), url);
});

test("a cut never splits a surrogate pair", () => {
    assert.equal(clip(`${"a".repeat(70)}😀b`, 72), `${"a".repeat(70)}…`);
});

test("a text that is one long word is cut rather than dropped", () => {
    const out = clipped("x".repeat(500));
    assert.equal(out.length, MAX);
    assert.ok(out.startsWith("xxxx") && out.endsWith("…"));
});

test("a fragment that begins inside a message is judged by what it holds: a JSON segment must close and parse", () => {
    assert.equal(
        clipFragment(`"quantity":3,"price":19.99} tail ${"t ".repeat(100)}`, 60).startsWith('"quantity"'),
        true,
    );
    const open = clipFragment(`before {"id":"a","items":[${"1,".repeat(200)}]} after`, 80);
    assert.ok(open.length <= 80);
    assert.ok(open.endsWith("{…}") || open.endsWith("…"), open);
    assert.ok(!open.includes('"items"'), "the structure is closed off, not left open");
    // A fragment that fits is still checked: its start is the middle of something.
    assert.equal(clipFragment('x {"a":', 80), "x {…}");
    assert.equal(clipFragment("plain text", 80), "plain text");
});

test("the markers say whether an object or a list was closed off", () => {
    assert.deepEqual(closedOffMarkers("a {…} b"), { object: true, array: false });
    assert.deepEqual(closedOffMarkers("items […]"), { object: false, array: true });
    assert.deepEqual(closedOffMarkers("plain…"), { object: false, array: false });
});
