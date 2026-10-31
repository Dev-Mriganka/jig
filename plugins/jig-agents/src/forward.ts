// A child's questions, brought to the user's screen. In RPC mode Pi turns the child's dialog into an `extension_ui_request` with a random
// id; the parent shows it, one at a time and under a line of its own, and answers with an `extension_ui_response` carrying the same id.
// Every failure is a no: the request is cancelled, which the child's jig-core counts as a decline.
import { oneLine, shaped, stripControl } from "./clean.ts";
import type { Timers } from "./host.ts";
import type { Wire } from "./rpc.ts";

/** At most this many options, each at most this long. A request with more or longer ones is cancelled. */
export const MAX_OPTIONS = 5;
export const MAX_OPTION_CHARS = 100;
const MAX_TITLE_CHARS = 4000;
const MAX_ID_CHARS = 200;
/** The words jig-core's selector uses for a session-wide yes, and what the user sees instead: it ends with the child. */
const STOCK_SESSION = "Allow for this session";
const SHOWN_SESSION = "Allow for this subagent";
/** Methods that need no answer: free text from the child, ignored. */
const FIRE_AND_FORGET: ReadonlySet<string> = new Set([
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
]);

export type Parsed =
    | { kind: "ignore" }
    | { kind: "cancel"; id: string; why: string }
    | { kind: "select"; id: string; title: string; options: string[]; timeout?: number }
    | { kind: "confirm"; id: string; title: string; message: string; timeout?: number }
    | { kind: "input"; id: string; title: string; placeholder?: string; timeout?: number };

export type Askable = Exclude<Parsed, { kind: "ignore" } | { kind: "cancel" }>;

/** What goes back on the pipe. */
export type UiAnswer = { cancelled: true } | { value: string } | { confirmed: boolean };

function timeoutOf(raw: unknown): number | undefined {
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Reads a request without trusting it. Anything it cannot read is cancelled; only a request with no usable id is ignored. */
export function parseRequest(request: Wire): Parsed {
    const id = request.id;
    if (typeof id !== "string" || id === "" || id.length > MAX_ID_CHARS) return { kind: "ignore" };
    const method = request.method;
    if (typeof method !== "string") return { kind: "cancel", id, why: "the request has no method" };
    if (FIRE_AND_FORGET.has(method)) return { kind: "ignore" };
    const timeout = timeoutOf(request.timeout);
    const withTimeout = timeout === undefined ? {} : { timeout };
    const title = request.title;
    if (typeof title !== "string" || title.length > MAX_TITLE_CHARS) {
        return { kind: "cancel", id, why: "the request has no readable title" };
    }
    switch (method) {
        case "select": {
            const options = request.options;
            if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS) {
                return { kind: "cancel", id, why: `a selector needs 1 to ${MAX_OPTIONS} options` };
            }
            if (
                !options.every(
                    (option) => typeof option === "string" && option.length > 0 && option.length <= MAX_OPTION_CHARS,
                )
            ) {
                return { kind: "cancel", id, why: `an option is empty or longer than ${MAX_OPTION_CHARS} characters` };
            }
            return { kind: "select", id, title, options: options as string[], ...withTimeout };
        }
        case "confirm": {
            const message = typeof request.message === "string" ? request.message.slice(0, MAX_TITLE_CHARS) : "";
            return { kind: "confirm", id, title, message, ...withTimeout };
        }
        case "input": {
            const placeholder = typeof request.placeholder === "string" ? oneLine(request.placeholder, 100) : undefined;
            return { kind: "input", id, title, ...(placeholder === undefined ? {} : { placeholder }), ...withTimeout };
        }
        case "editor":
            return { kind: "cancel", id, why: "an editor cannot be forwarded" };
        default:
            return { kind: "cancel", id, why: `the method ${oneLine(method, 40)} is not one this plugin forwards` };
    }
}

/** The question as the user reads it: the plugin's own first line, then the child's text, indented, cleaned and cut. */
export function questionTitle(who: { name: string; role: string }, parsed: Askable, others: number): string {
    const waiting = others > 0 ? ` (${others} more waiting)` : "";
    const header = `Subagent "${who.name}" (${who.role}) asks. The text below comes from the child.${waiting}`;
    const text =
        parsed.kind === "confirm" && parsed.message !== "" ? `${parsed.title}\n${parsed.message}` : parsed.title;
    return `${header}\n${shaped(text, { indent: "  ", maxLines: 30, maxLineChars: 200 })}`;
}

