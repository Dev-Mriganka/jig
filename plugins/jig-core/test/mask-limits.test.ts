// Limits and failure behaviour: every limit throws MaskError, and nothing partial is ever returned.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMasker, MaskError } from "../src/mask/index.ts";
import { MAX_BYTES as LIMIT, MAX_NODES } from "../src/mask/limits.ts";
import { SENTINEL } from "../src/mask/shelf.ts";
import { assertFailsClosed, assertWithheld, keyOf, maskText, maskValue } from "./mask-support.ts";

function nestedArrays(levels: number): unknown {
    let value: unknown = null;
    for (let i = 0; i < levels; i++) value = [value];
    return value;
}

function nestedObjects(levels: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < levels; i++) value = { child: value };
    return value;
}

describe("limits", () => {
    it("accepts text of exactly the byte limit and refuses one byte more", () => {
        assert.equal(maskText("x".repeat(LIMIT)).length, LIMIT);
        assertFailsClosed(() => maskText("x".repeat(LIMIT + 1)));
    });

    it("counts bytes, not UTF-16 units", () => {
        assertFailsClosed(() => maskText("é".repeat(LIMIT / 2 + 1)));
        assert.doesNotThrow(() => maskText("é".repeat(LIMIT / 2)));
    });

    it("refuses a single string over the byte limit inside a value", () => {
        assertFailsClosed(() => maskValue({ message: "x".repeat(LIMIT + 1) }));
    });

    it("refuses many small values that add up past the byte limit", () => {
        const strings = Array.from({ length: Math.ceil(LIMIT / 600) + 1 }, () => "y".repeat(600));
        assertFailsClosed(() => maskValue(strings));
    });

    it("allows 64 levels of nesting and refuses 65", () => {
        assert.doesNotThrow(() => maskValue(nestedArrays(64)));
        assertFailsClosed(() => maskValue(nestedArrays(65)));
        assertFailsClosed(() => maskValue(nestedArrays(70)));
        assert.doesNotThrow(() => maskValue(nestedObjects(63)));
        assertFailsClosed(() => maskValue(nestedObjects(65)));
    });

    it("refuses cyclic values instead of looping", () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        assertFailsClosed(() => maskValue(cycle));
    });

    it("allows the node limit and refuses one more", () => {
        assert.doesNotThrow(() => maskValue(new Array(MAX_NODES - 1).fill(null))); // the array itself is the last allowed node
        assertFailsClosed(() => maskValue(new Array(MAX_NODES).fill(null)));
    });

    it("bounds JSON nested inside strings by the same depth limit", () => {
        const json = (levels: number): string => `${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`;
        assert.doesNotThrow(() => maskText(`payload=${json(30)}`));
        assertFailsClosed(() => maskText(`payload=${json(80)}`));
        // JSON inside a string inside JSON: each layer is one more level of decoding.
        let layered = "x";
        for (let i = 0; i < 12; i++) layered = JSON.stringify({ a: layered });
        assert.doesNotThrow(() => maskText(`payload=${layered}`));
    });

    it("withholds a string with malformed encoded content or truncated JSON, and only that string", () => {
        assertWithheld(() => maskText("GET /?email=someone%XXexample.com"));
        assertWithheld(() => maskText('INFO payload={"email":"a@example.com"'));
        assertWithheld(() => maskText('INFO payload={"email":"a@example.com", "x": ]'));
        // One bad log line in a result: that line is withheld, the others are masked as usual.
        const value = maskValue({
            hits: [{ message: "INFO ok for account 42" }, { message: 'INFO payload={"email":"a@example.com"' }],
        });
        assert.deepEqual(value, {
            hits: [{ message: "INFO ok for account 42" }, { message: "[removed:unparseable]" }],
        });
    });

    describe("a text of several lines", () => {
        const good = ["INFO ok for account 42", "INFO contact alice@example.com", "INFO done"];

        it("withholds only the lines that fail, and masks the others as usual", () => {
            const text = [
                good[0],
                'WARN payload={"email":"bad@example.com"',
                good[1],
                "GET /?email=someone%XXexample.com",
                good[2],
            ].join("\n");
            const value = maskText(text);
            const lines = value.split("\n");
            assert.equal(lines.length, 5);
            assert.deepEqual(
                [lines[0], lines[1], lines[3], lines[4]],
                [good[0], "[removed:unparseable]", "[removed:unparseable]", good[2]],
            );
            assert.match(lines[2] ?? "", /^INFO contact email#[0-9a-f]{6}$/);
            assert.ok(!value.includes("example.com"), "nothing of a failing line or a masked email survives");
        });

        it("keeps the line endings it found", () => {
            const value = maskText(`${good[0]}\r\nINFO payload={"a":\r\n${good[2]}\r\n`);
            assert.equal(value, `${good[0]}\r\n[removed:unparseable]\r\n${good[2]}\r\n`);
        });

        it("withholds the whole text when the fault is not in one line", () => {
            // A pretty-printed JSON block cut off: every line passes alone, but together they hold unparsed personal data.
            const cutOff = '{\n  "name": "Casey Sample",\n  "address": {\n    "city": "Springfield"';
            assertWithheld(() => maskText(`${good[0]}\n${cutOff}`));
        });

        it("masks the text left after the failing lines as one text, so patterns that span lines still apply", () => {
            const value = maskText(`INFO at 12 Oak\nLane\nWARN payload={"a":\n${good[2]}`);
            assert.ok(!value.includes("Oak"), value);
            assert.match(value, /\n\[removed:unparseable\]\nINFO done$/);
        });

        it("still fails closed on a limit hit by a later line, never withholding it as a bad line", () => {
            const tooDeep = `payload=${'{"a":'.repeat(80)}1${"}".repeat(80)}`;
            assertFailsClosed(() => maskText(`INFO payload={"a":\n${good[0]}\n${tooDeep}`));
        });

        it("a single line behaves as before", () => {
            assertWithheld(() => maskText('INFO payload={"a":'));
        });
    });

    it("refuses text containing the private-use marker the masker reserves", () => {
        assertFailsClosed(() => maskText(`before ${SENTINEL} after`));
        assertFailsClosed(() => maskValue({ note: `a${SENTINEL}b` }));
    });

    it("refuses values that are not JSON-like", () => {
        for (const value of [
            () => 1,
            Symbol("s"),
            new Date(),
            new Map(),
            new Set(),
            new (class Box {})(),
            { nested: [() => 1] },
        ]) {
            assertFailsClosed(() => maskValue(value));
        }
        assertFailsClosed(() => maskText(42 as unknown as string));
    });

    it("throws a MaskError whose message never contains the input", () => {
        const secret = "person@example.com";
        for (const work of [
            () => maskValue({ note: "x".repeat(LIMIT + 1), secret }),
            () => maskText(`${secret} ${SENTINEL}`),
        ]) {
            assert.throws(work, (error: unknown) => {
                assert.ok(error instanceof MaskError);
                assert.ok(!error.message.includes("person"), error.message);
                assert.equal(error.cause, undefined);
                return true;
            });
        }
    });

    it("says why it failed, without the input", () => {
        const failure = (work: () => unknown): string | undefined => {
            try {
                work();
            } catch (error) {
                return error instanceof MaskError ? error.failure : "not a MaskError";
            }
            return undefined;
        };
        assert.equal(
            failure(() => maskText("x".repeat(LIMIT + 1))),
            "limit",
        );
        assert.equal(
            failure(() => maskValue(nestedArrays(70))),
            "limit",
        );
        assert.equal(
            failure(() => maskValue(new Date())),
            "unsupported",
        );
        assert.equal(
            failure(() => maskText(`a ${SENTINEL} b`)),
            "unsupported",
        );
        assert.equal(
            failure(() => createMasker(new Uint8Array(3))),
            "internal",
        );
        assert.equal(
            failure(() => maskText("fine")),
            undefined,
        );
    });

    it("exposes the same failures through createMasker", () => {
        const masker = createMasker(keyOf(3));
        assert.throws(() => masker.text("x".repeat(LIMIT + 1)), MaskError);
        assert.throws(() => masker.value(nestedArrays(70)), MaskError);
    });
});
