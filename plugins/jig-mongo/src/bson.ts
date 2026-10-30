// What comes back from the driver, as plain JSON that never depends on driver classes: relaxed Extended JSON, so that an
// `_id` or a date in a result can be pasted into the next filter. Values that would flood the context (binary data, code) are
// shown as a short note instead. Ported in spirit from the reference: depth is bounded, numbers that JSON cannot hold become
// typed values, and a key named `__proto__` stays an own property.
import type { Doc } from "./values.ts";
import { isWrapper } from "./ejson.ts";

const MAX_DEPTH = 64;

interface BsonLike {
    _bsontype: string;
    toExtendedJSON?(options: { relaxed: boolean }): unknown;
    [key: string]: unknown;
}

/** A value of the driver's BSON classes (an `ObjectId`, a `Long`, ...), found by the type tag every one carries. */
export function isBson(value: unknown): value is BsonLike {
    return (
        typeof value === "object" && value !== null && typeof (value as { _bsontype?: unknown })._bsontype === "string"
    );
}

/** A value that is not a document or an array: it is shown or kept whole, never entered. */
export function isLeaf(value: unknown): boolean {
    return (
        typeof value !== "object" ||
        value === null ||
        isBson(value) ||
        value instanceof Date ||
        value instanceof RegExp ||
        value instanceof Uint8Array ||
        isWrapper(value)
    );
}

function binaryNote(value: BsonLike): unknown {
    const binary = value as unknown as {
        sub_type?: number;
        length?: () => number;
        position?: number;
        toString(encoding?: string): string;
    };
    if (binary.sub_type === 4) {
        try {
            return { $uuid: binary.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5") };
        } catch {
            // Not 16 bytes: shown as binary below.
        }
    }
    return `<binary ${typeof binary.length === "function" ? binary.length() : (binary.position ?? 0)} bytes>`;
}

function bsonValue(value: BsonLike, depth: number): unknown {
    switch (value._bsontype) {
        case "Binary":
            return binaryNote(value);
        case "Code":
            return `<code ${String(value.code).length} characters>`;
        case "BSONSymbol":
            return String(value.value);
        case "Long": {
            // The driver's relaxed form turns a 64-bit integer into a number, which loses digits beyond 2^53.
            const text = String(value);
            return Number.isSafeInteger(Number(text)) ? Number(text) : { $numberLong: text };
        }
        default:
    }
    if (typeof value.toExtendedJSON === "function")
        return toExtended(value.toExtendedJSON({ relaxed: true }), depth + 1);
    return String(value);
}

/** The value as relaxed Extended JSON. Never throws on odd input: a function or a symbol becomes null. */
export function toExtended(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
        case "string":
        case "boolean":
            return value;
        case "number":
            return Number.isFinite(value) ? value : { $numberDouble: String(value) };
        case "bigint":
            return { $numberLong: value.toString() };
        case "function":
        case "symbol":
            return null;
        default:
    }
    if (depth > MAX_DEPTH) return "<nested too deeply>";
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { $date: value.toISOString() };
    if (value instanceof RegExp) return { $regularExpression: { pattern: value.source, options: value.flags } };
    if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
    if (Array.isArray(value)) return value.map((item) => toExtended(item, depth + 1));
    if (isBson(value)) return bsonValue(value, depth);
    return Object.fromEntries(Object.entries(value as Doc).map(([key, item]) => [key, toExtended(item, depth + 1)]));
}

/** The BSON type of a value, by the names MongoDB's `$type` uses where it has one. Plain numbers count as int or double. */
export function typeName(value: unknown): string {
    if (value === null || value === undefined) return "null";
    switch (typeof value) {
        case "string":
            return "string";
        case "boolean":
            return "bool";
        case "number":
            return Number.isInteger(value) ? "int" : "double";
        case "bigint":
            return "long";
        default:
    }
    if (Array.isArray(value)) return "array";
    if (value instanceof Date) return "date";
    if (value instanceof RegExp) return "regex";
    if (value instanceof Uint8Array) return "binData";
    if (isBson(value)) {
        switch (value._bsontype) {
            case "ObjectId":
                return "objectId";
            case "Int32":
                return "int";
            case "Long":
                return "long";
            case "Double":
                return "double";
            case "Decimal128":
                return "decimal";
            case "Timestamp":
                return "timestamp";
            case "BSONRegExp":
                return "regex";
            case "Binary":
                return (value as { sub_type?: number }).sub_type === 4 ? "uuid" : "binData";
            case "Code":
                return "javascript";
            case "BSONSymbol":
                return "symbol";
            case "DBRef":
                return "dbRef";
            case "MinKey":
                return "minKey";
            case "MaxKey":
                return "maxKey";
            default:
                return value._bsontype.toLowerCase();
        }
    }
    return "object";
}
