// What a preview shows, as data, and the plain-text body made from it. The markup for the browser page (page.ts) is made
// from the same data, so the review screen and the page can never disagree about what will be sent.
import type { Preview } from "../../jig-core/src/contract.ts";
import { htmlOf } from "./page.ts";
import { FLAG_HEADING, flagLines } from "./pointers.ts";

/** A text that will be sent, in Jira wiki markup. */
export interface TextBlock {
    label: string;
    source: string;
    /** The text it replaces, when the write replaces one. */
    replaces?: string;
}

export interface Shown {
    /** One line: what will happen. */
    summary: string;
    /** Pointers to things readers cannot open, found in the outgoing text (see pointers.ts). */
    flags: readonly string[];
    /** Plain facts: a label and a value, such as each field of a new issue with its final value. */
    rows: ReadonlyArray<readonly [label: string, value: string]>;
    /** Lines of explanation, such as the possible duplicates of a new issue. */
    notes: readonly string[];
    texts: readonly TextBlock[];
}

/** The summary, with a mark when the text was flagged, so the mark is seen on every screen. */
export function summaryOf(shown: Shown): string {
    const count = shown.flags.length;
    const mark = count === 0 ? "" : ` [${count === 1 ? "1 pointer" : `${count} pointers`} flagged]`;
    return `${shown.summary}${mark}`;
}

/** The body for the review screen: flags first, then the facts, the notes and each text as the wiki source. */
export function bodyOf(shown: Shown): string {
    const parts: string[] = [];
    if (shown.flags.length > 0) {
        const listed = flagLines(shown.flags).map((flag) => `  - ${flag}`);
        parts.push([FLAG_HEADING, ...listed, "Rewrite the text, or approve it if this is intended."].join("\n"));
    }
    if (shown.rows.length > 0) parts.push(shown.rows.map(([label, value]) => `${label}: ${value}`).join("\n"));
    if (shown.notes.length > 0) parts.push(shown.notes.join("\n"));
    for (const text of shown.texts) {
        parts.push(`${text.label} (Jira wiki markup):\n${text.source}`);
        if (text.replaces !== undefined) parts.push(`It replaces:\n${text.replaces === "" ? "(nothing)" : text.replaces}`);
    }
    return parts.join("\n\n");
}

/** The preview that jig-core shows, without a fingerprint: the plan adds it. */
export function previewOf(shown: Shown): Omit<Preview, "fingerprint"> {
    return {
        summary: summaryOf(shown),
        body: bodyOf(shown),
        format: "text",
        // Only a write that carries text gets markup of its own; for the rest jig-core makes the page from the body.
        ...(shown.texts.length === 0 ? {} : { html: htmlOf(shown) }),
    };
}
