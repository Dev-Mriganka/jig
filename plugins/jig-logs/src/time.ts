// Time windows for log searches: reading them, checking them, and planning the buckets a long one is searched in.
// Every instant is epoch milliseconds, and a range is half-open: [from, to).
import { refuse, shown } from "./values.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** The longest window one call searches. An older period is read in slices of at most this. */
export const MAX_RANGE_MS = 7 * DAY_MS;
/** A bucket that times out or loses shards is halved at most this many times. */
export const MAX_DEPTH = 4;
/** Below this a bucket is not worth halving. */
const MIN_SPLIT_MS = 2_000;

export interface Range {
    from: number;
    to: number;
}

/** A slice of the window that is searched on its own. `depth` counts how often it was halved. */
export interface Bucket extends Range {
    depth: number;
}

const WINDOW_HELP =
    "window must look like 30m, 2h or 1d and be at most 7d; " +
    "for older logs pass from and to in slices of at most 7 days";
const WINDOW = /^([1-9][0-9]{0,4})([mhd])$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** "30m", "2h" or "1d" in milliseconds, at most 7 days. */
export function parseWindow(text: string): number {
    const match = WINDOW.exec(text);
    if (match === null) return refuse(`logs: ${WINDOW_HELP} (got ${shown(text)})`);
    const unit = match[2] === "m" ? MINUTE_MS : match[2] === "h" ? HOUR_MS : DAY_MS;
    const span = Number(match[1]) * unit;
    if (span > MAX_RANGE_MS) return refuse(`logs: ${WINDOW_HELP} (got ${shown(text)})`);
    return span;
}

/** ISO 8601 with an explicit timezone. `Date.parse` alone rolls 30 February into March, so the parts are checked. */
export function parseInstant(text: string, label: string): number {
    const bad = `logs: ${label} must be ISO 8601 with a timezone, such as 2026-10-13T09:30:00Z (got ${shown(text)})`;
    const match = INSTANT.exec(text);
    if (match === null) return refuse(bad);
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
    ];
    const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
    const date = new Date(Date.UTC(year, month - 1, day));
    const valid =
        year >= 2000 &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day &&
        hour <= 23 &&
        minute <= 59 &&
        second <= 59 &&
        offsetHour <= 23 &&
        offsetMinute <= 59;
    const time = valid ? Date.parse(text) : Number.NaN;
    if (!Number.isFinite(time)) return refuse(bad);
    return time;
}

export interface RangeInput {
    window?: string;
    from?: string;
    to?: string;
}

/** The searched range: an explicit `from` and `to`, or the last `window` (else `defaultWindow`) ending now. */
export function resolveRange(input: RangeInput, defaultWindow: string, now: number): Range {
    if ((input.from === undefined) !== (input.to === undefined))
        return refuse("logs: from and to must be given together");
    if (input.from !== undefined && input.to !== undefined) {
        if (input.window !== undefined) return refuse("logs: give either window or from and to, not both");
        const range = { from: parseInstant(input.from, "from"), to: parseInstant(input.to, "to") };
        if (range.to <= range.from) return refuse("logs: to must be after from");
        if (range.to - range.from > MAX_RANGE_MS) {
            return refuse("logs: from..to must span at most 7 days; search older logs in slices of at most 7 days");
        }
        return range;
    }
    return { from: now - parseWindow(input.window ?? defaultWindow), to: now };
}

/** The compact UTC form used in request bodies and in the result: no milliseconds when they are zero. */
export function iso(ms: number): string {
    return new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * The buckets a window is searched in, oldest first. Over 2 days it is searched in day buckets, over 6 hours in hour
 * buckets, otherwise in one. A day of logs in one request is where a busy backend starts to time out, and a bucket
 * that does is halved and tried again (see `halve`). A backend that refuses a request over some length passes it as
 * `longest`, and no bucket is longer.
 */
export function planBuckets(range: Range, longest: number = Number.POSITIVE_INFINITY): Bucket[] {
    const span = range.to - range.from;
    const step = Math.min(span > 2 * DAY_MS ? DAY_MS : span > 6 * HOUR_MS ? HOUR_MS : span, longest);
    const buckets: Bucket[] = [];
    for (let start = range.from; start < range.to; start += step) {
        buckets.push({ from: start, to: Math.min(start + step, range.to), depth: 0 });
    }
    return buckets;
}

/** Halves a bucket for a retry, or returns undefined once it has been halved enough or is too small. */
export function halve(bucket: Bucket): [Bucket, Bucket] | undefined {
    const span = bucket.to - bucket.from;
    if (bucket.depth >= MAX_DEPTH || span < MIN_SPLIT_MS) return undefined;
    const middle = bucket.from + Math.floor(span / 2);
    return [
        { from: bucket.from, to: middle, depth: bucket.depth + 1 },
        { from: middle, to: bucket.to, depth: bucket.depth + 1 },
    ];
}
