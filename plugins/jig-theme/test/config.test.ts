import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FOOTER, DEFAULT_SETTINGS, isColorValue, settingsFrom, validateTheme } from "../src/config.ts";
import { FOREGROUND_ROLES } from "../src/roles.ts";

const sea = { base: "jig-signal", vars: { accent: "#4FD6BE", heading: "#C099FF" }, colors: { mdCode: "#FFB454" } };

test("an empty section, or one with only valid fields, is valid", () => {
    assert.deepEqual(validateTheme({}), []);
    assert.deepEqual(validateTheme({ palettes: { sea } }), []);
    assert.deepEqual(validateTheme({ answerColor: false }), []);
    assert.deepEqual(validateTheme({ answerColor: "accent" }), []);
    assert.deepEqual(
        validateTheme({
            footer: {
                enabled: true,
                segments: ["model", "cwd", "branch"],
                dropFirst: ["cwd"],
                colors: { model: "accent", cost: "mdHeading" },
                context: { warnTokens: 100000, highTokens: 200000, warnPercent: 60, highPercent: 80 },
                costDecimals: 3,
                separator: " | ",
            },
        }),
        [],
    );
});

test("the section must be an object, and a misspelt field is an error that names it", () => {
    for (const raw of [null, "theme", [1], 3])
        assert.deepEqual(validateTheme(raw), ["theme: must be an object"], JSON.stringify(raw));
    assert.deepEqual(validateTheme({ palete: {} }), ["theme.palete: unknown field"]);
    assert.deepEqual(validateTheme({ footer: { colours: {} } }), ["theme.footer.colours: unknown field"]);
    assert.deepEqual(validateTheme({ footer: { context: { warn: 1 } } }), ["theme.footer.context.warn: unknown field"]);
    assert.deepEqual(validateTheme({ palettes: { sea: { base: "jig-lime", color: {} } } }), [
        "theme.palettes.sea.color: unknown field",
    ]);
});

test("a palette name is lower case letters, digits and hyphens, and never one that is taken", () => {
    for (const name of ["Sea", "sea_x", "-sea", "x".repeat(41), "a b", "..", "a/b", "sea.json"]) {
        const errors = validateTheme({ palettes: { [name]: sea } });
        assert.equal(errors.length, 1, name);
        assert.match(errors[0] ?? "", /a palette name is lower-case letters/, name);
    }
    for (const name of [
        "system",
        "dark",
        "light",
        "jig-lime",
        "jig-signal",
        "jig-ember",
        "jig-orchid",
        "jig-mono",
        "jig-paper",
        "reload",
        "footer",
    ]) {
        assert.match(
            validateTheme({ palettes: { [name]: sea } })[0] ?? "",
            /that name is reserved: a theme Pi or this plugin ships, or a word of \/theme/,
            name,
        );
    }
    assert.deepEqual(validateTheme({ palettes: { "a-1": sea, x: sea, ["y".repeat(40)]: sea } }), []);
});

test("base is one of the six, vars are the palette's colours, colors are Pi's roles", () => {
    assert.deepEqual(validateTheme({ palettes: { sea: {} } }), [
        "theme.palettes.sea.base: must be one of jig-lime, jig-signal, jig-ember, jig-orchid, jig-mono, jig-paper",
    ]);
    assert.match(validateTheme({ palettes: { sea: { base: "dark" } } })[0] ?? "", /sea\.base: must be one of/);
    assert.deepEqual(validateTheme({ palettes: { sea: { base: "jig-lime", vars: { nope: "#fff" } } } }), [
        "theme.palettes.sea.vars.nope: not a palette colour",
    ]);
    assert.deepEqual(validateTheme({ palettes: { sea: { base: "jig-lime", colors: { nope: "#fff" } } } }), [
        "theme.palettes.sea.colors.nope: not a Pi theme role",
    ]);
    assert.deepEqual(validateTheme({ palettes: { sea: "jig-lime" } }), [
        "theme.palettes.sea: must be an object with base, and optionally vars and colors",
    ]);
});

test("a colour is the forms Pi reads, and the error names the key and never the value", () => {
    for (const value of [
        "#4FD6BE",
        "#fff",
        "oklch(62% 0.1 200)",
        "oklch(0.62 0.1 200deg)",
        "okhsl(250 60% 55%)",
        39,
        0,
        255,
        "",
        "accent",
        "muted",
    ]) {
        assert.equal(isColorValue(value), true, String(value));
    }
    for (const value of [
        "red",
        "#12345",
        "#GGGGGG",
        "rgb(1,2,3)",
        256,
        -1,
        1.5,
        null,
        true,
        {},
        "oklch(1)",
        "x".repeat(200),
    ]) {
        assert.equal(isColorValue(value), false, String(value));
    }
    const canary = "private-canary-value";
    const errors = validateTheme({
        palettes: { sea: { base: "jig-lime", vars: { accent: canary }, colors: { mdCode: canary } } },
    });
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? "", /theme\.palettes\.sea\.vars\.accent: must be a colour as Pi reads it/);
    assert.match(errors[1] ?? "", /theme\.palettes\.sea\.colors\.mdCode: must be a colour as Pi reads it/);
    assert.doesNotMatch(errors.join("\n"), new RegExp(canary));
});

