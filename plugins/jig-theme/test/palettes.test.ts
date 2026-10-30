// The palettes and the role map: every role is filled, the first two palettes are the themes they were drawn as, and
// every palette is readable on the backgrounds its text sits on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { build, resolveColor, resolveTheme } from "../src/build.ts";
import { PALETTE_NAMES, PALETTES } from "../src/palettes.ts";
import { BACKGROUND_ROLES, FOREGROUND_ROLES, ROLE_MAP, ROLES, VAR_NAMES, VAR_PURPOSE } from "../src/roles.ts";
import type { Role } from "../src/roles.ts";
import { contrast, luminance } from "./contrast.ts";

const fixture = (name: string) =>
    JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8")) as {
        appearance: string;
        colors: Record<string, string>;
        export: Record<string, string>;
    };

test("the six palettes are named as the README says", () => {
    assert.deepEqual(PALETTE_NAMES, ["jig-lime", "jig-signal", "jig-ember", "jig-orchid", "jig-mono", "jig-paper"]);
});

test("a palette names exactly the colours the role map and the docs know", () => {
    assert.equal(VAR_NAMES.length, 17);
    assert.deepEqual(Object.keys(VAR_PURPOSE).sort(), [...VAR_NAMES].sort());
    for (const [name, palette] of Object.entries(PALETTES)) {
        assert.deepEqual(Object.keys(palette.vars).sort(), [...VAR_NAMES].sort(), name);
    }
});

test("the role map fills every role, and only from colours a palette names", () => {
    assert.deepEqual(Object.keys(ROLE_MAP), [...ROLES]);
    for (const [role, colour] of Object.entries(ROLE_MAP)) assert.ok((VAR_NAMES as readonly string[]).includes(colour), role);
    assert.equal(FOREGROUND_ROLES.length + BACKGROUND_ROLES.length, ROLES.length);
});

test("every colour of the map is used by some role, so none is dead", () => {
    const used = new Set(Object.values(ROLE_MAP));
    for (const name of VAR_NAMES) assert.ok(used.has(name), `${name} is not used by the role map`);
});

test("a palette sets only roles that exist, and its own values are colours or the names of its colours", () => {
    for (const [name, palette] of Object.entries(PALETTES)) {
        for (const [role, value] of Object.entries(palette.colors ?? {})) {
            assert.ok((ROLES as readonly string[]).includes(role), `${name}: ${role}`);
            const resolved = resolveColor(value, palette.vars);
            assert.ok("value" in resolved, `${name}: ${role}`);
        }
    }
});

test("build gives a complete theme: every role, the colours as vars, and the export colours", () => {
    for (const [name, palette] of Object.entries(PALETTES)) {
        const theme = build(palette, name);
        assert.deepEqual(Object.keys(theme), ["name", "appearance", "vars", "colors", "export"]);
        assert.equal(theme.name, name);
        assert.deepEqual(Object.keys(theme.colors), [...ROLES]);
        assert.deepEqual(Object.keys(theme.vars), [...VAR_NAMES]);
        assert.deepEqual(Object.keys(theme.export), ["pageBg", "cardBg", "infoBg"]);
        // Roles point at a variable unless the palette set that role itself.
        for (const role of ROLES) assert.equal(theme.colors[role], palette.colors?.[role] ?? ROLE_MAP[role], `${name}: ${role}`);
        assert.doesNotThrow(() => resolveTheme(theme), name);
    }
});

test("a palette that sets no roles is the role map and nothing else", () => {
    for (const name of ["jig-ember", "jig-orchid", "jig-mono", "jig-paper"]) {
        assert.equal(PALETTES[name]?.colors, undefined, `${name} sets roles by hand`);
    }
});

