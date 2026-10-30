// What the `logs` tool accepts: the schema the model sees, the usage line that goes with a wrong call, and the checks a
// schema cannot express. Every refusal is a TypeError (see `refuse`) whose one line says how to put the call right.
//
// The checks read the call as plain data and do not trust the schema to have run: a call can arrive from a test, or
// from another tool, without passing through Pi's own validation.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Target } from "./config.ts";
import { MAX_CHARS, MIN_CHARS } from "./line.ts";
import type { LogQuery, Order } from "./query.ts";
import type { View } from "./summary.ts";
import { resolveRange } from "./time.ts";
import { CONTROL, printable, refuse, shown } from "./values.ts";

export const DEFAULT_WINDOW = "2h";
export const DEFAULT_SIZE = 50;
export const MAX_SIZE = 200;
export const MAX_PHRASE_CHARS = 512;
export const MAX_QUERY_CHARS = 2000;
export const MAX_TERMS = 5;
export const MAX_TERM_CHARS = 200;
/** Only a sanity bound: the hits fetched never exceed MAX_SIZE, and an offset past them is answered in the text. */
const MAX_OFFSET = 1_000_000;

const OPTIONAL = ["window", "from", "to", "size", "order", "match", "exclude", "around", "chars", "offset"] as const;
const KNOWN: ReadonlySet<string> = new Set(["phrase", "query", "environment", ...OPTIONAL]);

/** Ends every error about the shape of a call, so the model can correct it at once. */
export const USAGE = `Usage: logs {phrase or query, environment, ${OPTIONAL.map((name) => `${name}?`).join(", ")}}`;

const terms = (description: string) =>
    Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: MAX_TERM_CHARS }), {
            minItems: 1,
            maxItems: MAX_TERMS,
            description,
        }),
    );

export const logsParameters = Type.Object(
    {
        phrase: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_PHRASE_CHARS,
                description: "An exact phrase in the message: an id or an error text. Give phrase or query.",
            }),
        ),
        query: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_QUERY_CHARS,
                description: "A Lucene query over the message: AND, OR, NOT, wildcards, quotes. Give phrase or query.",
            }),
        ),
        environment: Type.String({
            minLength: 1,
            maxLength: 64,
            description: "Where to search: a configured environment.",
        }),
        window: Type.Optional(
            Type.String({
                pattern: "^[1-9][0-9]{0,4}[mhd]$",
                description: "Window ending now: 30m, 2h, 1d; at most 7d. Default 2h. Not with from and to.",
            }),
        ),
        from: Type.Optional(Type.String({ description: "Start, ISO 8601 with a timezone. Give with to." })),
        to: Type.Optional(
            Type.String({ description: "End (exclusive), ISO 8601 with a timezone; within 7 days of from." }),
        ),
        size: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SIZE, description: "Hits to fetch. Default 50." })),
        order: Type.Optional(
            StringEnum(["asc", "desc"] as const, {
                description: "asc (default): the oldest hits of the window. desc: the newest.",
            }),
        ),
        match: terms(
            "Show only hits whose message contains all these plain texts (ignoring case). Picks among fetched hits.",
        ),
        exclude: terms("Hide hits whose message contains any of these plain texts. Picks among fetched hits."),
        around: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_TERM_CHARS,
                description: "Show each hit as a window around the first occurrence of this text.",
            }),
        ),
        chars: Type.Optional(
            Type.Integer({
                minimum: MIN_CHARS,
                maximum: MAX_CHARS,
                description: "Characters per hit: 300, or 4000 when 3 or fewer are shown.",
            }),
        ),
        offset: Type.Optional(
            Type.Integer({
                minimum: 0,
                description: "First hit to show among the fetched ones; a page holds up to 20.",
            }),
        ),
    },
    { additionalProperties: false },
);

type Input = Readonly<Record<string, unknown>>;

/** Checks the shape of a call: no parameter the tool lacks, and exactly one of `phrase` and `query`. */
export function checkParams(input: Input): void {
    for (const [name, value] of Object.entries(input)) {
        if (value !== undefined && !KNOWN.has(name)) refuse(`logs does not use ${printable(name)}. ${USAGE}`);
    }
    const given = [input.phrase, input.query].filter((value) => value !== undefined).length;
    if (given === 0) refuse(`logs needs phrase or query. ${USAGE}`);
    if (given === 2) refuse(`logs takes phrase or query, not both. ${USAGE}`);
}

/** A text that is printable and not only spaces. */
function printableText(value: unknown, name: string, max: number): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL.test(value)) {
        return refuse(`logs: ${name} must be 1-${max} printable characters, not only spaces`);
    }
    return value;
}

function optionalText(input: Input, name: string): string | undefined {
    const value = input[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") return refuse(`logs: ${name} must be text (got ${shown(value)})`);
    return value;
}

function integer(input: Input, name: string, min: number, max: number): number | undefined {
    const value = input[name];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return refuse(`logs: ${name} must be an integer from ${min} to ${max} (got ${shown(value)})`);
    }
    return value;
}

/** Up to five plain texts of up to 200 printable characters: what `match` and `exclude` take. */
function checkTerms(input: Input, name: "match" | "exclude"): string[] | undefined {
    const value = input[name];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TERMS) {
        return refuse(`logs: ${name} must list 1 to ${MAX_TERMS} texts`);
    }
    return value.map((term) => printableText(term, `each ${name}`, MAX_TERM_CHARS));
}

/**
 * What the call searches for: the text, the window, how many hits and from which end. `environment` is the name the
 * call used and `target` what the configuration says about it.
 */
export function resolveQuery(input: Input, environment: string, target: Target, now: number): LogQuery {
    const kind = input.phrase !== undefined ? "phrase" : "query";
    const text = printableText(input[kind], kind, kind === "phrase" ? MAX_PHRASE_CHARS : MAX_QUERY_CHARS);
    const range = resolveRange(
        { window: optionalText(input, "window"), from: optionalText(input, "from"), to: optionalText(input, "to") },
        DEFAULT_WINDOW,
        now,
    );
    const order = input.order ?? "asc";
    if (order !== "asc" && order !== "desc") refuse(`logs: order must be asc or desc (got ${shown(order)})`);
    return {
        environment,
        target,
        kind,
        text,
        size: integer(input, "size", 1, MAX_SIZE) ?? DEFAULT_SIZE,
        order: order as Order,
        range,
    };
}

/** What only chooses and shapes the hits already fetched: `match`, `exclude`, `around`, `chars` and `offset`. */
export function resolveView(input: Input): View {
    const match = checkTerms(input, "match");
    const exclude = checkTerms(input, "exclude");
    const around = input.around === undefined ? undefined : printableText(input.around, "around", MAX_TERM_CHARS);
    const chars = integer(input, "chars", MIN_CHARS, MAX_CHARS);
    return {
        ...(match === undefined ? {} : { match }),
        ...(exclude === undefined ? {} : { exclude }),
        ...(around === undefined ? {} : { around }),
        ...(chars === undefined ? {} : { chars }),
        offset: integer(input, "offset", 0, MAX_OFFSET) ?? 0,
    };
}
