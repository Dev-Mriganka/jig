// Cleaning what a watch says before anyone reads it.
//
// The summary and details come from a plugin, often from a log or an API of a system that holds customer data. They are
// saved, handed to other plugins, shown to the user and sent to the agent. A message sent with `sendMessage` does not
// pass the hook that cleans tool results, so the engine has to do it here, once, when the watch ends.
//
// The order is the one for a tool result: redact secrets, mask personal data, cut to size. Terminal escape codes go
// first, because a code in the middle of a secret would stop the redactor from finding it.
import type { WatchResult } from "../contract.ts";
import { cleanFacts } from "../records.ts";

/** What the engine cleans with. `mask` throws when it cannot mask; the caller then withholds the text. */
export interface Protect {
    redact(text: string): string;
    mask(text: string): string;
}

export const MAX_DETAIL_LINES = 40;
export const MAX_LINE_CHARS = 1_000;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_LINKS = 10;
export const MAX_LINK_CHARS = 500;
/** Stands in for text that could not be masked. */
export const WITHHELD = "withheld: it could not be masked";

const OUTCOMES: readonly string[] = ["passed", "failed", "timed-out", "stopped", "error"];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a plugin's answer has the shape of a result. A poll that ends with anything else is a failed poll. */
export function isWatchResult(value: unknown): value is WatchResult {
    if (!isObject(value)) return false;
    const links = value.links;
    return (
        OUTCOMES.includes(value.outcome as string) &&
        typeof value.summary === "string" &&
        (value.details === undefined || typeof value.details === "string") &&
        (links === undefined || (Array.isArray(links) && links.every((link) => typeof link === "string"))) &&
        (value.facts === undefined || isObject(value.facts))
    );
}

// A CI log is full of colour codes, and a hostile one can carry codes that act on the terminal (a title, the
// clipboard). They are of no use to the model and no safe thing to show, so they go before anything else is done.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/; // colours, cursor moves
const OSC = /\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?/; // titles, links, the clipboard
const SHORT = /\u001b[@-Z\\-_]/; // two-character escapes
const ESCAPES = new RegExp([CSI, OSC, SHORT].map((part) => part.source).join("|"), "g");
// Control characters other than the tab and the line break, including the single-byte C1 codes.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Text without escape codes and control characters. A carriage return counts as a line break, so a progress bar that
 *  redraws itself becomes lines instead of one long run. */
export function sanitize(text: string): string {
    return text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "");
}

/** At most `max` characters, ending in an ellipsis when cut, and never between the halves of a surrogate pair. */
export function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = text.slice(0, max - 1);
    const last = head.charCodeAt(head.length - 1);
    return `${last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head}…`;
}

/** Line breaks and the white space around them become one space. */
function oneLine(text: string): string {
    return text.replace(/\s*\n\s*/g, " ").trim();
}

/** Text from a plugin shown as one short line, such as a title: no escape codes, no line breaks, cut to `max`. */
export function plainLine(text: string, max: number): string {
    return clip(oneLine(sanitize(text)), max);
}

/** Details as up to 40 lines of up to 1 000 characters. The 40th line says how many were cut. */
function detailLines(text: string): string | undefined {
    const lines = text.split("\n").map((line) => clip(line.trimEnd(), MAX_LINE_CHARS));
    while (lines[0] === "") lines.shift();
    while (lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return undefined;
    if (lines.length <= MAX_DETAIL_LINES) return lines.join("\n");
    const kept = lines.slice(0, MAX_DETAIL_LINES - 1);
    return [...kept, `[${lines.length - kept.length} more lines cut]`].join("\n");
}

/** One line of text from outside, such as an error message: cleaned, on one line, at most `max` characters. */
export function cleanLine(text: string, protect: Protect, max: number): string {
    try {
        return clip(oneLine(protect.mask(protect.redact(sanitize(text)))), max);
    } catch {
        return WITHHELD;
    }
}

/** A result safe to save, send and show. Never throws: text that cannot be masked is replaced; the outcome stays. */
export function cleanResult(result: WatchResult, protect: Protect): WatchResult {
    let summary: string;
    let details: string | undefined;
    try {
        const clean = (text: string) => protect.mask(protect.redact(sanitize(text)));
        summary = clip(oneLine(clean(result.summary)), MAX_SUMMARY_CHARS);
        details = result.details === undefined ? undefined : detailLines(clean(result.details));
    } catch {
        // Masking is all or nothing: if it failed, no part of the text can be trusted.
        summary = `summary ${WITHHELD}`;
        details = undefined;
    }
    // A link is not personal data and must stay a working address, so it is redacted but not masked.
    const links = (result.links ?? [])
        .slice(0, MAX_LINKS)
        .map((link) => clip(oneLine(protect.redact(sanitize(link))), MAX_LINK_CHARS));
    const facts = result.facts === undefined ? undefined : cleanFacts(result.facts, (text) => protect.redact(text));
    return {
        outcome: result.outcome,
        summary,
        ...(details === undefined ? {} : { details }),
        ...(links.length === 0 ? {} : { links }),
        ...(facts === undefined ? {} : { facts }),
    };
}
