// What one entry of a Pi session file says about usage: the model that answered, its tokens, and its cost when Pi priced it.
// `/lens usage` reads Pi's own session files, not Jig's records, so this is Pi's format and not jig-core's.

export interface UsageRecord {
    /** The entry's id: a fork copies its parent's entries, and an id is what counts each once. */
    id?: string;
    /** Milliseconds since the epoch; 0 when the entry has no time. */
    timestamp: number;
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Undefined when Pi had no price for the model: the amount is then not known, which is not the same as free. */
    cost?: number;
    /** `assistant`, `toolResult`, `usage`, `compaction` or `branch_summary`. */
    type: string;
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;
const amount = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown, fallback: string): string =>
    typeof value === "string" && value !== "" ? value : fallback;

/**
 * The usage of a session entry, or undefined for an entry that has none. A model reply or a tool result that did model work
 * (a subagent) carries it in its message; a standalone `usage` entry (a cache refresh), a compaction and a branch summary
 * carry it themselves. A reply is recorded under the model that answered when that differs from the one asked.
 */
export function usageRecord(entry: unknown): UsageRecord | undefined {
    if (!isRec(entry)) return undefined;
    const message = entry.type === "message" && isRec(entry.message) ? entry.message : undefined;
    const ofMessage = message !== undefined && (message.role === "assistant" || message.role === "toolResult");
    const ofEntry = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary";
    if (!ofMessage && !ofEntry) return undefined;
    const usage = ofMessage ? message?.usage : entry.usage;
    if (!isRec(usage)) return undefined;
    const stamp = message?.timestamp ?? entry.timestamp;
    const timestamp = typeof stamp === "number" ? stamp : typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    return {
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        provider: text(message?.provider ?? entry.provider, "Tools"),
        model: text(message?.responseModel ?? message?.model ?? entry.model, "summaries"),
        input: amount(usage.input) ?? 0,
        output: amount(usage.output) ?? 0,
        cacheRead: amount(usage.cacheRead) ?? 0,
        cacheWrite: amount(usage.cacheWrite) ?? 0,
        ...optional(amount(isRec(usage.cost) ? usage.cost.total : usage.cost)),
        type: text(message?.role ?? entry.type, "usage"),
    };
}

/** `{ cost }` when there is one, and nothing at all when there is not. */
const optional = (cost: number | undefined): { cost?: number } => (cost === undefined ? {} : { cost });
