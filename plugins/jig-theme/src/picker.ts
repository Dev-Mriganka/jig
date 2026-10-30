// `/theme` with no argument: every theme Pi has, each with a swatch of its own colours. Moving shows a theme live and does
// not save it, Enter keeps it as `/settings` would, and Esc puts back the theme you had.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { plain } from "./width.ts";

/** The roles drawn as a swatch: the colours a theme is known by. */
const SWATCH = ["accent", "mdHeading", "mdLink", "toolTitle", "success", "warning", "error"] as const;

/** The theme as the picker draws it: a name, the colours as a row of blocks, and whether it is light or dark. */
interface Row {
    name: string;
    swatch: string;
    appearance: string;
}

/**
 * Shows the list and returns the name chosen, which the caller keeps; or undefined after Esc, when the theme in use before
 * the list opened has been put back.
 */
export async function pickTheme(ctx: ExtensionCommandContext): Promise<string | undefined> {
    const names = ctx.ui.getAllThemes().map((theme) => theme.name);
    // `ctx.ui.theme` is a view of whichever theme is in use at the moment, so it cannot be kept to put back later: the theme
    // itself is loaded by its name. A theme that cannot be loaded again is not previewed, because it could not be restored.
    const originalName: string | undefined = ctx.ui.theme?.name;
    const original = originalName === undefined ? undefined : ctx.ui.getTheme(originalName);
    let previewed = false;
    const name = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        const rows = new Map<string, Row>();
        const rowOf = (themeName: string): Row => {
            const known = rows.get(themeName);
            if (known !== undefined) return known;
            const loaded = ctx.ui.getTheme(themeName);
            const row: Row = {
                name: themeName,
                swatch:
                    loaded === undefined ? "cannot be loaded" : SWATCH.map((role) => loaded.fg(role, "██")).join(" "),
                appearance: loaded?.appearance ?? "",
            };
            rows.set(themeName, row);
            return row;
        };
        let at = Math.max(0, names.indexOf(originalName ?? ""));
        const show = (themeName: string | undefined) => {
            if (original === undefined || themeName === undefined) return;
            const preview = ctx.ui.getTheme(themeName);
            if (preview === undefined) return;
            ctx.ui.setTheme(preview);
            if (themeName !== originalName) previewed = true;
        };
        const move = (to: number) => {
            if (names.length === 0) return;
            at = Math.max(0, Math.min(names.length - 1, to));
            show(names[at]);
            tui.requestRender();
        };
        const height = () => Math.max(3, Math.min(names.length, (tui.terminal?.rows ?? 24) - 8));
        return {
            invalidate() {},
            handleInput(data: string) {
                if (matchesKey(data, Key.escape)) done(undefined);
                else if (matchesKey(data, Key.enter)) done(names[at]);
                else if (matchesKey(data, Key.up)) move(at - 1);
                else if (matchesKey(data, Key.down)) move(at + 1);
                else if (matchesKey(data, Key.pageUp)) move(at - height());
                else if (matchesKey(data, Key.pageDown)) move(at + height());
                else if (matchesKey(data, Key.home)) move(0);
                else if (matchesKey(data, Key.end)) move(names.length - 1);
            },
            render(width: number): string[] {
                const lines = [theme.fg("accent", theme.bold("Themes")), ""];
                const size = height();
                const first = Math.max(0, Math.min(at - Math.floor(size / 2), names.length - size));
                const widest = Math.max(1, ...names.map((themeName) => plain(themeName, 40).length));
                for (const themeName of names.slice(first, first + size)) {
                    const row = rowOf(themeName);
                    const marker = themeName === names[at] ? theme.fg("accent", "›") : " ";
                    const label = plain(row.name, 40).padEnd(widest);
                    const used = themeName === originalName ? theme.fg("muted", " in use") : "";
                    const tail = row.appearance === "" ? "" : theme.fg("muted", ` ${row.appearance}`);
                    lines.push(
                        truncateToWidth(
                            `${marker} ${themeName === names[at] ? theme.fg("accent", label) : label}  ${row.swatch}${tail}${used}`,
                            Math.max(0, width),
                            "",
                        ),
                    );
                }
                if (names.length > size)
                    lines.push(
                        theme.fg("muted", `${first + 1}-${Math.min(names.length, first + size)} of ${names.length}`),
                    );
                lines.push("", theme.fg("muted", "↑/↓ move · Enter keep · Esc cancel"));
                return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
            },
        };
    });
    if (name === undefined && previewed && original !== undefined) ctx.ui.setTheme(original);
    return name;
}
