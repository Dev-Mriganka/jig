// `{{name}}` variables in a text: finding them, and telling the generated ones (`{{$uuid}}`) from the rest. Sources use this
// to say which variables a request uses; resolve.ts uses it to fill them in.
import type { Generated } from "./engine/text.ts";

/** A variable: `{{name}}`, with optional white space inside. A name has no braces and no line break. */
const VARIABLE = /\{\{\s*([^{}\r\n]+?)\s*\}\}/g;

/** A text cut into plain pieces and variable names, in order. */
export function partsOf(template: string): Array<string | { variable: string }> {
    const parts: Array<string | { variable: string }> = [];
    let last = 0;
    for (const match of template.matchAll(VARIABLE)) {
        if (match.index > last) parts.push(template.slice(last, match.index));
        parts.push({ variable: match[1] as string });
        last = match.index + match[0].length;
    }
    if (last < template.length) parts.push(template.slice(last));
    return parts;
}

/** The variable names in the texts, once each, in order of first use. */
export function variablesIn(...templates: ReadonlyArray<string | undefined>): string[] {
    const names = new Set<string>();
    for (const template of templates) {
        if (template === undefined) continue;
        for (const match of template.matchAll(VARIABLE)) names.add(match[1] as string);
    }
    return [...names];
}

/**
 * The values this plugin makes itself. `$uuid` and `$timestamp` (seconds) and `$isoTimestamp` are the dynamic variables of the
 * `.http` dialects, and `$guid` is Postman's name for `$uuid`. Any other `$name` is not supported.
 */
export function generatedKind(name: string): Generated["generated"] | undefined {
    switch (name) {
        case "$uuid":
        case "$guid": return "uuid";
        case "$timestamp": return "timestamp";
        case "$isoTimestamp": return "isoTimestamp";
        default: return undefined;
    }
}

/**
 * Why a request cannot use these variables, or undefined when it can. A generated value other than the three that are made
 * here would need code to run, and `{{login.response.body.$.token}}` needs another request to have run first.
 */
export function unsupportedVariable(names: readonly string[]): string | undefined {
    for (const name of names) {
        if (name.startsWith("$") && generatedKind(name) === undefined) {
            return `{{${name}}} is not supported (only $uuid, $timestamp and $isoTimestamp are made here)`;
        }
        if (/\.(?:response|request)\./.test(name) || /^\$?\w+\.(?:response|request)$/.test(name)) {
            return `{{${name}}} needs the answer of another request, and requests are run one at a time`;
        }
    }
    return undefined;
}
