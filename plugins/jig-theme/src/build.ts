// A palette to a Pi theme: its colours as `vars`, every role pointing at one of them (or holding the palette's own colour
// for that role), and the colours of an HTML export. The result is the JSON of a Pi theme file, nothing more.
import type { ColorValue, Palette } from "./palettes.ts";
import { ROLE_MAP, ROLES, VAR_NAMES } from "./roles.ts";
import type { Role, VarName } from "./roles.ts";

/** What Pi's `schemas/theme.schema.json` calls a theme. The keys are in the order they are written. */
export interface PiTheme {
    name: string;
    appearance: "dark" | "light";
    vars: Record<VarName, ColorValue>;
    colors: Record<Role, ColorValue>;
    export: { pageBg: ColorValue; cardBg: ColorValue; infoBg: ColorValue };
}

/** A colour that is not the name of a variable: Pi reads these as they are. */
const isLiteral = (value: string): boolean => value === "" || value.startsWith("#") || /^ok(lch|hsl)\(/i.test(value);

/** The colour a value comes to once variable names are followed, or the name of the variable that has none. */
export type Resolved = { value: ColorValue } | { problem: "missing" | "loop"; name: string };

export function resolveColor(value: ColorValue, vars: Readonly<Record<string, ColorValue>>): Resolved {
    const seen = new Set<string>();
    let current = value;
    while (typeof current === "string" && !isLiteral(current)) {
        if (seen.has(current)) return { problem: "loop", name: current };
        seen.add(current);
        if (!Object.hasOwn(vars, current)) return { problem: "missing", name: current };
        current = vars[current] as ColorValue;
    }
    return { value: current };
}

/** `""` is the terminal's own colour, which a variable cannot stand for in the HTML export; the palette's colour does. */
const forExport = (value: ColorValue, fallback: VarName): ColorValue => (value === "" ? fallback : value);

/** The Pi theme of a palette under a name. */
export function build(palette: Palette, name: string): PiTheme {
    const vars = Object.fromEntries(VAR_NAMES.map((key) => [key, palette.vars[key]])) as Record<VarName, ColorValue>;
    const colors = Object.fromEntries(
        ROLES.map((role) => [role, palette.colors?.[role] ?? ROLE_MAP[role]]),
    ) as Record<Role, ColorValue>;
    return {
        name,
        appearance: palette.appearance,
        vars,
        colors,
        // The page is the palette's background; the cards follow the user message and the notices the custom message,
        // which is what Pi itself does when it is not told.
        export: {
            pageBg: "bg",
            cardBg: forExport(colors.userMessageBg, "panel"),
            infoBg: forExport(colors.customMessageBg, "panel"),
        },
    };
}

/** The text of a theme file. */
export const themeText = (theme: PiTheme): string => `${JSON.stringify(theme, null, 2)}\n`;

/** A theme with every variable followed: what Pi draws with. Throws when a name has no colour, or names loop. */
export function resolveTheme(theme: PiTheme): { colors: Record<Role, ColorValue>; export: PiTheme["export"] } {
    const follow = (value: ColorValue): ColorValue => {
        const resolved = resolveColor(value, theme.vars);
        if ("problem" in resolved) throw new Error(`theme ${theme.name}: "${resolved.name}" is ${resolved.problem === "loop" ? "in a loop" : "not a variable"}`);
        return resolved.value;
    };
    const colors = Object.fromEntries(ROLES.map((role) => [role, follow(theme.colors[role])])) as Record<Role, ColorValue>;
    return {
        colors,
        export: { pageBg: follow(theme.export.pageBg), cardBg: follow(theme.export.cardBg), infoBg: follow(theme.export.infoBg) },
    };
}
