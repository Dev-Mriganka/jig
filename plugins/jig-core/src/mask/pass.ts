import { hasCredentialShape, removeCredentialShapes } from "./credentials.ts";
import { maskEmbeddedJson } from "./embedded.ts";
import { MaskError, limitError, reservedCharacterError, unsupportedError } from "./error.ts";
import { maskFreeText, maskIpAddresses } from "./freetext.ts";
import type { Host } from "./host.ts";
import { RawJson } from "./jsonscan.ts";
import { isRemoved, isTokenised, removed } from "./kinds.ts";
import type { Kind, KindOf } from "./kinds.ts";
import { MAX_BYTES, Limits, byteLength } from "./limits.ts";
import { maskLogFields } from "./logfields.ts";
import { isPlausiblePhone, lastFour, phoneDigits } from "./phone.ts";
import { maskQuery } from "./query.ts";
import { SENTINEL, Shelf } from "./shelf.ts";
import type { Tokens } from "./token.ts";

/** Replaces a string the masker cannot parse safely: the value is withheld, not guessed at. */
export const UNPARSEABLE = "[removed:unparseable]";

/** A phone value longer than this is not a phone number; it is removed whole, without scanning. */
const MAX_PHONE_CHARACTERS = 64;
/** What an identifier looks like. Anything longer or odder in an identifier field is scanned as text. */
const MAX_IDENTIFIER_CHARACTERS = 128;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]+$/;
/** Text may grow while masking (tokens are longer than short values), but not without bound. */
const MAX_EXPANDED_BYTES = MAX_BYTES * 2;

type Json = Record<string, unknown>;

function isRawNumber(value: object): boolean {
    return RawJson.isRawJSON(value);
}

