// What happens after a tool ran:
//
//   `tool_result`        redact → mask (production) → cap, and replace the result only when something changed
//   `tool_execution_end` write the call's record
//   `turn_end`           write the turn's record
//
// Pi ignores an error thrown by a `tool_result` hook and lets the unchanged result through. That would leak, so every
// failure in here replaces the result with a short error instead: a result is withheld, never passed unchecked.
import type {
    ExtensionContext,
    ToolExecutionEndEvent,
    ToolResultEvent,
    ToolResultEventResult,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { capContent, textOf } from "./cap.ts";
import type { Content } from "./cap.ts";
import { errorMessage } from "./errors.ts";
import { callRecord, cleanFacts, oneLine, turnRecord, writeRecord } from "./records.ts";
import type { ErrorKind, Outcome } from "./records.ts";
import type { CallState, JigState } from "./state.ts";

type Parts = { content: Content[]; structured: ToolResultEvent["structuredContent"]; details: unknown };
type Changed = { content: boolean; structured: boolean; details: boolean };

/** A result that cannot be shown. `text` is what the model reads instead. */
class Withheld extends Error {}

function withheld(text: string): ToolResultEventResult {
    // Without `structuredContent` in the answer Pi drops it, which is what we want. `details` is replaced too.
    return { content: [{ type: "text", text }], details: {}, isError: true };
}

function sameJson(a: unknown, b: unknown): boolean {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        // Not JSON (a BigInt, say): assume it changed, which only means the replacement is returned.
        return false;
    }
}

/** Applies a text change to the text blocks and a value change to the structured parts, and notes what changed. */
function transform(parts: Parts, text: (input: string) => string, value: <T>(input: T) => T, changed: Changed): Parts {
    const content = parts.content.map((block) => {
        if (block.type !== "text") return block;
        const next = text(block.text);
        if (next === block.text) return block;
        changed.content = true;
        return { ...block, text: next };
    });
    const structured = parts.structured === undefined ? undefined : value(parts.structured);
    if (!sameJson(parts.structured, structured)) changed.structured = true;
    const details = parts.details === undefined ? undefined : value(parts.details);
    if (!sameJson(parts.details, details)) changed.details = true;
    return { content, structured, details };
}

export function toolResult(
    state: JigState,
    event: ToolResultEvent,
    ctx: ExtensionContext,
): ToolResultEventResult | undefined {
    const call = state.calls.get(event.toolCallId);
    try {
        return protect(state, event, ctx);
    } catch (error) {
        const text = error instanceof Withheld ? error.message : "result withheld: jig-core could not process it";
        if (call !== undefined) call.withheld = text;
        return withheld(text);
    }
}

