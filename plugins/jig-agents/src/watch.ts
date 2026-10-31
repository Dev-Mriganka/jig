// The watch of kind `subagent`: how a child's report reaches the parent without polling. A poll only reads this plugin's own record of
// the child, so it costs nothing. The first poll comes about 2 seconds after the start, and later ones are at least 5 seconds apart.
// Also here: which watch belongs to which child (`ChildWatches`), so that the runtime can start one and stop it.
import { jig } from "../../jig-core/src/client.ts";
import type { PollOutcome, WatchKind } from "../../jig-core/src/contract.ts";
import { InputError } from "../../jig-core/src/kit/values.ts";
import type { Child } from "./child.ts";
import type { Runtime } from "./runtime.ts";

/** The kind of watch every child is. */
export const WATCH_KIND = "subagent";

/** What a watch remembers about its child. */
export interface WatchSpec {
    id: string;
    name: string;
    /** When the plugin stops waiting for the child, in milliseconds since the epoch. */
    deadline: number;
}

export type WatchState = Record<string, never>;

/** Which watch tells the agent about which child, and back. */
export class ChildWatches {
    private readonly watchOf = new Map<string, string>();
    private readonly childOfWatch = new Map<string, string>();

    /** Starts the watch that tells the agent how the child ended, and returns its id. */
    start(child: Child, plan: { spec: WatchSpec; timeoutMinutes: number; stallMinutes: number }): string {
        const watchId = jig().watches.start({
            kind: WATCH_KIND,
            spec: plan.spec,
            title: `child agent ${child.name} (${child.spec.role})`,
            timeoutMinutes: plan.timeoutMinutes,
            stallMinutes: plan.stallMinutes,
        });
        this.watchOf.set(child.id, watchId);
        this.childOfWatch.set(watchId, child.id);
        return watchId;
    }

    /** Stops the child's watch, if it has one. */
    stop(child: Child): void {
        const watchId = this.watchOf.get(child.id);
        if (watchId === undefined) return;
        this.watchOf.delete(child.id);
        this.childOfWatch.delete(watchId);
        try {
            jig().watches.stop(watchId);
        } catch {
            // It had ended already.
        }
    }

    /** A watch ended: forgets it, and returns the id of its child. Undefined for a watch that is not a child's. */
    ended(watchId: string): string | undefined {
        const childId = this.childOfWatch.get(watchId);
        if (childId === undefined) return undefined;
        this.childOfWatch.delete(watchId);
        this.watchOf.delete(childId);
        return childId;
    }

    clear(): void {
        this.watchOf.clear();
        this.childOfWatch.clear();
    }
}

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
