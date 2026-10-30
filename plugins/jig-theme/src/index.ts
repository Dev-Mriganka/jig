// Pi entry point of jig-theme. The factory registers the `theme` section with jig-core and listens for what it needs; the
// palettes are written, the footer is installed and the answer colour is set only when a session starts in a terminal.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jig, withJig } from "../../jig-core/src/client.ts";
import { applyPalettes } from "./apply.ts";
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
}

/** The `theme` section as jig-core loaded it. Without jig-core, or without the section, the defaults apply. */
function themeSection(): unknown {
    try {
        return jig().config.section("theme");
    } catch {
        return undefined;
    }
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

        pi.on("session_start", (_event, ctx: ExtensionContext) => {
            const now = settings();
            // Palettes are for a person at a terminal: not for print and RPC runs, and not for a child the parent started.
            if (ctx.mode === "tui" && !isSubagentChild(env)) {
                const applied = applyPalettes(ctx.ui, agentDir(), now.palettes);
                if (applied.problems.length > 0) ctx.ui.notify(`jig-theme: ${applied.problems.join("\n")}`, "warning");
                if (applied.notes.length > 0) ctx.ui.notify(`jig-theme: ${applied.notes.join("\n")}`, "info");
            }
            session.start(ctx, now);
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
        });
    };
}

export default theme();
