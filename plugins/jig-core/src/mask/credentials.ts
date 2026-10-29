// High-confidence credential shapes, found in any text regardless of field name.
const MARK = "[removed:credential]";

interface Shape {
    test(text: string): boolean;
    /** Replaces every occurrence. */
    replace(text: string): string;
}

/** A case-insensitive pattern, as credential keywords appear in any case. */
function regexShape(pattern: RegExp, replacement: string): Shape {
    const once = new RegExp(pattern.source, "i");
    const every = new RegExp(pattern.source, "gi");
    return {
        test: (text) => once.test(text),
        replace: (text) => text.replace(every, () => replacement),
    };
}

const TOKEN_RUN = /[A-Za-z0-9_-]+/g;

/** Offset of a JWT header (`eyJ`) at a word boundary inside a run of token characters, with a character after it. */
function headerOffset(run: string): number {
    const lower = run.toLowerCase();
    for (let at = lower.indexOf("eyj"); at >= 0 && at + 3 < lower.length; at = lower.indexOf("eyj", at + 1)) {
        if (at === 0 || lower[at - 1] === "-") return at;
    }
    return -1;
}

/** End of the dot-separated part that starts right after the `.` at `dot`, or -1 when `dot` is not followed by one. */
function partEnd(text: string, dot: number): number {
    if (text[dot] !== ".") return -1;
    const part = /[A-Za-z0-9_-]+/y;
    part.lastIndex = dot + 1;
    return part.exec(text) === null ? -1 : part.lastIndex;
}

/**
 * `eyJ<header>.<payload>.<signature>`. Found run by run rather than with one pattern: a pattern that reads a long
 * header run and then fails would be retried at every `eyJ` inside it, which is quadratic on `eyJ-eyJ-eyJ-...`.
 */
const jwt: Shape = {
    test: (text) => jwt.replace(text) !== text,
    replace(text) {
        let out = "";
        let cursor = 0;
        const runs = new RegExp(TOKEN_RUN.source, "g");
        for (let run = runs.exec(text); run !== null; run = runs.exec(text)) {
            const offset = headerOffset(run[0]);
            if (offset < 0) continue;
            const payloadEnd = partEnd(text, run.index + run[0].length);
            const signatureEnd = payloadEnd < 0 ? -1 : partEnd(text, payloadEnd);
            if (signatureEnd < 0) continue;
            out += text.slice(cursor, run.index + offset) + MARK;
            cursor = signatureEnd;
            runs.lastIndex = signatureEnd;
        }
        return out + text.slice(cursor);
    },
};

const SECRET_NAMES = "client_secret|access_token|refresh_token|X-Amz-Signature|X-Goog-Signature|Signature|sig|token";

const SHAPES: readonly Shape[] = [
    // Bearer <token>
    regexShape(/\bBearer\s*[A-Za-z0-9._~+/%=-]{16,}/, MARK),
    // Authorization: [Basic|Bearer|Token] <value>
    regexShape(/\bAuthorization["']?\s*:\s*(?:(?:Basic|Bearer|Token)\s*)?[^\s"'\\[{]{16,}/, `Authorization: ${MARK}`),
    jwt,
    // tok_ API tokens
    regexShape(/\btok_[A-Za-z0-9_]{12,}\b/, MARK),
    // secret-bearing assignments and signed-URL parameters
    regexShape(new RegExp(String.raw`\b(?:${SECRET_NAMES})["']?\s*[=:]\s*["']?[^\s&#"'<>[\]}]+`), MARK),
];

export function hasCredentialShape(text: string): boolean {
    return SHAPES.some((shape) => shape.test(text));
}

export function removeCredentialShapes(text: string): string {
    return SHAPES.reduce((current, shape) => shape.replace(current), text);
}
