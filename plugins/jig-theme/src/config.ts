// The `theme` section of jig.json: your palettes, the footer, and the answer colour. jig-core checks the section with
// validateTheme when it loads, so the rest of the plugin reads a section that is valid, or absent. A problem names the key
// and never its value, so a secret pasted into the wrong field is not repeated on the screen.
import { build, derive, resolveTheme } from "./build.ts";
import type { ColorValue } from "./palettes.ts";
import { PALETTE_NAMES, PALETTES } from "./palettes.ts";
import { isForegroundRole, isRole, isVarName } from "./roles.ts";
import type { ForegroundRole } from "./roles.ts";
import { cellWidth, plain } from "./width.ts";

// ---- what the footer is made of ---------------------------------------------------------------------------------------

export const SEGMENT_IDS = ["model", "thinking", "context", "cache", "cost", "tokens", "branch", "cwd", "statuses", "plugins"] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

const isSegmentId = (value: unknown): value is SegmentId =>
    typeof value === "string" && (SEGMENT_IDS as readonly string[]).includes(value);

export interface ContextLimits {
    /** From this many tokens the size is drawn in the warning colour, and from `highTokens` in the error colour. */
    warnTokens: number;
    highTokens: number;
    /** The same for the share of the model's window. The worse of the two decides. */
    warnPercent: number;
    highPercent: number;
}

export interface FooterSettings {
    enabled: boolean;
    segments: SegmentId[];
    dropFirst: SegmentId[];
    colors: Record<SegmentId, ForegroundRole>;
    context: ContextLimits;
    costDecimals: number;
    separator: string;
}

/** What a palette you wrote is: one of the six, with a few colours changed. */
export interface PaletteSpec {
    base: string;
    vars: Record<string, ColorValue>;
    colors: Record<string, ColorValue>;
}

export interface ThemeSettings {
    palettes: Record<string, PaletteSpec>;
    footer: FooterSettings;
    /** The role answers are drawn in, or false to leave Pi's own colour. */
    answerColor: ForegroundRole | false;
}

export const DEFAULT_FOOTER: FooterSettings = {
    enabled: true,
    segments: ["model", "thinking", "context", "cache", "cost", "tokens", "plugins", "statuses"],
    dropFirst: ["tokens", "cache", "branch", "cwd", "plugins"],
    colors: {
        model: "mdHeading",
        thinking: "warning",
        context: "toolTitle",
        cache: "muted",
        cost: "mdQuoteBorder",
        tokens: "muted",
        branch: "accent",
        cwd: "muted",
        statuses: "success",
        plugins: "text",
    },
    context: { warnTokens: 150_000, highTokens: 250_000, warnPercent: 70, highPercent: 90 },
    costDecimals: 2,
    separator: " · ",
};

export const DEFAULT_SETTINGS: ThemeSettings = { palettes: {}, footer: DEFAULT_FOOTER, answerColor: "text" };

// ---- names and colours ------------------------------------------------------------------------------------------------

/** The names of palettes you write: file names too, so nothing that could leave the themes folder. */
export const PALETTE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Themes Pi ships, the six of this plugin, and the words of `/theme`: a palette of yours cannot take these names. */
export const RESERVED_NAMES: readonly string[] = ["system", "dark", "light", ...PALETTE_NAMES, "reload", "footer"];

export const MAX_PALETTES = 20;
export const SEPARATOR_CELLS = 5;

// Pi's own grammar of a colour (pi-tui's `parseColor`), so what passes here is read there. Pi still checks the ranges.
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const OKLCH = new RegExp(`^oklch\\(\\s*(${NUMBER})(%)?\\s+(${NUMBER})\\s+(${NUMBER})(?:deg)?\\s*\\)$`, "i");
const OKHSL = new RegExp(`^okhsl\\(\\s*(${NUMBER})(?:deg)?\\s+(${NUMBER})(%)?\\s+(${NUMBER})(%)?\\s*\\)$`, "i");