for (const [name, file] of [["jig-lime", "lime-roles.json"], ["jig-signal", "signal-roles.json"]] as const) {
    test(`${name} is the theme it was drawn as: all ${ROLES.length} roles and the export colours, after the colours are followed`, () => {
        const golden = fixture(file);
        const palette = PALETTES[name];
        assert.ok(palette);
        const resolved = resolveTheme(build(palette, name));
        assert.equal(palette.appearance, golden.appearance);
        assert.deepEqual(Object.keys(golden.colors).sort(), [...ROLES].sort(), "the fixture has every role");
        for (const role of ROLES) assert.equal(String(resolved.colors[role]).toLowerCase(), golden.colors[role]?.toLowerCase(), `${name}: ${role}`);
        assert.deepEqual(
            Object.fromEntries(Object.entries(resolved.export).map(([key, value]) => [key, String(value).toLowerCase()])),
            Object.fromEntries(Object.entries(golden.export).map(([key, value]) => [key, value.toLowerCase()])),
        );
    });
}

test("each palette matches its appearance: dark ones have a dark page, jig-paper a light one", () => {
    for (const [name, palette] of Object.entries(PALETTES)) {
        const page = String(palette.vars.bg);
        if (palette.appearance === "light") assert.ok(luminance(page) > 0.5, name);
        else assert.ok(luminance(page) < 0.05, name);
    }
    assert.equal(PALETTES["jig-paper"]?.appearance, "light");
});

test("no two palettes share their accent, or most of their colours", () => {
    const accents = new Set(Object.values(PALETTES).map((palette) => String(palette.vars.accent).toLowerCase()));
    assert.equal(accents.size, 6);
    const names = Object.keys(PALETTES);
    for (const a of names) {
        for (const b of names) {
            if (a >= b) continue;
            const same = VAR_NAMES.filter((key) => String(PALETTES[a]?.vars[key]).toLowerCase() === String(PALETTES[b]?.vars[key]).toLowerCase());
            assert.ok(same.length <= 4, `${a} and ${b} share ${same.join(", ")}`);
        }
    }
});

// ---- contrast ---------------------------------------------------------------------------------------------------------

type Surface = "page" | "card" | "info" | "user" | "custom" | "toolPending" | "toolSuccess" | "toolError" | "selected" | "searchMatch";

const EVERYWHERE: Surface[] = ["page", "card", "info", "user", "custom", "toolPending", "toolSuccess", "toolError", "selected", "searchMatch"];
/** Where running text sits: not on a selected row, which only holds a line of a list. */
const FLAT: Surface[] = ["page", "user", "custom", "toolPending", "toolSuccess", "toolError"];
const TOOLS: Surface[] = ["toolPending", "toolSuccess", "toolError"];

/** Text that is read for long stretches: 7:1. */
const BODY: ReadonlyArray<[Role, Surface[]]> = [
    ["text", EVERYWHERE],
    ["userMessageText", ["user", "card"]],
    ["customMessageText", ["custom", "info"]],
    ["toolOutput", TOOLS],
    ["mdCodeBlock", FLAT],
    ["syntaxVariable", FLAT],
    ["searchMatchText", ["searchMatch"]],
];

/** Secondary text: 4.5:1. */
const MUTED: ReadonlyArray<[Role, Surface[]]> = [
    ["muted", EVERYWHERE],
    ["mdLinkUrl", FLAT],
    ["toolDiffContext", FLAT],
    ["syntaxPunctuation", FLAT],
    ["thinkingText", ["page"]],
    ["dim", FLAT],
    ["syntaxComment", FLAT],
];

/** Colour used for words: 4.5:1 on the page, a user message and a failed tool box. */
const COLOURED: readonly Role[] = [
    "accent", "success", "error", "warning", "toolTitle", "mdHeading", "mdLink", "mdCode", "customMessageLabel", "mdListBullet",
    "toolDiffAdded", "toolDiffRemoved", "syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
];

/**
 * Roles of a palette that are below the rule it is measured by, because that is how the palette was drawn. They are kept
 * as drawn and named here, so that nothing else slips. A test fails when one of them has become readable, so the
 * entry is then removed.
 */
const BELOW_MUTED: Readonly<Record<string, readonly Role[]>> = {
    // #586779 is 3.2:1 on the page and 3.0:1 on a user message.
    "jig-signal": ["dim", "syntaxComment"],
};

