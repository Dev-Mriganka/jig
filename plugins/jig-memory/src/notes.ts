// notes.md: the template a new ticket starts from, and the ## Now block, which stays under 1 KB. ## Now is read first,
// and a compaction message repeats it, so it stays short: the lines it outgrows move to history/. These are text
// functions. store.ts reads and writes the file.

/** A ## Now block over this many bytes is moved to history. */
export const NOW_LIMIT = 1024;
/** After a move, ## Now keeps the first whole lines that fit in this many bytes. The status, the next step and the
 *  open questions sit at the top, so they stay, and the room left under NOW_LIMIT is for the pointer and new lines. */
export const NOW_KEEP = 768;

const NOW = /^##[ \t]+now[ \t]*\r?$/i;
// A `#` or `##` heading ends the block. A `###` heading is part of it.
const SECTION = /^#{1,2}[ \t]/;
// The line a move leaves in the block, naming the history file that holds the lines it replaced.
const POINTER = /^\(older lines moved to history\/[^)]*\)\r?$/;

export function notesTemplate(key: string): string {
    return `# ${key}\n\n## Now\nStatus: new\nNext:\nOpen questions:\n\n## Decisions\n`;
}

/** A history file: the lines that left ## Now, with the time they left. */
export function historyText(moved: string, when: Date): string {
    return `# Moved from ## Now at ${when.toISOString()}\n\n${moved}\n`;
}

/**
 * The notes with ## Now cut to NOW_KEEP bytes, and the lines cut as `moved`. Undefined when ## Now is within NOW_LIMIT,
 * or when no line can move. The caller writes `moved` to history/<historyName>, which the pointer line names.
 */
export function tidyNow(notes: string, historyName: string): { notes: string; moved: string } | undefined {
    const lines = notes.split("\n");
    const start = lines.findIndex((line) => NOW.test(line));
    if (start < 0) return undefined;
    let end = start + 1;
    while (end < lines.length && !SECTION.test(lines[end] ?? "")) end++;
    if (Buffer.byteLength(lines.slice(start, end).join("\n")) <= NOW_LIMIT) return undefined;

    // An older pointer is dropped here and written again below, so a block never holds more than one.
    const body = lines.slice(start + 1, end).filter((line) => !POINTER.test(line));
    let keep = 0;
    let bytes = 0;
    for (const line of body) {
        const size = Buffer.byteLength(line) + 1;
        // The first line always stays, so a block that is one long line is never emptied.
        if (keep > 0 && bytes + size > NOW_KEEP) break;
        bytes += size;
        keep++;
    }
    const head = trimBlank(body.slice(0, keep));
    const moved = trimBlank(body.slice(keep));
    if (moved.length === 0) return undefined;
    const pointer = `(older lines moved to history/${historyName})`;
    const rebuilt = [...lines.slice(0, start), lines[start] ?? "", ...head, pointer, "", ...lines.slice(end)];
    return { notes: rebuilt.join("\n"), moved: moved.join("\n") };
}

/** The lines without the blank ones at either end. */
function trimBlank(lines: readonly string[]): string[] {
    let from = 0;
    let to = lines.length;
    while (from < to && lines[from]?.trim() === "") from++;
    while (to > from && lines[to - 1]?.trim() === "") to--;
    return lines.slice(from, to);
}
