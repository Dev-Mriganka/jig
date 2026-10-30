// The `/theme` command:
//   /theme                 every theme, with a swatch of its colours; moving shows one, Enter keeps it, Esc puts back yours
//   /theme <name>          switches to that theme and keeps it, as /settings does
//   /theme reload          reads jig.json again and writes your palettes
//   /theme footer on|off   shows or hides this plugin's footer for this session
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickTheme } from "./picker.ts";
import type { Session } from "./session.ts";
import { plain } from "./width.ts";

export const USAGE = "Usage: /theme [name | reload | footer on|off]";

/** Set just before a reload that `/theme reload` asked for, so the session that starts after it can say what it wrote. */
const ASKED = Symbol.for("jig-theme.reload-asked");
type Flag = { [ASKED]?: boolean };

/** Whether the session that is starting follows a `/theme reload`; the answer is true once. */
export function reloadWasAsked(): boolean {
    const asked = (globalThis as Flag)[ASKED] === true;
    delete (globalThis as Flag)[ASKED];
    return asked;
}

const needsTerminal = (ctx: ExtensionCommandContext) => ctx.ui.notify("/theme needs the terminal.", "info");

export interface CommandDeps {
    session: Session;
    agentDir: () => string;
    /** How long after a theme is chosen its file is written again, for Pi to read a changed palette anew. */
    rereadDelayMs: number;
}

/** The names of the themes Pi has, kept for argument completion, which has no context of its own. */
let known: readonly string[] = [];

export function registerThemeCommand(pi: ExtensionAPI, deps: CommandDeps): void {
    pi.registerCommand("theme", {
        description: "Themes and the footer: /theme [name | reload | footer on|off]",
        getArgumentCompletions: (prefix: string) => {
            const choices = [...known, "reload", "footer on", "footer off"];
            const matches = choices.filter((choice) => choice.startsWith(prefix.trimStart()));
            return matches.length === 0 ? null : matches.map((choice) => ({ value: choice, label: choice }));
        },
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const words = args.trim().split(/\s+/).filter((word) => word !== "");
            if (words.length === 0) return choose(ctx, deps);
            if (words.length === 1 && words[0] === "reload") return reload(ctx);
            if (words[0] === "footer" && words.length === 2 && (words[1] === "on" || words[1] === "off")) return footer(ctx, deps.session, words[1] === "on");
            if (words.length === 1) return switchTo(ctx, deps, words[0] as string);
            ctx.ui.notify(USAGE, "warning");
            return undefined;
        },
    });
}

/** `/theme`: the list. */
async function choose(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
    if (ctx.mode !== "tui") return needsTerminal(ctx);
    known = ctx.ui.getAllThemes().map((theme) => theme.name);
    const name = await pickTheme(ctx);
    if (name !== undefined) keep(ctx, deps, name);
}

/** `/theme <name>`. */
function switchTo(ctx: ExtensionCommandContext, deps: CommandDeps, name: string): void {
    if (ctx.mode !== "tui") return needsTerminal(ctx);
    const themes = ctx.ui.getAllThemes();
    known = themes.map((theme) => theme.name);
    if (!known.includes(name)) {
        ctx.ui.notify(`No theme named "${plain(name, 40)}". ${USAGE}`, "warning");
        return;
    }
    keep(ctx, deps, name);
}

/** Switches to a theme by name, which Pi also saves as the `theme` setting. */
function keep(ctx: ExtensionCommandContext, deps: CommandDeps, name: string): void {
    const result = ctx.ui.setTheme(name);
    if (!result.success) {
        ctx.ui.notify(`Pi could not load the theme "${plain(name, 40)}": ${plain(result.error ?? "unknown error", 200)}`, "warning");
        return;
    }
    // A palette changed since Pi read it is known to Pi by its old colours; Pi is now watching it, so it is written again.
    deps.session.reread(deps.agentDir(), name, deps.rereadDelayMs);
}

/**
 * `/theme reload`. jig.json is read when a session starts, and that is also when palettes are written, so this is a reload
 * of Pi, which does both. The session that starts after it says what it wrote.
 */
async function reload(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") return needsTerminal(ctx);
    (globalThis as Flag)[ASKED] = true;
    try {
        await ctx.reload();
    } catch {
        delete (globalThis as Flag)[ASKED];
        ctx.ui.notify("jig-theme: Pi could not be reloaded; run /reload", "warning");
    }
}

/** `/theme footer on|off`. */
function footer(ctx: ExtensionCommandContext, session: Session, on: boolean): void {
    if (ctx.mode !== "tui") return needsTerminal(ctx);
    if (!on) {
        session.off(ctx);
        return;
    }
    const why = session.on(ctx);
    if (why !== undefined) ctx.ui.notify(`The footer cannot be shown here: ${why}.`, "warning");
}
