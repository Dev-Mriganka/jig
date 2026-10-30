// The narrow grammar every request body of this plugin promises to stay inside, restated here so that a change to the
// query builder that steps outside it fails a test instead of reaching a backend. It is deliberately stricter than the
// backends are: no script, no aggregation, no paging by `from`, no field list but the two that hits need.
import { isObject } from "../../src/values.ts";

const DAY_MS = 86_400_000;
const FORBIDDEN = [
    "script",
    "script_fields",
    "aggs",
    "aggregations",
    "runtime_mappings",
    "rescore",
    "inner_hits",
    "post_filter",
    "collapse",
    "pit",
    "search_after",
    "highlight",
    "stored_fields",
    "docvalue_fields",
    "indices_boost",
    "__proto__",
    "constructor",
    "prototype",
];
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface Fields {
    timeField: string;
    messageField: string;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void, depth = 0): void {
    if (depth > 12) throw new Error("nested deeper than 12");
    if (isObject(value)) {
        visit(value);
        for (const child of Object.values(value)) walk(child, visit, depth + 1);
    } else if (Array.isArray(value)) {
        for (const child of value) walk(child, visit, depth + 1);
    }
}

function onlyKeys(node: Record<string, unknown>, allowed: readonly string[], label: string, problems: string[]): void {
    for (const key of Object.keys(node)) if (!allowed.includes(key)) problems.push(`${label}.${key} is not allowed`);
}

function checkRange(clause: unknown, fields: Fields, problems: string[]): void {
    if (!isObject(clause) || Object.keys(clause).join() !== "range" || !isObject(clause.range)) {
        return void problems.push("the first filter must be a range");
    }
    const entries = Object.entries(clause.range);
    if (entries.length !== 1 || entries[0]?.[0] !== fields.timeField) {
        return void problems.push(`the range must be on ${fields.timeField}, and only on it`);
    }
    const bounds = entries[0][1];
    if (!isObject(bounds)) return void problems.push("the range needs bounds");
    onlyKeys(bounds, ["gte", "lt", "format"], "range", problems);
    const { gte, lt } = bounds;
    if (typeof gte !== "string" || typeof lt !== "string" || !INSTANT.test(gte) || !INSTANT.test(lt)) {
        return void problems.push("the range bounds must be UTC instants like 2026-10-13T12:00:00Z");
    }
    if (bounds.format !== "strict_date_optional_time") problems.push("the range must say how its bounds are written");
    if (!(Date.parse(lt) > Date.parse(gte))) problems.push("the range must end after it starts");
    else if (Date.parse(lt) - Date.parse(gte) > 7 * DAY_MS) problems.push("the range is longer than 7 days");
}

function checkMust(clause: unknown, fields: Fields, problems: string[]): void {
    if (!isObject(clause) || Object.keys(clause).length !== 1) return void problems.push("a must clause has one key");
    if (isObject(clause.match_phrase)) {
        const entries = Object.entries(clause.match_phrase);
        if (entries.length !== 1 || entries[0]?.[0] !== fields.messageField || typeof entries[0][1] !== "string") {
            problems.push(`match_phrase must hold the phrase for ${fields.messageField} and nothing else`);
        }
    } else if (isObject(clause.query_string)) {
        const { query, default_field: field } = clause.query_string;
        onlyKeys(clause.query_string, ["query", "default_field", "analyze_wildcard"], "query_string", problems);
        if (typeof query !== "string" || query === "") problems.push("query_string needs a query");
        if (field !== fields.messageField) problems.push(`query_string must search ${fields.messageField}`);
    } else {
        problems.push(`the must clause ${Object.keys(clause).join()} is not allowed`);
    }
}

/** Every way this body steps outside the grammar. Empty means it is inside. */
export function problemsWith(body: unknown, fields: Fields): string[] {
    const problems: string[] = [];
    if (!isObject(body)) return ["the body must be an object"];
    onlyKeys(body, ["size", "timeout", "track_total_hits", "query", "sort", "_source"], "body", problems);
    try {
        walk(body, (node) => {
            for (const key of Object.keys(node)) if (FORBIDDEN.includes(key)) problems.push(`${key} is not allowed`);
        });
    } catch (error) {
        problems.push((error as Error).message);
    }

    const { size } = body;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > 200)
        problems.push("size must be 0 to 200");
    if (typeof body.timeout !== "string" || !/^[1-9][0-9]?s$/.test(body.timeout))
        problems.push("timeout must be like 25s");
    if (body.track_total_hits !== true) problems.push("totals must be exact");

    if (size === 0) {
        if (body.sort !== undefined || body._source !== undefined)
            problems.push("a count asks for no sort and no fields");
    } else {
        const sort = body.sort;
        const entry = Array.isArray(sort) && sort.length === 1 && isObject(sort[0]) ? sort[0] : undefined;
        const direction = entry === undefined ? undefined : entry[fields.timeField];
        const order = isObject(direction) ? direction.order : undefined;
        if (
            entry === undefined ||
            Object.keys(entry).join() !== fields.timeField ||
            (order !== "asc" && order !== "desc")
        ) {
            problems.push(`the sort must be on ${fields.timeField}, ascending or descending, and only that`);
        }
        const source = body._source;
        if (!Array.isArray(source) || source.join() !== [fields.timeField, fields.messageField].join()) {
            problems.push("only the time and the message are fetched");
        }
    }

    const bool = isObject(body.query) && isObject(body.query.bool) ? body.query.bool : undefined;
    if (bool === undefined || Object.keys(body.query as object).join() !== "bool")
        return [...problems, "the query must be a bool"];
    onlyKeys(bool, ["filter", "must"], "bool", problems);
    const filter = Array.isArray(bool.filter) ? bool.filter : [];
    if (filter.length === 0) problems.push("the query needs a filter");
    checkRange(filter[0], fields, problems);
    for (const clause of filter.slice(1)) {
        const kind = isObject(clause) ? Object.keys(clause).join() : "";
        const body = isObject(clause) && (kind === "term" || kind === "terms") ? clause[kind] : undefined;
        const entries = isObject(body) ? Object.entries(body) : [];
        const scalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);
        const value = entries[0]?.[1];
        const fine =
            kind === "term"
                ? scalar(value)
                : Array.isArray(value) && value.length >= 1 && value.length <= 50 && value.every(scalar);
        if (entries.length !== 1 || !fine) {
            problems.push("every filter after the range is a term with one scalar value, or a terms with 1 to 50");
        }
    }
    if (size !== 0 || bool.must !== undefined) {
        const must = Array.isArray(bool.must) ? bool.must : [];
        if (must.length !== 1) problems.push("a search has exactly one must clause");
        else checkMust(must[0], fields, problems);
    }
    return problems;
}