function isPlainObject(value: object): value is Json {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Text of a non-string scalar; undefined for null. Anything that is not JSON-like is refused. */
function scalarText(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    switch (typeof value) {
        case "number":
        case "bigint":
        case "boolean":
            return String(value);
        case "object": // raw JSON numbers: `walk` has already ruled out every other object
            return (value as { rawJSON: string }).rawJSON;
        default:
            throw unsupportedError();
    }
}

/** One masking call. Holds the per-call limits and the placeholder shelf; discard it afterwards. */
export class Pass implements Host {
    readonly tokens: Tokens;
    readonly #kindOf: KindOf;
    readonly #limits = new Limits();
    #shelf = new Shelf();

    constructor(tokens: Tokens, kindOf: KindOf) {
        this.tokens = tokens;
        this.#kindOf = kindOf;
    }

    kindOf(key: string, parent: string): Kind {
        return this.#kindOf(key, parent);
    }

    // ---- JSON values -------------------------------------------------------------------------------------

    /** Masks a JSON-like value. `kind` and `parent` describe the field that holds it. */
    walk(value: unknown, kind: Kind, parent: string, depth: number): unknown {
        this.#limits.visit(depth);
        if (typeof value === "string") {
            this.#limits.addBytes(byteLength(value));
            return this.scalar(value, kind, depth);
        }
        if (Array.isArray(value)) return this.#walkArray(value, kind, parent, depth);
        if (typeof value === "object" && value !== null && !isRawNumber(value)) {
            if (!isPlainObject(value)) throw unsupportedError();
            return this.#walkObject(value, kind, parent, depth);
        }
        return this.#walkOther(value, kind, depth);
    }

    /** Numbers, booleans and null: kept as they are unless the field's kind says the value is sensitive. */
    #walkOther(value: unknown, kind: Kind, depth: number): unknown {
        const text = scalarText(value);
        if (isRemoved(kind)) return removed(kind);
        if (text === undefined) return value;
        this.#limits.addBytes(text.length);
        return isTokenised(kind) ? this.scalar(text, kind, depth) : value;
    }

    #walkArray(items: unknown[], kind: Kind, parent: string, depth: number): unknown {
        if (isRemoved(kind)) return removed(kind);
        const itemKind: Kind = kind === "safe" ? "other" : kind;
        const out: unknown[] = [];
        for (let i = 0; i < items.length; i++) out.push(this.walk(items[i], itemKind, parent, depth + 1));
        return out;
    }

    #walkObject(map: Json, kind: Kind, parent: string, depth: number): unknown {
        if (isRemoved(kind)) return removed(kind);
        const entries: [string, unknown][] = [];
        for (const key of Object.keys(map)) {
            this.#limits.addBytes(byteLength(key));
            const value = map[key];
            const classified = this.#isNumericTokenCount(key, value, parent) ? "other" : this.kindOf(key, parent);
            // A field with no rule of its own takes its enclosing field's rule, unless that field was a safe one.
            const child: Kind = classified === "other" && kind !== "safe" ? kind : classified;
            entries.push([key, this.walk(value, child, key, depth + 1)]);
        }
        return Object.fromEntries(entries); // fromEntries, not assignment: a "__proto__" key stays plain data
    }

    /** Usage counters such as `tokens` or `input_tokens: 42` are metrics; credential fields named that way are not. */
    #isNumericTokenCount(key: string, value: unknown, parent: string): boolean {
        const numeric =
            typeof value === "number" ||
            typeof value === "bigint" ||
            value === null ||
            value === undefined ||
            (typeof value === "object" && !Array.isArray(value) && isRawNumber(value));
        return (
            numeric &&
            (key === "tokens" || key.endsWith("_tokens") || key.startsWith("tokens_") || key.includes("_tokens_")) &&
            this.kindOf(key.replaceAll("tokens", "units"), parent) !== "credential"
        );
    }

    // ---- scalars -----------------------------------------------------------------------------------------

    /** Masks one decoded string the way a field of `kind` is masked. */
    scalar(text: string, kind: Kind, depth: number): string {
        switch (kind) {
            case "email":
            case "name":
            case "user":
            case "personal":
                return this.tokens.mint(kind, text);
            case "ip":
                return maskIpAddresses(text, this); // public addresses only; a hostname is left as it is
            case "phone":
                return this.#phone(text);
            case "card":
                return this.#card(text);
            case "identifier":
                return this.#identifier(text, depth);
            case "safe":
                return this.#safeValue(text);
            case "other":
                return this.text(text, depth);
            default: // every other kind is removed whole
                return removed(kind);
        }
    }

    #phone(text: string): string {
        const digits = text.length > MAX_PHONE_CHARACTERS ? "" : phoneDigits(text);
        // A value in a phone field that is not a phone number is removed whole: nothing of it survives.
        return isPlausiblePhone(digits) ? `${this.tokens.mint("phone", digits)}-${lastFour(digits)}` : removed("phone");
    }

    #card(text: string): string {
        const digits = text.replace(/\D/g, "");
        return digits.length < 4 ? removed("card") : `card ****${lastFour(digits)}`;
    }

    /** Identifier fields stay readable, but a credential shape inside one is still removed. */
    #identifier(text: string, depth: number): string {
        if (hasCredentialShape(text)) return removed("credential");
        if (text !== "" && text.length <= MAX_IDENTIFIER_CHARACTERS && IDENTIFIER.test(text)) return text;
        return this.text(text, depth);
    }

    /** Diagnostic fields (version, status, ...) stay as they are, except for a credential shape. */
    #safeValue(text: string): string {
        return hasCredentialShape(text) ? removed("credential") : text;
    }

    // ---- free text ---------------------------------------------------------------------------------------

    /**
     * Masks free text: JSON and URL queries and `key=value` fields first (by field rules), then patterns. A string
     * whose structure cannot be parsed safely (malformed encoding, JSON-like text that does not parse) is replaced
     * whole by UNPARSEABLE instead of failing the result: that one value is withheld, the rest stays usable.
     */
    text(input: string, depth: number): string {
        return this.tryText(input, depth) ?? UNPARSEABLE;
    }

    /**
     * `text`, but undefined where `text` would withhold the string, so a caller that knows more about the input
     * (the engine, for a text of several lines) can decide how much to withhold.
     */
    tryText(input: string, depth: number): string | undefined {
        this.#limits.requireDepth(depth);
        if (byteLength(input) > MAX_BYTES) throw limitError("input size");
        if (input.includes(SENTINEL)) throw reservedCharacterError();
        if (input === "") return "";
        try {
            return this.#maskText(input, depth);
        } catch (error) {
            if (!(error instanceof MaskError) || error.failure !== "malformed") throw error;
            return undefined;
        }
    }

    #maskText(input: string, depth: number): string {
        const outer = this.#shelf;
        const shelf = new Shelf();
        this.#shelf = shelf;
        try {
            let text = maskEmbeddedJson(this, input, depth + 1);
            text = maskQuery(this, text, depth + 1);
            text = maskLogFields(this, text, depth + 1);
            text = removeCredentialShapes(text);
            text = maskFreeText(text, { tokens: this.tokens, protect: (segment) => this.protect(segment) });
            const masked = shelf.restore(text);
            if (byteLength(masked) > MAX_EXPANDED_BYTES) throw limitError("output size");
            return masked;
        } finally {
            this.#shelf = outer;
        }
    }

    protect(text: string): string {
        return this.#shelf.protect(text);
    }

    json(value: unknown, depth: number): unknown {
        return this.walk(value, "other", "", depth);
    }
}
