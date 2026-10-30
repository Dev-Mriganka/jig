// The six palettes. Each names 17 colours (see VAR_NAMES in roles.ts); build.ts spreads them over Pi's roles with one
// role map. `colors` lists the roles a palette sets by hand, where the map's choice is not the one it wants.
//
// A colour is any form Pi accepts: `#RRGGBB`, `oklch(...)`, `okhsl(...)`, a 0-255 index, a variable name, or `""` for
// the terminal's own. The six use hex, so that their contrast can be measured.
import type { Role, VarName } from "./roles.ts";

/** A colour as Pi's theme format writes it. */
export type ColorValue = string | number;

export interface Palette {
    /** The background it is designed for. Pi uses it when the terminal's own appearance is not known. */
    appearance: "dark" | "light";
    vars: Readonly<Record<VarName, ColorValue>>;
    /** Roles that take a colour of their own, after the role map. */
    colors?: Readonly<Partial<Record<Role, ColorValue>>>;
}

/** The slate-blue lines that jig-lime and jig-signal share, whatever their other colours. */
const SLATE_LINES = {
    mdCodeBlockBorder: "#2B3B4F",
    mdHr: "#304054",
    thinkingOff: "#354255",
    scrollbarTrack: "#1C2735",
} as const;

const lime: Palette = {
    appearance: "dark",
    vars: {
        bg: "#11160F", panel: "#171D14", selected: "#283322", errorBg: "#22171C",
        text: "#FFFFFF", soft: "#E4E8DD", muted: "#A5AE9A", dim: "#929D86",
        border: "#46513A", borderMuted: "#35402C",
        accent: "#C4F36B", link: "#73DFEB", heading: "#ED9EE8", info: "#73DFEB",
        success: "#C4F36B", warning: "#FFD080", error: "#FF8095",
    },
    colors: {
        ...SLATE_LINES,
        thinkingText: "#8C9580",
        scrollbarThumb: "#8292A6",
        searchMatchText: "#D8E1EA",
        toolOutput: "#D3DCC8",
        mdCode: "accent",
        mdQuote: "#BCC5B1",
        thinkingMinimal: "#78A9FF",
        thinkingMedium: "#4FD6BE",
        thinkingHigh: "accent",
        thinkingMax: "#FF6B7A",
        bashMode: "#FFB454",
    },
};

const signal: Palette = {
    appearance: "dark",
    vars: {
        bg: "#0E1520", panel: "#111C2A", selected: "#1B2A3D", errorBg: "#241820",
        text: "#FFFFFF", soft: "#D8E1EA", muted: "#8292A6", dim: "#586779",
        border: "#273344", borderMuted: "#1D2734",
        accent: "#55DDE0", link: "#55DDE0", heading: "#C099FF", info: "#78A9FF",
        success: "#7BD88F", warning: "#FFB454", error: "#FF6B7A",
    },
    colors: {
        ...SLATE_LINES,
        thinkingText: "#7F8A99",
        customMessageBg: "#111923",
        // Tool boxes keep the terminal's own background.
        toolPendingBg: "",
        toolSuccessBg: "",
        toolErrorBg: "",
        toolOutput: "#C4CFDA",
        mdQuote: "#A7B3C2",
        mdQuoteBorder: "#4FD6BE",
        syntaxOperator: "#F78FB3",
        thinkingMedium: "#4FD6BE",
    },
};

const ember: Palette = {
    appearance: "dark",
    vars: {
        bg: "#17120E", panel: "#211A14", selected: "#33271C", errorBg: "#2E1715",
        text: "#FFF8F0", soft: "#EBDFD1", muted: "#BBA994", dim: "#A39380",
        border: "#5A4634", borderMuted: "#3A2D22",
        accent: "#FFAE42", link: "#7FD6C2", heading: "#FF8C75", info: "#8FB8E8",
        success: "#A5D86E", warning: "#FFD166", error: "#FF6B6B",
    },
};

const orchid: Palette = {
    appearance: "dark",
    vars: {
        bg: "#15111F", panel: "#1D1830", selected: "#2D2548", errorBg: "#2B1522",
        text: "#FBF8FF", soft: "#E3DDF2", muted: "#B1A8CC", dim: "#9A92B6",
        border: "#4A4070", borderMuted: "#2F2749",
        accent: "#B794F6", link: "#6EC1FF", heading: "#F78FC3", info: "#9DA9FF",
        success: "#7EE0B0", warning: "#FFC777", error: "#FF7A93",
    },
};

const mono: Palette = {
    appearance: "dark",
    vars: {
        bg: "#0C0C0C", panel: "#161616", selected: "#2A2A2A", errorBg: "#251616",
        text: "#FFFFFF", soft: "#F0F0F0", muted: "#BEBEBE", dim: "#A8A8A8",
        border: "#5A5A5A", borderMuted: "#343434",
        accent: "#5CE1E6", link: "#5CE1E6", heading: "#FFFFFF", info: "#D2D2D2",
        success: "#5CE1E6", warning: "#FFD166", error: "#FF6B6B",
    },
};

const paper: Palette = {
    appearance: "light",
    vars: {
        bg: "#FAF6EE", panel: "#F1EADB", selected: "#E5DAC3", errorBg: "#FBE3DF",
        text: "#1B1712", soft: "#2E2820", muted: "#5A5144", dim: "#6A6050",
        border: "#B8AA90", borderMuted: "#DDD2BD",
        accent: "#9C4208", link: "#0B6A94", heading: "#862A74", info: "#2A55A0",
        success: "#25702A", warning: "#8A5600", error: "#B3261E",
    },
};

/** The palettes by theme name, in the order the docs list them. */
export const PALETTES: Readonly<Record<string, Palette>> = {
    "jig-lime": lime,
    "jig-signal": signal,
    "jig-ember": ember,
    "jig-orchid": orchid,
    "jig-mono": mono,
    "jig-paper": paper,
};

export const PALETTE_NAMES: readonly string[] = Object.keys(PALETTES);
