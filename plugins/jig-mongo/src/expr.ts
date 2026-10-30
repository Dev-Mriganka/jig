// Aggregation expressions and the check every field reference goes through. A reference is a "$path" string, a variable such as
// "$$ROOT.status", or the name of a field in a stage. Each is turned into a path from the root of the document and asked of the
// view (access.ts): a denied field, or with an allow list a field that is not listed, is refused before anything runs.
import { fieldPath } from "./access.ts";
import type { View } from "./access.ts";
import { isWrapper } from "./ejson.ts";
import { InputError, isObject } from "./values.ts";
import type { Doc } from "./values.ts";

/** What one stage of a pipeline knows about the documents it reads. */
export interface Ctx {
    view: View;
    /**
     * Allow list only: top-level names that the pipeline made up (`$addFields`, `$project`, `$lookup` `as`). They hold derived
     * data, not source fields, so they are not asked of the allow list. The set is shared by the stages of one pipeline.
     */
    derived: Set<string>;
    /** Allow list only: after `$group` and the like every name is one the pipeline made up. */
    rootDerived: boolean;
    /** Variables in scope: the path they stand for in the source documents, or "derived" for anything computed. */
    vars: ReadonlyMap<string, readonly string[] | "derived">;
}

export function newCtx(view: View, vars: Iterable<[string, readonly string[] | "derived"]> = []): Ctx {
    return {
        view,
        derived: new Set(),
        rootDerived: false,
        vars: new Map<string, readonly string[] | "derived">([["ROOT", []], ["CURRENT", []], ...vars]),
    };
}

const SYSTEM_VARIABLES: ReadonlySet<string> = new Set([
    "NOW",
    "CLUSTER_TIME",
    "REMOVE",
    "DESCEND",
    "PRUNE",
    "KEEP",
    "SEARCH_META",
    "USER_ROLES",
]);
const MAX_DEPTH = 32;

/**
 * Where a reference stands. A `key` is a filter or a sort. An `expr` is part of an expression, which can copy a value under
 * another name. A `shape` keeps or drops a field where it is (`$unwind`, an inclusion in `$project`), so it adds nothing to what
 * the stream already holds.
 */
export type Position = "key" | "expr" | "shape";

const madeUp = (ctx: Ctx, path: readonly string[]): boolean =>
    ctx.view.mode === "allow" && (ctx.rootDerived || (path[0] !== undefined && ctx.derived.has(path[0])));

/** Refuses a path that names a field that may not be seen. */
export function checkPath(ctx: Ctx, path: readonly string[], position: Position): void {
    const { view } = ctx;
    if (madeUp(ctx, path)) {
        const name = path.find((segment) => view.nameDenied(segment));
        if (name !== undefined) throw new InputError(view.reason([name]));
        return;
    }
    const status = view.visibility(path);
    if (status === "yes") return;
    // A key can name a document that holds a denied field: the result is stripped. An expression could copy it out under
    // another name, and with an allow list a filter or a sort on a whole document would compare fields that are not listed.
    if (status === "partial" && (position === "shape" || (position === "key" && view.mode === "deny"))) return;
    if (path.length === 0)
        throw new InputError(
            "$$ROOT stands for the whole document, which holds fields that may not be seen; name the fields you need",
        );
    throw new InputError(view.reason(path));
}

/** A key in a filter, a sort or a projection. */
export function checkKey(ctx: Ctx, text: string, position: Position = "key"): void {
    checkPath(ctx, fieldPath(text), position);
}

/** The name of a field a stage creates. Only credential-like names (and names the deny list gives alone) are refused. */
export function checkName(ctx: Ctx, name: string): void {
    const bad = fieldPath(name).find((segment) => ctx.view.nameDenied(segment));
    if (bad !== undefined) throw new InputError(`${ctx.view.reason([bad])}; choose another name`);
}

/** Notes a top-level name that a stage made up, when an allow list makes the difference matter. */
export function markDerived(ctx: Ctx, name: string): void {
    if (ctx.view.mode !== "allow" || name.includes(".")) return;
    if (ctx.view.leaves.some((leaf) => leaf[0] === name)) return;
    ctx.derived.add(name);
}

/** What a "$path" or "$$variable.path" string stands for: a path in the source documents, or "derived". */
function resolve(ctx: Ctx, text: string): readonly string[] | "derived" {
    if (text.startsWith("$$")) {
        const [name = "", ...rest] = text.slice(2).split(".");
        if (SYSTEM_VARIABLES.has(name)) return "derived";
        const bound = ctx.vars.get(name);
        if (bound === undefined) throw new InputError(`unknown variable $$${name}`);
        if (bound === "derived") {
            const bad = rest.find((segment) => ctx.view.nameDenied(segment));
            if (bad !== undefined) throw new InputError(ctx.view.reason([bad]));
            return "derived";
        }
        return [...bound, ...(rest.length === 0 ? [] : fieldPath(rest.join(".")))];
    }
    return fieldPath(text.slice(1));
}

