// What jig-core decided about a call, as far as `api` needs it: the kind of the environment the call was decided in.
//
// Which environments are production is jig-core's to say, and the contract gives a plugin no way to ask. What jig-core
// does publish, on Pi's event bus, is its decision for every call before the call runs (`jig:decision`), and that
// message names the kind. `api` runs a command in a pod, so it must never run where jig-core says production, whatever
// the environment is called. classify can only refuse the one name that is always production (see params.ts); this
// closes the rest.
import type { DecisionEvent, EnvironmentKind, JIG_EVENTS } from "../../jig-core/src/contract.ts";
import type { Target } from "./config.ts";
import { isObject } from "./values.ts";

/** jig-core's event for a decision. The type makes the compiler check the name against the contract, which plugins
 *  otherwise only import types from. */
export const DECISION_EVENT: typeof JIG_EVENTS.decision = "jig:decision";

const KINDS: readonly string[] = ["local", "external", "test", "production"] satisfies EnvironmentKind[];

/** Decisions kept at once. Each call is looked up once, a moment after it was decided. */
const KEPT = 200;

interface Seen {
    environment: string;
    kind: EnvironmentKind;
}

export interface Decisions {
    /** Takes a message from the event bus. It is another package's message, so nothing is assumed of it. */
    remember(event: unknown): void;
    /** The kind jig-core decided for this call of the k8s tool, or undefined when it did not say. */
    seen(toolCallId: string): Seen | undefined;
}

export function createDecisions(): Decisions {
    const decided = new Map<string, Seen>();
    return {
        remember(event) {
            if (!isObject(event) || event.tool !== "k8s") return;
            const { toolCallId, environment, environmentKind } = event as Partial<DecisionEvent>;
            if (typeof toolCallId !== "string" || typeof environment !== "string") return;
            if (typeof environmentKind !== "string" || !KINDS.includes(environmentKind)) return;
            decided.delete(toolCallId);
            decided.set(toolCallId, { environment, kind: environmentKind });
            const oldest = decided.keys().next();
            if (decided.size > KEPT && !oldest.done) decided.delete(oldest.value);
        },
        seen: (toolCallId) => decided.get(toolCallId),
    };
}

/**
 * Refuses an `api` call unless jig-core said, for this very call, that the environment is not production. A call
 * jig-core did not announce, or announced for another environment, cannot be vouched for, and fails closed.
 */
export function requireNotProduction(decisions: Decisions, toolCallId: string, target: Target): void {
    const where = `${target.service} in ${target.environment}`;
    const decision = decisions.seen(toolCallId);
    if (decision === undefined || decision.environment !== target.jigEnvironment) {
        throw new Error(
            `k8s api could not confirm that ${where} is not production: ` +
                "jig-core did not say which environment it decided this call in. Nothing was run",
        );
    }
    if (decision.kind === "production") {
        throw new Error(
            `k8s api is refused in production (${where}): it runs in test environments only. Nothing was run`,
        );
    }
}
