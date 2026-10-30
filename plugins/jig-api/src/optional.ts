// Optional variables. A source that describes parameters (OpenAPI) says which ones may be left out. When nobody gives such a
// variable a value, whatever hangs on it is left out of the request: its query pair, its header, its JSON property. This is
// done on the templates, before any variable is filled, so that a variable with no value stays an error only when the request
// really needs it.
//
// It relies on the shape the sources write: a query pair is `name={{variable}}`, a header's whole value is `{{variable}}`, and
// a JSON property is on a line of its own. A pair, header or property that holds more than the variable is not touched.
import type { Body, SavedRequest } from "./model.ts";

/** The name in a text that is nothing but one `{{variable}}`, or undefined. */
function aloneIn(text: string): string | undefined {
    return /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(text.trim())?.[1];
}

function isUnset(text: string, unset: ReadonlySet<string>): boolean {
    const name = aloneIn(text);
    return name !== undefined && unset.has(name);
}

function prunedUrl(url: string, unset: ReadonlySet<string>): string {
    const mark = url.indexOf("?");
    if (mark < 0) return url;
    const pairs = url
        .slice(mark + 1)
        .split("&")
        .filter((pair) => {
            const equals = pair.indexOf("=");
            return equals < 0 || !isUnset(pair.slice(equals + 1), unset);
        });
    return pairs.length === 0 ? url.slice(0, mark) : `${url.slice(0, mark)}?${pairs.join("&")}`;
}

/** A property line: `  "name": "{{variable}}",` or a number or flag written as `{{variable}}`. */
const PROPERTY = /^\s*"(?:[^"\\]|\\.)*":\s*"?\{\{\s*([^{}]+?)\s*\}\}"?,?\s*$/;

/** The line that opens an object property, and the line that closes an object: what is left of an object with nothing in it. */
const OPENS = /^\s*"(?:[^"\\]|\\.)*":\s*\{\s*$/;
const CLOSES = /^\s*\},?\s*$/;

function prunedJson(text: string, unset: ReadonlySet<string>): string {
    const lines = text.split("\n");
    const kept = lines.filter((line) => {
        const name = PROPERTY.exec(line)?.[1];
        return name === undefined || !unset.has(name);
    });
    if (kept.length === lines.length) return text;
    // An object whose properties were all left out is left out too: sending it empty would claim a value nobody gave.
    for (let at = 0; at + 1 < kept.length; ) {
        if (OPENS.test(kept[at] as string) && CLOSES.test(kept[at + 1] as string)) {
            kept.splice(at, 2);
            at = Math.max(0, at - 1);
        } else {
            at++;
        }
    }
    // The last property that is left must not end with a comma. A comma at the end of a line is never inside a JSON string.
    return kept.join("\n").replace(/,(\n\s*[}\]])/g, "$1");
}

export interface Pruned {
    url: string;
    headers: SavedRequest["headers"];
    body: Body | undefined;
}

/** The request's address, headers and body without what hangs on the optional variables in `unset`. */
export function pruned(request: SavedRequest, unset: ReadonlySet<string>): Pruned {
    if (unset.size === 0) return { url: request.url, headers: request.headers, body: request.body };
    const body =
        request.body?.kind === "json" ? { ...request.body, text: prunedJson(request.body.text, unset) } : request.body;
    return {
        url: prunedUrl(request.url, unset),
        headers: request.headers.filter(([, value]) => !isUnset(value, unset)),
        body,
    };
}
