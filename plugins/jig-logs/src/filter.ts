// The `filter` of an environment: fields of its documents (Elasticsearch) or labels of its streams (Loki) that a hit
// must have. Each entry names one field and says what it must equal: one value, or a list of values of which it may
// equal any. Both come from the configuration, never from the model, and both backends read them the same way, so the
// checks are here.
import type { FilterSetting, FilterValue } from "./config.ts";
import { CONTROL, isObject, printable, shown } from "./values.ts";

/** How many fields or labels one environment's filter may name. */
export const MAX_FILTERS = 8;
/** How many values one entry may list. */
export const MAX_FILTER_VALUES = 50;
const MAX_VALUE_CHARS = 200;

/** True for an entry that lists values, which every reader of a filter has to tell from a single value. */
export function isList(setting: FilterSetting): setting is readonly FilterValue[] {
    return Array.isArray(setting);
}

/** A value an entry may hold: text of up to 200 printable characters, a finite number, true or false. */
function isValue(value: unknown): value is FilterValue {
    if (typeof value === "string") return value !== "" && value.length <= MAX_VALUE_CHARS && !CONTROL.test(value);
    return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

/**
 * Adds one message to `errors` for each problem in a `filter`. `name` says what a key may look like, and `noun` what it
 * is called in a message: a field of a document, or a label of a stream.
 */
export function checkFilter(
    raw: unknown,
    key: string,
    name: { pattern: RegExp; noun: "field" | "label" },
    errors: string[],
): void {
    if (!isObject(raw) || Object.keys(raw).length === 0 || Object.keys(raw).length > MAX_FILTERS) {
        errors.push(
            `${key} must map 1 to ${MAX_FILTERS} ${name.noun} names to the value each must equal, ` +
                "or to a list of values it may equal",
        );
        return;
    }
    for (const [field, setting] of Object.entries(raw)) {
        if (!name.pattern.test(field)) errors.push(`${key}: ${shown(field)} is not a ${name.noun} name`);
        const at = `${key}.${printable(field)}`;
        if (!Array.isArray(setting)) {
            if (!isValue(setting)) {
                errors.push(
                    `${at} must be text, a number, true or false, or a list of 1 to ${MAX_FILTER_VALUES} of them`,
                );
            }
        } else if (setting.length === 0 || setting.length > MAX_FILTER_VALUES) {
            errors.push(`${at} must list 1 to ${MAX_FILTER_VALUES} values`);
        } else if (!setting.every(isValue)) {
            errors.push(`${at} must list only text, numbers, true or false`);
        }
    }
}
