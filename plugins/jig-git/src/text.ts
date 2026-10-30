// Small helpers for the plain text every jig-git tool returns to the model.

/** `text` cut to `max` characters, with "..." when something was cut. */
export function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The first `maxLines` lines. `cut` counts the lines left out, so the caller can say how to see the rest. */
export function firstLines(text: string, maxLines: number): { text: string; cut: number } {
    const all = text.replace(/\n$/, "").split("\n");
    return { text: all.slice(0, maxLines).join("\n"), cut: Math.max(0, all.length - maxLines) };
}

export function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Joins the parts that are not empty, one per line. `false` and `undefined` let a caller write `cond && "text"`. */
export function lines(...parts: readonly (string | false | undefined)[]): string {
    return parts.filter((part): part is string => part !== undefined && part !== false && part !== "").join("\n");
}

/** Runs `work` on every item with at most `limit` running at once, and keeps the results in order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index] as T);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
