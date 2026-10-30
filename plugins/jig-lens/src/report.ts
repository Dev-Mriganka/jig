// What the commands tell the user. Plain sentences, built from what the importer and the index report, so they can be
// read and tested without starting anything.
import { plural } from "./format.ts";
import { RETENTION_DAYS } from "./import.ts";
import type { ImportOutcome } from "./import.ts";
import type { IndexStatus } from "./store.ts";
import type { Viewer } from "./viewer.ts";

/** The first line of an error's message, which is the part that says what went wrong. */
export const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** `1.2 MB`. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `2026-10-30 14:02:11 UTC`, the way the records give times. */
export function formatTime(seconds: number): string {
    return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** What an import did, in a sentence or two. */
export function importLine({ result, problem }: ImportOutcome): string {
    if (result === undefined) return `The import failed: ${problem}. /lens rebuild makes the index again.`;
    const parts = [
        result.calls + result.turns === 0
            ? "The index is up to date."
            : `Imported ${plural(result.calls, "new call")} and ${plural(result.turns, "new turn")}.`,
    ];
    if (result.skipped > 0) parts.push(skippedLine(result.skipped));
    if (result.removed > 0) parts.push(`Removed ${plural(result.removed, "row")} older than ${RETENTION_DAYS} days.`);
    if (problem !== undefined) parts.push(`Not read: ${problem}.`);
    return parts.join(" ");
}

export function skippedLine(lines: number): string {
    return lines === 1 ? "Skipped 1 line that is not a record." : `Skipped ${lines} lines that are not records.`;
}

/** The index's part of `/lens status`: where it is, what it holds, when it was last imported, and what was skipped. */
export function indexLines(file: string, read: () => IndexStatus | undefined): string[] {
    let status: IndexStatus | undefined;
    try {
        status = read();
    } catch (error) {
        return [`Index: ${file} cannot be read (${reason(error)}). /lens rebuild makes it again.`];
    }
    if (status === undefined) {
        return [`Index: none yet at ${file}. It is made when an agent run ends, and by /lens.`, "Last import: never"];
    }
    const held = `${plural(status.calls, "call")} and ${plural(status.turns, "turn")}`;
    const skipped = status.skipped.reduce((sum, row) => sum + row.lines, 0);
    return [
        `Index: ${status.file}, ${formatBytes(status.bytes)}, ${held} from ${plural(status.files, "record file")}`,
        `Last import: ${status.lastImport === undefined ? "never" : formatTime(status.lastImport)}`,
        skipped === 0
            ? "Skipped lines: none"
            : `Skipped lines: ${skipped} (${status.skipped.map((row) => `${row.file}: ${row.lines}`).join(", ")})`,
    ];
}

/** What to do when the viewer's program is not on PATH. */
export function missingProgram(viewer: Viewer): string {
    if (viewer === "datasette") {
        return [
            "Datasette is not installed: there is no datasette on PATH.",
            "Install it with pip (pip install datasette), then run /lens datasette again.",
        ].join("\n");
    }
    return [
        "Grafana is not installed: there is no grafana or grafana-server on PATH.",
        "Install Grafana OSS with your package manager (Homebrew on macOS), then add its SQLite data source:",
        "  grafana cli plugins install frser-sqlite-datasource",
        "and run /lens grafana again.",
        "Datasette shows the same index. Install it with pip (pip install datasette) and run /lens datasette.",
    ].join("\n");
}

/** Said the first time Grafana starts with its folder: the sign-in is the user's to secure. */
export const FIRST_START = [
    "First start: sign in as admin (Grafana's initial password is admin) and choose a new password when it asks.",
    "Do not skip that: until you do, any program on this machine can sign in.",
    "If the dashboards report that the data source plugin is missing, run " +
        "grafana cli plugins install frser-sqlite-datasource and start Grafana again.",
];
