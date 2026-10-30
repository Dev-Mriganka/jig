// Pi's theme roles, the names of a palette's colours, and the one map that turns the second into the first.
//
// Pi's theme format has 56 roles. A palette names 17 colours instead, and ROLE_MAP says which colour each role takes.
// Adding a palette, or your own, is then a matter of choosing 17 colours. The list of roles is Pi's own (its
// `schemas/theme.schema.json`); a test compares the two, so a Pi release that adds a role fails there.

/** Every colour role of a Pi theme, in the order of Pi's schema. */
export const ROLES = [
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "scrollbarTrack",
    "scrollbarThumb",
    "selectedBg",
    "searchMatchBg",
    "searchMatchText",
    "userMessageBg",
    "userMessageText",
    "customMessageBg",
    "customMessageText",
    "customMessageLabel",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
    "bashMode",
] as const;

export type Role = (typeof ROLES)[number];

/** The roles Pi draws as a background. The others are foregrounds: `theme.fg(role, text)` takes only those. */
export const BACKGROUND_ROLES = [
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
] as const;

export type BackgroundRole = (typeof BACKGROUND_ROLES)[number];
export type ForegroundRole = Exclude<Role, BackgroundRole>;

export const FOREGROUND_ROLES: readonly ForegroundRole[] = ROLES.filter(
    (role): role is ForegroundRole => !(BACKGROUND_ROLES as readonly string[]).includes(role),
);

export const isRole = (value: unknown): value is Role =>
    typeof value === "string" && (ROLES as readonly string[]).includes(value);

export const isForegroundRole = (value: unknown): value is ForegroundRole =>
    typeof value === "string" && (FOREGROUND_ROLES as readonly string[]).includes(value);

/** The names of a palette's colours. */
export const VAR_NAMES = [
    "bg",
    "panel",
    "selected",
    "errorBg",
    "text",
    "soft",
    "muted",
    "dim",
    "border",
    "borderMuted",
    "accent",
    "link",
    "heading",
    "info",
    "success",
    "warning",
    "error",
] as const;

export type VarName = (typeof VAR_NAMES)[number];

export const isVarName = (value: unknown): value is VarName =>
    typeof value === "string" && (VAR_NAMES as readonly string[]).includes(value);

/** What each colour is for. Shown in the docs, so the two cannot drift apart. */
export const VAR_PURPOSE: Readonly<Record<VarName, string>> = {
    bg: "the page, and the boxes tool calls are drawn in",
    panel: "your messages and the cards of an HTML export",
    selected: "the selected item of a list, and a search match",
    errorBg: "the box of a tool call that failed",
    text: "answers, and the brightest text",
    soft: "your messages, code blocks, tool output and variables in code",
    muted: "secondary text: link addresses, diff context, punctuation, quotes, thinking",
    dim: "the faintest text: comments in code",
    border: "borders, code block fences and rules",
    borderMuted: "the quietest borders, and the scrollbar track",
    accent: "the main colour: selection, list bullets, the label of a message",
    link: "links, types in code, the quote bar, low thinking",
    heading: "headings, keywords in code, high thinking",
    info: "tool titles, function names, minimal thinking",
    success: "success, added lines, strings in code, medium thinking",
    warning: "warnings, inline code, numbers in code, high thinking, bash mode",
    error: "errors, removed lines, the highest thinking level",
};

/** The colour each role takes. A palette can set a single role differently (its `colors`). */
export const ROLE_MAP: Readonly<Record<Role, VarName>> = {
    accent: "accent",
    border: "border",
    borderAccent: "accent",
    borderMuted: "borderMuted",
    success: "success",
    error: "error",
    warning: "warning",
    muted: "muted",
    dim: "dim",
    text: "text",
    thinkingText: "muted",
    scrollbarTrack: "borderMuted",
    scrollbarThumb: "muted",
    selectedBg: "selected",
    searchMatchBg: "selected",
    searchMatchText: "soft",
    userMessageBg: "panel",
    userMessageText: "soft",
    customMessageBg: "panel",
    customMessageText: "soft",
    customMessageLabel: "accent",
    toolPendingBg: "bg",
    toolSuccessBg: "bg",
    toolErrorBg: "errorBg",
    toolTitle: "info",
    toolOutput: "soft",
    mdHeading: "heading",
    mdLink: "link",
    mdLinkUrl: "muted",
    mdCode: "warning",
    mdCodeBlock: "soft",
    mdCodeBlockBorder: "border",
    mdQuote: "muted",
    mdQuoteBorder: "link",
    mdHr: "border",
    mdListBullet: "accent",
    toolDiffAdded: "success",
    toolDiffRemoved: "error",
    toolDiffContext: "muted",
    syntaxComment: "dim",
    syntaxKeyword: "heading",
    syntaxFunction: "info",
    syntaxVariable: "soft",
    syntaxString: "success",
    syntaxNumber: "warning",
    syntaxType: "link",
    syntaxOperator: "heading",
    syntaxPunctuation: "muted",
    thinkingOff: "border",
    thinkingMinimal: "info",
    thinkingLow: "link",
    thinkingMedium: "success",
    thinkingHigh: "warning",
    thinkingXhigh: "heading",
    thinkingMax: "error",
    bashMode: "warning",
};
