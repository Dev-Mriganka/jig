// Cap: a result whose text is very long is cut for the model, and the whole text goes to a spill file the model can
// read on demand. The cut keeps the model's context small; the spill file keeps nothing lost.
//
// The text written to the spill file is the text after masking and redaction, because `results.ts` caps last.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createPrivateFile, privateDir, removeIfEmpty, removeOldFiles } from "./paths.ts";

/** A result with more text than this is cut. */
export const CAP_CHARS = 50_000;
/** How much of the text the model still gets. */
export const HEAD_CHARS = 8_000;

/** Pi's own tools that cut their output themselves, with a file of their own for the rest. */
export const SELF_TRUNCATING_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "powershell", "grep", "find", "ls"]);

export type Content = TextContent | ImageContent;

export interface Capped {
    content: Content[];
    /** The spill file, or undefined when it could not be written. */
    spill?: string;
}

/** The text blocks of a result, in one string. */
export function textOf(content: readonly Content[]): string {
    return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** A single safe file name for an id that came from outside: no folder separators, no dots-only names. */
function safeName(id: string): string {
    const clean = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    return /^\.*$/.test(clean) ? "_" : clean;
}

/** Cuts at a character boundary: not between the two halves of a surrogate pair. */
function head(text: string, length: number): string {
    const cut = text.slice(0, length);
    const last = cut.charCodeAt(cut.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Returns the capped content, or undefined when the result is short enough (or the tool cuts its own output).
 * The file is `<state>/spill/<session>/<tool call id>.txt`; a nested call id such as `call_1/2` becomes `call_1_2`.
 */
export function capContent(input: { tool: string; toolCallId: string; sessionId: string; content: readonly Content[] }): Capped | undefined {
    if (SELF_TRUNCATING_TOOLS.has(input.tool)) return undefined;
    const full = textOf(input.content);
    if (full.length <= CAP_CHARS) return undefined;

    const shown = head(full, HEAD_CHARS);
    const images = input.content.filter((block) => block.type !== "text");
    const spill = writeSpill(input.sessionId, input.toolCallId, full);
    const note = spill === undefined
        ? `[Output cut: ${full.length} characters in total, the first ${shown.length} shown. The full text could not be saved.]`
        : `[Output cut: ${full.length} characters in total, the first ${shown.length} shown. The full text is in ${spill}: read it with the read tool.]`;
    return {
        content: [{ type: "text", text: `${shown}\n\n${note}` }, ...images],
        ...(spill === undefined ? {} : { spill }),
    };
}

/** Writes the full text to a new private file. A second call with the same id gets a numbered name, so nothing is
 *  overwritten. Returns undefined when the file cannot be written. */
function writeSpill(sessionId: string, toolCallId: string, text: string): string | undefined {
    try {
        const dir = privateDir("spill", safeName(sessionId));
        const base = safeName(toolCallId);
        for (let attempt = 1; attempt < 100; attempt++) {
            const file = join(dir, attempt === 1 ? `${base}.txt` : `${base}-${attempt}.txt`);
            try {
                createPrivateFile(file, text);
                return file;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
        }
    } catch {
        // The result is still cut for the model; only the full copy is missing.
    }
    return undefined;
}

/** Deletes spill files older than `maxAgeDays`, and the session folders they leave empty. Returns how many files. */
export function cleanupSpill(maxAgeDays: number, now: number = Date.now()): number {
    let deleted = 0;
    const root = privateDir("spill");
    for (const session of readdirSync(root)) {
        const dir = join(root, session);
        deleted += removeOldFiles(dir, maxAgeDays, now);
        removeIfEmpty(dir);
    }
    return deleted;
}
