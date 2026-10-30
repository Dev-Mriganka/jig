// What the model reads: a header line, then one line of JSON for each document. Each line stays valid JSON, because jig-core
// masks production results field by field and withholds JSON-like text that does not parse.
import { toExtended } from "./bson.ts";

/** Stays under jig-core's cap on a result's text, so that the model gets the whole of what is shown. */
export const MAX_TEXT = 40_000;

export const partialNote = (limit: number): string =>
    `possibly partial (limit ${limit} reached; narrow the filter or raise limit)`;

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** One value as a line of JSON. */
export const line = (value: unknown): string => JSON.stringify(toExtended(value)) ?? "null";

/**
 * The header and the documents, as lines. When the documents do not all fit in the budget the header says how many were
 * shown, so a cut is never silent.
 */
export function renderDocs(
    head: string,
    noun: [string, string],
    docs: readonly unknown[],
    options: { limit?: number; note?: string } = {},
): string {
    const lines: string[] = [];
    let size = 0;
    for (const doc of docs) {
        const text = line(doc);
        if (size + text.length > MAX_TEXT && lines.length > 0) break;
        lines.push(text);
        size += text.length + 1;
    }
    const notes: string[] = [];
    if (options.note !== undefined) notes.push(options.note);
    if (options.limit !== undefined && docs.length >= options.limit) notes.push(partialNote(options.limit));
    if (lines.length < docs.length)
        notes.push(
            `showing the first ${lines.length}; the output limit was reached, so narrow the projection or lower the limit`,
        );
    const suffix = notes.length === 0 ? "" : `, ${notes.join("; ")}`;
    return [`${head}: ${plural(docs.length, noun[0], noun[1])}${suffix}`, ...lines].join("\n");
}
