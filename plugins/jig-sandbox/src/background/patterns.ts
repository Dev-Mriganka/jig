// The patterns that wake the agent: checking them before the task starts, and matching them against its lines.
//
// A pattern is a JavaScript regular expression, written without the slashes and matched against one line of output at a
// time, case-sensitively. The agent writes them, and a regular expression can be made to take very long on a line of the
// wrong shape, so a pattern is refused when it holds a construct that can: a back-reference, a look-behind, or a repeat
// inside a repeat (`(a+)+`). Each line is also cut to 4 KiB before it is matched.
export const MAX_PATTERNS = 5;
export const MAX_PATTERN_CHARS = 200;
/** The largest count in `{n,m}`: `a{1,100000}` is a slow pattern in disguise. */
const MAX_COUNT = 1_000;
/** Only the start of a line is matched. */
const MAX_MATCH_LINE = 4_096;
/** A line without a newline is matched after this much quiet, so a prompt still counts. */
const IDLE_MS = 500;

/** What is wrong with one pattern, or undefined when it is fine. */
export function patternProblem(source: string): string | undefined {
    if (source.trim() === "") return "it is empty";
    if (source.length > MAX_PATTERN_CHARS) return `it is longer than ${MAX_PATTERN_CHARS} characters`;
    if (/[\u0000-\u001f\u007f]/.test(source)) return "it holds a control character or a line break";
    const construct = riskyConstruct(source);
    if (construct !== undefined) return `it uses ${construct}, which can make matching slow`;
    let compiled: RegExp;
    try {
        compiled = new RegExp(source);
    } catch (error) {
        return `it is not a valid regular expression (${(error as Error).message.replace(/^Invalid regular expression: /, "")})`;
    }
    if (compiled.test("")) return "it matches an empty line, so it would match every line";
    return undefined;
}

/** The problem with a `notifyOn` list, written for the agent, or undefined when it is fine. */
export function screenPatterns(kind: "ready" | "error", list: unknown): string | undefined {
    if (list === undefined) return undefined;
    if (!Array.isArray(list)) return `notifyOn.${kind} must be a list of regular expressions as text.`;
    if (list.length > MAX_PATTERNS) {
        return `notifyOn.${kind} has ${list.length} patterns; at most ${MAX_PATTERNS}.`;
    }
    for (const [index, item] of list.entries()) {
        if (typeof item !== "string") return `notifyOn.${kind}[${index}] must be text.`;
        const problem = patternProblem(item);
        if (problem !== undefined) return `notifyOn.${kind}[${index}] (${item.slice(0, 60)}) is refused: ${problem}.`;
    }
    return undefined;
}

/**
 * Finds a back-reference, a look-behind or a repeat inside a repeat by reading the pattern once, group by group. This is not
 * a regular expression parser, only enough of one to know where groups, classes, escapes and repeats are.
 */
function riskyConstruct(source: string): string | undefined {
    // One entry per open group: whether a repeat that can run long sits inside it.
    const groups: Array<{ repeats: boolean }> = [];
    let inClass = false;
    /** After an atom, a quantifier may follow. A closed group that held a long repeat is waiting for it. */
    let closed: { repeats: boolean } | undefined;

    const markRepeat = (): string | undefined => {
        if (closed?.repeats) return "a repeat inside a repeat";
        // The repeat sits in the open group, and in every group around it.
        for (const group of groups) group.repeats = true;
        if (closed !== undefined) closed = undefined;
        return undefined;
    };

    for (let at = 0; at < source.length; at++) {
        const char = source[at] as string;
        if (char === "\\") {
            const next = source[at + 1] ?? "";
            if (!inClass && /[1-9]/.test(next)) return "a back-reference";
            if (!inClass && next === "k" && source[at + 2] === "<") return "a back-reference";
            at++;
            closed = undefined;
            continue;
        }
        if (inClass) {
            if (char === "]") inClass = false;
            continue;
        }
        if (char === "[") {
            inClass = true;
            closed = undefined;
            continue;
        }
        if (char === "(") {
            if (source.startsWith("(?<=", at) || source.startsWith("(?<!", at)) return "a look-behind";
            groups.push({ repeats: false });
            closed = undefined;
            continue;
        }
        if (char === ")") {
            closed = groups.pop();
            continue;
        }
        if (char === "*" || char === "+") {
            const problem = markRepeat();
            if (problem !== undefined) return problem;
            // A lazy or possessive mark after the quantifier is not another repeat.
            if (source[at + 1] === "?") at++;
            continue;
        }
        if (char === "{") {
            const counts = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(at));
            if (counts === null) {
                closed = undefined;
                continue;
            }
            const low = Number(counts[1]);
            const high =
                counts[2] === undefined ? low : counts[2] === "" ? Number.POSITIVE_INFINITY : Number(counts[2]);
            if (low > MAX_COUNT || (Number.isFinite(high) && high > MAX_COUNT)) return "a repeat count over 1,000";
            // A count of at most a few does not make a repeat that grows with the line; an open end or a wide one does.
            if (high > 3) {
                const problem = markRepeat();
                if (problem !== undefined) return problem;
            } else {
                closed = undefined;
            }
            at += counts[0].length - 1;
            if (source[at + 1] === "?") at++;
            continue;
        }
        closed = undefined;
    }
    return undefined;
}

