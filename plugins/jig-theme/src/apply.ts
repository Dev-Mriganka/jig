// Your palettes, from the settings to the themes folder to Pi: what a session start (and a reload) does about them.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaletteSpec } from "./config.ts";
import { syncPalettes } from "./write.ts";

export interface Applied {
    /** Palettes written now. */
    written: string[];
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
    const applied: Applied = { written: [], removed: [], problems: [], notes: [] };
    try {
        const known = ui.getAllThemes();
        const result = syncPalettes({ agentDir, palettes, known });
        applied.written = result.written;
        applied.removed = result.removed;
        applied.problems.push(...result.problems);
        for (const name of result.owned) {
            if (ui.getTheme(name) === undefined) applied.problems.push(`Pi cannot load the theme "${name}"; check its base, vars and colors`);
        }
        // Pi reads the themes folder once, when it starts. A palette that was already there and has changed is picked up at
        // once when it is the theme in use (Pi watches that file), and otherwise by /reload.
        const stale = result.changed.filter((name) => ui.theme?.name !== name);
        if (stale.length > 0) {
            applied.notes.push(`${stale.map((name) => `"${name}"`).join(", ")} changed on disk; run /reload to use ${stale.length === 1 ? "it" : "them"} from /settings and /theme`);
        }
    } catch {
        applied.problems.push("your palettes could not be written; the themes folder was left as it was");
    }
    return applied;
}
