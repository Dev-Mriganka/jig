// Plan, preview, run. Each action works out what it would do (checks the input, reads the state, builds the text the
// user would see, and a digest of it), and only then does it. The same plan serves two callers:
//   - jig-core asks for the preview when a rule says "ask", and shows it to the user;
//   - execute() plans again, refuses if the plan differs from the one the user approved, and runs it.
// So whatever changed while the user was reading (a new commit, a moved pull request head) is caught, not pushed.
import { createHash } from "node:crypto";
import type { Facts, Preview } from "../../jig-core/src/contract.ts";
import { jig } from "../../jig-core/src/client.ts";
import type { GitSettings } from "./config.ts";

/** What every action is given: the call it belongs to, its abort signal, and the settings read for this call. */
export interface Call {
    toolCallId: string;
    signal?: AbortSignal;
    settings: GitSettings;
}

/** What an action returns to the model: plain text, plus a few facts for the record. */
export interface Reply {
    text: string;
    /** Named numbers or short codes, added to this call's record. */
    facts?: Facts;
    /** Structured data for tests and renderers. Never needed to understand `text`. */
    details?: unknown;
}

/** What a call will do, worked out before it is done. */
export interface Planned {
    preview: Preview;
    run(): Promise<Reply>;
}

/** A short digest of whatever was shown to the user. Equal digests mean the same plan. */
export function digest(...parts: readonly unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/**
 * Refuses to run when the user approved a preview and the call would now do something else. When the call did not ask
 * (a rule allowed it), jig-core has no approved preview and there is nothing to compare.
 */
export function checkUnchanged(toolCallId: string, planned: Planned, label: string): void {
    const approved = jig().approvedPreview(toolCallId);
    if (approved?.fingerprint === undefined || planned.preview.fingerprint === undefined) return;
    if (approved.fingerprint !== planned.preview.fingerprint) {
        throw new Error(`${label} changed since the preview; run it again to see the new preview`);
    }
}

/** A plan for an action that changes nothing and needs no approval: the preview is one line. */
export function readOnly(summary: string, run: () => Promise<Reply>): Planned {
    return { preview: { summary }, run };
}

/** A preview for the review screen: one summary line and the text to read. */
export function reviewPreview(
    summary: string,
    body: string,
    fingerprint: string,
    format: Preview["format"] = "markdown",
): Preview {
    return { summary, body, format, fingerprint };
}

/** Pi's result for a reply: the text for the model, and the facts added to the record. */
export function toResult(
    toolCallId: string,
    reply: Reply,
): { content: { type: "text"; text: string }[]; details: unknown } {
    if (reply.facts !== undefined) jig().addFacts(toolCallId, reply.facts);
    return { content: [{ type: "text", text: reply.text }], details: reply.details };
}
