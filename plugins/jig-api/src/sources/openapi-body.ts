// A JSON request body described by an OpenAPI schema, as a template with one variable for each value the agent can give. The
// agent's values are text, numbers and flags, so only the scalar properties of an object (and of objects inside it, a few
// levels down) can be variables. A property that is a list, a choice between shapes, a file or a free-form object cannot be
// filled that way: a required one makes the body unsupported, an optional one is left out and said so.
//
// The template is written one property to a line, which is what optional.ts relies on to leave out a property nobody gave.
import { isObject } from "../engine/values.ts";

/** Resolves a `$ref`, or returns what it is given when it is not one. Undefined when the reference cannot be followed. */
export type Deref = (node: unknown) => unknown;

export interface Leaf {
    /** The property names from the top of the body, such as `["address", "city"]`. */
    path: readonly string[];
    /** How the value is written: in quotes, or as it is (a number or a flag). */
    type: "string" | "number" | "boolean";
    /** True when the body cannot be right without it: required in every object above it too. */
    required: boolean;
    /** What it is, for `show`. */
    doc: string;
}

export type Shape =
    | { kind: "leaf"; leaf: Leaf }
    | { kind: "object"; fields: Array<{ key: string; shape: Shape }> };

export interface BodyShape {
    root: Extract<Shape, { kind: "object" }> | undefined;
    leaves: Leaf[];
    /** What was left out, and why. */
    notes: string[];
    /** Why the body cannot be sent: set when something it requires cannot be filled. */
    unsupported: string | undefined;
}

/** Objects inside objects are followed this far: the body, and two levels of objects inside it. */
const MAX_DEPTH = 3;
const MAX_MERGE = 8;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The properties of an object schema, with those of the schemas it is made of (`allOf`) merged in. */
function objectOf(schema: unknown, deref: Deref, depth = 0): { properties: Map<string, unknown>; required: Set<string> } | undefined {
    const found = deref(schema);
    if (!isObject(found) || depth > MAX_MERGE) return undefined;
    const properties = new Map<string, unknown>();
    const required = new Set<string>();
    if (Array.isArray(found.allOf)) {
        for (const member of found.allOf as unknown[]) {
            const merged = objectOf(member, deref, depth + 1);
            for (const [key, value] of merged?.properties ?? []) properties.set(key, value);
            for (const key of merged?.required ?? []) required.add(key);
        }
    }
    if (isObject(found.properties)) for (const [key, value] of Object.entries(found.properties)) properties.set(key, value);
    if (Array.isArray(found.required)) for (const key of found.required as unknown[]) if (typeof key === "string") required.add(key);
    return properties.size === 0 ? undefined : { properties, required };
}

/** The type of a schema: the first one that is not `null` (OpenAPI 3.1 writes a list), or one a list of values implies. */
export function typeOf(schema: Record<string, unknown>): string | undefined {
    const given = Array.isArray(schema.type) ? (schema.type as unknown[]).find((item) => item !== "null") : schema.type;
    if (typeof given === "string") return given;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.every((item) => typeof item === "number") ? "number" : "string";
    return undefined;
}

/** What a scalar value is, in a few words: `integer`, `string, one of open | shipped`, `string (date-time)`. */
export function describeScalar(schema: Record<string, unknown>): string {
    const type = typeOf(schema) ?? "string";
    const values = Array.isArray(schema.enum) ? (schema.enum as unknown[]).filter((item) => ["string", "number", "boolean"].includes(typeof item)).map(String) : [];
    if (values.length > 0) return `${type}, one of ${values.slice(0, 12).join(" | ")}${values.length > 12 ? " | ..." : ""}`;
    return typeof schema.format === "string" ? `${type} (${schema.format})` : type;
}

const SCALARS = new Set(["string", "integer", "number", "boolean"]);

/** Why a schema cannot be one variable, or undefined when it can. */
export function whyNotScalar(schema: Record<string, unknown>): string | undefined {
    if (schema.format === "binary" || schema.format === "byte") return "a file";
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return "a choice between shapes";
    const type = typeOf(schema);
    if (type === undefined || SCALARS.has(type)) return undefined;
    return type === "array" ? "a list" : type === "object" ? "an object" : `of the type ${type}`;
}

