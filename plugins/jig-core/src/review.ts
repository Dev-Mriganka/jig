// The review screen: a scrollable preview that the user approves with a key, inside the waiting tool call.
//
//   y        allow
//   s        allow for this session
//   n, Esc   decline
//   o        open the rendered preview in the browser (the browser only shows; the answer is given here)
//   up, down, PgUp, PgDn, Home, End   scroll
//
// It is a component for `ctx.ui.custom`, so it exists only in the terminal interface. Other hosts use a plain selector
// (see `approvals.ts`).
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Preview } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import type { Answer } from "./records.ts";

export interface ReviewOptions {
    /** The line naming the tool, action, environment and effect. */
    header: string;
    preview: Preview;
    /** Opens the rendered preview in the browser and says how it went. */
    openInBrowser: () => Promise<string>;
}

/** Only what the screen uses of Pi's terminal interface and theme, so tests can pass small fakes. */
type Screen = Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
type Styles = Pick<Theme, "fg" | "bold">;

/** Lines the screen uses besides the summary and the body: three rules, the title, the keys, the status line. */
const CHROME_LINES = 6;
const MAX_SUMMARY_LINES = 4;

export function createReviewScreen(
    options: ReviewOptions,
    tui: Screen,
    theme: Styles,
    done: (answer: Answer) => void,
): Component {
    let top = 0;
    let status = "";
    let finished = false;
    let cached: { width: number; summary: string[]; body: string[] } | undefined;

    const answer = (value: Answer): void => {
        if (finished) return;
        finished = true;
        done(value);
    };

    /** Colours one line of the body by its format. */
    function style(line: string, inFence: { open: boolean }): string {
        const format = options.preview.format;
        if (format === "diff") {
            const header = ["+++", "---", "diff ", "index "].some((prefix) => line.startsWith(prefix));
            if (header) return theme.fg("muted", line);
            if (line.startsWith("@@")) return theme.fg("accent", line);
            if (line.startsWith("+")) return theme.fg("success", line);
            if (line.startsWith("-")) return theme.fg("error", line);
            return line;
        }
        if (format === "markdown") {
            if (line.startsWith("```")) {
                inFence.open = !inFence.open;
                return theme.fg("muted", line);
            }
            if (inFence.open) return theme.fg("muted", line);
            if (/^#{1,6}\s/.test(line)) return theme.bold(theme.fg("accent", line));
        }
        return line;
    }

    function layout(width: number): { summary: string[]; body: string[] } {
        if (cached?.width === width) return cached;
        const inner = Math.max(10, width - 2);
        const summary = wrapTextWithAnsi(options.preview.summary, inner).slice(0, MAX_SUMMARY_LINES);
        const body: string[] = [];
        const fence = { open: false };
        for (const line of (options.preview.body ?? "(no further detail)").split("\n")) {
            const wrapped = wrapTextWithAnsi(style(line, fence), inner);
            body.push(...(wrapped.length === 0 ? [""] : wrapped));
        }
        cached = { width, summary, body };
        return cached;
    }

    function viewport(summaryLines: number): number {
        return Math.max(1, tui.terminal.rows - CHROME_LINES - summaryLines - 1);
    }

    function scroll(to: number, bodyLines: number, height: number): void {
        top = Math.min(Math.max(0, to), Math.max(0, bodyLines - height));
    }

    return {
        render(width) {
            const { summary, body } = layout(width);
            const height = viewport(summary.length);
            scroll(top, body.length, height);
            const shown = body.slice(top, top + height);
            const position = body.length > height ? ` ${top + 1}-${top + shown.length} of ${body.length} ` : "";
            const rule = (extra = ""): string =>
                theme.fg("border", `${"─".repeat(Math.max(0, width - extra.length))}${extra}`);
            const key = (letter: string): string => theme.fg("accent", letter);
            const lines = [
                rule(),
                ` ${theme.bold(theme.fg("accent", "Approve this call?"))} ${theme.fg("muted", options.header)}`,
                ...summary.map((line) => ` ${line}`),
                rule(position),
                ...shown.map((line) => ` ${line}`),
                rule(),
                ` ${key("y")} allow  ${key("s")} allow for this session  ${key("n")}/Esc decline  ${key("o")} open in browser  ` +
                    theme.fg("muted", "up/down PgUp/PgDn scroll"),
                ` ${theme.fg("muted", status)}`,
            ];
            return lines.map((line) => truncateToWidth(line, width));
        },

        handleInput(data) {
            if (matchesKey(data, "y")) return answer("allow");
            if (matchesKey(data, "s")) return answer("allow-session");
            if (matchesKey(data, "n") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
                return answer("decline");
            if (matchesKey(data, "o")) {
                status = "opening the preview in the browser...";
                tui.requestRender();
                void options.openInBrowser().then(
                    (message) => {
                        status = message;
                        tui.requestRender();
                    },
                    // Writing the page can fail too (a full disk, say). The question stays open.
                    (error: unknown) => {
                        status = `could not open the browser: ${errorMessage(error)}`;
                        tui.requestRender();
                    },
                );
                return;
            }
            const { summary, body } = cached ?? { summary: [], body: [] };
            const height = viewport(summary.length);
            const page = Math.max(1, height - 1);
            if (matchesKey(data, "up") || matchesKey(data, "k")) scroll(top - 1, body.length, height);
            else if (matchesKey(data, "down") || matchesKey(data, "j")) scroll(top + 1, body.length, height);
            else if (matchesKey(data, "pageUp")) scroll(top - page, body.length, height);
            else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) scroll(top + page, body.length, height);
            else if (matchesKey(data, "home")) scroll(0, body.length, height);
            else if (matchesKey(data, "end")) scroll(body.length, body.length, height);
            else return;
            tui.requestRender();
        },

        invalidate() {
            cached = undefined;
        },
    };
}
