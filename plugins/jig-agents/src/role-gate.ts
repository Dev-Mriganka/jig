// The child's half of "a role only narrows": the child enforces it, not the parent and not the prompt. The parent put the role's policy in
// the child's environment (launch.ts); here the plugin, which loads in every child, reads it once at start and registers a jig-core gate.
// A gate can only make a decision stricter, so the rules and the floor of the child's jig-core still apply on top.
//
//   writes: false   every call classified as a write is refused. The one exception is `bash`, which jig-core calls a write because a
//                   shell string can do anything: in a child with jig-sandbox it runs in a sandbox that locks the working folder and
//                   the home folder (jig-sandbox reads the same policy), and then it may run. `bash` with `outside: true`, which runs
//                   outside the sandbox, is a different action and is refused with the rest.
//   actions         a tool named there runs only the actions listed; any other action of it is refused
//   ask             a tool action named there asks, even if the rules allow it
//
// A policy that is there and cannot be read refuses every call, and makes the start-up check fail the same way a plugin that failed to
// load does: the plugin throws when the session starts, and Pi reports that as an `extension_error` the parent already refuses on.
import type { Gate, GateCall, GateVerdict } from "../../jig-core/src/contract.ts";
import { withJig } from "../../jig-core/src/client.ts";
import { readRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import type { RolePolicy } from "../../jig-core/src/kit/role-policy.ts";

/** The gate's name. It is in the decision's event, and in the record as "held by gate role-policy". */
export const GATE_NAME = "role-policy";

const label = (call: Pick<GateCall, "tool" | "action">): string =>
    call.action === undefined ? call.tool : `${call.tool} ${call.action}`;

const deny = (reason: string): GateVerdict => ({ decision: "deny", reason });

/** The actions a list names for a tool, or undefined when the policy says nothing about the tool. */
function listed(map: Readonly<Record<string, string[]>>, tool: string): string[] | undefined {
    return Object.hasOwn(map, tool) ? map[tool] : undefined;
}

/**
 * What the role says about one call: a refusal, a question, or nothing. `sandboxActive` is whether jig-sandbox is registered, on and able
 * to run commands in this child, which is what makes `bash` read-only.
 */
export function roleVerdict(policy: RolePolicy, call: GateCall, sandboxActive: boolean): GateVerdict | undefined {
    const who = `the role "${policy.role}"`;
    if (!policy.writes && call.effect === "write") {
        if (call.tool !== "bash" || call.action !== undefined) {
            return deny(`${who} may not write, and ${label(call)} writes`);
        }
        if (!sandboxActive) {
            return deny(
                `${who} may not write, and its bash is read-only only inside jig-sandbox, which is not active in this agent`,
            );
        }
    }
    const allowed = listed(policy.actions, call.tool);
    if (allowed !== undefined && (call.action === undefined || !allowed.includes(call.action))) {
        const only = allowed.length === 0 ? "no action of it" : `only ${call.tool} ${allowed.join(", ")}`;
        return deny(
            `${who} may run ${only}; ${call.action === undefined ? `${call.tool} with no action` : label(call)} is not one of them`,
        );
    }
    const asks = listed(policy.ask, call.tool);
    if (asks !== undefined && call.action !== undefined && asks.includes(call.action)) {
        return { decision: "ask", reason: `${who} asks before ${label(call)}` };
    }
    return undefined;
}

/** The gate for a policy, or for a policy that cannot be read: that one refuses every call. */
export function roleGate(reading: ReturnType<typeof readRolePolicy>, sandboxActive: () => boolean): Gate | undefined {
    if (reading.kind === "absent") return undefined;
    if (reading.kind === "unreadable") {
        return {
            name: GATE_NAME,
            plugin: "jig-agents",
            check: () =>
                deny(
                    `this agent's role policy cannot be read (${reading.problem}), so it may not do anything. The agent that started it must be started again`,
                ),
        };
    }
    return {
        name: GATE_NAME,
        plugin: "jig-agents",
        check: (call) => roleVerdict(reading.policy, call, sandboxActive()),
    };
}

/**
 * Reads the policy from the environment and registers its gate with jig-core. Returns what is wrong with the policy, if anything: the
 * caller reports it when the session starts, so that the parent's start-up check refuses the child.
 */
export function installRoleGate(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const reading = readRolePolicy(env);
    withJig((api) => {
        const gate = roleGate(reading, () => api.sandbox.canRun);
        if (gate !== undefined) api.gates.register(gate);
    });
    return reading.kind === "unreadable"
        ? `JIG_ROLE_POLICY cannot be read (${reading.problem}); every call is refused until the agent is started again`
        : undefined;
}
