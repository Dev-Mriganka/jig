// Extended JSON going in (checked before anything connects, and turned into BSON for the driver) and coming out (relaxed Extended
// JSON, whatever BSON class the driver used).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    BSON,
    Binary,
    Code,
    DBRef,
    Decimal128,
    Double,
    Int32,
    Long,
    MaxKey,
    MinKey,
    ObjectId,
    Timestamp,
    UUID,
} from "mongodb";
import * as driver from "mongodb";
import { isLeaf, toExtended, typeName } from "../src/bson.ts";
import { toBson } from "../src/driver.ts";
import { checkExtended, isWrapper } from "../src/ejson.ts";
import { InputError } from "../src/values.ts";

const OID = "65f1f1f1f1f1f1f1f1f1f1f1";

describe("checking Extended JSON", () => {
    test("typed values are recognised, and an operator or a document is not one", () => {
        assert.ok(isWrapper({ $oid: OID }));
        assert.ok(isWrapper({ $date: "2026-01-31T09:00:00Z" }));
        assert.ok(isWrapper({ $binary: "AAA=", $type: "00" }));
        assert.ok(isWrapper({ $ref: "orders", $id: { $oid: OID } }));
        assert.ok(!isWrapper({ $gt: 5 }));
        assert.ok(!isWrapper({ $oid: OID, other: 1 }));
        assert.ok(!isWrapper({ status: "open" }));
        assert.ok(!isWrapper("text"));
    });

    test("valid values pass at any depth", () => {
        checkExtended({
            _id: { $oid: OID },
            when: { $date: "2026-01-31T09:00:00Z" },
            ms: { $date: { $numberLong: "1700000000000" } },
            n: [
                { $numberInt: "5" },
                { $numberLong: "9007199254740993" },
                { $numberDouble: "NaN" },
                { $numberDecimal: "12.340" },
            ],
            u: { $uuid: "3f0c8c2e-1b52-4c6a-9d59-0d2f6a8f7a11" },
            b: { $binary: { base64: "AAA=", subType: "00" } },
            t: { $timestamp: { t: 1, i: 2 } },
            r: { $regularExpression: { pattern: "^a", options: "i" } },
            k: { $minKey: 1 },
            nested: { deeper: [{ $oid: OID }] },
        });
    });

    test("a malformed value is refused with what it should look like", () => {
        const refused: Array<[unknown, RegExp]> = [
            [{ a: { $oid: "xyz" } }, /\$oid.*24 hexadecimal/],
            [{ a: { $date: "yesterday" } }, /\$date.*ISO 8601/],
            [{ a: { $numberInt: "3000000000" } }, /\$numberInt/],
            [{ a: { $numberLong: "1.5" } }, /\$numberLong/],
            [{ a: { $numberLong: "9223372036854775808" } }, /\$numberLong/],
            [{ a: { $numberDouble: "five" } }, /\$numberDouble/],
            [{ a: { $numberDecimal: "x" } }, /\$numberDecimal/],
            [{ a: { $uuid: "not-a-uuid" } }, /\$uuid/],
            [{ a: { $binary: { base64: "@@", subType: "00" } } }, /\$binary/],
            [{ a: { $timestamp: { t: "1", i: 2 } } }, /\$timestamp/],
            [{ a: { $regularExpression: { pattern: "a" } } }, /\$regularExpression/],
            [{ a: { $minKey: 2 } }, /\$minKey/],
        ];
        for (const [value, pattern] of refused) {
            assert.throws(
                () => checkExtended(value),
                (error: unknown) => error instanceof InputError && pattern.test(error.message),
                JSON.stringify(value),
            );
        }
    });

    test("a value nested too deeply is refused", () => {
        let deep: unknown = 1;
        for (let level = 0; level < 40; level++) deep = { a: deep };
        assert.throws(() => checkExtended(deep), /nests more than 32/);
    });
});

describe("turning checked values into BSON for the driver", () => {
    test("typed values become the driver's classes, an operator stays an operator", () => {
        const bson = toBson(
            {
                _id: { $oid: OID },
                when: { $date: "2026-01-31T09:00:00Z" },
                count: { $gt: { $numberLong: "5" } },
                ids: [{ $oid: OID }],
            },
            driver,
        ) as Record<string, any>;
        assert.ok(bson._id instanceof ObjectId);
        assert.equal(bson._id.toHexString(), OID);
        assert.ok(bson.when instanceof Date);
        assert.equal(bson.when.toISOString(), "2026-01-31T09:00:00.000Z");
        assert.ok(bson.count.$gt instanceof Long);
        assert.ok(bson.ids[0] instanceof ObjectId);
    });

    test("a $regex operator keeps its other operators: a plain conversion would drop them", () => {
        assert.deepEqual(toBson({ name: { $regex: "^a", $options: "i", $exists: true } }, driver), {
            name: { $regex: "^a", $options: "i", $exists: true },
        });
    });

    test("a whole number beyond 32 bits is sent as a 64-bit integer, and a smaller one as it is", () => {
        const bson = toBson({ big: 3_000_000_000, small: 5, fraction: 1.5, huge: 1e30 }, driver) as Record<
            string,
            unknown
        >;
        assert.ok(bson.big instanceof Long);
        assert.equal(bson.small, 5);
        assert.equal(bson.fraction, 1.5);
        assert.equal(bson.huge, 1e30);
    });

    test("a key named __proto__ stays an own property and does not change the prototype", () => {
        const bson = toBson(JSON.parse('{"__proto__": {"x": 1}, "a": 1}'), driver) as Record<string, unknown>;
        assert.equal(Object.getPrototypeOf(bson), Object.prototype);
        assert.deepEqual(Object.keys(bson), ["__proto__", "a"]);
    });
});

