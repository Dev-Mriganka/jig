// The prompt cache's clock: how long a model's cache entry lives on after the last reply that used it.

/** Prompt-cache lifetimes in seconds when the model declares none: the 5-minute default and the 1-hour tier of PI_CACHE_RETENTION=long. */
const DEFAULT_SECONDS = { short: 300, long: 3600 } as const;

export type CacheState = { state: "warm"; remainingMs: number } | { state: "cold" };

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;

/**
 * Time left on the prompt cache of the model the session is using. The cache entry is refreshed when a request that reads or
 * writes it starts, so the clock starts at the last reply's start time (`message.timestamp`) or at a Pi cache-warming refresh,
 * and runs for the model's lifetime for the active retention (`promptCache` on the model, else 5 minutes, or 1 hour with
 * PI_CACHE_RETENTION=long). Undefined when there is nothing to say: no reply yet, or the last reply used no cache.
 * A model switch or a compaction after the last reply means the next request writes a new cache, so that is `cold`.
 */
export function cacheState(
    entries: readonly unknown[],
    model: { promptCache?: { short?: number; long?: number } } | undefined,
    env: NodeJS.ProcessEnv,
    now: number,
): CacheState | undefined {
    const tier = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    const seconds = model?.promptCache ? model.promptCache[tier] : DEFAULT_SECONDS[tier];
    if (typeof seconds !== "number" || !(seconds > 0)) return undefined;
    let rewritten = false;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!isRec(entry)) continue;
        if (entry.type === "model_change" || entry.type === "compaction") {
            rewritten = true;
            continue;
        }
        let at: number | undefined;
        const message = isRec(entry.message) ? entry.message : undefined;
        if (entry.type === "usage" && entry.kind === "cache_warm") {
            at = Date.parse(String(entry.timestamp));
        } else if (entry.type === "message" && message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
            const usage = isRec(message.usage) ? message.usage : undefined;
            const touched = (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0);
            if (!(touched > 0)) return undefined;
            at = typeof message.timestamp === "number" ? message.timestamp : Number.NaN;
        }
        if (at === undefined) continue;
        if (!Number.isFinite(at)) return undefined;
        const remainingMs = at + seconds * 1000 - now;
        return rewritten || remainingMs <= 0 ? { state: "cold" } : { state: "warm", remainingMs };
    }
    return undefined;
}

/** `cache 3:41`, or `cache cold`. */
export function cacheLabel(cache: CacheState): string {
    if (cache.state === "cold") return "cache cold";
    const seconds = Math.max(0, Math.ceil(cache.remainingMs / 1000));
    return `cache ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
