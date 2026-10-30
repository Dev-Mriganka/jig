// Extended JSON as the model writes it: `{"$oid": "..."}`, `{"$date": "..."}` and the other typed values of the format.
// This file only checks them, without the driver, so a malformed value is found while a call is classified and not after
// a connection was opened. The driver turns the checked values into BSON at the last moment (driver.ts).
import { InputError, isObject, shown } from "./values.ts";
import type { Doc } from "./values.ts";

const HEX24 = /^[0-9a-fA-F]{24}$/;
const INTEGER = /^-?\d{1,19}$/;
const DOUBLE = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|NaN|-?Infinity)$/;
const DECIMAL = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+-]?NaN|[+-]?Infinity)$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SUBTYPE = /^[0-9a-fA-F]{1,2}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const INT32 = { min: -(2 ** 31), max: 2 ** 31 - 1 };
const INT64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };

/** The wrapper keys that make an object one typed value, not a document. `$code` is not here: it is JavaScript. */
const WRAPPER_KEYS: ReadonlySet<string> = new Set([
    "$oid",
    "$date",
    "$numberInt",
    "$numberLong",
    "$numberDouble",
    "$numberDecimal",
    "$binary",
    "$uuid",
    "$timestamp",
    "$regularExpression",
    "$minKey",
    "$maxKey",
    "$symbol",
    "$undefined",
]);

/** Whether an object is a typed value of Extended JSON (`{"$oid": ...}`) and not a document or an operator. */
export function isWrapper(value: unknown): boolean {
    if (!isObject(value)) return false;
    const keys = Object.keys(value);
    if (keys.length === 1) return WRAPPER_KEYS.has(keys[0] as string);
    if (keys.length === 2 && "$binary" in value && "$type" in value) return true;
    // A database reference: `{"$ref": "orders", "$id": {...}, "$db": "shop"}`.
    return (
        keys.includes("$ref") &&
        keys.includes("$id") &&
        keys.every((key) => key === "$ref" || key === "$id" || key === "$db")
    );
}

const bad = (type: string, value: unknown, hint: string): InputError =>
    new InputError(`${type} ${shown(value, 30)} is not valid Extended JSON: ${hint}`);

function checkWrapper(value: Doc): void {
    if ("$ref" in value) {
        if (typeof value.$ref !== "string") throw bad("$ref", value.$ref, "it must be a collection name");
        return;
    }
    if ("$binary" in value && "$type" in value) {
        if (typeof value.$binary !== "string" || !BASE64.test(value.$binary))
            throw bad("$binary", value.$binary, "base64 text");
        if (typeof value.$type !== "string" || !SUBTYPE.test(value.$type))
            throw bad("$type", value.$type, "a hex subtype such as 00");
        return;
    }
    const [key] = Object.keys(value) as [string];
    const inner = value[key];
    switch (key) {
        case "$oid":
            if (typeof inner !== "string" || !HEX24.test(inner)) throw bad("$oid", inner, "24 hexadecimal characters");
            return;
        case "$date": {
            const millis = isObject(inner) ? inner.$numberLong : inner;
            const fine =
                typeof millis === "number"
                    ? Number.isFinite(millis)
                    : typeof millis === "string" &&
                      (INTEGER.test(millis) || (/^\d{4}-/.test(millis) && !Number.isNaN(Date.parse(millis))));
            if (!fine) throw bad("$date", inner, 'an ISO 8601 text such as "2026-01-31T09:00:00Z"');
            return;
        }
        case "$numberInt":
            if (
                typeof inner !== "string" ||
                !INTEGER.test(inner) ||
                Number(inner) < INT32.min ||
                Number(inner) > INT32.max
            ) {
                throw bad("$numberInt", inner, "a 32-bit integer as text");
            }
            return;
        case "$numberLong":
            if (
                typeof inner !== "string" ||
                !INTEGER.test(inner) ||
                BigInt(inner) < INT64.min ||
                BigInt(inner) > INT64.max
            ) {
                throw bad("$numberLong", inner, "a 64-bit integer as text");
            }
            return;
        case "$numberDouble":
            if (typeof inner !== "string" || !DOUBLE.test(inner)) throw bad("$numberDouble", inner, "a number as text");
            return;
        case "$numberDecimal":
            if (typeof inner !== "string" || !DECIMAL.test(inner))
                throw bad("$numberDecimal", inner, "a decimal as text");
            return;
        case "$binary":
            if (
                !isObject(inner) ||
                typeof inner.base64 !== "string" ||
                !BASE64.test(inner.base64) ||
                typeof inner.subType !== "string" ||
                !SUBTYPE.test(inner.subType)
            ) {
                throw bad("$binary", inner, '{"base64": "...", "subType": "00"}');
            }
            return;
        case "$uuid":
            if (typeof inner !== "string" || !UUID.test(inner))
                throw bad("$uuid", inner, "a UUID such as 3f0c8c2e-1b52-4c6a-9d59-0d2f6a8f7a11");
            return;
        case "$timestamp":
            if (!isObject(inner) || !Number.isInteger(inner.t) || !Number.isInteger(inner.i))
                throw bad("$timestamp", inner, '{"t": 1, "i": 1}');
            return;
        case "$regularExpression":
            if (!isObject(inner) || typeof inner.pattern !== "string" || typeof inner.options !== "string") {
                throw bad("$regularExpression", inner, '{"pattern": "...", "options": "i"}');
            }
            return;
        case "$minKey":
        case "$maxKey":
            if (inner !== 1) throw bad(key, inner, "it must be 1");
            return;
        case "$symbol":
            if (typeof inner !== "string") throw bad("$symbol", inner, "text");
            return;
        default:
        // `$undefined`: nothing to check.
    }
}

const MAX_DEPTH = 32;

/** Checks every typed value inside a request. The shapes of filters and pipelines are checked where they are read. */
export function checkExtended(value: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) throw new InputError(`a value nests more than ${MAX_DEPTH} levels deep`);
    if (Array.isArray(value)) {
        for (const item of value) checkExtended(item, depth + 1);
    } else if (isObject(value)) {
        if (isWrapper(value)) {
            checkWrapper(value);
            return;
        }
        for (const item of Object.values(value)) checkExtended(item, depth + 1);
    }
}