function protect(state: JigState, event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined {
    const call = state.calls.get(event.toolCallId);
    // A result with no call on file was never decided. Treat it like production: mask it.
    const masked = call === undefined ? true : call.masked && !call.masksOwnResults;
    const changed: Changed = { content: false, structured: false, details: false };
    let parts: Parts = { content: event.content, structured: event.structuredContent, details: event.details };

    // 1. Redact: every resolved secret and every secret-shaped string.
    try {
        parts = transform(
            parts,
            (text) => state.redactor.text(text),
            (value) => state.redactor.value(value),
            changed,
        );
    } catch {
        throw new Withheld("result withheld: it could not be redacted");
    }

    // 2. Mask: customer personal data in production results, for tools that do not mask their own.
    if (masked) {
        try {
            const masker = state.masker();
            parts = transform(
                parts,
                (text) => masker.text(text),
                (value) => masker.value(value),
                changed,
            );
            // An image cannot be masked, so it does not pass.
            if (parts.content.some((block) => block.type === "image")) {
                const note: Content = { type: "text", text: "[image withheld: images cannot be masked]" };
                parts = { ...parts, content: parts.content.map((block) => (block.type === "image" ? note : block)) };
                changed.content = true;
            }
        } catch {
            throw new Withheld("result withheld: it could not be masked");
        }
    }

    // 3. Cap: last, so the spill file holds the text as the model would have seen it.
    const capped = capContent({
        tool: event.toolName,
        toolCallId: event.toolCallId,
        sessionId: sessionIdOf(ctx),
        content: parts.content,
    });
    if (capped !== undefined) {
        parts = { ...parts, content: capped.content };
        changed.content = true;
        if (call !== undefined && capped.spill !== undefined) call.spill = capped.spill;
    }

    if (!changed.content && !changed.structured && !changed.details) return undefined;
    const result: ToolResultEventResult = {};
    if (changed.content) {
        result.content = parts.content;
        // Pi drops `structuredContent` when `content` is replaced and it is not returned along with it.
        if (parts.structured !== undefined) result.structuredContent = parts.structured;
    } else if (changed.structured && parts.structured !== undefined) {
        result.structuredContent = parts.structured;
    }
    if (changed.details) result.details = parts.details;
    return result;
}

function sessionIdOf(ctx: ExtensionContext): string {
    try {
        return ctx.sessionManager.getSessionId();
    } catch {
        return "unknown";
    }
}

// ---- records -----------------------------------------------------------------------------------------------------------

/** Writes the call's record and forgets the call. A failure to write is noted for `/jig`, never thrown: appending a line
 *  must not break a tool call. */
export function finishCall(state: JigState, event: ToolExecutionEndEvent, ctx: ExtensionContext): void {
    const call = state.calls.get(event.toolCallId);
    state.calls.delete(event.toolCallId);
    try {
        const { outcome, errorKind, error } = outcomeOf(state, event, call);
        const classification = call?.classification;
        const facts = cleanFacts(call?.facts ?? {}, (text) => state.redactor.text(text));
        const plugin = call?.plugin;
        const parent = call?.parentToolCallId ?? event.parentToolCallId;
        writeRecord(
            callRecord(
                {
                    session: sessionIdOf(ctx),
                    ...(state.ticket === undefined ? {} : { ticket: state.ticket }),
                    tool: event.toolName,
                    ...(classification?.action === undefined ? {} : { action: classification.action }),
                    ...(plugin === undefined ? {} : { plugin }),
                    ...(classification === undefined || call === undefined
                        ? {}
                        : {
                              environment: classification.environment,
                              environmentKind: call.environmentKind,
                              effect: classification.effect,
                              decision: call.decision,
                              decisionSource: call.decisionSource,
                          }),
                    ...(call?.approval === undefined
                        ? {}
                        : {
                              approval: call.approval.kind,
                              answer: call.approval.answer,
                              waitedMs: call.approval.waitedMs,
                          }),
                    outcome,
                    ...(errorKind === undefined ? {} : { errorKind }),
                    ...(error === undefined ? {} : { error }),
                    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
                    toolCallId: event.toolCallId,
                    ...(parent === undefined ? {} : { parentToolCallId: parent }),
                    ...(call?.spill === undefined ? {} : { spill: call.spill }),
                    ...(facts === undefined ? {} : { facts }),
                },
                state.now(),
            ),
            state.now(),
        );
    } catch (error) {
        state.recordsProblem = errorMessage(error);
    }
}

function outcomeOf(
    state: JigState,
    event: ToolExecutionEndEvent,
    call: CallState | undefined,
): { outcome: Outcome; errorKind?: ErrorKind; error?: string } {
    if (call?.blocked !== undefined)
        return { outcome: "blocked", errorKind: call.blocked.kind, error: call.blocked.line };
    if (call?.withheld !== undefined) return { outcome: "error", errorKind: "withheld", error: oneLine(call.withheld) };
    if (!event.isError) return { outcome: "ok" };
    // A call that never reached the tool manager failed before its tool could run, in Pi's own checks. Pi's message can
    // quote the arguments, and a record never holds those, so only the kind is kept.
    if (call === undefined) return { outcome: "error", errorKind: "not-run" };
    // The result already went through redaction and masking in `tool_result`; redact again for safety.
    const text = textOf((event.result?.content ?? []) as Content[]);
    return { outcome: "error", errorKind: "tool", error: oneLine(state.redactor.text(text)) };
}

/** Writes the record of one model turn from Pi's usage data. */
export function finishTurn(state: JigState, event: TurnEndEvent, ctx: ExtensionContext): void {
    const message = event.message;
    if (!("role" in message) || message.role !== "assistant") return;
    try {
        const { usage } = message;
        writeRecord(
            turnRecord(
                {
                    session: sessionIdOf(ctx),
                    ...(state.ticket === undefined ? {} : { ticket: state.ticket }),
                    model: message.model,
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    cost: usage.cost.total,
                },
                state.now(),
            ),
            state.now(),
        );
    } catch (error) {
        state.recordsProblem = errorMessage(error);
    }
}