test("colours that point at each other, or at nothing, are a problem found before Pi is asked", () => {
    assert.deepEqual(
        validateTheme({ palettes: { sea: { base: "jig-lime", vars: { accent: "link", link: "accent" } } } }),
        ["theme.palettes.sea: its colours point at each other in a loop"],
    );
    assert.deepEqual(validateTheme({ palettes: { sea: { base: "jig-lime", vars: { accent: "link" } } } }), []);
});

test("a key that is not safe to show is cut and cleaned in the message", () => {
    const errors = validateTheme({ [`x\u001b[31m${"y".repeat(80)}`]: 1 });
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0] ?? "", /\u001b/);
    assert.ok((errors[0] ?? "").length < 80);
});

test("at most twenty palettes", () => {
    const palettes = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, sea]));
    assert.deepEqual(validateTheme({ palettes }), ["theme.palettes: at most 20 palettes"]);
});

test("footer.segments and dropFirst are known parts, once each; segments is not empty", () => {
    assert.deepEqual(validateTheme({ footer: { segments: ["model", "nope"] } }), [
        "theme.footer.segments[1]: not a footer part (model, thinking, context, cache, cost, tokens, branch, cwd, statuses, plugins)",
    ]);
    assert.deepEqual(validateTheme({ footer: { segments: ["model", "model"] } }), [
        "theme.footer.segments[1]: listed twice",
    ]);
    assert.match(
        validateTheme({ footer: { segments: [] } })[0] ?? "",
        /theme\.footer\.segments: must list at least one part/,
    );
    assert.deepEqual(validateTheme({ footer: { dropFirst: [] } }), []);
    assert.match(
        validateTheme({ footer: { dropFirst: "tokens" } })[0] ?? "",
        /theme\.footer\.dropFirst: must be a list/,
    );
});

test("footer.colors maps a part to a Pi text role, not a background", () => {
    assert.deepEqual(validateTheme({ footer: { colors: { nope: "accent" } } }), [
        "theme.footer.colors.nope: not a footer part (model, thinking, context, cache, cost, tokens, branch, cwd, statuses, plugins)",
    ]);
    assert.deepEqual(validateTheme({ footer: { colors: { model: "userMessageBg" } } }), [
        "theme.footer.colors.model: must be a Pi text role, such as muted, accent or mdHeading (not a background)",
    ]);
    assert.deepEqual(validateTheme({ footer: { colors: { model: "nope" } } }), [
        "theme.footer.colors.model: must be a Pi text role, such as muted, accent or mdHeading (not a background)",
    ]);
    assert.deepEqual(validateTheme({ answerColor: "selectedBg" }), [
        "theme.answerColor: must be a Pi text role, such as text or accent, or false",
    ]);
    assert.deepEqual(validateTheme({ answerColor: true }), [
        "theme.answerColor: must be a Pi text role, such as text or accent, or false",
    ]);
});

test("the context limits are whole numbers in range, and warn is below high", () => {
    assert.deepEqual(validateTheme({ footer: { context: { warnTokens: 100 } } }), [
        "theme.footer.context.warnTokens: must be a whole number from 1000 to 10000000",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { highTokens: 12.5 } } }), [
        "theme.footer.context.highTokens: must be a whole number from 1000 to 10000000",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { warnPercent: 0 } } }), [
        "theme.footer.context.warnPercent: must be a whole number from 1 to 100",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { highPercent: 101 } } }), [
        "theme.footer.context.highPercent: must be a whole number from 1 to 100",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { warnTokens: 300000 } } }), [
        "theme.footer.context.warnTokens: must be lower than highTokens",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { warnTokens: 200000, highTokens: 200000 } } }), [
        "theme.footer.context.warnTokens: must be lower than highTokens",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { warnPercent: 95 } } }), [
        "theme.footer.context.warnPercent: must be lower than highPercent",
    ]);
    // The one that is not set is the default, 150000 here, so this is out of order too.
    assert.deepEqual(validateTheme({ footer: { context: { highTokens: 120000 } } }), [
        "theme.footer.context.warnTokens: must be lower than highTokens",
    ]);
    assert.deepEqual(validateTheme({ footer: { context: { highTokens: 120000, warnTokens: 100000 } } }), []);
});