describe("turning what the driver returns into Extended JSON", () => {
    test("typed values keep their type, so an id from a result can be used in the next filter", () => {
        const id = new ObjectId(OID);
        assert.deepEqual(toExtended(id), { $oid: OID });
        assert.deepEqual(toExtended(new Date("2026-01-02T03:04:05.678Z")), { $date: "2026-01-02T03:04:05.678Z" });
        assert.equal(toExtended(new Date("nope")), null);
        assert.deepEqual(toExtended(Decimal128.fromString("12.340")), { $numberDecimal: "12.340" });
        assert.deepEqual(toExtended(new Timestamp({ t: 5, i: 1 })), { $timestamp: { t: 5, i: 1 } });
        assert.deepEqual(toExtended(new MinKey()), { $minKey: 1 });
        assert.deepEqual(toExtended(new MaxKey()), { $maxKey: 1 });
        assert.deepEqual(toExtended(new BSON.BSONRegExp("^a", "i")), {
            $regularExpression: { pattern: "^a", options: "i" },
        });
        assert.deepEqual(toExtended(/ab+/gi), { $regularExpression: { pattern: "ab+", options: "gi" } });
    });

    test("numbers: small ones are plain, one JSON cannot hold keeps its type", () => {
        assert.equal(toExtended(new Int32(7)), 7);
        assert.equal(toExtended(new Double(1.5)), 1.5);
        assert.equal(toExtended(Long.fromNumber(3)), 3);
        assert.deepEqual(toExtended(Long.fromString("9007199254740993")), { $numberLong: "9007199254740993" });
        assert.deepEqual(toExtended(10n), { $numberLong: "10" });
        assert.deepEqual(toExtended(Number.NaN), { $numberDouble: "NaN" });
        assert.deepEqual(toExtended(Number.POSITIVE_INFINITY), { $numberDouble: "Infinity" });
        assert.equal(toExtended(undefined), null);
    });

    test("binary data and code are shown as a note, a UUID as a UUID, a reference as a reference", () => {
        assert.equal(toExtended(new Binary(Buffer.from("abc"))), "<binary 3 bytes>");
        assert.equal(toExtended(Buffer.from("abcd")), "<binary 4 bytes>");
        assert.deepEqual(toExtended(new UUID("3f0c8c2e-1b52-4c6a-9d59-0d2f6a8f7a11")), {
            $uuid: "3f0c8c2e-1b52-4c6a-9d59-0d2f6a8f7a11",
        });
        assert.equal(toExtended(new Code("x = 1")), "<code 5 characters>");
        assert.deepEqual(toExtended(new DBRef("accounts", new ObjectId(OID))), {
            $ref: "accounts",
            $id: { $oid: OID },
        });
    });

    test("documents and arrays convert at every depth, and the result is valid JSON", () => {
        const doc = {
            _id: new ObjectId(OID),
            items: [{ price: Decimal128.fromString("1.5") }],
            deep: { ids: [new ObjectId(OID)] },
        };
        const text = JSON.stringify(toExtended(doc));
        assert.deepEqual(JSON.parse(text), {
            _id: { $oid: OID },
            items: [{ price: { $numberDecimal: "1.5" } }],
            deep: { ids: [{ $oid: OID }] },
        });
    });

    test("a key named __proto__ stays an own property, and an absurdly deep value is cut", () => {
        const plain = toExtended(JSON.parse('{"__proto__": {"x": 1}, "a": 1}')) as Record<string, unknown>;
        assert.equal(Object.getPrototypeOf(plain), Object.prototype);
        assert.deepEqual(Object.keys(plain), ["__proto__", "a"]);
        let deep: unknown = "end";
        for (let level = 0; level < 100; level++) deep = [deep];
        assert.ok(JSON.stringify(toExtended(deep)).includes("<nested too deeply>"));
    });

    test("a function or a symbol is null, and nothing throws", () => {
        assert.equal(
            toExtended(() => 1),
            null,
        );
        assert.equal(toExtended(Symbol("x")), null);
    });
});

describe("types and leaves", () => {
    test("a value's type is named the way $type names it", () => {
        const names: Array<[unknown, string]> = [
            [null, "null"],
            ["a", "string"],
            [true, "bool"],
            [5, "int"],
            [1.5, "double"],
            [new Int32(1), "int"],
            [new Double(1), "double"],
            [Long.fromNumber(1), "long"],
            [Decimal128.fromString("1"), "decimal"],
            [new ObjectId(OID), "objectId"],
            [new Date(), "date"],
            [[1], "array"],
            [{ a: 1 }, "object"],
            [new UUID("3f0c8c2e-1b52-4c6a-9d59-0d2f6a8f7a11"), "uuid"],
            [new Binary(Buffer.from("a")), "binData"],
            [new Timestamp({ t: 1, i: 1 }), "timestamp"],
            [/a/, "regex"],
            [new MinKey(), "minKey"],
        ];
        for (const [value, name] of names) assert.equal(typeName(value), name);
    });

    test("typed values are leaves: a walk over a document does not enter them", () => {
        for (const leaf of [new ObjectId(OID), new Date(), /a/, Buffer.from("a"), { $oid: OID }, "text", 5, null])
            assert.ok(isLeaf(leaf));
        for (const inner of [{ a: 1 }, [1]]) assert.ok(!isLeaf(inner));
    });
});
