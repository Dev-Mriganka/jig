// How the summary reaches the user, and why it never reaches the model.
//
// The summary is for the person at the keyboard. Pi has four ways to put text on the screen from a command, and one is
// right for a table the user reads and may compare with an earlier one:
//
//  - `pi.sendMessage` / `pi.sendUserMessage`: part of the conversation. The model would read it, and every later turn
//    would pay for it. Wrong for anything that is only for the user.
//  - `ctx.ui.notify`: a status line. It is drawn dim, and the next status replaces it, so a table does not stay long
//    enough to be read next to a later one. Right for a sentence, and for an RPC client (below).
//  - `ctx.ui.custom` or a widget: a screen or a strip that takes the keyboard or the space beside the editor until the
//    user closes it, and has to scroll and handle keys itself.
//  - `pi.appendEntry` with an entry renderer (chosen): Pi's own types say custom entries "do not participate in LLM
//    context". It is drawn in the transcript like any message, so the terminal's scrollback and selection work, it
//    needs no keys, and a resumed session shows it again as it was. The renderer draws the data with the colours of
//    the current theme, so a theme change reaches an old summary too.
//
// Only the full terminal interface draws entries. An RPC client has dialogs and notifications but no transcript to
// draw into, so it gets the shortened text as a notification. With no screen at all (print and JSON modes) nothing is
// shown: there is nobody to show it to, and printing it would put it in the run's output.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { clean } from "./format.ts";
import { render, short } from "./summary.ts";
import type { Block, Style } from "./summary.ts";

/** The kind of session entry that holds a summary. */
export const ENTRY = "jig-lens-summary";

/** What an entry holds. Only strings and lists of them, so it is the same text whatever draws it. */
export interface SummaryEntry {
    blocks: Block[];
}

const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");

/** Whether data read back from a session file is a list of blocks. A file from another version may hold anything. */
function isBlocks(value: unknown): value is Block[] {
    return (
        Array.isArray(value) &&
        value.every((block: unknown) => {
            if (typeof block !== "object" || block === null) return false;
            const { title, sections, empty } = block as Record<string, unknown>;
            return (
                typeof title === "string" &&
                (empty === undefined || typeof empty === "string") &&
                Array.isArray(sections) &&
                sections.every((section: unknown) => {
                    if (typeof section !== "object" || section === null) return false;
                    const { name, lines } = section as Record<string, unknown>;
                    return typeof name === "string" && isStrings(lines);
                })
            );
        })
    );
}

/**
 * The blocks with control characters cleaned again. The summary cleans the text it makes, but an entry is read back
 * from a session file, which anyone could have edited or handed over, and a terminal acts on an escape sequence.
 */
function cleaned(blocks: readonly Block[]): Block[] {
    return blocks.map((block) => ({
        title: clean(block.title),
        ...(block.empty === undefined ? {} : { empty: clean(block.empty) }),
        sections: block.sections.map((section) => ({ name: clean(section.name), lines: section.lines.map(clean) })),
    }));
}

/** The colours of a theme for the parts of a block. */
function styleOf(theme: Theme): Style {
    return {
        title: (text) => theme.bold(theme.fg("accent", text)),
        label: (text) => theme.bold(text),
        dim: (text) => theme.fg("dim", text),
    };
}

/** Teaches Pi to draw a summary entry. Called when the extension loads. */
export function registerDisplay(pi: ExtensionAPI): void {
    pi.registerEntryRenderer<SummaryEntry>(ENTRY, (entry, _options, theme) => {
        const blocks = entry.data?.blocks;
        // An entry that does not hold a summary is not drawn. Pi would show the error of a renderer that throws.
        if (!isBlocks(blocks)) return undefined;
        const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
        // Text keeps the spaces that line the columns up, and wraps a line only when the terminal is narrower than it.
        box.addChild(new Text(render(cleaned(blocks), styleOf(theme)).join("\n"), 0, 0));
        return box;
    });
}

/** Shows the summary on whatever screen there is. `brief` is the text for a notification, when cutting each section to
 *  its first line would not say enough. */
export function show(pi: ExtensionAPI, ctx: ExtensionContext, blocks: readonly Block[], brief?: string): void {
    if (ctx.mode === "tui") {
        pi.appendEntry<SummaryEntry>(ENTRY, { blocks: [...blocks] });
    } else if (ctx.hasUI) {
        ctx.ui.notify(brief ?? short(blocks), "info");
    }
}
