import assert from "node:assert/strict";
import { test } from "node:test";
import { CborError, decodeCbor, decodeCborExactly } from "../src/passkey/cbor.ts";
import { encodeCbor } from "./support/authenticator.ts";

const hex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.replaceAll(" ", ""), "hex"));

test("decodes integers, strings, arrays and maps (RFC 8949 appendix A examples)", () => {
    assert.equal(decodeCborExactly(hex("00")), 0);
    assert.equal(decodeCborExactly(hex("17")), 23);
    assert.equal(decodeCborExactly(hex("18 18")), 24);
    assert.equal(decodeCborExactly(hex("19 03e8")), 1000);
    assert.equal(decodeCborExactly(hex("1a 000f4240")), 1_000_000);
    assert.equal(decodeCborExactly(hex("20")), -1);
    assert.equal(decodeCborExactly(hex("38 63")), -100);
    assert.equal(decodeCborExactly(hex("26")), -7, "the COSE key's ES256");
    assert.equal(decodeCborExactly(hex("39 0100")), -257, "the COSE key's RS256");
    assert.equal(decodeCborExactly(hex("63 616263")), "abc");
    assert.deepEqual(decodeCborExactly(hex("44 01020304")), Uint8Array.from([1, 2, 3, 4]));
    assert.deepEqual(decodeCborExactly(hex("83 01 02 03")), [1, 2, 3]);
    assert.deepEqual(
        [...(decodeCborExactly(hex("a2 01 02 03 04")) as Map<number, number>)],
        [
            [1, 2],
            [3, 4],
        ],
    );
    assert.equal(decodeCborExactly(hex("f4")), false);
    assert.equal(decodeCborExactly(hex("f5")), true);
    assert.equal(decodeCborExactly(hex("f6")), null);
    assert.equal(decodeCborExactly(hex("f7")), undefined);
});

test("round-trips what the fake authenticator encodes, with text and integer keys", () => {
    const value = decodeCborExactly(
        encodeCbor({
            map: [
                ["fmt", "none"],
                [-2, Buffer.from("xy")],
                [3, [1, -1, "z"]],
            ],
        }),
    ) as Map<string | number, unknown>;
    assert.equal(value.get("fmt"), "none");
    assert.deepEqual(value.get(-2), Uint8Array.from(Buffer.from("xy")));
    assert.deepEqual(value.get(3), [1, -1, "z"]);
});

test("reports where a value ends, so the bytes after it can be read", () => {
    const bytes = Buffer.concat([encodeCbor({ map: [[1, 2]] }), Buffer.from("rest")]);
    assert.equal(decodeCbor(bytes).end, 3);
    assert.throws(() => decodeCborExactly(bytes), CborError);
});

test("refuses what an authenticator never sends: tags, floats, indefinite lengths, odd map keys, repeated keys", () => {
    assert.throws(() => decodeCborExactly(hex("c1 1a514b67b0")), /tags/);
    assert.throws(() => decodeCborExactly(hex("fb 3ff199999999999a")), /floats/);
    assert.throws(() => decodeCborExactly(hex("9f 01 02 ff")), /indefinite/);
    assert.throws(() => decodeCborExactly(hex("5f 41 01 ff")), /indefinite/);
    assert.throws(() => decodeCborExactly(hex("a1 41 01 02")), /integer or text/, "a byte-string key");
    assert.throws(() => decodeCborExactly(hex("a2 01 02 01 03")), /repeats a key/);
});

test("refuses truncated data, huge lengths and bad text without reading past the end", () => {
    assert.throws(() => decodeCborExactly(hex("44 010203")), /past the end/);
    assert.throws(() => decodeCborExactly(hex("19 03")), /past the end/);
    assert.throws(() => decodeCborExactly(hex("5a ffffffff 00")), /past the end/);
    assert.throws(() => decodeCborExactly(hex("9a ffffffff")), /longer than its data/);
    assert.throws(() => decodeCborExactly(hex("ba ffffffff")), /longer than its data/);
    assert.throws(() => decodeCborExactly(hex("1b ffffffffffffffff")), /too large/);
    assert.throws(() => decodeCborExactly(hex("62 c328")), /UTF-8/);
    assert.throws(() => decodeCborExactly(hex("")), CborError);
});

test("refuses a value nested deeper than anything WebAuthn sends", () => {
    assert.throws(() => decodeCborExactly(Uint8Array.from([...new Array(20).fill(0x81), 0x00])), /nested too deeply/);
});
