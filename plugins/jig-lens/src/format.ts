// Numbers and text for what the commands say: amounts with their units, and columns that line up. Pure functions, so
// every format is tested on its own.

/** `1 call`, `2 calls`. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `$1.23`. Under a cent it keeps four decimals (`$0.0042`), so a cheap turn is not shown as free. */
export function money(dollars: number): string {
    if (dollars === 0) return "$0.00";
    return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

/** One decimal below 100 (`9.9`, `12.3`), whole numbers from there on (`123`). */
function compact(value: number): string {
    const tenths = Math.round(value * 10) / 10;
    return tenths < 100 ? tenths.toFixed(1) : String(Math.round(value));
}

/** A token count without its unit: `850`, `12.3k`, `123k`, `1.2M`. */
export function tokens(count: number): string {
    if (count < 1000) return String(Math.round(count));
    if (count < 999_500) return `${compact(count / 1000)}k`;
    return `${compact(count / 1_000_000)}M`;
}

/** `850ms`, `4.2s`, `12s`, `4m 10s`, `1h 5m`. Seconds are dropped from an hour on, and zero parts are left out. */
export function duration(ms: number): string {
    if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
    if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** `91%`, as a whole number. A whole of zero is 0%, not a division by zero. */
export function percent(part: number, whole: number): string {
    return whole <= 0 ? "0%" : `${Math.round((100 * part) / whole)}%`;
}

/** How long ago, for a time in seconds since the epoch: `45s ago`, `12m ago`, `3h ago`, `2d ago`. */
export function ago(seconds: number, now: Date): string {
    const elapsed = Math.floor(now.getTime() / 1000 - seconds);
    if (elapsed < 1) return "just now";
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 48 * 3600) return `${Math.floor(elapsed / 3600)}h ago`;
    return `${Math.floor(elapsed / 86400)}d ago`;
}

/**
 * Text from the records, made safe to print. A record never holds tool output, but a tool name, a ticket or a fact
 * comes from other code, and a terminal acts on the control characters in a string: an escape sequence can rewrite
 * the screen. They become `?`, and so do the characters that reorder text on the line.
 */
export function clean(text: string): string {
    return text.replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

/** The text cut to `max` characters, with `…` where it was cut. */
export function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A name from the records, ready to print in a column. */
export const label = (text: string, max = 28) => clip(clean(text), max);

/**
 * Rows of cells as lines whose columns line up: each column as wide as its widest cell, two spaces between columns, no
 * padding after the last one. Columns in `right` (by index) are right-aligned, as numbers should be.
 */
export function table(rows: ReadonlyArray<readonly string[]>, right: readonly number[] = []): string[] {
    const columns = Math.max(0, ...rows.map((row) => row.length));
    const widths = Array.from({ length: columns }, (_, column) =>
        Math.max(0, ...rows.map((row) => (row[column] ?? "").length)),
    );
    return rows.map((row) =>
        widths
            .map((width, column) => {
                const cell = row[column] ?? "";
                if (column === columns - 1 && !right.includes(column)) return cell;
                return right.includes(column) ? cell.padStart(width) : cell.padEnd(width);
            })
            .join("  ")
            .trimEnd(),
    );
}
