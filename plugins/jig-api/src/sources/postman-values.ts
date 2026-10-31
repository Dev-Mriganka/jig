// The small readers every part of a Postman collection uses: a value as text, a description, the `{ key, value }` lists that hold
// attributes and variables, and `Reading`, what `load` collects while it reads. They are apart from postman.ts so that the readers of
// auth, bodies and requests can share them.
import { isObject } from "../engine/values.ts";
import type { Problem } from "../model.ts";

/** What `load` collects while it reads. */
export interface Reading {
    collection: string;
    /** The collection file's name, for `origin`. */
    shown: string;
    problems: Problem[];
    /** The variables that some environment declares secret. */
    secretNames: ReadonlySet<string>;
}

export const text = (value: unknown): string | undefined =>
    typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : undefined;

/** A description, which may be text or `{ content }`. */
export function descriptionOf(value: unknown): string | undefined {
    const given = isObject(value) ? value.content : value;
    return typeof given === "string" && given.trim() !== "" ? given.trim() : undefined;
}

/** The `{ key, value }` pairs of an auth block, which is a list (v2.1) or, in older exports, an object. */
export function attributesOf(block: unknown): Map<string, string> {
    const found = new Map<string, string>();
    if (Array.isArray(block)) {
        for (const item of block as unknown[]) {
            if (isObject(item) && typeof item.key === "string") {
                const value = text(item.value);
                if (value !== undefined) found.set(item.key, value);
            }
        }
    } else if (isObject(block)) {
        for (const [key, value] of Object.entries(block)) {
            const given = text(value);
            if (given !== undefined) found.set(key, given);
        }
    }
    return found;
}

/** The `{ key, value }` variables of a collection, a folder or an item. */
export function variablesOf(raw: unknown): Map<string, string> {
    const found = new Map<string, string>();
    if (!Array.isArray(raw)) return found;
    for (const item of raw as unknown[]) {
        if (!isObject(item) || item.disabled === true) continue;
        const key = typeof item.key === "string" ? item.key : typeof item.id === "string" ? item.id : "";
        const value = text(item.value);
        if (key !== "" && value !== undefined) found.set(key, value);
    }
    return found;
}