test("cost decimals are 2 to 4, and the separator is 1 to 5 cells of plain text", () => {
    for (const costDecimals of [1, 5, 2.5, "2"]) {
        assert.deepEqual(
            validateTheme({ footer: { costDecimals } }),
            ["theme.footer.costDecimals: must be a whole number from 2 to 4"],
            String(costDecimals),
        );
    }
    assert.deepEqual(validateTheme({ footer: { separator: "" } }), [
        "theme.footer.separator: must be text of 1 to 5 characters wide",
    ]);
    assert.deepEqual(validateTheme({ footer: { separator: 5 } }), [
        "theme.footer.separator: must be text of 1 to 5 characters wide",
    ]);
    assert.deepEqual(validateTheme({ footer: { separator: "      " } }), [
        "theme.footer.separator: must be 1 to 5 cells wide",
    ]);
    assert.deepEqual(
        validateTheme({ footer: { separator: "日本語" } }),
        ["theme.footer.separator: must be 1 to 5 cells wide"],
        "wide characters count two cells",
    );
    assert.deepEqual(validateTheme({ footer: { separator: "a\u001b[31m" } }), [
        "theme.footer.separator: must not hold control characters",
    ]);
    assert.deepEqual(validateTheme({ footer: { separator: " │ " } }), []);
    assert.deepEqual(validateTheme({ footer: { enabled: "yes" } }), ["theme.footer.enabled: must be true or false"]);
});

test("every mistake is reported, not only the first", () => {
    assert.equal(validateTheme({ x: 1, answerColor: 3, footer: { costDecimals: 9, enabled: 1 } }).length, 4);
});

test("the settings are the defaults for what is missing, absent or wrong", () => {
    assert.deepEqual(settingsFrom(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom(null), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom({}), DEFAULT_SETTINGS);
    assert.deepEqual(settingsFrom({ footer: "x", palettes: 3, answerColor: 4 }), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS.footer, DEFAULT_FOOTER);
    assert.equal(DEFAULT_SETTINGS.answerColor, "text");
    assert.deepEqual(DEFAULT_FOOTER.segments, [
        "model",
        "thinking",
        "context",
        "cache",
        "cost",
        "tokens",
        "plugins",
        "statuses",
    ]);
    assert.deepEqual(DEFAULT_FOOTER.dropFirst, ["tokens", "cache", "branch", "cwd", "plugins"]);
    assert.deepEqual(DEFAULT_FOOTER.context, {
        warnTokens: 150000,
        highTokens: 250000,
        warnPercent: 70,
        highPercent: 90,
    });
    assert.equal(DEFAULT_FOOTER.costDecimals, 2);
    assert.equal(DEFAULT_FOOTER.separator, " · ");
});

test("every default footer colour is a Pi text role", () => {
    for (const role of Object.values(DEFAULT_FOOTER.colors))
        assert.ok((FOREGROUND_ROLES as readonly string[]).includes(role), role);
});

test("the settings carry what is set, and keep the default for the rest", () => {
    const settings = settingsFrom({
        palettes: { sea },
        answerColor: false,
        footer: {
            enabled: false,
            segments: ["model", "cost"],
            colors: { model: "accent" },
            context: { warnTokens: 100000 },
            costDecimals: 4,
            separator: " | ",
        },
    });
    assert.deepEqual(Object.keys(settings.palettes), ["sea"]);
    assert.deepEqual(settings.palettes.sea, sea);
    assert.equal(settings.answerColor, false);
    assert.equal(settings.footer.enabled, false);
    assert.deepEqual(settings.footer.segments, ["model", "cost"]);
    assert.equal(settings.footer.colors.model, "accent");
    assert.equal(settings.footer.colors.cost, "mdQuoteBorder");
    assert.deepEqual(settings.footer.context, {
        warnTokens: 100000,
        highTokens: 250000,
        warnPercent: 70,
        highPercent: 90,
    });
    assert.equal(settings.footer.costDecimals, 4);
    assert.equal(settings.footer.separator, " | ");
});

test("a palette that is not valid is left out of the settings, and the rest stay", () => {
    const settings = settingsFrom({ palettes: { sea, Bad: sea, dark: sea, two: { base: "nope" } } });
    assert.deepEqual(Object.keys(settings.palettes), ["sea"]);
});

test("a context limit pair that is not in order falls back to the defaults together", () => {
    assert.deepEqual(
        settingsFrom({ footer: { context: { warnTokens: 400000 } } }).footer.context,
        DEFAULT_FOOTER.context,
    );
});
