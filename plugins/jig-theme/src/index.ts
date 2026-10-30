// Pi entry point of jig-theme. The factory registers the `theme` section with jig-core and listens for what it needs; the
// palettes are written, the footer is installed and the answer colour is set only when a session starts in a terminal.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jig, withJig } from "../../jig-core/src/client.ts";
import { applyPalettes } from "./apply.ts";
import { installAnswerText, uninstallAnswerText } from "./answer-text.ts";
import { registerThemeCommand, reloadWasAsked } from "./command.ts";
import { settingsFrom, validateTheme } from "./config.ts";
import type { ThemeSettings } from "./config.ts";
import { isSubagentChild } from "./child.ts";
import { SEGMENT_EVENT } from "./segments.ts";
import { Session } from "./session.ts";

/** The parts a test replaces. */
export interface ThemeOptions {
    /** Pi's environment. */
    env?: NodeJS.ProcessEnv;
    /** Pi's agent folder, looked up at each use. Default: Pi's own, which `PI_CODING_AGENT_DIR` moves. */
    agentDir?: () => string;
    /** From the `theme` section of jig.json, or the defaults. */
    settings?: () => ThemeSettings;
    /** How long after a reload this plugin's notices wait, so that Pi's own "Reloaded" line does not replace them. */
    noticeDelayMs?: number;
    /** How long after a session starts, or a theme is chosen, a changed palette's file is written again for Pi to read it anew. */
    rereadDelayMs?: number;
}

/** The `theme` section as jig-core loaded it. Without jig-core, or without the section, the defaults apply. */
function themeSection(): unknown {
    try {
        return jig().config.section("theme");
    } catch {
        return undefined;
    }
}

/** What a `/theme reload` did, in a line. */
function summary(applied: { written: string[]; removed: string[] }, palettes: string[]): string {
    const parts: string[] = [];
    if (applied.written.length > 0) parts.push(`wrote ${applied.written.join(", ")}`);
    if (applied.removed.length > 0) parts.push(`removed ${applied.removed.join(", ")}`);
    if (parts.length > 0) return parts.join("; ");
    return palettes.length > 0 ? "your palettes are up to date" : "no palettes in jig.json";
}

/** The extension, with parts a test can replace. Pi loads the default export below. */
export function theme(options: ThemeOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const env = options.env ?? process.env;
        const agentDir = options.agentDir ?? (() => getAgentDir());
        const settings = options.settings ?? (() => settingsFrom(themeSection()));
        withJig((api) => api.config.registerSection("theme", validateTheme));
        const session = new Session(pi, env);

        // Other plugins add footer parts on the event bus. This is listened to from the start, so a part sent before this
        // plugin's session starts is not lost.
        const unlisten = pi.events.on(SEGMENT_EVENT, (payload) => {
            if (session.plugins.accept(payload)) session.refresh();
        });

        pi.on("session_start", (event, ctx: ExtensionContext) => {
            const now = settings();
            const asked = reloadWasAsked();
            // Pi shows its own line when a reload ends, which replaces a notice made while it was reloading: those wait.
            const say = (text: string, level: "info" | "warning") => {
                if (event.reason === "reload")
                    session.later(() => ctx.ui.notify(text, level), options.noticeDelayMs ?? 1500);
                else ctx.ui.notify(text, level);
            };
            // Palettes are for a person at a terminal: not for print and RPC runs, and not for a child the parent started.
            if (ctx.mode === "tui" && !isSubagentChild(env)) {
                const applied = applyPalettes(ctx.ui, agentDir(), now.palettes);
                session.start(ctx, now);
                if (applied.problems.length > 0) say(`jig-theme: ${applied.problems.join("\n")}`, "warning");
                // One notice: Pi shows a notice of this kind in place of the one before it.
                const info = [...applied.notes];
                if (asked && applied.problems.length === 0) info.push(summary(applied, Object.keys(now.palettes)));
                if (info.length > 0) say(`jig-theme: ${info.join("\n")}`, "info");
                session.markStale(applied.changed);
                // The theme in use is read again by Pi when its file changes; this makes it change once more, after Pi is watching.
                const inUse = ctx.ui.theme?.name;
                if (inUse !== undefined) session.reread(agentDir(), inUse, options.rereadDelayMs ?? 800);
            } else {
                session.start(ctx, now);
            }
            // Answers in the theme's colour, so they stand apart from thinking text. Any terminal session, a child's too.
            if (ctx.mode === "tui" && now.answerColor !== false) {
                const role = now.answerColor;
                installAnswerText(() => (text) => ctx.ui.theme.fg(role, text));
            } else {
                uninstallAnswerText();
            }
        });

        // What the footer shows changes with these; it is drawn again, and reads everything fresh.
        const refresh = () => session.refresh();
        pi.on("message_end", refresh);
        pi.on("thinking_level_select", refresh);
        pi.on("agent_settled", refresh);
        pi.on("session_compact", refresh);
        pi.on("session_tree", refresh);
        pi.on("model_select", refresh);

        pi.on("session_shutdown", () => {
            unlisten();
            session.shutdown();
            uninstallAnswerText();
        });

        registerThemeCommand(pi, { session, agentDir, rereadDelayMs: options.rereadDelayMs ?? 100 });
    };
}

export default theme();