/** A colour as a theme file writes it: hex, oklch(), okhsl(), a 0-255 index, `""` for the terminal's own, or the name of one of the palette's colours. */
export function isColorValue(value: unknown): value is ColorValue {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255;
    if (typeof value !== "string") return false;
    if (value === "" || isVarName(value)) return true;
    if (value.length > 80) return false;
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) || OKLCH.test(value) || OKHSL.test(value);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** A key of the section as it is named in a message: short, and with nothing that could move the cursor. */
const named = (key: string): string => plain(key, 40) || "?";

const COLOR_HELP = 'a colour as Pi reads it: #RRGGBB, oklch(), okhsl(), 0-255, the name of a palette colour, or ""';

// ---- validation -------------------------------------------------------------------------------------------------------

const WHOLE = (value: unknown, low: number, high: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

function listOf(value: unknown, where: string, errors: string[], { unique = true, nonEmpty = false } = {}): SegmentId[] {
    if (!Array.isArray(value)) {
        errors.push(`${where}: must be a list of footer parts (${SEGMENT_IDS.join(", ")})`);
        return [];
    }
    const ids: SegmentId[] = [];
    value.forEach((item, index) => {
        if (!isSegmentId(item)) errors.push(`${where}[${index}]: not a footer part (${SEGMENT_IDS.join(", ")})`);
        else if (unique && ids.includes(item)) errors.push(`${where}[${index}]: listed twice`);
        else ids.push(item);
    });
    if (nonEmpty && value.length === 0) errors.push(`${where}: must list at least one part; footer.enabled: false turns the footer off`);
    return ids;
}

function validateFooter(raw: unknown, errors: string[]): void {
    if (!isObject(raw)) {
        errors.push("theme.footer: must be an object");
        return;
    }
    const known = ["enabled", "segments", "dropFirst", "colors", "context", "costDecimals", "separator"];
    for (const key of Object.keys(raw)) if (!known.includes(key)) errors.push(`theme.footer.${named(key)}: unknown field`);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push("theme.footer.enabled: must be true or false");
    if (raw.segments !== undefined) listOf(raw.segments, "theme.footer.segments", errors, { nonEmpty: true });
    if (raw.dropFirst !== undefined) listOf(raw.dropFirst, "theme.footer.dropFirst", errors);
    if (raw.colors !== undefined) {
        if (!isObject(raw.colors)) errors.push("theme.footer.colors: must be an object of footer part to Pi role");
        else {
            for (const [part, role] of Object.entries(raw.colors)) {
                if (!isSegmentId(part)) errors.push(`theme.footer.colors.${named(part)}: not a footer part (${SEGMENT_IDS.join(", ")})`);
                else if (!isForegroundRole(role)) errors.push(`theme.footer.colors.${part}: must be a Pi text role, such as muted, accent or mdHeading (not a background)`);
            }
        }
    }
    if (raw.context !== undefined) validateContext(raw.context, errors);
    if (raw.costDecimals !== undefined && !WHOLE(raw.costDecimals, 2, 4)) {
        errors.push("theme.footer.costDecimals: must be a whole number from 2 to 4");
    }
    if (raw.separator !== undefined) {
        const separator = raw.separator;
        if (typeof separator !== "string" || separator === "") errors.push("theme.footer.separator: must be text of 1 to 5 characters wide");
        else if (/[\x00-\x1f\x7f-\x9f]/.test(separator)) errors.push("theme.footer.separator: must not hold control characters");
        else if (cellWidth(separator) > SEPARATOR_CELLS || cellWidth(separator) < 1) {
            errors.push(`theme.footer.separator: must be 1 to ${SEPARATOR_CELLS} cells wide`);
        }
    }
}

function validateContext(raw: unknown, errors: string[]): void {
    if (!isObject(raw)) {
        errors.push("theme.footer.context: must be an object");
        return;
    }
    const known = ["warnTokens", "highTokens", "warnPercent", "highPercent"];
    for (const key of Object.keys(raw)) if (!known.includes(key)) errors.push(`theme.footer.context.${named(key)}: unknown field`);
    for (const key of ["warnTokens", "highTokens"] as const) {
        if (raw[key] !== undefined && !WHOLE(raw[key], 1000, 10_000_000)) {
            errors.push(`theme.footer.context.${key}: must be a whole number from 1000 to 10000000`);
        }
    }
    for (const key of ["warnPercent", "highPercent"] as const) {
        if (raw[key] !== undefined && !WHOLE(raw[key], 1, 100)) errors.push(`theme.footer.context.${key}: must be a whole number from 1 to 100`);
    }
    const warnTokens = WHOLE(raw.warnTokens, 1000, 10_000_000) ? raw.warnTokens : DEFAULT_FOOTER.context.warnTokens;
    const highTokens = WHOLE(raw.highTokens, 1000, 10_000_000) ? raw.highTokens : DEFAULT_FOOTER.context.highTokens;
    if (warnTokens >= highTokens && (raw.warnTokens !== undefined || raw.highTokens !== undefined)) {
        errors.push("theme.footer.context.warnTokens: must be lower than highTokens");
    }
    const warnPercent = WHOLE(raw.warnPercent, 1, 100) ? raw.warnPercent : DEFAULT_FOOTER.context.warnPercent;
    const highPercent = WHOLE(raw.highPercent, 1, 100) ? raw.highPercent : DEFAULT_FOOTER.context.highPercent;
    if (warnPercent >= highPercent && (raw.warnPercent !== undefined || raw.highPercent !== undefined)) {
        errors.push("theme.footer.context.warnPercent: must be lower than highPercent");
    }
}

function validatePalette(name: string, raw: unknown, errors: string[]): void {
    const where = `theme.palettes.${named(name)}`;
    if (!PALETTE_NAME.test(name)) {
        errors.push(`${where}: a palette name is lower-case letters, digits and hyphens, up to 40, starting with a letter or digit`);
    } else if (RESERVED_NAMES.includes(name)) {
        errors.push(`${where}: that name is reserved: a theme Pi or this plugin ships, or a word of /theme`);
    }
    if (!isObject(raw)) {
        errors.push(`${where}: must be an object with base, and optionally vars and colors`);
        return;
    }
    for (const key of Object.keys(raw)) if (!["base", "vars", "colors"].includes(key)) errors.push(`${where}.${named(key)}: unknown field`);
    const base = typeof raw.base === "string" ? PALETTES[raw.base] : undefined;
    if (base === undefined) errors.push(`${where}.base: must be one of ${PALETTE_NAMES.join(", ")}`);
    let fine = base !== undefined;
    if (raw.vars !== undefined) {
        if (!isObject(raw.vars)) {
            errors.push(`${where}.vars: must be an object of palette colour to colour`);
            fine = false;
        } else {
            for (const [key, value] of Object.entries(raw.vars)) {
                if (!isVarName(key)) {
                    errors.push(`${where}.vars.${named(key)}: not a palette colour`);
                    fine = false;
                } else if (!isColorValue(value)) {
                    errors.push(`${where}.vars.${key}: must be ${COLOR_HELP}`);
                    fine = false;
                }
            }
        }
    }
    if (raw.colors !== undefined) {
        if (!isObject(raw.colors)) {
            errors.push(`${where}.colors: must be an object of Pi role to colour`);
            fine = false;
        } else {
            for (const [key, value] of Object.entries(raw.colors)) {
                if (!isRole(key)) {
                    errors.push(`${where}.colors.${named(key)}: not a Pi theme role`);
                    fine = false;
                } else if (!isColorValue(value)) {
                    errors.push(`${where}.colors.${key}: must be ${COLOR_HELP}`);
                    fine = false;
                }
            }
        }
    }
    // Colours that name each other: Pi cannot load such a theme, so it is said here and not when the file is written.
    if (fine && base !== undefined) {
        try {
            resolveTheme(build(derive(base, specOf(raw)), "check"));
        } catch {
            errors.push(`${where}: its colours point at each other in a loop`);
        }
    }
}

/** The fields of a palette as written, when they are valid. */
function specOf(raw: Record<string, unknown>): Pick<PaletteSpec, "vars" | "colors"> {
    return {
        vars: isObject(raw.vars) ? (raw.vars as Record<string, ColorValue>) : {},
        colors: isObject(raw.colors) ? (raw.colors as Record<string, ColorValue>) : {},
    };
}

/**
 * The errors in a raw `theme` section, each naming its key. An empty list means the section is valid. A misspelt field is
 * an error and not a silent default.
 */
export function validateTheme(raw: unknown): string[] {
    if (!isObject(raw)) return ["theme: must be an object"];
    const errors: string[] = [];
    for (const key of Object.keys(raw)) {
        if (!["palettes", "footer", "answerColor"].includes(key)) errors.push(`theme.${named(key)}: unknown field`);
    }
    if (raw.palettes !== undefined) {
        if (!isObject(raw.palettes)) errors.push("theme.palettes: must be an object of palette name to palette");
        else {
            const names = Object.keys(raw.palettes);
            if (names.length > MAX_PALETTES) errors.push(`theme.palettes: at most ${MAX_PALETTES} palettes`);
            for (const name of names.slice(0, MAX_PALETTES)) validatePalette(name, raw.palettes[name], errors);
        }
    }
    if (raw.footer !== undefined) validateFooter(raw.footer, errors);
    if (raw.answerColor !== undefined && raw.answerColor !== false && !isForegroundRole(raw.answerColor)) {
        errors.push("theme.answerColor: must be a Pi text role, such as text or accent, or false");
    }
    return errors;
}

// ---- the settings -----------------------------------------------------------------------------------------------------

/** The settings for the section as `config.section("theme")` returns it. A missing or wrong field is the default. */
export function settingsFrom(raw: unknown): ThemeSettings {
    const fields = isObject(raw) ? raw : {};
    const footer = isObject(fields.footer) ? fields.footer : {};
    const context = isObject(footer.context) ? footer.context : {};
    const parts = (value: unknown, fallback: SegmentId[]): SegmentId[] =>
        Array.isArray(value) && value.every(isSegmentId) ? [...new Set<SegmentId>(value)] : [...fallback];
    const colors = { ...DEFAULT_FOOTER.colors };
    if (isObject(footer.colors)) {
        for (const [part, role] of Object.entries(footer.colors)) if (isSegmentId(part) && isForegroundRole(role)) colors[part] = role;
    }
    const pick = <T extends keyof ContextLimits>(key: T, low: number, high: number): number =>
        WHOLE(context[key], low, high) ? (context[key] as number) : DEFAULT_FOOTER.context[key];
    const limits: ContextLimits = {
        warnTokens: pick("warnTokens", 1000, 10_000_000),
        highTokens: pick("highTokens", 1000, 10_000_000),
        warnPercent: pick("warnPercent", 1, 100),
        highPercent: pick("highPercent", 1, 100),
    };
    const palettes: Record<string, PaletteSpec> = {};
    if (isObject(fields.palettes)) {
        for (const [name, value] of Object.entries(fields.palettes).slice(0, MAX_PALETTES)) {
            const probe: string[] = [];
            validatePalette(name, value, probe);
            if (probe.length > 0 || !isObject(value)) continue;
            palettes[name] = { base: String(value.base), ...specOf(value) };
        }
    }
    const separator = typeof footer.separator === "string" && footer.separator !== "" && cellWidth(footer.separator) <= SEPARATOR_CELLS && !/[\x00-\x1f\x7f-\x9f]/.test(footer.separator)
        ? footer.separator
        : DEFAULT_FOOTER.separator;
    return {
        palettes,
        answerColor: fields.answerColor === false ? false : isForegroundRole(fields.answerColor) ? fields.answerColor : "text",
        footer: {
            enabled: footer.enabled !== false,
            segments: Array.isArray(footer.segments) && footer.segments.length > 0 ? parts(footer.segments, DEFAULT_FOOTER.segments) : [...DEFAULT_FOOTER.segments],
            dropFirst: parts(footer.dropFirst, DEFAULT_FOOTER.dropFirst),
            colors,
            context: limits.warnTokens < limits.highTokens && limits.warnPercent < limits.highPercent ? limits : { ...DEFAULT_FOOTER.context },
            costDecimals: WHOLE(footer.costDecimals, 2, 4) ? footer.costDecimals : DEFAULT_FOOTER.costDecimals,
            separator,
        },
    };
}