/** The options as shown, with the stock session answer renamed. Undefined when two would look the same. */
export function shownOptions(options: readonly string[]): Array<{ shown: string; original: string }> | undefined {
    const mapped = options.map((original) => ({
        original,
        shown: original === STOCK_SESSION ? SHOWN_SESSION : oneLine(original, MAX_OPTION_CHARS),
    }));
    return new Set(mapped.map((entry) => entry.shown)).size === mapped.length &&
        mapped.every((entry) => entry.shown !== "")
        ? mapped
        : undefined;
}

/** The parts of Pi's context a question needs. */
export interface Screen {
    hasUI: boolean;
    signal?: AbortSignal | undefined;
    ui: {
        select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
        confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
        input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
    };
}

export interface AskDeps {
    /** The latest screen Pi gave the plugin, or undefined. */
    screen(): Screen | undefined;
    /** jig-core's queue: one question at a time, behind its own. */
    inTurn<T>(job: () => Promise<T>): Promise<T>;
    /** Questions waiting for the screen across all children, the one on screen included. */
    queue: { waiting: number };
    /** How long a question may wait, queue included. */
    waitMs: number;
    timers: Timers;
}

/** How a question ended, for the child's transcript. */
export type Verdict = "answered" | "no screen" | "timed out" | "closed" | "unreadable";

export interface Asked {
    answer: UiAnswer;
    verdict: Verdict;
}

const CANCEL: UiAnswer = { cancelled: true };

/**
 * Puts one question to the user and returns the answer to send back. It never rejects: any failure is a cancelled request. `closed` is
 * aborted when the child ends, so nobody is asked about a child that is gone.
 */
export async function askUser(
    deps: AskDeps,
    who: { name: string; role: string },
    parsed: Askable,
    closed: AbortSignal,
): Promise<Asked> {
    const screen = deps.screen();
    if (screen === undefined || !screen.hasUI) return { answer: CANCEL, verdict: "no screen" };
    const options = parsed.kind === "select" ? shownOptions(parsed.options) : undefined;
    if (parsed.kind === "select" && options === undefined) return { answer: CANCEL, verdict: "unreadable" };

    const controller = new AbortController();
    let verdict: Verdict = "answered";
    const stop = (why: Verdict) => {
        if (!controller.signal.aborted) {
            verdict = why;
            controller.abort();
        }
    };
    const waits = [deps.waitMs, parsed.timeout].filter((ms): ms is number => ms !== undefined);
    const timer = deps.timers.setTimeout(() => stop("timed out"), Math.min(...waits));
    const onClosed = () => stop("closed");
    closed.addEventListener("abort", onClosed, { once: true });
    // The parent's own run being aborted (Esc) closes the question too. An idle parent has no run signal.
    const runSignal = screen.signal;
    const onRun = () => stop("closed");
    runSignal?.addEventListener("abort", onRun, { once: true });
    if (closed.aborted) stop("closed");
    if (runSignal?.aborted) stop("closed");

    /** The question itself, run when no other is open. */
    const show = async (): Promise<Asked> => {
        if (controller.signal.aborted) return { answer: CANCEL, verdict };
        const opts = { signal: controller.signal };
        const title = questionTitle(who, parsed, Math.max(0, deps.queue.waiting - 1));
        let answer: UiAnswer = CANCEL;
        if (parsed.kind === "select" && options !== undefined) {
            const picked = await screen.ui.select(
                title,
                options.map((entry) => entry.shown),
                opts,
            );
            const chosen = options.find((entry) => entry.shown === picked);
            if (chosen !== undefined) answer = { value: chosen.original };
        } else if (parsed.kind === "confirm") {
            const yes = await screen.ui.confirm(title, "", opts);
            answer = { confirmed: yes === true };
        } else if (parsed.kind === "input") {
            const typed = await screen.ui.input(title, parsed.placeholder, opts);
            if (typeof typed === "string") answer = { value: stripControl(typed).slice(0, 2000) };
        }
        if (controller.signal.aborted) return { answer: CANCEL, verdict };
        return { answer, verdict: "answered" };
    };

    deps.queue.waiting++;
    try {
        const queued = deps.inTurn(async () => {
            // Counted as waiting until the question ends, so the next one's header does not count this one.
            try {
                return await show();
            } finally {
                deps.queue.waiting = Math.max(0, deps.queue.waiting - 1);
            }
        });
        queued.catch(() => undefined);
        // A question stuck behind another still runs out of time: the wait is counted from the request, not from the screen.
        const expired = new Promise<Asked>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve({ answer: CANCEL, verdict }), { once: true });
        });
        return await Promise.race([queued, expired]);
    } catch {
        return { answer: CANCEL, verdict: "unreadable" };
    } finally {
        deps.timers.clearTimeout(timer);
        closed.removeEventListener("abort", onClosed);
        runSignal?.removeEventListener("abort", onRun);
        controller.abort();
    }
}
