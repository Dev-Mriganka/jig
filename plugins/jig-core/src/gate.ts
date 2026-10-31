// The `tool_call` hook: what happens before any tool runs.
//
//   classify → decide → (ask the user) → announce → let the call run, or block it
//
// Any failure in here blocks the call: a tool must never run because jig-core could not tell whether it may.
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { chooseKind } from "./approvals.ts";
import { classify, UNKNOWN_CLASS } from "./classify.ts";
import { JIG_EVENTS } from "./contract.ts";
import type { DecisionEvent } from "./contract.ts";
import { decide, sessionKey } from "./decide.ts";
import type { Verdict } from "./decide.ts";
import { errorMessage, InvalidInputError } from "./errors.ts";
import { frozenCall } from "./gates.ts";
import type { GateOutcome } from "./gates.ts";
import { buildPreview, defaultSummary, describeCall, isInvalidInput } from "./preview.ts";
import { homedir } from "node:os";
import { checkFileTool, filePathsOf } from "./protected-paths.ts";
import type { Answer, ErrorKind } from "./records.ts";
import { rememberCall } from "./state.ts";
import type { CallState, JigState } from "./state.ts";

export async function gate(
    state: JigState,
    event: ToolCallEvent,
    ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
    try {
        return await decideCall(state, event, ctx);
    } catch (error) {
        // Pi would also block a call whose handler throws, but with a message the model cannot act on.
        const reason = `jig-core could not decide: ${errorMessage(error)}`;
        const call = state.calls.get(event.toolCallId) ?? failedCall(state, event);
        call.blocked = { kind: "internal", line: "jig-core could not decide" };
        return { block: true, reason };
    }
}

/** What is known about a call that failed before it was classified. */
function failedCall(state: JigState, event: ToolCallEvent): CallState {
    const call: CallState = {
        toolCallId: event.toolCallId,
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        tool: event.toolName,
        classification: { ...UNKNOWN_CLASS, source: "unknown" },
        environmentKind: "external",
        masked: true,
        masksOwnResults: false,
        decision: "deny",
        decisionSource: "floor",
        facts: {},
    };
    rememberCall(state, call);
    return call;
}

/** The tool found the input invalid while classifying it: blocked with its message, and nobody is asked. */
function blockInvalid(state: JigState, event: ToolCallEvent, message: string): ToolCallEventResult {
    const call = failedCall(state, event);
    call.decisionSource = "tool";
    call.blocked = { kind: "invalid", line: "the tool found the input invalid" };
    return { block: true, reason: `Blocked by jig-core: ${event.toolName} cannot run with this input: ${message}` };
}

async function decideCall(
    state: JigState,
    event: ToolCallEvent,
    ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
    const policy = state.policy();
    const input = (event.input ?? {}) as Record<string, unknown>;
    const toolInfo = (name: string) => state.pi.getAllTools().find((tool) => tool.name === name);

    let classification: ReturnType<typeof classify>;
    try {
        classification = classify(event.toolName, input, {
            declarations: state.declarations,
            classifyRules: policy.classify,
            toolInfo,
        });
    } catch (error) {
        if (error instanceof InvalidInputError) return blockInvalid(state, event, error.message);
        throw error;
    }
    const environmentKind = policy.environments.kindOf(classification.environment);
    const declaration = state.declarations.get(event.toolName);
    // Only a label for the records: a tool without source information must not be blocked for lack of one.
    const plugin = classification.plugin ?? toolInfo(event.toolName)?.sourceInfo?.source;

    const command = typeof input.command === "string" ? input.command : undefined;
    const cwd = ctx.cwd ?? process.cwd();
    let verdict = decide({
        call: {
            tool: event.toolName,
            ...(classification.action === undefined ? {} : { action: classification.action }),
            environment: classification.environment,
            environmentKind,
            effect: classification.effect,
            ...(classification.atLeast === undefined ? {} : { atLeast: classification.atLeast }),
            ...(classification.approval === undefined ? {} : { approval: classification.approval }),
            ...(command === undefined ? {} : { command }),
            unknown: classification.source === "unknown",
        },
        rules: policy.rules,
        sessionAllows: state.sessionAllows,
        hasUI: ctx.hasUI,
        protectedRefusal: checkFileTool(event.toolName, input, {
            entries: policy.protectedPaths,
            cwd,
            home: homedir(),
        })?.reason,
    });

    // The gates other plugins registered see the call once the rules have decided. They can only make it stricter, and a
    // call that is already denied cannot be made stricter, so they are not asked.
    let gated: GateOutcome | undefined;
    if (verdict.decision !== "deny") {
        gated = await state.gates.check(
            frozenCall({
                toolCallId: event.toolCallId,
                tool: event.toolName,
                ...(classification.action === undefined ? {} : { action: classification.action }),
                environment: classification.environment,
                environmentKind,
                effect: classification.effect,
                decision: verdict.decision,
                input,
                cwd,
                paths: filePathsOf(event.toolName, input, { cwd, home: homedir() }),
            }),
        );
        verdict = tightened(verdict, gated, ctx.hasUI);
    }

    const call: CallState = {
        toolCallId: event.toolCallId,
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        tool: event.toolName,
        classification,
        environmentKind,
        masked: policy.environments.masks(classification.environment),
        masksOwnResults: declaration?.masksOwnResults === true,
        decision: verdict.decision,
        decisionSource: verdict.source,
        ...(gated === undefined ? {} : { gate: gated.gate }),
        ...(plugin === undefined ? {} : { plugin }),
        facts: {},
    };
    rememberCall(state, call);

    if (verdict.decision === "deny") {
        if (verdict.source === "gate" && gated !== undefined) {
            // The gate's own words are for the model and the user; the record keeps only that a gate held the call.
            const kind: ErrorKind = gated.failed ? "internal" : "denied";
            call.blocked = { kind, line: `held by gate ${gated.gate}` };
            announce(state, call);
            return { block: true, reason: gated.failed ? gated.reason : `Blocked by jig-core: ${gated.reason}` };
        }
        const kind: ErrorKind = verdict.floor === "no-screen" ? "no-screen" : "denied";
        call.blocked = { kind, line: `blocked: ${verdict.reason ?? "denied"}` };
        announce(state, call);
        return { block: true, reason: `Blocked by jig-core: ${verdict.reason ?? "denied"}.` };
    }
    if (verdict.decision === "ask") {
        return askUser(state, call, verdict, input, ctx, gated?.decision === "ask" ? gated : undefined);
    }

    announce(state, call);
    return undefined;
}