export interface Match {
    kind: "ready" | "error";
    /** The pattern as the agent wrote it. */
    pattern: string;
    /** The line that matched. */
    line: string;
    /** Where the line starts in the log. */
    offset: number;
}

export interface MatcherOptions {
    ready: readonly string[];
    error: readonly string[];
    onMatch(match: Match): void;
    /** Quiet before a line without a newline is matched. Default 500 ms. */
    idleMs?: number;
}

/**
 * Splits output into lines at a line feed or a carriage return (so a progress meter or a prompt counts), keeps the
 * unfinished line, and matches it after a pause. A `ready` pattern is matched until it has matched once.
 */
export class LineMatcher {
    private readonly ready: Array<{ source: string; test: RegExp }>;
    private readonly error: Array<{ source: string; test: RegExp }>;
    private readonly options: MatcherOptions;
    private parts: Buffer[] = [];
    private held = 0;
    private lineStart = 0;
    private readySeen = false;
    private timer: NodeJS.Timeout | undefined;

    constructor(options: MatcherOptions) {
        this.options = options;
        this.ready = options.ready.map((source) => ({ source, test: new RegExp(source) }));
        this.error = options.error.map((source) => ({ source, test: new RegExp(source) }));
    }

    /** `offset` is where `data` starts in the log. */
    push(data: Buffer, offset: number): void {
        let from = 0;
        for (let at = 0; at < data.length; at++) {
            const byte = data[at];
            if (byte !== 0x0a && byte !== 0x0d) continue;
            this.take(data.subarray(from, at), offset + from);
            this.emit();
            from = at + 1;
        }
        if (from < data.length) this.take(data.subarray(from), offset + from);
        this.arm();
    }

    /** Matches whatever is held as if it were a whole line. */
    flush(): void {
        this.disarm();
        this.emit();
    }

    dispose(): void {
        this.disarm();
        this.parts = [];
        this.held = 0;
    }

    private take(part: Buffer, offset: number): void {
        if (part.length === 0) return;
        if (this.held === 0) this.lineStart = offset;
        const room = MAX_MATCH_LINE - Math.min(this.held, MAX_MATCH_LINE);
        if (room > 0) this.parts.push(part.subarray(0, room));
        this.held += part.length;
    }

    private emit(): void {
        if (this.held === 0) return;
        const text = Buffer.concat(this.parts).toString("utf8").trim();
        const offset = this.lineStart;
        this.parts = [];
        this.held = 0;
        if (text === "") return;
        if (!this.readySeen) {
            const hit = this.ready.find((pattern) => pattern.test.test(text));
            if (hit !== undefined) {
                this.readySeen = true;
                this.options.onMatch({ kind: "ready", pattern: hit.source, line: text, offset });
            }
        }
        const hit = this.error.find((pattern) => pattern.test.test(text));
        if (hit !== undefined) this.options.onMatch({ kind: "error", pattern: hit.source, line: text, offset });
    }

    private arm(): void {
        this.disarm();
        if (this.held === 0) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.emit();
        }, this.options.idleMs ?? IDLE_MS);
        this.timer.unref();
    }

    private disarm(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }
}