function describeLeaf(schema: Record<string, unknown>, where: readonly string[]): string {
    const description = text(schema.description).replace(/\s+/g, " ").trim();
    return `body property ${where.join(".")}, ${describeScalar(schema)}${description === "" ? "" : `; ${description}`}`;
}

/**
 * The shape of a JSON body from its schema: the variables it holds and the template they go in. `required` says whether the
 * body itself is required.
 */
export function shapeOf(schema: unknown, deref: Deref, required: boolean): BodyShape {
    const leaves: Leaf[] = [];
    const notes: string[] = [];
    let unsupported: string | undefined;

    const build = (given: { properties: Map<string, unknown>; required: Set<string> }, path: readonly string[], here: boolean): Extract<Shape, { kind: "object" }> => {
        const fields: Array<{ key: string; shape: Shape }> = [];
        for (const [key, definition] of given.properties) {
            const where = [...path, key];
            const name = where.join(".");
            const mine = here && given.required.has(key);
            const schema = deref(definition);
            if (!isObject(schema)) {
                notes.push(`the property ${name} is left out: its schema cannot be read`);
                continue;
            }
            const choice = Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf);
            const objectLike = !choice && (typeOf(schema) === "object" || isObject(schema.properties) || Array.isArray(schema.allOf));
            const nested = objectLike && path.length + 1 < MAX_DEPTH ? objectOf(schema, deref) : undefined;
            if (nested !== undefined) {
                const inner = build(nested, where, mine);
                // An optional object with nothing in it that can be filled is left out, and not sent empty.
                if (inner.fields.length > 0 || mine) fields.push({ key, shape: inner });
                continue;
            }
            const why = objectLike
                ? (path.length + 1 < MAX_DEPTH ? "an object with no properties" : "an object nested too deep")
                : whyNotScalar(schema);
            if (why !== undefined) {
                if (mine) unsupported ??= `its JSON body needs the property ${name}, which is ${why} and cannot be filled from a variable`;
                else notes.push(`the optional property ${name} is left out: it is ${why}, and cannot be filled from a variable`);
                continue;
            }
            const type = typeOf(schema) ?? "string";
            const leaf: Leaf = { path: where, type: type === "integer" || type === "number" ? "number" : type === "boolean" ? "boolean" : "string", required: mine, doc: describeLeaf(schema, where) };
            leaves.push(leaf);
            fields.push({ key, shape: { kind: "leaf", leaf } });
        }
        return { kind: "object", fields };
    };

    const top = objectOf(schema, deref);
    if (top === undefined) {
        const reason = "its JSON body has no properties to fill (a free-form object, a list or a single value)";
        if (required) unsupported = reason;
        else notes.push(`its optional JSON body is left out: ${reason.replace(/^its JSON body /, "it ")}`);
        return { root: undefined, leaves, notes, unsupported };
    }
    return { root: build(top, [], required), leaves, notes, unsupported };
}

/** The template: one property to a line, a variable in quotes for a string and bare for a number or a flag. */
export function templateOf(shape: Extract<Shape, { kind: "object" }>, nameOf: (leaf: Leaf) => string): string {
    const lines = (object: Extract<Shape, { kind: "object" }>, depth: number): string[] => {
        const pad = "  ".repeat(depth + 1);
        return object.fields.flatMap((field, index) => {
            const comma = index < object.fields.length - 1 ? "," : "";
            const key = JSON.stringify(field.key);
            if (field.shape.kind === "leaf") {
                const variable = `{{${nameOf(field.shape.leaf)}}}`;
                return [`${pad}${key}: ${field.shape.leaf.type === "string" ? `"${variable}"` : variable}${comma}`];
            }
            const inner = lines(field.shape, depth + 1);
            return inner.length === 0 ? [`${pad}${key}: {}${comma}`] : [`${pad}${key}: {`, ...inner, `${pad}}${comma}`];
        });
    };
    return ["{", ...lines(shape, 0), "}"].join("\n");
}
