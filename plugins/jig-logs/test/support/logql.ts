// A small reader of LogQL, written for the tests and independent of the code under test. It reads the shape the adapter
// builds: a stream selector, then line filters. With it a test can say what a query is made of, and so prove that the
// model's text ended up as the value of one filter and in no other place.

export interface Filter {
    op: "|=" | "!=" | "|~" | "!~";
    value: string;
}

export interface Matcher {
    label: string;
    op: "=" | "!=" | "=~" | "!~";
    value: string;
}

export interface Parsed {
    selector: string;
    matchers: Matcher[];
    filters: Filter[];
    /** Whatever follows the line filters, such as a parser stage. Empty when the query is selector and filters only. */
    rest: string;
}

/** Reads a quoted string at `from`: double quotes with Go escapes, or backticks. Returns the value and where it ends. */
export function readString(text: string, from: number): { value: string; end: number } | undefined {
    const quote = text[from];
    if (quote === "`") {
        const close = text.indexOf("`", from + 1);
        return close < 0 ? undefined : { value: text.slice(from + 1, close), end: close + 1 };
    }
    if (quote !== '"') return undefined;
    let value = "";
    for (let i = from + 1; i < text.length; i++) {
        const char = text[i] as string;
        if (char === '"') return { value, end: i + 1 };
        if (char !== "\\") {
            value += char;
            continue;
        }
        const next = text[i + 1];
        const simple: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", t: "\t", r: "\r" };
        if (next !== undefined && next in simple) {
            value += simple[next];
            i += 1;
        } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
            i += 5;
        } else {
            return undefined;
        }
    }
    return undefined;
}

function skipSpaces(text: string, from: number): number {
    let i = from;
    while (text[i] === " ") i += 1;
    return i;
}

/** The selector at the start of a query: its raw text, its matchers, and where it ends. */
function readSelector(text: string): { selector: string; matchers: Matcher[]; end: number } | undefined {
    if (text[0] !== "{") return undefined;
    const matchers: Matcher[] = [];
    let i = 1;
    for (;;) {
        i = skipSpaces(text, i);
        const label = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
        if (label === undefined) return undefined;
        i = skipSpaces(text, i + label.length);
        const op = /^(=~|!~|!=|=)/.exec(text.slice(i))?.[0] as Matcher["op"] | undefined;
        if (op === undefined) return undefined;
        i = skipSpaces(text, i + op.length);
        const read = readString(text, i);
        if (read === undefined) return undefined;
        matchers.push({ label, op, value: read.value });
        i = skipSpaces(text, read.end);
        if (text[i] === ",") {
            i += 1;
            continue;
        }
        if (text[i] === "}") return { selector: text.slice(0, i + 1), matchers, end: i + 1 };
        return undefined;
    }
}

/** A query read as selector, line filters and the rest; undefined when it does not start with a selector. */
export function parseLogql(query: string): Parsed | undefined {
    const selector = readSelector(query);
    if (selector === undefined) return undefined;
    const filters: Filter[] = [];
    let i = skipSpaces(query, selector.end);
    for (;;) {
        const op = /^(\|=|!=|\|~|!~)/.exec(query.slice(i))?.[0] as Filter["op"] | undefined;
        if (op === undefined) break;
        const start = skipSpaces(query, i + op.length);
        const read = readString(query, start);
        if (read === undefined) return undefined;
        filters.push({ op, value: read.value });
        i = skipSpaces(query, read.end);
    }
    return { selector: selector.selector, matchers: selector.matchers, filters, rest: query.slice(i) };
}

/** The positions of every `{` that is not inside a quoted string. A well-formed query has exactly the selector's. */
export function bracesOutsideStrings(query: string): number[] {
    const found: number[] = [];
    for (let i = 0; i < query.length; i++) {
        const char = query[i];
        if (char === '"' || char === "`") {
            const read = readString(query, i);
            if (read === undefined) return [...found, -1];
            i = read.end - 1;
        } else if (char === "{") {
            found.push(i);
        }
    }
    return found;
}
