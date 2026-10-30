// The parts of LogQL that Loki's adapter has to get exactly right: writing a string, reading a stream selector, and
// keeping the model's pipeline from reaching past the selector the configuration chose.
import type { FilterSetting } from "../config.ts";
import { isList } from "../filter.ts";
import { CONTROL, refuse } from "../values.ts";

/**
 * A LogQL string for `text`: double quotes, with the backslash, the quote and every control character escaped. The text
 * can then only ever be the value of a line filter: nothing in it can close the string.
 */
export function quote(text: string): string {
    let out = '"';
    for (const char of text) {
        if (char === '"' || char === "\\") out += `\\${char}`;
        else if (CONTROL.test(char)) out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        else out += char;
    }
    return `${out}"`;
}

/**
 * A regular expression that matches `text` literally, for a `|~` or `!~` filter. Loki reads RE2, and RE2 takes the same
 * backslash escapes as here. The filters use it with `(?i)` in front, because the tool ignores case on every backend and
 * Loki's `|=` and `!=` do not.
 */
export function literalPattern(text: string): string {
    return text.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}

// ---- the stream selector, which comes from configuration ----------------------------------------------------------

/** A label name, as the selector reads it. */
export const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The matcher for one `filter` entry: `label="value"` for one value, and for a list `label=~"a|b"`, which Loki reads as
 * the whole value being a or b (a matcher is anchored). Each value is matched literally, escaped the way a line filter's
 * text is, so a value with a `|` or a `.` in it is one alternative and not a pattern. Label values are text, so a
 * number or a flag is written as its text. Label values are matched with their case.
 */
export function matcherFor(label: string, setting: FilterSetting): string {
    if (!isList(setting)) return `${label}=${quote(String(setting))}`;
    return `${label}=~${quote(setting.map((value) => literalPattern(String(value))).join("|"))}`;
}

const LABEL = "[A-Za-z_][A-Za-z0-9_]*";
const OPERATOR = "=~|!~|!=|=";
/** A value is a double-quoted string (a backslash escapes the next character) or a backtick string (no escapes). */
// biome-ignore lint/style/useTemplate: a template would need the backticks of the second part escaped
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|` + "`[^`]*`";
const MATCHER = ` *(${LABEL}) *(${OPERATOR}) *(${VALUE}) *`;
const SELECTOR = new RegExp(`^\\{${MATCHER}(?:,${MATCHER})*\\}$`);

const MAX_SELECTOR_CHARS = 1000;

/**
 * What is wrong with a stream selector, or undefined when it is fine: `form` when it is not one (`{app="orders-api"}`,
 * matchers separated by commas), `positive` when it has no `=` or `=~` matcher with a value. Loki refuses a selector
 * that can match every stream, and one with only `!=` or `!~` matchers can, so a configuration that has one is wrong
 * today and not when the first search runs.
 */
export function selectorProblem(text: unknown): "form" | "positive" | undefined {
    if (typeof text !== "string" || text.length > MAX_SELECTOR_CHARS || CONTROL.test(text)) return "form";
    const trimmed = text.trim();
    if (!SELECTOR.test(trimmed)) return "form";
    const matchers = [...trimmed.slice(1, -1).matchAll(new RegExp(MATCHER, "g"))];
    const positive = matchers.some(([, , operator, value]) => {
        return (operator === "=" || operator === "=~") && !isEmpty(value);
    });
    return positive ? undefined : "positive";
}

/** A quoted value with nothing in it. */
function isEmpty(value: string | undefined): boolean {
    return value === '""' || value === "``";
}

// ---- the model's query, which is a pipeline ------------------------------------------------------------------------

/**
 * A query is appended after the selector, so it has to be a pipeline: it starts with `|`, as `|= "timeout"` or
 * `| json | level="error"` do. Nothing in it may open another stream selector, and that takes a `{`, which is allowed
 * only inside a quoted string, such as the template of `line_format "{{.msg}}"`. Everything outside a string is read as
 * code here, a single quote included, as LogQL has no string in single quotes. Loki can then read less as code than
 * this does (a comment would hide the rest from it), never more, so no `{` reaches it outside a string. Returns the
 * query without the spaces around it.
 */
export function checkPipeline(text: string): string {
    const query = text.trim();
    if (!query.startsWith("|")) {
        return refuse('logs: a Loki query must start with |, such as |= "timeout" or | json | level="error"');
    }
    if (CONTROL.test(query)) return refuse("logs: a Loki query must be one line of printable characters");
    let open: '"' | "`" | undefined;
    for (let i = 0; i < query.length; i++) {
        const char = query[i];
        if (open === '"') {
            if (char === "\\") i += 1;
            else if (char === '"') open = undefined;
        } else if (open === "`") {
            if (char === "`") open = undefined;
        } else if (char === '"' || char === "`") {
            open = char;
        } else if (char === "{") {
            return refuse("logs: a Loki query cannot hold { outside quotes: the stream selector is set in jig.json");
        }
    }
    if (open !== undefined) return refuse("logs: a Loki query has a quote that is never closed");
    return query;
}
