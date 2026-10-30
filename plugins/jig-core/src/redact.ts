// Redaction: removing secrets from what the model would see.
//
// Two sources of secrets are covered:
// - Every value a Jig tool resolved through `secrets.resolve`, in the forms it takes in output: as it is, as JSON
//   text, in base64 and base64url, URL-encoded, and in hex.
// - Secrets Jig never resolved but whose shape is unmistakable: GitHub tokens, AWS access key ids, private-key
//   blocks, JWTs and Slack tokens.
//
// A secret that sits inside a longer base64 string (as in an HTTP `Basic` header) is not caught: only the base64 of
// the secret on its own is. The raw value, which a tool normally prints, is always caught.

export const REDACTED = "[redacted]";

/** Deepest structure the walk follows. Anything deeper is refused instead of passed through unchecked. */
const MAX_DEPTH = 100;

/** Thrown when a structure cannot be walked safely (too deep, or it refers to itself). The caller then withholds
 *  the result instead of letting it through. */
export class RedactionError extends Error {}

/** Shapes that are secrets with high confidence. Each pattern is specific enough that a false match is unlikely. */
const SHAPES: readonly RegExp[] = [
    /gh[pousr]_[A-Za-z0-9]{36,255}/g,
    /github_pat_[A-Za-z0-9_]{22,255}/g,
    /(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}(?![A-Z0-9])/g,
    // A private-key block runs to its END line. A block cut short, with no END line, runs to the end of the text.
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g,
    /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    /xapp-[0-9]-[A-Za-z0-9-]{10,}/g,
];

export interface Redactor {
    /** Starts removing this value, and its encodings, from everything that passes through. Empty values are
     *  ignored. */
    register(value: string): void;
    text(input: string): string;
    /** Redacts every string in a structure, including object keys. Plain objects and arrays are walked; other
     *  values (numbers, dates, buffers) are left as they are. */
    value<T>(input: T): T;
    /** How many secret values are registered. Never their text. */
    count(): number;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text forms a secret can take in output, the value itself first. */
export function secretForms(secret: string): string[] {
    const bytes = Buffer.from(secret, "utf8");
    const base64 = bytes.toString("base64");
    const base64url = bytes.toString("base64url");
    const forms = new Set<string>([
        secret,
        // Inside a JSON string, quotes, backslashes and newlines are escaped.
        JSON.stringify(secret).slice(1, -1),
        base64,
        base64.replace(/=+$/, ""),
        base64url,
        encodeURIComponent(secret),
        bytes.toString("hex"),
        bytes.toString("hex").toUpperCase(),
    ]);
    forms.delete("");
    return [...forms];
}

export function createRedactor(): Redactor {
    const secrets = new Set<string>();
    // One pattern for every form, longest first: a form that contains a shorter one is replaced as a whole, and the
    // marker that was just written is never scanned again.
    let literals: RegExp | undefined;

    function rebuild(): void {
        const forms = new Set<string>();
        for (const secret of secrets) for (const form of secretForms(secret)) forms.add(form);
        const sorted = [...forms].sort((a, b) => b.length - a.length);
        literals = sorted.length === 0 ? undefined : new RegExp(sorted.map(escapeRegExp).join("|"), "g");
    }

    function text(input: string): string {
        let out = literals === undefined ? input : input.replace(literals, REDACTED);
        for (const shape of SHAPES) out = out.replace(shape, REDACTED);
        return out;
    }

    return {
        register(value) {
            if (value === "" || secrets.has(value)) return;
            secrets.add(value);
            rebuild();
        },
        text,
        value: (input) => mapStrings(input, text),
        count: () => secrets.size,
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Applies `change` to every string in a structure, object keys included, and returns a copy. Plain objects and
 * arrays are walked. Numbers, booleans, dates, buffers and other objects are left as they are. Throws
 * `RedactionError` for a structure that is too deep or refers to itself.
 */
export function mapStrings<T>(input: T, change: (text: string) => string): T {
    const ancestors = new Set<object>();

    function walk(value: unknown, depth: number): unknown {
        if (typeof value === "string") return change(value);
        if (value === null || typeof value !== "object") return value;
        const walkable = Array.isArray(value) || isPlainObject(value);
        if (!walkable) return value;
        if (depth > MAX_DEPTH) throw new RedactionError("the structure is nested too deeply");
        if (ancestors.has(value)) throw new RedactionError("the structure refers to itself");
        ancestors.add(value);
        try {
            if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
            const out: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(value)) {
                // Two keys can change to the same name; keep both values instead of letting one overwrite the other.
                const base = change(key);
                let name = base;
                for (let n = 2; Object.hasOwn(out, name); n++) name = `${base}#${n}`;
                Object.defineProperty(out, name, {
                    value: walk(item, depth + 1),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            return out;
        } finally {
            ancestors.delete(value);
        }
    }

    return walk(input, 0) as T;
}
