// The gate this plugin registers with jig-core. It does two things, and can only make a decision stricter:
//   - holds: a call that a workflow's hold lists is denied until the hold's condition holds, in the bound repositories only;
//   - calls that always ask: a plan to approve, a stage that needs you, a switch of workflow, a test run outside the sandbox.
// A hold follows the session's active ticket. It reads the same conditions `advance` does, limited to the repository the call
// acts in, and uses the last reading of a pull request rather than the network.
import type { Gate, GateCall, GateVerdict } from "../../jig-core/src/contract.ts";
import { evaluate } from "./conditions.ts";
import { callText, REPOSITORY_CONDITIONS } from "./definition.ts";
import type { HoldCall } from "./definition.ts";
import { scopeOf } from "./repos.ts";
import type { Runtime } from "./runtime.ts";
import { isTicketKey } from "./ticket.ts";

export const GATE_NAME = "workflow";
export const TOOL_NAME = "workflow";

/** Whether a hold's call names this call: the tool, and the action when the hold gives one. */
export function holdMatches(hold: HoldCall, call: Pick<GateCall, "tool" | "action">): boolean {
    return hold.tool === call.tool && (hold.action === undefined || hold.action === call.action);
}

/** The ticket a call to the `workflow` tool is about: the one it names, else the session's. */
function targetTicket(rt: Runtime, input: Readonly<Record<string, unknown>>): string | undefined {
    return isTicketKey(input.ticket) ? input.ticket : rt.activeTicket();
}

/** Why a call to the `workflow` tool must be put to the user, or undefined when it need not be. */
function mustAsk(rt: Runtime, call: GateCall): string | undefined {
    const ticket = targetTicket(rt, call.input);
    switch (call.action) {
        case "submit-plan":
            return "workflow submit-plan always asks: you approve this exact plan, with its fingerprint";
        case "advance": {
            if (ticket === undefined) return undefined;
            const { read } = rt.work(ticket);
            if (read.kind !== "state") return undefined;
            const stage = rt
                .definition(read.state)
                ?.workflow.stages.find((candidate) => candidate.id === read.state.stage);
            return stage?.exit.includes("you-approve") === true
                ? `moving on from ${stage.id} needs your yes, and it is asked every time`
                : undefined;
        }
        case "start": {
            if (call.input.replace !== true || ticket === undefined) return undefined;
            return rt.work(ticket).read.kind === "none"
                ? undefined
                : `workflow start replace over the workflow of ${ticket} loses its evidence, and it is asked every time`;
        }
        case "test": {
            if (ticket === undefined || rt.work(ticket).read.kind !== "state") return undefined;
            return rt.host.sandbox.canRun()
                ? undefined
                : "there is no sandbox that can run commands, so these tests would run outside it, as you: this asks every time";
        }
        default:
            return undefined;
    }
}

async function held(rt: Runtime, call: GateCall): Promise<string | undefined> {
    const ticket = rt.activeTicket();
    if (ticket === undefined) return undefined;
    const work = rt.work(ticket);
    if (work.read.kind !== "state") return undefined;
    const { state } = work.read;
    const loaded = rt.definition(state);
    if (loaded === undefined) return undefined;
    const holds = loaded.workflow.holds.filter((hold) => hold.calls.some((entry) => holdMatches(entry, call)));
    if (holds.length === 0) return undefined;

    const bound = rt.bound(ticket).roots;
    const scope = scopeOf({ tool: call.tool, input: call.input, cwd: call.cwd, paths: call.paths }, bound);
    if (scope.kind === "elsewhere") return undefined;

    const evidence = rt.evidence(work, state, { live: false });
    for (const hold of holds) {
        const only = scope.kind === "repository" && REPOSITORY_CONDITIONS.has(hold.until) ? scope.root : undefined;
        const result = await evaluate(hold.until, evidence, only);
        if (result.ok) continue;
        const what = hold.calls.find((entry) => holdMatches(entry, call));
        const missing = result.lines.slice(0, 2).join("; ");
        return (
            `held by workflow ${state.workflow} on ${ticket}: ${what === undefined ? call.tool : callText(what)} waits for ` +
            `${hold.until}, which is not met: ${missing}`
        );
    }
    return undefined;
}

export function createGate(rt: Runtime): Gate {
    return {
        name: GATE_NAME,
        plugin: "jig-workflow",
        async check(call): Promise<GateVerdict | undefined> {
            // The tool that satisfies the holds is never held itself. It asks where its own actions need you.
            if (call.tool === TOOL_NAME) {
                const reason = mustAsk(rt, call);
                return reason === undefined ? undefined : { decision: "ask", reason };
            }
            const reason = await held(rt, call);
            return reason === undefined ? undefined : { decision: "deny", reason };
        },
    };
}