/**
 * The decision with the gates' answer laid over it, which can only make it stricter: a deny ends the call, an ask turns an
 * allow into an ask (and stays one), and with no screen to ask on an ask is a deny, as everywhere else.
 */
function tightened(verdict: Verdict, gated: GateOutcome | undefined, hasUI: boolean): Verdict {
    if (gated === undefined) return verdict;
    if (gated.decision === "deny") return { decision: "deny", source: "gate", reason: gated.reason };
    if (!hasUI) {
        return {
            decision: "deny",
            source: "floor",
            floor: "no-screen",
            reason: "this call needs approval and there is no screen to ask on",
        };
    }
    return verdict.decision === "ask" ? verdict : { ...verdict, decision: "ask", source: "gate" };
}

async function askUser(
    state: JigState,
    call: CallState,
    verdict: Verdict,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    asked?: GateOutcome,
): Promise<ToolCallEventResult | undefined> {
    const { classification } = call;
    const described = {
        tool: call.tool,
        ...(classification.action === undefined ? {} : { action: classification.action }),
        environment: classification.environment,
        effect: classification.effect,
    };

    const fallback = defaultSummary({ ...described, unknown: classification.source === "unknown" }, input);
    const preview = await buildPreview(state.declarations.get(call.tool), input, fallback);
    if (isInvalidInput(preview)) {
        call.blocked = { kind: "invalid", line: "the tool found the input invalid" };
        announce(state, call);
        return {
            block: true,
            reason: `Blocked by jig-core: ${call.tool} cannot run with this input: ${preview.invalid}`,
        };
    }
    const kind = chooseKind(verdict.approval, preview);
    // A gate that asks says why, in the question; the preview the tool reads back with `approvedPreview` stays as it built it.
    const shown =
        asked === undefined
            ? preview
            : { ...preview, summary: `${preview.summary}\nAsked by ${asked.gate}: ${asked.reason}` };
    const approval = await state.approvals.ask(ctx, { header: describeCall(described), preview: shown, kind });

    call.approval = { kind, answer: approval.answer, waitedMs: approval.waitedMs };
    if (approval.answer === "decline") {
        call.blocked = approval.dismissed
            ? { kind: "dismissed", line: "the question was closed without an answer" }
            : { kind: "declined", line: "declined by the user" };
        announce(state, call, "decline");
        const why = approval.dismissed
            ? "the question was closed without an answer"
            : approval.reason === undefined
              ? "the user declined this call"
              : `the user declined this call, and said: ${approval.reason}`;
        return { block: true, reason: `Blocked by jig-core: ${why}` };
    }

    // The tool can read this back with `approvedPreview()` and refuse to run if what it would do has changed.
    call.approvedPreview = preview;
    // A gate that asks asks again next time, so remembering the answer would remember nothing.
    if (approval.answer === "allow-session" && asked === undefined) {
        state.sessionAllows.add(
            sessionKey({
                tool: call.tool,
                ...(classification.action === undefined ? {} : { action: classification.action }),
                environment: classification.environment,
                ...(typeof input.command === "string" ? { command: input.command } : {}),
            }),
        );
    }
    announce(state, call, approval.answer);
    return undefined;
}

/** Tells other plugins about the decision. A listener that fails does not change the decision. */
function announce(state: JigState, call: CallState, answer?: Answer): void {
    const { classification } = call;
    const event: DecisionEvent = {
        toolCallId: call.toolCallId,
        tool: call.tool,
        ...(classification.action === undefined ? {} : { action: classification.action }),
        environment: classification.environment,
        environmentKind: call.environmentKind,
        effect: classification.effect,
        decision: call.decision,
        source: call.decisionSource,
        ...(call.gate === undefined ? {} : { gate: call.gate }),
        ...(answer === undefined ? {} : { answer }),
    };
    try {
        state.pi.events.emit(JIG_EVENTS.decision, event);
    } catch {
        // See above.
    }
}