function checkRef(ctx: Ctx, text: string): void {
    const path = resolve(ctx, text);
    if (path !== "derived") checkPath(ctx, path, "expr");
}

const isRef = (value: unknown): value is string => typeof value === "string" && value.startsWith("$");

function withVariable(ctx: Ctx, name: string, bound: readonly string[] | "derived"): Ctx {
    return { ...ctx, vars: new Map(ctx.vars).set(name, bound) };
}

/** What an expression that feeds a variable stands for: the path of a plain reference, otherwise derived data. */
function binding(ctx: Ctx, value: unknown): readonly string[] | "derived" {
    return isRef(value) ? resolve(ctx, value) : "derived";
}

function expectObject(operator: string, value: unknown): Doc {
    if (!isObject(value)) throw new InputError(`${operator} takes an object`);
    return value;
}

/** Walks an expression: every reference in it is checked, and the operators that can read a field by a computed name are refused. */
export function checkExpr(value: unknown, ctx: Ctx, depth = 0): void {
    if (depth > MAX_DEPTH) throw new InputError(`an expression nests more than ${MAX_DEPTH} levels deep`);
    if (typeof value === "string") {
        if (value.startsWith("$")) checkRef(ctx, value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) checkExpr(item, ctx, depth + 1);
        return;
    }
    if (!isObject(value) || isWrapper(value)) return;
    for (const [key, inner] of Object.entries(value)) {
        if (!key.startsWith("$")) {
            checkName(ctx, key);
            checkExpr(inner, ctx, depth + 1);
        } else {
            operator(key, inner, ctx, depth + 1);
        }
    }
}

function operator(name: string, value: unknown, ctx: Ctx, depth: number): void {
    switch (name) {
        case "$literal":
        case "$meta":
            return;
        case "$objectToArray":
            throw new InputError(
                "$objectToArray turns field names into values, which the access lists cannot check; name the fields instead",
            );
        case "$getField": {
            const spec = typeof value === "string" ? { field: value } : expectObject(name, value);
            const field = isObject(spec.field) && "$literal" in spec.field ? spec.field.$literal : spec.field;
            if (typeof field !== "string")
                throw new InputError("$getField needs the field name written out; a computed name cannot be checked");
            const input = "input" in spec ? spec.input : "$$CURRENT";
            if (isRef(input)) {
                const base = resolve(ctx, input);
                if (base === "derived") {
                    if (ctx.view.nameDenied(field)) throw new InputError(ctx.view.reason([field]));
                } else {
                    checkPath(ctx, [...base, field], "expr");
                }
            } else {
                checkExpr(input, ctx, depth + 1);
                if (ctx.view.nameDenied(field)) throw new InputError(ctx.view.reason([field]));
            }
            return;
        }
        case "$setField":
        case "$unsetField": {
            const spec = expectObject(name, value);
            const field = isObject(spec.field) && "$literal" in spec.field ? spec.field.$literal : spec.field;
            if (typeof field !== "string") throw new InputError(`${name} needs the field name written out`);
            checkName(ctx, field);
            checkExpr(spec.input, ctx, depth + 1);
            checkExpr(spec.value, ctx, depth + 1);
            return;
        }
        case "$map":
        case "$filter": {
            const spec = expectObject(name, value);
            checkExpr(spec.input, ctx, depth + 1);
            const as = typeof spec.as === "string" ? spec.as : "this";
            const inner = withVariable(ctx, as, binding(ctx, spec.input));
            checkExpr(name === "$map" ? spec.in : spec.cond, inner, depth + 1);
            checkExpr(spec.limit, ctx, depth + 1);
            return;
        }
        case "$reduce": {
            const spec = expectObject(name, value);
            checkExpr(spec.input, ctx, depth + 1);
            checkExpr(spec.initialValue, ctx, depth + 1);
            const inner = withVariable(withVariable(ctx, "this", binding(ctx, spec.input)), "value", "derived");
            checkExpr(spec.in, inner, depth + 1);
            return;
        }
        case "$let": {
            const spec = expectObject(name, value);
            let inner = ctx;
            for (const [variable, expression] of Object.entries(isObject(spec.vars) ? spec.vars : {})) {
                checkExpr(expression, ctx, depth + 1);
                inner = withVariable(inner, variable, binding(ctx, expression));
            }
            checkExpr(spec.in, inner, depth + 1);
            return;
        }
        default:
            checkExpr(value, ctx, depth + 1);
    }
}
