// The watch of kind `subagent`: how a child's report reaches the parent without polling. A poll only reads this plugin's own record of
// the child, so it costs nothing. The first poll comes about 2 seconds after the start, and later ones are at least 5 seconds apart.
import type { PollOutcome, WatchKind } from "../../jig-core/src/contract.ts";
import { InputError } from "../../jig-core/src/kit/values.ts";
import type { Runtime, WatchSpec } from "./runtime.ts";
import { WATCH_KIND } from "./runtime.ts";

export type WatchState = Record<string, never>;

function isSpec(spec: unknown): spec is WatchSpec {
    const s = spec as Partial<WatchSpec> | null;
    return typeof s?.id === "string" && typeof s.name === "string" && typeof s.deadline === "number";
}

export function watchKind(rt: Runtime): WatchKind<WatchSpec, WatchState> {
    return {
        kind: WATCH_KIND,
        plugin: "jig-agents",
        intervalMs: 5_000,
        describe: (spec) => (isSpec(spec) ? `child agent ${spec.name}` : "a child agent"),
        async poll(spec): Promise<PollOutcome<WatchState>> {
            if (!isSpec(spec)) throw new InputError("a child agent's watch has no child");
            const child = rt.children.get(spec.id);
            if (child === undefined) {
                // After a restart there is no child in memory: its process ended with the session. `message` resumes it from its saved session.
                return {
                    state: {},
                    done: {
                        outcome: "error",
                        summary: `${spec.name}: the session restarted while this child ran, so it was stopped. The message action resumes it from its saved session.`,
                    },
                };
            }
            const ended = child.result();
            if (ended !== undefined) return { state: {}, done: ended };
            if (rt.host.now() >= spec.deadline) {
                await child.timedOut();
                const result = child.result();
                if (result !== undefined) return { state: {}, done: result };
            }
            return { state: {} };
        },
    };
}