function surfaces(name: string): Record<Surface, string> {
    const palette = PALETTES[name];
    assert.ok(palette);
    const { colors, export: exported } = resolveTheme(build(palette, name));
    const page = String(exported.pageBg);
    // A background of "" is the terminal's own, which the page stands for.
    const own = (value: unknown) => (value === "" ? page : String(value));
    return {
        page,
        card: String(exported.cardBg),
        info: String(exported.infoBg),
        user: own(colors.userMessageBg),
        custom: own(colors.customMessageBg),
        toolPending: own(colors.toolPendingBg),
        toolSuccess: own(colors.toolSuccessBg),
        toolError: own(colors.toolErrorBg),
        selected: String(colors.selectedBg),
        searchMatch: String(colors.searchMatchBg),
    };
}

/** The ratios of a role over the surfaces it sits on, lowest first. */
function ratios(name: string, role: Role, on: readonly Surface[]): Array<[Surface, number]> {
    const palette = PALETTES[name];
    assert.ok(palette);
    const colour = String(resolveTheme(build(palette, name)).colors[role]);
    const where = surfaces(name);
    return on.map((surface): [Surface, number] => [surface, contrast(colour, where[surface])]).sort((a, b) => a[1] - b[1]);
}

for (const name of PALETTE_NAMES) {
    test(`${name}: body text keeps 7:1 on the backgrounds it sits on`, () => {
        for (const [role, on] of BODY) {
            const [worst] = ratios(name, role, on);
            assert.ok(worst && worst[1] >= 7, `${name} ${role} on ${worst?.[0]}: ${worst?.[1].toFixed(2)}`);
        }
    });

    test(`${name}: muted text keeps 4.5:1 on the backgrounds it sits on`, () => {
        for (const [role, on] of MUTED) {
            const [worst] = ratios(name, role, on);
            assert.ok(worst);
            if (BELOW_MUTED[name]?.includes(role)) {
                assert.ok(worst[1] < 4.5, `${name} ${role} now has ${worst[1].toFixed(2)}:1, so it needs no exception`);
            } else {
                assert.ok(worst[1] >= 4.5, `${name} ${role} on ${worst[0]}: ${worst[1].toFixed(2)}`);
            }
        }
    });

    test(`${name}: coloured words keep 4.5:1 on the page, a user message and a failed tool box`, () => {
        for (const role of COLOURED) {
            const [worst] = ratios(name, role, ["page", "user", "toolError"]);
            assert.ok(worst && worst[1] >= 4.5, `${name} ${role} on ${worst?.[0]}: ${worst?.[1].toFixed(2)}`);
        }
    });
}

test("the exceptions are for palettes and roles that exist", () => {
    for (const [name, roles] of Object.entries(BELOW_MUTED)) {
        assert.ok(PALETTE_NAMES.includes(name));
        for (const role of roles) assert.ok(MUTED.some(([muted]) => muted === role), role);
    }
});

test("jig-mono, the highest contrast, keeps muted text at 7:1 and body text at 12:1", () => {
    for (const [role, on] of MUTED) {
        if (role === "thinkingText") continue;
        const [worst] = ratios("jig-mono", role, on);
        assert.ok(worst && worst[1] >= 7, `${role} on ${worst?.[0]}: ${worst?.[1].toFixed(2)}`);
    }
    for (const [role, on] of BODY) {
        const [worst] = ratios("jig-mono", role, on);
        assert.ok(worst && worst[1] >= 12, `${role} on ${worst?.[0]}: ${worst?.[1].toFixed(2)}`);
    }
});

test("the contrast function is WCAG's: black on white is 21, a colour on itself is 1", () => {
    assert.equal(Math.round(contrast("#000000", "#FFFFFF")), 21);
    assert.equal(contrast("#123456", "#123456"), 1);
    assert.ok(Math.abs(contrast("#777777", "#FFFFFF") - 4.48) < 0.01);
    assert.equal(contrast("#fff", "#000"), contrast("#FFFFFF", "#000000"));
});
