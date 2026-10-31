// What the agent and the `/ps` log view read of a task's log: paged, filtered and capped. The log already holds cleaned text
// with credential values taken out, so nothing here cleans. The paging helpers (takeLines, wholeCharacters, fitPrefix) are
// adapted from gvanderclay/pi-bg-bash (MIT, see docs/background.md, "Credit").
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { formatRuntime, runtimeMs, stateText } from "./format.ts";
import { countLines } from "./logfile.ts";
import type { TaskLog } from "./logfile.ts";
import type { Task } from "./types.ts";

const NEWLINE = 0x0a;
/** An unfinished last line of a running task is held back until its newline or this much quiet. */
export const IDLE_MS = 500;
const LOOKBACK = 64 * 1024;

export interface OutputRequest {
    /** The last lines. */
    tail?: number;
    /** Read forward from this offset. */
    offset?: number;
    /** Keep the lines that contain this text, ignoring case. */
    filter?: string;
}

export interface OutputResult {
    text: string;
    /** The range of the log this read covered, so a wake-up it made redundant can be dropped. */
    range?: { start: number; end: number };
}

export function formatBytes(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Drops bytes from the end so the buffer does not finish inside a multi-byte character. */
export function wholeCharacters(buffer: Buffer): Buffer {
    let end = buffer.length;
    let at = end;
    while (at > 0 && end - at < 3 && ((buffer[at - 1] as number) & 0xc0) === 0x80) at--;
    if (at > 0 && (buffer[at - 1] as number) >= 0xc0) {
        const lead = buffer[at - 1] as number;
        const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
        if (end - (at - 1) < need) end = at - 1;
    }
    return buffer.subarray(0, end);
}

function fromCharacterBoundary(buffer: Buffer): Buffer {
    let start = 0;
    while (start < buffer.length && start < 3 && ((buffer[start] as number) & 0xc0) === 0x80) start++;
    return buffer.subarray(start);
}

/** The longest whole-character prefix of `line` that decodes to at most `maxBytes`. */
function fitPrefix(line: Buffer, maxBytes: number): number {
    let length = Math.min(line.length, maxBytes);
    for (;;) {
        length = wholeCharacters(line.subarray(0, length)).length;
        const decoded = Buffer.byteLength(line.subarray(0, length).toString("utf8"));
        if (decoded <= maxBytes || length <= 1) return Math.max(length, 1);
        length = Math.min(length - 1, Math.floor((length * maxBytes) / decoded));
    }
}

/** Whole lines from the start of `buffer`, at most `maxLines` and `maxBytes` once decoded. `used` counts bytes of the buffer. */
function takeLines(buffer: Buffer, maxLines: number, maxBytes: number): { text: string; used: number } {
    let used = 0;
    let lines = 0;
    let decoded = 0;
    while (used < buffer.length && lines < maxLines) {
        const newline = buffer.indexOf(NEWLINE, used);
        const lineEnd = newline < 0 ? buffer.length : newline + 1;
        const size = Buffer.byteLength(buffer.subarray(used, lineEnd).toString("utf8"));
        if (decoded + size > maxBytes) {
            if (lines === 0) used = fitPrefix(buffer.subarray(0, lineEnd), maxBytes);
            break;
        }
        decoded += size;
        used = lineEnd;
        lines++;
    }
    const text = buffer.subarray(0, used).toString("utf8");
    return { text: text.endsWith("\n") ? text.slice(0, -1) : text, used };
}

/** The end of what may be shown: everything once the task is over or quiet, else up to the last line feed. */
export function readableEnd(task: Task, now: number): number {
    const log = task.log;
    if (!log) return 0;
    if (task.state !== "running" || now - log.lastWriteAt >= IDLE_MS) return log.size;
    const from = Math.max(log.oldest, log.size - LOOKBACK);
    const newline = log.read(from, log.size).lastIndexOf(NEWLINE);
    if (newline >= 0) return from + newline + 1;
    return from > log.oldest ? log.size : from;
}

function applyFilter(text: string, filter: string | undefined): { text: string; note?: string } {
    if (filter === undefined || text === "") return { text };
    const needle = filter.toLowerCase();
    const all = text.split("\n");
    const kept = all.filter((line) => line.toLowerCase().includes(needle));
    return { text: kept.join("\n"), note: `[filter: ${kept.length} of ${all.length} lines matched]` };
}

function fits(text: string): boolean {
    return Buffer.byteLength(text) <= DEFAULT_MAX_BYTES && text.split("\n").length <= DEFAULT_MAX_LINES;
}

function header(task: Task, now: number): string {
    const log = task.log;
    const size = log?.size ?? 0;
    const oldest = log?.oldest ?? 0;
    return `${task.id} "${task.name}": ${stateText(task)}, ${formatRuntime(runtimeMs(task, now))}, ${formatBytes(size)} logged (offsets ${oldest}-${size}, ${oldest} dropped).`;
}

function footer(parts: Array<string | undefined>): string | undefined {
    const kept = parts.filter((part): part is string => Boolean(part));
    return kept.length > 0 ? `[${kept.join(" | ")}]` : undefined;
}

/** Reads forward from `start`: a page of whole lines, filtered and capped. */
function forward(
    log: TaskLog,
    start: number,
    end: number,
    filter: string | undefined,
): { body: string; note?: string; next: number; range: { start: number; end: number } } {
    const buffer = log.read(start, Math.min(end, start + DEFAULT_MAX_BYTES * 2 + 1));
    const windowCut = start + buffer.length < end;
    let whole = buffer;
    // Only whole lines, unless a single line is longer than the window.
    if (windowCut) {
        const last = buffer.lastIndexOf(NEWLINE);
        whole = last >= 0 ? buffer.subarray(0, last + 1) : wholeCharacters(buffer.subarray(0, DEFAULT_MAX_BYTES));
    }
    const page = takeLines(whole, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    const shown = applyFilter(page.text, filter);
    const body = fits(shown.text)
        ? shown.text
        : truncateTail(shown.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
    return { body, note: shown.note, next: start + page.used, range: { start, end: start + page.used } };
}

export function readOutput(task: Task, request: OutputRequest, now: number): OutputResult {
    const log = task.log;
    const head = header(task, now);
    if (!log) return { text: `${head}\n(no output)` };
    const end = readableEnd(task, now);
    const oldest = log.oldest;
    let range: { start: number; end: number } | undefined;
    let body = "";
    let note: string | undefined;
    let next: number | undefined;
    let skipped: number | undefined;
    let dropped = false;

    if (request.tail !== undefined) {
        const from = Math.max(oldest, end - DEFAULT_MAX_BYTES * 4);
        const buffer = log.read(from, end);
        let offset = from;
        let slice = buffer;
        if (from > oldest) {
            const first = buffer.indexOf(NEWLINE);
            // A window with no whole line in it (one huge line) is cut at a character boundary instead.
            const cut =
                first >= 0 && first < buffer.length - 1
                    ? first + 1
                    : buffer.length - fromCharacterBoundary(buffer).length;
            offset += cut;
            slice = buffer.subarray(cut);
        }
        const start = startOfLastLines(slice, request.tail);
        offset += start;
        slice = slice.subarray(start);
        const shown = applyFilter(slice.toString("utf8").replace(/\n$/, ""), request.filter);
        body = truncateTail(shown.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
        note = shown.note;
        range = { start: offset, end };
        const unreadFrom = Math.max(task.cursor, oldest);
        if (offset > unreadFrom) {
            const lines = countLines(log, unreadFrom, offset);
            if (lines > 0) skipped = lines;
        }
        task.cursor = end;
    } else {
        const wanted = request.offset ?? task.cursor;
        if (wanted > log.size) throw new Error(`offset ${wanted} is past the end of the log (${log.size}).`);
        const start = Math.max(wanted, oldest);
        dropped = wanted < oldest;
        if (start < end) {
            const page = forward(log, start, end, request.filter);
            body = page.body;
            note = page.note;
            range = page.range;
            if (page.next < end) next = page.next;
            if (request.offset === undefined) task.cursor = page.next;
        } else if (request.offset === undefined) {
            task.cursor = Math.max(task.cursor, start);
        }
    }

    const lines = [head];
    lines.push(body === "" ? (note ? "(no lines matched)" : "(no new output)") : body);
    if (note) lines.push(note);
    const rest = footer([
        next === undefined ? undefined : `next offset ${next}`,
        skipped === undefined ? undefined : `${skipped} unread line${skipped === 1 ? "" : "s"} skipped`,
        dropped ? `earlier output dropped by log rotation, oldest available offset ${oldest}` : undefined,
    ]);
    if (rest) lines.push(rest);
    return range === undefined ? { text: lines.join("\n") } : { text: lines.join("\n"), range };
}

/** The byte index in `buffer` where the last `count` lines start. */
function startOfLastLines(buffer: Buffer, count: number): number {
    let at = buffer.length;
    if (at > 0 && buffer[at - 1] === NEWLINE) at--;
    let seen = 0;
    while (at > 0) {
        const newline = buffer.lastIndexOf(NEWLINE, at - 1);
        if (newline < 0) return 0;
        seen++;
        if (seen === count) return newline + 1;
        at = newline;
    }
    return 0;
}

/** The last lines of the log for a message or the `/ps` view: capped, and it never moves the agent's read position. */
export function tailText(task: Task, maxLines: number, maxBytes: number, now: number): { text: string; cut: boolean } {
    const log = task.log;
    if (!log) return { text: "", cut: false };
    const end = readableEnd(task, now);
    const from = Math.max(log.oldest, end - LOOKBACK);
    const raw = fromCharacterBoundary(log.read(from, end));
    const lines = raw.toString("utf8").replace(/\n$/, "").split("\n");
    if (lines.length === 1 && lines[0] === "") return { text: "", cut: from > log.oldest };
    const chosen = lines.slice(-maxLines).join("\n");
    const bytes = Buffer.from(chosen, "utf8");
    const cut = from > log.oldest || lines.length > maxLines || bytes.length > maxBytes;
    if (bytes.length <= maxBytes) return { text: chosen, cut };
    return { text: fromCharacterBoundary(bytes.subarray(bytes.length - maxBytes)).toString("utf8"), cut };
}
