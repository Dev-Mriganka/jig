// One line of a record file, as the values of one row. A line that is not a record in the format of jig-core's
// records.ts has no row: the importer skips it and counts it, and it never stops the import.
import { CALL, TURN } from "./fields.ts";
import type { Field } from "./fields.ts";

export type SqlValue = string | number | null;

export interface Row {
    table: "call" | "turn";
    /** In the order of the table's fields. */
    values: SqlValue[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The column value for a field, null when an optional field is absent, or undefined when the value cannot be used. */
function convert(field: Field, value: unknown): SqlValue | undefined {
    if (value === undefined || value === null) return field.required ? undefined : null;
    switch (field.kind) {
        case "text":
            return typeof value === "string" ? value : undefined;
        case "count":
        case "number":
            return typeof value === "number" && Number.isFinite(value) ? value : undefined;
        case "time": {
            const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
            return Number.isNaN(milliseconds) ? undefined : milliseconds / 1000;
        }
        case "json":
            if (!isObject(value)) return undefined;
            // An empty object says nothing, so "has facts" is simply "not null".
            return Object.keys(value).length === 0 ? null : JSON.stringify(value);
    }
}

/** The row for a line, or undefined when the line is not a record. */
export function parseLine(text: string): Row | undefined {
    let record: unknown;
    try {
        record = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!isObject(record) || (record.kind !== "call" && record.kind !== "turn")) return undefined;
    const table = record.kind;
    const values: SqlValue[] = [];
    for (const field of table === "call" ? CALL : TURN) {
        const value = convert(field, record[field.name]);
        if (value === undefined) return undefined;
        values.push(value);
    }
    return { table, values };
}
