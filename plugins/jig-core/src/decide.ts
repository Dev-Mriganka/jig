// The decision: allow, ask or deny, for one classified call. A pure function, so every cell of the rules table and
// every part of the floor can be tested without Pi.
//
// The steps run in this order, and each can only change what the step before it produced:
//   1. the table (environment kind × effect), or the unknown default for a call nothing classified;
//   2. the tool's own `atLeast`, which can only make the call stricter;
//   3. the first rule in configuration that matches, which can make it stricter or looser;
//   4. a session allow, which turns an ask into an allow;
//   5. the floor, last, which configuration can never lower.
import { matchesName } from "./classify.ts";
import type {
    ApprovalKind,
    Decision,
    DecisionEvent,
    Effect,
    EnvironmentKind,
    EnvironmentName,
    Rule,
} from "./contract.ts";

/** Where the decision came from. The same words `DecisionEvent` uses. */
export type DecisionSource = DecisionEvent["source"];

/** What `decide` needs to know about a call. */
export interface DecidedCall {
    tool: string;
    action?: string;
    environment: EnvironmentName;
    environmentKind: EnvironmentKind;
    effect: Effect;
    atLeast?: "ask" | "deny";
    approval?: ApprovalKind;
    /** True when nothing classified the call, so the unknown default applies. */
    unknown: boolean;
}

export interface DecideInput {
    call: DecidedCall;
    /** Personal rules first, then the company's. The first match decides. */
    rules: readonly Rule[];
    /** Keys from `sessionKey`, added when the user answered "Allow for this session". */
    sessionAllows: ReadonlySet<string>;
    /** False when there is no screen to ask on. */
    hasUI: boolean;
}

export interface Verdict {
    decision: Decision;
    source: DecisionSource;
    /** The screen a rule or the tool chose for asking. */
    approval?: ApprovalKind;
    /** What the floor changed, when it did. */
    floor?: "production-write" | "unknown-tool" | "no-screen";
    /** A plain sentence for the model, set when the decision is deny. */
    reason?: string;
}

const TABLE: Readonly<Record<EnvironmentKind, Readonly<Record<Effect, Decision>>>> = {
    local: { read: "allow", write: "allow" },
    external: { read: "allow", write: "ask" },
    test: { read: "allow", write: "ask" },
    production: { read: "allow", write: "deny" },
};

const STRICTNESS: Readonly<Record<Decision, number>> = { allow: 0, ask: 1, deny: 2 };

/** The key under which "Allow for this session" is remembered. It includes the environment, so approving a deploy to
 *  one test environment does not approve a deploy to another. */
export function sessionKey(call: Pick<DecidedCall, "tool" | "action" | "environment">): string {
    return JSON.stringify([call.tool, call.action ?? null, call.environment]);
}

/** Whether a rule applies to a call. A rule that leaves out `action`, `environment` or `effect` applies to any. */
export function ruleMatches(rule: Rule, call: DecidedCall): boolean {
    if (!matchesName(rule.tool, call.tool)) return false;
    if (rule.action !== undefined && rule.action !== call.action) return false;
    if (rule.environment !== undefined && rule.environment !== call.environment) return false;
    if (rule.effect !== undefined && rule.effect !== call.effect) return false;
    return true;
}

export function decide(input: DecideInput): Verdict {
    const { call } = input;

    // 1. The table. A call nothing classified is a write outside the machine: it asks.
    let decision: Decision = call.unknown ? "ask" : TABLE[call.environmentKind][call.effect];
    let source: DecisionSource = call.unknown ? "unknown" : "table";
    let approval = call.approval;
    let decidingRule: Rule | undefined;

    // 2. The tool's own default can only be stricter than the table.
    if (call.atLeast !== undefined && STRICTNESS[call.atLeast] > STRICTNESS[decision]) {
        decision = call.atLeast;
        source = "tool";
    }

    // 3. Configuration. Rules are listed most specific first, so the first match decides.
    const rule = input.rules.find((candidate) => ruleMatches(candidate, call));
    if (rule !== undefined) {
        decision = rule.decision;
        source = "rule";
        approval = rule.approval ?? approval;
        decidingRule = rule;
    }

    // 4. "Allow for this session" answers an ask that came up before.
    if (decision === "ask" && input.sessionAllows.has(sessionKey(call))) {
        decision = "allow";
        source = "session";
    }

    // 5. The floor. Nothing above can reach past it.
    let floor: Verdict["floor"];
    if (call.effect === "write" && call.environmentKind === "production") {
        decision = "deny";
        source = "floor";
        floor = "production-write";
    }
    // An unknown tool is allowed only by a rule that names it exactly. A wildcard rule cannot allow it.
    if (call.unknown && decision === "allow" && source === "rule" && decidingRule?.tool.includes("*")) {
        decision = "ask";
        source = "floor";
        floor = "unknown-tool";
    }
    if (decision === "ask" && !input.hasUI) {
        decision = "deny";
        source = "floor";
        floor = "no-screen";
    }

    return {
        decision,
        source,
        ...(approval === undefined ? {} : { approval }),
        ...(floor === undefined ? {} : { floor }),
        ...(decision === "deny" ? { reason: denyReason(source, floor) } : {}),
    };
}

function denyReason(source: DecisionSource, floor: Verdict["floor"]): string {
    if (floor === "production-write") return "writes to production are never allowed";
    if (floor === "no-screen") return "this call needs approval and there is no screen to ask on";
    if (source === "tool") return "the tool's own declaration denies this action";
    return "a rule in the configuration denies this call";
}
