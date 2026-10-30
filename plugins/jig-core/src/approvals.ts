// Approvals: asking the user, inside the tool call that is waiting for the answer.
//
// The user answers in Pi. A browser can show a long preview, but it never carries an answer, because the agent's shell
// can reach anything a browser button could call (see docs/approvals.md).
//
// Three answers: Allow, Allow for this session, and Decline. After Decline the user may type a reason, which goes into
// the block message the model reads.
//
// Two screens in this version:
// - the review screen, for a preview with a body (or a call that asks for it), in the terminal interface;
// - Pi's own selector, for everything else: short questions, hosts without a terminal interface (RPC), and the form
//   kind, which is not built yet.
//
// Tool calls from one model message run in parallel, and Pi has one dialog slot, so questions wait in a queue and are
// shown one at a time.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalKind, Preview } from "./contract.ts";
import { createReviewScreen } from "./review.ts";
import type { Answer } from "./records.ts";

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DECLINE = "Decline";

/** The longest decline reason that goes to the model. */
const MAX_REASON_CHARS = 500;
/** How much of a long preview the selector shows when the review screen is not available. */
const EXCERPT_LINES = 20;
const EXCERPT_CHARS = 2_000;

export interface AskRequest {
    /** The line naming the tool, action, environment and effect. */
    header: string;
    preview: Preview;
    kind: ApprovalKind;
}

export interface Approval {
    answer: Answer;
    /** What the user typed after declining, if anything. */
    reason?: string;
    /** True when the question was closed without an answer (Esc on a selector, the run was aborted). */
    dismissed: boolean;
    /** How long the call waited for the user, in milliseconds, including time in the queue. */
    waitedMs: number;
}

/** The parts of Pi's context a question needs. */
export type AskContext = Pick<ExtensionContext, "ui" | "mode" | "signal">;

export interface Approvals {
    ask(ctx: AskContext, request: AskRequest): Promise<Approval>;
}

export interface ApprovalsOptions {
    now?: () => number;
    /** Shows the rendered preview in the browser (the `o` key). The default writes the page and opens it. */
    openPreview?: (preview: Preview, header: string) => Promise<string>;
}

export function createApprovals(options: ApprovalsOptions = {}): Approvals {
    const now = options.now ?? Date.now;
    const openPreview = options.openPreview ?? (async () => "the browser is not available");

    // One question at a time. A failed question does not stop the ones behind it.
    let tail: Promise<unknown> = Promise.resolve();
    function inTurn<T>(job: () => Promise<T>): Promise<T> {
        const turn = tail.then(job, job);
        tail = turn.catch(() => undefined);
        return turn;
    }

    /** The question as a selector: the header, the summary and, for a long preview, its first lines. */
    function selectorTitle(request: AskRequest): string {
        const lines = [request.header, request.preview.summary];
        if (request.preview.body !== undefined) {
            const excerpt = request.preview.body.split("\n").slice(0, EXCERPT_LINES).join("\n");
            lines.push("", excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}...` : excerpt);
            const cut = request.preview.body.split("\n").length > EXCERPT_LINES || excerpt.length > EXCERPT_CHARS;
            if (cut) lines.push("(the rest is not shown here)");
        }
        return lines.join("\n");
    }

    async function showSelector(ctx: AskContext, request: AskRequest): Promise<Answer | undefined> {
        // A tool can say what the buttons mean for its call. The three words stay distinct, so one answer is never two.
        const given = request.preview.answers;
        const words = [word(given?.allow, ALLOW), word(given?.session, ALLOW_SESSION), word(given?.decline, DECLINE)];
        const labels = new Set(words).size === 3 ? words : [ALLOW, ALLOW_SESSION, DECLINE];
        const picked = await ctx.ui.select(selectorTitle(request), labels, signalOption(ctx));
        if (picked === labels[0]) return "allow";
        if (picked === labels[1]) return "allow-session";
        if (picked === labels[2]) return "decline";
        return undefined;
    }

    async function showReview(ctx: AskContext, request: AskRequest): Promise<Answer | undefined> {
        return ctx.ui.custom<Answer | undefined>((tui, theme, _keybindings, done) => {
            // A run that is aborted while the screen is open closes it.
            const onAbort = () => done(undefined);
            ctx.signal?.addEventListener("abort", onAbort, { once: true });
            const finish = (answer: Answer) => {
                ctx.signal?.removeEventListener("abort", onAbort);
                done(answer);
            };
            return createReviewScreen(
                {
                    header: request.header,
                    preview: request.preview,
                    openInBrowser: () => openPreview(request.preview, request.header),
                },
                tui,
                theme,
                finish,
            );
        });
    }

    async function askReason(ctx: AskContext): Promise<string | undefined> {
        const typed = await ctx.ui.input(
            "Why decline? The model will read this (optional)",
            "reason",
            signalOption(ctx),
        );
        const reason = typed?.trim();
        return reason === undefined || reason === "" ? undefined : reason.slice(0, MAX_REASON_CHARS);
    }

    return {
        async ask(ctx, request) {
            const queuedAt = now();
            return inTurn<Approval>(async () => {
                if (ctx.signal?.aborted) return { answer: "decline", dismissed: true, waitedMs: now() - queuedAt };
                // The form kind falls back to the selector in this version.
                const useReview = ctx.mode === "tui" && request.kind === "review";
                const picked = useReview ? await showReview(ctx, request) : await showSelector(ctx, request);
                if (picked === undefined) return { answer: "decline", dismissed: true, waitedMs: now() - queuedAt };
                const reason = picked === "decline" && !ctx.signal?.aborted ? await askReason(ctx) : undefined;
                return {
                    answer: picked,
                    dismissed: false,
                    ...(reason === undefined ? {} : { reason }),
                    waitedMs: now() - queuedAt,
                };
            });
        },
    };
}

/** A button's words from a tool: a short line of plain text, or the usual words. */
function word(given: unknown, usual: string): string {
    return typeof given === "string" &&
        given.length > 0 &&
        given.length <= 60 &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(given)
        ? given
        : usual;
}

function signalOption(ctx: AskContext): { signal: AbortSignal } | undefined {
    return ctx.signal === undefined ? undefined : { signal: ctx.signal };
}

/**
 * Which screen a call uses: the screen a rule or the tool chose, else the review screen when the preview has a body,
 * else a dialog.
 */
export function chooseKind(chosen: ApprovalKind | undefined, preview: Preview): ApprovalKind {
    return chosen ?? (preview.body !== undefined ? "review" : "dialog");
}
