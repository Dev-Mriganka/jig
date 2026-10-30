// Your palettes, from the settings to the themes folder to Pi: what a session start (and a reload) does about them.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaletteSpec } from "./config.ts";
import { syncPalettes } from "./write.ts";

export interface Applied {
    /** Palettes written now. */
    written: string[];
    /** The part of `written` that Pi may already know by its old colours: the file existed and its colours changed. */
    changed: string[];
    /** Files deleted because the palette is gone. */
    removed: string[];
    /** Things to tell the user as a warning. */
    problems: string[];
    /** Things to tell the user as information. */
    notes: string[];
}

/** The `ui` Pi gives: only what is used here. */
type Ui = Pick<ExtensionContext["ui"], "getAllThemes" | "getTheme" | "theme">;

/**
 * Writes the palettes, then asks Pi to load each one it owns, so a palette Pi cannot read is named instead of failing
 * silently the first time it is chosen. Never throws: a failure here is a problem to report, not a reason to stop Pi.
 */
export function applyPalettes(ui: Ui, agentDir: string, palettes: Readonly<Record<string, PaletteSpec>>): Applied {
    const applied: Applied = { written: [], changed: [], removed: [], problems: [], notes: [] };
    try {
        const known = ui.getAllThemes();
        const result = syncPalettes({ agentDir, palettes, known });
        applied.written = result.written;
        applied.changed = result.changed;
        applied.removed = result.removed;
        applied.problems.push(...result.problems);
        for (const name of result.owned) {
            if (ui.getTheme(name) === undefined) applied.problems.push(`Pi cannot load the theme "${name}"; check its base, vars and colors`);
        }
        // Pi reads the themes folder when it starts or reloads, so it knows a palette that has changed since by its old colours.
        // The one in use is read again at once (the caller touches its file, which Pi watches), and one you switch to with
        // /theme is too; /settings shows the new colours after a /reload.
        const others = result.changed.filter((name) => ui.theme?.name !== name);
        if (others.length > 0) {
            applied.notes.push(`${others.map((name) => `"${name}"`).join(", ")} changed; /theme shows ${others.length === 1 ? "it" : "them"} anew, and /reload does so in /settings too`);
        }
    } catch {
        applied.problems.push("your palettes could not be written; the themes folder was left as it was");
    }
    return applied;
}
