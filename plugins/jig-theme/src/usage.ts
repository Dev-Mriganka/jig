// What a session has used so far, read from its own entries: tokens, an estimated cost, and the size of the context.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;

/** A number that is finite and not negative; anything else is not a measurement. */
export const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export interface SessionUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    compactions: number;
    /** Undefined as soon as one call in the session has no price: the total is then not known. */
    estimatedCost?: number;
    contextPercent?: number;
    contextTokens?: number;
    contextWindow?: number;
}

interface Metered {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: number;
}

/** The usage a session entry carries: a model reply or tool result, a cache refresh, a compaction or a branch summary. */
function metered(entry: unknown): Metered | undefined {
    if (!isRec(entry)) return undefined;
    const message = entry.type === "message" && isRec(entry.message) ? entry.message : undefined;
    const ofMessage = message !== undefined && (message.role === "assistant" || message.role === "toolResult");
    const ofEntry = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary";
    if (!ofMessage && !ofEntry) return undefined;
    const usage = ofMessage ? message?.usage : entry.usage;
    if (!isRec(usage)) return undefined;
    const cost = isRec(usage.cost) ? usage.cost.total : usage.cost;
    return {
        input: number(usage.input) ?? 0,
        output: number(usage.output) ?? 0,
        cacheRead: number(usage.cacheRead) ?? 0,
        cacheWrite: number(usage.cacheWrite) ?? 0,
        cost: number(cost),
    };
}

/** The totals of a list of session entries. */
export function sumUsage(
    entries: readonly unknown[],
): Omit<SessionUsage, "contextPercent" | "contextTokens" | "contextWindow"> {
    const total = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        compactions: 0,
        estimatedCost: 0 as number | undefined,
    };
    for (const entry of entries) {
        if (isRec(entry) && entry.type === "compaction") total.compactions++;
        const used = metered(entry);
        if (used === undefined) continue;
        total.input += used.input;
        total.output += used.output;
        total.cacheRead += used.cacheRead;
        total.cacheWrite += used.cacheWrite;
        total.estimatedCost =
            total.estimatedCost === undefined || used.cost === undefined ? undefined : total.estimatedCost + used.cost;
    }
    return total;
}

/** The session's totals, and how full its context is now. */
export function collectUsage(
    ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model">,
): SessionUsage {
    const manager = ctx.sessionManager as {
        getEntries?: () => readonly unknown[];
        getBranch: () => readonly unknown[];
    };
    const result: SessionUsage = sumUsage(manager.getEntries?.() ?? manager.getBranch());
    const context = ctx.getContextUsage();
    result.contextPercent = number(context?.percent);
    result.contextTokens = number(context?.tokens);
    result.contextWindow = number(context?.contextWindow ?? ctx.model?.contextWindow);
    return result;
}
