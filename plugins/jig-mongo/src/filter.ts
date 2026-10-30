// A filter in the query language: `find`'s filter, `$match`, a `$lookup` that matches, an update's condition. Every field it
// names is checked (a filter on a denied field would let the agent probe its values), whatever operator wraps it.
import { fieldPath } from "./access.ts";
import { checkExpr, checkPath } from "./expr.ts";
import type { Ctx } from "./expr.ts";
import { isWrapper } from "./ejson.ts";
import { InputError, isObject } from "./values.ts";
import type { Doc } from "./values.ts";

const MAX_DEPTH = 32;

const LOGICAL: ReadonlySet<string> = new Set(["$and", "$or", "$nor"]);
/** Operators on a field, whose argument holds values and no field names. */
const VALUE_OPERATORS: ReadonlySet<string> = new Set([
    "$eq",
    "$ne",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
    "$in",
    "$nin",
    "$exists",
    "$type",
    "$regex",
    "$options",
    "$mod",
    "$size",
    "$bitsAllSet",
    "$bitsAllClear",
    "$bitsAnySet",
    "$bitsAnyClear",
]);
/** Geospatial operators: their arguments are coordinates and shapes. */
const GEO_OPERATORS: ReadonlySet<string> = new Set([
    "$near",
    "$nearSphere",
    "$geoWithin",
    "$geoIntersects",
    "$geometry",
    "$maxDistance",
    "$minDistance",
    "$box",
    "$center",
    "$centerSphere",
    "$polygon",
]);

const allOperators = (value: Doc): boolean => {
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => key.startsWith("$"));
};

/** A value written into a filter: arrays and nested documents are walked, because their keys are field names. */
function checkLiteral(value: unknown, path: readonly string[], ctx: Ctx, depth: number): void {
    if (depth > MAX_DEPTH) throw new InputError(`a filter nests more than ${MAX_DEPTH} levels deep`);
    if (Array.isArray(value)) {
        for (const item of value) checkLiteral(item, path, ctx, depth + 1);
    } else if (isObject(value) && !isWrapper(value)) {
        for (const [key, inner] of Object.entries(value)) {
            if (key.startsWith("$")) continue;
            const next = [...path, ...fieldPath(key)];
            checkPath(ctx, next, "key");
            checkLiteral(inner, next, ctx, depth + 1);
        }
    }
}

function checkOperators(operators: Doc, path: readonly string[], ctx: Ctx, depth: number): void {
    for (const [name, argument] of Object.entries(operators)) {
        if (VALUE_OPERATORS.has(name)) {
            checkLiteral(argument, path, ctx, depth + 1);
        } else if (GEO_OPERATORS.has(name)) {
            continue;
        } else if (name === "$not") {
            if (isObject(argument) && !isWrapper(argument) && allOperators(argument))
                checkOperators(argument, path, ctx, depth + 1);
        } else if (name === "$all") {
            for (const item of Array.isArray(argument) ? argument : []) {
                if (isObject(item) && allOperators(item) && !isWrapper(item))
                    checkOperators(item, path, ctx, depth + 1);
                else checkLiteral(item, path, ctx, depth + 1);
            }
        } else if (name === "$elemMatch") {
            if (!isObject(argument)) throw new InputError("$elemMatch takes an object");
            checkFilter(argument, ctx, path, depth + 1);
        } else {
            throw new InputError(`the query operator ${name} is not supported`);
        }
    }
}

/**
 * Checks a filter. `base` is the path the filter's keys are relative to: empty at the top, the array's path inside
 * `$elemMatch`. Throws an InputError for a field that may not be seen and for what the access lists cannot check.
 */
export function checkFilter(filter: unknown, ctx: Ctx, base: readonly string[] = [], depth = 0): void {
    if (depth > MAX_DEPTH) throw new InputError(`a filter nests more than ${MAX_DEPTH} levels deep`);
    if (!isObject(filter)) throw new InputError('a filter must be an object such as {"status": "open"}');
    for (const [key, value] of Object.entries(filter)) {
        if (LOGICAL.has(key)) {
            if (!Array.isArray(value)) throw new InputError(`${key} takes a list of filters`);
            for (const item of value) checkFilter(item, ctx, base, depth + 1);
        } else if (key === "$expr") {
            checkExpr(value, ctx);
        } else if (key === "$where" || key === "$comment") {
            // `$where` is JavaScript, which was refused already unless the environment allows it.
            continue;
        } else if (key === "$text") {
            // A text search reads every indexed text field, whatever the lists say.
            if (ctx.view.mode === "allow")
                throw new InputError(
                    "$text searches fields the allow list cannot check; filter on listed fields instead",
                );
        } else if (key === "$jsonSchema") {
            throw new InputError(
                "$jsonSchema names fields in a schema that cannot be checked; filter on the fields directly",
            );
        } else if (key.startsWith("$")) {
            // Below an array's path, an operator applies to the elements themselves: `{$elemMatch: {$gt: 5}}`.
            if (base.length === 0)
                throw new InputError(`the query operator ${key} is not supported at the top of a filter`);
            checkOperators({ [key]: value }, base, ctx, depth + 1);
        } else {
            const path = [...base, ...fieldPath(key)];
            checkPath(ctx, path, "key");
            if (isObject(value) && !isWrapper(value) && allOperators(value))
                checkOperators(value, path, ctx, depth + 1);
            else checkLiteral(value, path, ctx, depth + 1);
        }
    }
}
