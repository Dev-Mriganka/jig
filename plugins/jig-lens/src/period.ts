// Days as the person sees them. The index keeps UTC seconds, and a record file is a UTC day, but "today" in the summary
// is the day on the user's own clock, so a late evening is not counted as tomorrow.

/** A run of whole days in the local time zone. */
export interface Days {
    /** Midnight at the start of the first day, in seconds since the epoch. */
    from: number;
    /** Midnight at the end of the last day, which is not part of it. */
    to: number;
    /** The first and the last day as `YYYY-MM-DD`. */
    first: string;
    last: string;
}

const two = (n: number) => String(n).padStart(2, "0");
const dateOf = (day: Date) => `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;

/**
 * The `days` calendar days that end with the day `now` falls in. The days are made by date and not by adding 24 hours,
 * so the day a clock changes (23 or 25 hours long) still starts and ends at midnight.
 */
export function lastDays(now: Date, days: number): Days {
    const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    const after = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { from: first.getTime() / 1000, to: after.getTime() / 1000, first: dateOf(first), last: dateOf(now) };
}
