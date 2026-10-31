// Closing a ticket: the plugin drafts card.md from the notes and evidence, the agent fills the three sections, and the
// plugin reads the file back. These are the steps without Pi: session.ts sends the messages and decides when to check.
import {
    type CardFront,
    type CardSections,
    checkCard,
    draftCard,
    isValid,
    PLACEHOLDER,
    renderCard,
    SECTION_LIMIT,
    SECTIONS,
} from "./card.ts";
import { frontOf, hasContent, readMaterial } from "./material.ts";
import { readText, replaceFile, ticketPaths } from "./store.ts";

/** The custom message that asks the agent to write the card. */
export const CARD_REQUEST = "jig-memory-card-request";
/** The custom message that says what to change in a card that did not pass. */
export const CARD_FIX = "jig-memory-card-fix";

/** What the plugin remembers of a close that is waiting for the agent. */
export interface Closing {
    key: string;
    /** The front matter as drafted, which is written back if the agent damages it. */
    front: CardFront;
    /** Whether the one correction message has been sent. */
    corrected: boolean;
}

/** The ticket has nothing a card could say. */
export class NothingToClose extends Error {}

/**
 * Writes the draft card of a ticket and returns what the plugin keeps of it. An existing card is replaced: a ticket
 * that was reopened gets a new card.
 */
export function draftClose(folder: string, key: string, pattern: RegExp | undefined, now: Date): Closing {
    const material = readMaterial(folder, key);
    if (!hasContent(material)) {
        throw new NothingToClose(`${key} has no notes or saved evidence yet, so there is nothing to put on a card.`);
    }
    const front = frontOf(material, pattern, now);
    replaceFile(ticketPaths(folder, key).card, draftCard(front));
    return { key, front, corrected: false };
}

/** The one message that asks the agent to fill the card. */
export function requestText(folder: string, key: string): string {
    const paths = ticketPaths(folder, key);
    return [
        `[ticket ${key}] Closing the ticket. A draft card is in ${paths.card}, with its front matter filled in.`,
        `Fill its three sections from ${paths.notes} (and ${paths.evidence}/ if you need the exact error), with your file tools:`,
        "",
        "- `## Problem`: what went wrong, or what was asked for.",
        "- `## Cause`: why it happened.",
        "- `## Fix`: what was changed, or what to do.",
        "",
        `Each section is plain text of at most ${SECTION_LIMIT} characters (aim for 300) and replaces ${PLACEHOLDER}. Write only what the notes and evidence say. Keep only these three sections, and leave the front matter as it is.`,
    ].join("\n");
}

/** The message for a card that did not pass: what to change, once. */
export function correctionText(folder: string, key: string, problems: readonly string[]): string {
    return [
        `[ticket ${key}] The card in ${ticketPaths(folder, key).card} needs changes:`,
        ...problems.map((problem) => `- ${problem}`),
        "Edit the file, and keep only the sections Problem, Cause and Fix.",
    ].join("\n");
}

/**
 * Reads card.md back. A card with a section missing, empty, still the placeholder or too long is not ok, and the
 * problems say what to change. When the sections are fine and the front matter is not, the drafted front matter is
 * written back, because only the plugin fills it.
 */
export function verifyCard(folder: string, closing: Closing): { ok: boolean; problems: string[] } {
    const file = ticketPaths(folder, closing.key).card;
    const text = readText(file);
    if (text === "") {
        return {
            ok: false,
            problems: [`The card is gone: ${file} is missing. Run /ticket close ${closing.key} again.`],
        };
    }
    const checked = checkCard(text);
    if (checked.problems.length > 0) return { ok: false, problems: checked.problems };
    if (!isValid(checked, closing.key)) {
        const sections = Object.fromEntries(SECTIONS.map((name) => [name, checked.sections[name] ?? ""]));
        replaceFile(file, renderCard(closing.front, sections as CardSections));
    }
    return { ok: true, problems: [] };
}
