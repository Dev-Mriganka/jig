// The usage in Pi's session files, collected for `/lens usage`. Local only: it opens files under Pi's sessions folder and
// reads them, and nothing else. A session file only grows, so one last written before a period began holds nothing from
// it, and the scan skips such files; the folder can reach hundreds of megabytes.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { usageRecord } from "./usage-record.ts";
import type { UsageRecord } from "./usage-record.ts";

export type Period = "today" | "week" | "last-week" | "30-days" | "all";

/** `older` counts files last written before `since`, which were not opened. */
export interface History {
    records: UsageRecord[];
    files: number;
    skipped: number;
    older: number;
    since: number;
}

export interface Totals {
    tokens: number;
    cost: number;
    /** How many records had no price, so that `cost` is a lower bound. */
    unknownCosts: number;
    records: number;
}

export interface HistorySummary extends Totals {
    models: Array<Totals & { provider: string; model: string }>;
    buckets: Array<Totals & { label: string; start: number }>;
}

const totals = (): Totals => ({ tokens: 0, cost: 0, unknownCosts: 0, records: 0 });

function add(total: Totals, record: UsageRecord): void {
    total.tokens += record.input + record.output + record.cacheRead + record.cacheWrite;
    total.cost += record.cost ?? 0;
    total.unknownCosts += record.cost === undefined ? 1 : 0;
    total.records++;
}

interface CachedFile {
    fingerprint: string;
    reports: Array<{ key: string; record: UsageRecord }>;
    skipped: number;
}

/** What a file held when it was last read, for as long as its size and times are the same. */
const cache = new Map<string, CachedFile>();
const MAX_CACHED_FILES = 2000;

export interface CollectOptions {
    sessionsDir: string;
    /** Only files last written at or after this time (epoch ms) are read. Default: all. */
    since?: number;
    signal?: AbortSignal;
    onProgress?: (files: number) => void;
}

/**
 * Reads every session file whose last write is not before `since`. Rejects with an AbortError when `signal` aborts, and
 * never returns part of a result.
 */
export async function collectHistory(options: CollectOptions): Promise<History> {
    const since = options.since ?? 0;
    const unique = new Map<string, UsageRecord>();
    let files = 0;
    let skipped = 0;
    let older = 0;
    const check = () => options.signal?.throwIfAborted();

    /** Undefined: the file is older than `since` and was not opened. */
    async function read(file: string): Promise<CachedFile | undefined> {
        check();
        const info = await stat(file);
        if (info.mtimeMs < since) return undefined;
        const fingerprint = [info.size, info.mtimeMs, info.ctimeMs].join(":");
        const cached = cache.get(file);
        if (cached?.fingerprint === fingerprint) return cached;
        const parsed: CachedFile = { fingerprint, reports: [], skipped: 0 };
        const stream = createReadStream(file, { encoding: "utf8", ...(options.signal === undefined ? {} : { signal: options.signal }) });
        const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
        let lineNumber = 0;
        try {
            for await (const line of lines) {
                check();
                lineNumber++;
                let entry: unknown;
                try {
                    entry = JSON.parse(line);
                } catch {
                    if (line.trim() !== "") parsed.skipped++;
                    continue;
                }
                const record = usageRecord(entry);
                if (record) parsed.reports.push({ key: record.id === undefined ? `${file}:${lineNumber}` : JSON.stringify(record), record });
            }
        } finally {
            lines.close();
            stream.destroy();
        }
        check();
        // A session appended to while it was read is read again next time.
        const after = await stat(file);
        if ([after.size, after.mtimeMs, after.ctimeMs].join(":") === fingerprint) {
            cache.set(file, parsed);
            if (cache.size > MAX_CACHED_FILES) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
            }
        }
        return parsed;
    }

    async function scan(directory: string): Promise<void> {
        check();
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            check();
            skipped++;
            return;
        }
        for (const entry of entries) {
            check();
            const file = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                await scan(file);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            try {
                const parsed = await read(file);
                if (parsed === undefined) {
                    older++;
                    continue;
                }
                // A forked session copies its parent's entries; each is counted once.
                for (const item of parsed.reports) if (!unique.has(item.key)) unique.set(item.key, item.record);
                skipped += parsed.skipped;
                files++;
                options.onProgress?.(files);
            } catch {
                check();
                skipped++;
            }
        }
    }

    await scan(options.sessionsDir);
    check();
    const records = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
    return { records, files, skipped, older, since };
}

/** The local-time window a period covers: whole days on the user's own clock, with Monday as the first day of a week. */
export function periodRange(period: Period, now = new Date()): { start: Date; end: Date } {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    if (period === "week" || period === "last-week") {
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        end.setTime(start.getTime());
        end.setDate(end.getDate() + 7);
        if (period === "last-week") {
            start.setDate(start.getDate() - 7);
            end.setDate(end.getDate() - 7);
        }
    } else if (period === "30-days") {
        start.setDate(start.getDate() - 29);
    } else if (period === "all") {
        start.setTime(0);
    }
    return { start, end };
}

/** Maps a recorded provider and model to the pair to show; undefined keeps it as recorded. */
export type ModelNames = (provider: string, model: string) => { provider: string; model: string } | undefined;

/** The records of a period added up: in all, by model, and by bucket (an hour for today, a day, or a month for all time). */
export function summarizeHistory(records: readonly UsageRecord[], period: Period, now = new Date(), names?: ModelNames): HistorySummary {
    const summary: HistorySummary = { ...totals(), models: [], buckets: [] };
    const models = new Map<string, HistorySummary["models"][number]>();
    const buckets = new Map<string, HistorySummary["buckets"][number]>();
    const { start, end } = periodRange(period, now);
    for (const record of records) {
        if (record.timestamp < +start || record.timestamp >= +end) continue;
        add(summary, record);
        const shown = names?.(record.provider, record.model) ?? record;
        const key = JSON.stringify([shown.provider, shown.model]);
        let model = models.get(key);
        if (model === undefined) {
            model = { ...totals(), provider: shown.provider, model: shown.model };
            models.set(key, model);
        }
        add(model, record);
        const date = new Date(record.timestamp);
        if (period === "today") {
            date.setMinutes(0, 0, 0);
        } else {
            date.setHours(0, 0, 0, 0);
            if (period === "all") date.setDate(1);
        }
        const label =
            period === "today"
                ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : date.toLocaleDateString([], period === "all" ? { year: "numeric", month: "short" } : { month: "short", day: "numeric" });
        let bucket = buckets.get(label);
        if (bucket === undefined) {
            bucket = { ...totals(), label, start: +date };
            buckets.set(label, bucket);
        }
        add(bucket, record);
    }
    summary.models = [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
    summary.buckets = [...buckets.values()];
    return summary;
}
