// The arithmetic of a child's limits, kept apart from the process so that every rule can be tested with numbers alone.
//
// At a limit the child is told to write its report from what it has and gets two more turns or two more minutes, whichever comes
// first; then it is aborted. Time spent waiting for the user is not counted, and cost is bounded only for a priced model.
import type { Limits } from "./config.ts";

export type LimitName = "turns" | "minutes" | "cost";

/** What a child has used so far. `cost` is undefined while the model has no price, and then no cost limit can apply. */
export interface Used {
    turns: number;
    /** Wall-clock milliseconds since the first prompt, minus the time spent waiting for the user. */
    activeMs: number;
    cost: number | undefined;
}

/** Where the wrap-up began. */
export interface Wrap {
    limit: LimitName;
    turns: number;
    activeMs: number;
}

/** Two more turns or two more minutes after the limit. */
export const GRACE_TURNS = 2;
export const GRACE_MS = 2 * 60_000;

/** The first limit that has been reached, or undefined. Turns first, then minutes, then cost. */
export function reached(limits: Limits, used: Used): LimitName | undefined {
    if (used.turns >= limits.maxTurns) return "turns";
    if (used.activeMs >= limits.maxMinutes * 60_000) return "minutes";
    if (used.cost !== undefined && used.cost >= limits.maxCost) return "cost";
    return undefined;
}

/** True when the grace after a limit is over and the child must be aborted. */
export function graceOver(wrap: Wrap, used: Used): boolean {
    return used.turns >= wrap.turns + GRACE_TURNS || used.activeMs >= wrap.activeMs + GRACE_MS;
}

/** The sentence that says which limit was reached, for the report and the status. */
export function describe(limit: LimitName, limits: Limits, used: Used): string {
    switch (limit) {
        case "turns":
            return `the turn limit (${limits.maxTurns} turns)`;
        case "minutes":
            return `the time limit (${limits.maxMinutes} minutes; ${(used.activeMs / 60_000).toFixed(1)} used)`;
        case "cost":
            return `the cost limit ($${limits.maxCost}; $${(used.cost ?? 0).toFixed(2)} used)`;
    }
}

/** The message that tells the child to wrap up. */
export function wrapUpMessage(limit: LimitName, limits: Limits, used: Used): string {
    return [
        `You have reached ${describe(limit, limits, used)}. Stop working now.`,
        `Write your final report from what you have. Start it with "Stopped at the limit", say what you found or changed,`,
        `and list what is still unknown or undone. You have ${GRACE_TURNS} turns left and then you will be stopped.`,
    ].join(" ");
}

/** A cost for a line of status: dollars, or "cost unknown" for a model without a price. */
export function costText(cost: number | undefined): string {
    return cost === undefined ? "cost unknown" : `$${cost.toFixed(2)}`;
}
