// `/theme`: the picker, switching by name, reload, and the footer on and off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE } from "../src/command.ts";
import type { PaletteSpec } from "../src/config.ts";
import { statSync, utimesSync } from "node:fs";
import path from "node:path";
import { FakePi, FakeTheme, rig, settle } from "./support.ts";


const sea: PaletteSpec = { base: "jig-signal", vars: { accent: "#4FD6BE" }, colors: {} };
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ENTER = "\r";
const ESC = "\u001b";

const started = async (t: Parameters<typeof rig>[0], o: Parameters<typeof rig>[1] = {}) => {
    const made = rig(t, o);
    await made.pi.fire("session_start", { reason: "startup" });
    return made;
};

test("/theme is registered with a description, and completes theme names and its words", async (t) => {
    const { pi } = await started(t);
    const command = pi.commands.get("theme");
    assert.ok(command);
    assert.match(command.description ?? "", /theme/);
    await pi.theme("jig-ember");
    const complete = command.getArgumentCompletions as (prefix: string) => Array<{ value: string }> | null;
    assert.deepEqual(complete("jig-e")?.map((item) => item.value), ["jig-ember"]);
    assert.deepEqual(complete("foo")?.map((item) => item.value), ["footer on", "footer off"]);
    assert.deepEqual(complete("rel")?.map((item) => item.value), ["reload"]);
    assert.equal(complete("zzz"), null);
});

test("/theme <name> switches to that theme with Pi's own call, which saves it", async (t) => {
    const { pi } = await started(t);
    assert.deepEqual(await pi.theme("jig-ember"), []);
    assert.deepEqual(pi.setThemeCalls, ["jig-ember"]);
    assert.equal(pi.current.name, "jig-ember");
    await pi.theme("  dark  ");
    assert.equal(pi.current.name, "dark");
});

test("choosing a palette that changed since Pi read it writes its file again, once Pi is watching, so Pi reads it anew", async (t) => {
    const first = await started(t, { settings: { palettes: { sea } } });
    const file = path.join(first.agentDir, "themes", "sea.json");
    const aged = () => utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
    aged();
    const changed: PaletteSpec = { ...sea, vars: { accent: "#112233" } };
    const second = await started(t, { agentDir: first.agentDir, current: "dark", settings: { palettes: { sea: changed } } });
    aged();
    await second.pi.theme("sea");
    await settle();
    assert.ok(statSync(file).mtimeMs > Date.now() - 5000, "written again after the switch");
    aged();
    await second.pi.theme("sea");
    await settle();
    assert.ok(statSync(file).mtimeMs < Date.now() - 86_400_000, "once per change, not at every switch");
    aged();
    await second.pi.theme("jig-ember");
    await settle();
    assert.ok(statSync(file).mtimeMs < Date.now() - 86_400_000, "and not for another theme");
});

test("a palette of yours is a theme to /theme once it is written", async (t) => {
    const { pi } = await started(t, { settings: { palettes: { sea } } });
    assert.deepEqual(await pi.theme("sea"), []);
    assert.equal(pi.current.name, "sea");
});

test("a theme that does not exist, and anything else, is the usage line and changes nothing", async (t) => {
    const { pi } = await started(t);
    assert.deepEqual(await pi.theme("jig-embr"), [{ text: `No theme named "jig-embr". ${USAGE}`, level: "warning" }]);
    for (const args of ["a b", "reload now", "footer", "footer maybe", "footer on off", "one two three"]) {
        const notices = await pi.theme(args);
        assert.equal(notices.length, 1, args);
        assert.match(notices[0]?.text ?? "", /^(No theme named "footer"\. )?Usage: \/theme \[name \| reload \| footer on\|off\]$/, args);
    }
    assert.deepEqual(pi.setThemeCalls, []);
    assert.equal(pi.reloads, 0);
});

test("an unknown name is shown cleaned and cut", async (t) => {
    const { pi } = await started(t);
    const [notice] = await pi.theme(`x\u001b[31m${"y".repeat(100)}`);
    assert.doesNotMatch(notice?.text ?? "", /\u001b/);
    assert.ok((notice?.text ?? "").length < 120);
});

test("a theme Pi cannot load is said, with Pi's own words, and the name is cleaned", async (t) => {
    const { pi } = await started(t);
    pi.ctx.ui.setTheme = () => ({ success: false, error: "Variable reference not found: foo" });
    assert.deepEqual(await pi.theme("jig-ember"), [{ text: 'Pi could not load the theme "jig-ember": Variable reference not found: foo', level: "warning" }]);
});

test("without a terminal /theme and /theme <name> say it needs one, and the usage line still shows for what is not understood", async (t) => {
    for (const mode of ["rpc", "json", "print"] as const) {
        const { pi } = await started(t, { mode });
        assert.deepEqual(await pi.theme(""), [{ text: "/theme needs the terminal.", level: "info" }], mode);
        assert.deepEqual(await pi.theme("jig-ember"), [{ text: "/theme needs the terminal.", level: "info" }], mode);
        assert.deepEqual(await pi.theme("reload"), [{ text: "/theme needs the terminal.", level: "info" }], mode);
        assert.deepEqual(await pi.theme("footer on"), [{ text: "/theme needs the terminal.", level: "info" }], mode);
        assert.deepEqual(await pi.theme("a b c"), [{ text: USAGE, level: "warning" }], mode);
        assert.deepEqual(pi.setThemeCalls, []);
        assert.equal(pi.customs.length, 0);
    }
});

// ---- the footer ------------------------------------------------------------------------------------------------------

test("/theme footer off gives Pi's footer back for the session, and on shows ours again", async (t) => {
    const { pi } = await started(t);
    assert.ok(pi.footer);
    assert.deepEqual(await pi.theme("footer off"), []);
    assert.equal(pi.footer, undefined, "Pi was asked for its own footer");
    assert.deepEqual(await pi.theme("footer on"), []);
    assert.ok(pi.footer);
    assert.match(pi.row(), /Fixture Model/);
});

test("a footer switched off stays off for the session, and comes back with the next", async (t) => {
    const { pi } = await started(t);
    await pi.theme("footer off");
    await pi.fire("message_end");
    assert.equal(pi.footer, undefined);
    await pi.fire("session_start", { reason: "new" });
    assert.ok(pi.footer, "a new session starts with the footer again");
});

test("/theme footer on shows the footer even when the settings turned it off, but not where it is never shown", async (t) => {
    const off = await started(t, { settings: { footer: { enabled: false } } });
    assert.equal(off.pi.footers.length, 0);
    await off.pi.theme("footer on");
    assert.ok(off.pi.footer);
    const env = await started(t, { env: { JIG_THEME_FOOTER: "0" } });
    assert.deepEqual(await env.pi.theme("footer on"), [{ text: "The footer cannot be shown here: JIG_THEME_FOOTER=0 turns it off.", level: "warning" }]);
    assert.equal(env.pi.footers.length, 0);
    const child = await started(t, { env: { PI_SUBAGENT_ID: "child-1" } });
    assert.match((await child.pi.theme("footer on"))[0]?.text ?? "", /started by another session/);
});

// ---- reload ------------------------------------------------------------------------------------------------------------

test("/theme reload reloads Pi, which reads jig.json and writes the palettes; the session after it says what it wrote", async (t) => {
    const first = await started(t, { settings: { palettes: { sea } } });
    first.pi.notices.length = 0;
    await first.pi.theme("reload");
    assert.equal(first.pi.reloads, 1);
    // The next runtime: its session starts as Pi's reload makes it, and says what was written.
    const second = rig(t, { agentDir: first.agentDir, settings: { palettes: { sea, dusk: { base: "jig-orchid", vars: {}, colors: {} } } } });
    await second.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(second.pi.notices, [{ text: "jig-theme: wrote dusk", level: "info" }]);
    // Said once: a later session start does not repeat it.
    const third = rig(t, { agentDir: first.agentDir, settings: { palettes: { sea, dusk: { base: "jig-orchid", vars: {}, colors: {} } } } });
    await third.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(third.pi.notices, []);
});

test("what a reload says is one notice, because Pi shows a notice of that kind in place of the one before", async (t) => {
    const first = await started(t, { settings: { palettes: { sea } } });
    await first.pi.theme("reload");
    const changed: PaletteSpec = { ...sea, vars: { accent: "#112233" } };
    const next = rig(t, { agentDir: first.agentDir, current: "dark", settings: { palettes: { sea: changed, dusk: { base: "jig-mono", vars: {}, colors: {} } } } });
    await next.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(next.pi.notices, [
        { text: 'jig-theme: "sea" changed; /theme shows it anew, and /reload does so in /settings too\nwrote sea, dusk', level: "info" },
    ]);
});

test("a reload that changed nothing says the palettes are up to date, and with no palettes says so", async (t) => {
    const first = await started(t, { settings: { palettes: { sea } } });
    await first.pi.theme("reload");
    const again = rig(t, { agentDir: first.agentDir, settings: { palettes: { sea } } });
    await again.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(again.pi.notices, [{ text: "jig-theme: your palettes are up to date", level: "info" }]);
    await first.pi.theme("reload");
    const none = rig(t, { settings: {} });
    await none.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(none.pi.notices, [{ text: "jig-theme: no palettes in jig.json", level: "info" }]);
});

test("a palette removed from jig.json is said to be removed after a reload", async (t) => {
    const first = await started(t, { settings: { palettes: { sea } } });
    await first.pi.theme("reload");
    const gone = rig(t, { agentDir: first.agentDir, settings: {} });
    await gone.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(gone.pi.notices, [{ text: "jig-theme: removed sea", level: "info" }]);
});

test("a reload that cannot be done says so and does not mark the next session", async (t) => {
    const { pi } = await started(t);
    pi.reloadFails = true;
    assert.deepEqual(await pi.theme("reload"), [{ text: "jig-theme: Pi could not be reloaded; run /reload", level: "warning" }]);
    const next = rig(t, { settings: {} });
    await next.pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(next.pi.notices, []);
});

test("a problem during a reload is the warning, and the summary is left out", async (t) => {
    const first = await started(t, { settings: { palettes: { sea } } });
    await first.pi.theme("reload");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(`${first.agentDir}/themes/sea.json`, "\n");
    const next = rig(t, { agentDir: first.agentDir, settings: { palettes: { sea: { ...sea, vars: { accent: "#112233" } } } } });
    await next.pi.fire("session_start", { reason: "reload" });
    await settle();
    assert.deepEqual(next.pi.notices, [{ text: "jig-theme: themes/sea.json was changed by hand; jig-theme leaves it", level: "warning" }]);
});

// ---- the list ----------------------------------------------------------------------------------------------------------

const names = (pi: FakePi) => pi.ctx.ui.getAllThemes().map((theme) => theme.name);

/** Opens the list and returns what the test needs to drive it. */
async function openList(pi: FakePi, width = 300) {
    const running = pi.theme("");
    assert.equal(pi.customs.length > 0, true, "the list is open");
    const list = pi.customs.at(-1)!;
    return {
        running,
        render: () => list.component.render(width).join("\n").replace(/<\/?[a-zA-Z]*>/g, ""),
        raw: () => list.component.render(width).join("\n"),
        press: (data: string) => list.component.handleInput?.(data),
    };
}

test("/theme lists every theme Pi has, the one in use is marked and selected, and each has a swatch of its colours", async (t) => {
    const { pi } = await started(t, { current: "jig-lime" });
    const list = await openList(pi);
    const shown = list.raw();
    for (const name of names(pi)) assert.ok(shown.includes(name), name);
    assert.match(shown, /<accent>›<\/> <accent>jig-lime/, "the theme in use is the one selected");
    assert.match(list.render(), /jig-lime .*██ ██ ██ ██ ██ ██ ██ dark in use/);
    assert.ok(shown.includes("<mdHeading>██</>"), "the swatch is drawn in the theme's own colours");
    assert.match(list.render(), /jig-paper .* light/);
    assert.match(list.render(), /↑\/↓ move · Enter keep · Esc cancel/);
    list.press(ESC);
    await list.running;
});

test("moving shows a theme live without keeping it, and Enter keeps the one chosen", async (t) => {
    const { pi } = await started(t, { current: "jig-lime" });
    const list = await openList(pi);
    const at = names(pi).indexOf("jig-lime");
    list.press(DOWN);
    assert.equal(typeof pi.setThemeCalls.at(-1), "object", "a preview passes a theme object, which Pi does not save");
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme).name, names(pi)[at + 1]);
    list.press(DOWN);
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme).name, names(pi)[at + 2]);
    list.press(UP);
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme).name, names(pi)[at + 1]);
    assert.ok(pi.renders >= 3, "each move draws the list again");
    list.press(ENTER);
    await list.running;
    assert.equal(pi.setThemeCalls.at(-1), names(pi)[at + 1], "Enter keeps the choice by name, which Pi saves");
    assert.equal(pi.current.name, names(pi)[at + 1]);
});

test("Esc after moving puts back the theme that was in use, as an object, so nothing is saved", async (t) => {
    const { pi } = await started(t, { current: "jig-lime" });
    const list = await openList(pi);
    list.press(DOWN);
    list.press(DOWN);
    assert.notEqual(pi.current.name, "jig-lime");
    list.press(ESC);
    await list.running;
    assert.equal(pi.current.name, "jig-lime");
    assert.ok(pi.setThemeCalls.at(-1) instanceof FakeTheme, "a theme object, which Pi switches to without saving");
    assert.ok(!pi.setThemeCalls.some((call) => typeof call === "string"), "nothing was saved");
});

test("the theme in use is marked, and stays marked while another is shown", async (t) => {
    const { pi } = await started(t, { current: "jig-lime" });
    const list = await openList(pi);
    list.press(DOWN);
    const marked = list.render().split("\n").filter((line) => line.includes(" in use"));
    assert.equal(marked.length, 1);
    assert.match(marked[0] ?? "", /jig-lime/);
    assert.match(list.render(), /› jig-orchid|› jig-mono|› jig-paper|› jig-signal|› light|› sea/, "the selection moved on");
    list.press(ESC);
    await list.running;
});

test("a theme that cannot be loaded again is never previewed, because it could not be put back", async (t) => {
    const { pi } = await started(t, { current: "jig-lime" });
    const real = pi.ctx.ui.getTheme;
    pi.ctx.ui.getTheme = (name: string) => (name === "jig-lime" ? undefined : real(name));
    const list = await openList(pi);
    const before = pi.setThemeCalls.length;
    list.press(DOWN);
    assert.equal(pi.setThemeCalls.length, before);
    list.press(ENTER);
    await list.running;
    assert.equal(typeof pi.setThemeCalls.at(-1), "string", "Enter still keeps the choice");
});

test("Esc without moving changes nothing at all", async (t) => {
    const { pi } = await started(t, { current: "jig-lime" });
    const list = await openList(pi);
    list.press(ESC);
    await list.running;
    assert.deepEqual(pi.setThemeCalls, []);
});

test("the list stops at its ends, and Home, End and the page keys move by more", async (t) => {
    const { pi } = await started(t, { current: "system" });
    const list = await openList(pi);
    list.press(UP);
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme | undefined)?.name ?? "system", "system", "above the first stays on it");
    list.press("\u001b[F");
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme).name, names(pi).at(-1));
    list.press(DOWN);
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme).name, names(pi).at(-1), "below the last stays on it");
    list.press("\u001b[H");
    assert.equal((pi.setThemeCalls.at(-1) as FakeTheme).name, "system");
    list.press("\u001b[6~");
    assert.ok(names(pi).indexOf((pi.setThemeCalls.at(-1) as FakeTheme).name) > 1);
    list.press(ESC);
    await list.running;
});

test("a long list scrolls to keep the selection in view, and says where it is", async (t) => {
    const many = Array.from({ length: 40 }, (_, index) => ({ name: `t${String(index).padStart(2, "0")}`, path: `/x/t${index}.json` }));
    const { pi } = await started(t, { current: "t30", others: many, builtins: [...many.map((theme) => theme.name), "dark"] });
    pi.rows = 20;
    const list = await openList(pi);
    const shown = list.render();
    assert.ok(shown.includes("t30"), "the selection is on screen");
    assert.ok(shown.split("\n").length <= 20, "the list fits the terminal");
    assert.match(shown, /\d+-\d+ of \d+/);
    list.press(ESC);
    await list.running;
});

test("a theme Pi cannot load is listed, and moving onto it shows nothing and changes nothing", async (t) => {
    const { pi } = await started(t, { current: "dark", others: [{ name: "broken", path: "/x/broken.json" }], builtins: ["dark", "light"] });
    const list = await openList(pi);
    assert.match(list.render(), /broken .*cannot be loaded/);
    const before = pi.setThemeCalls.length;
    list.press("\u001b[F");
    assert.equal(pi.setThemeCalls.length, before, "no preview of a theme that cannot load");
    assert.match(list.render(), /› .*broken/, "the selection is on it");
    list.press(ESC);
    await list.running;
    assert.equal(pi.setThemeCalls.length, before, "and nothing to put back");
});

test("every line of the list fits the width, whatever it is", async (t) => {
    const { pi } = await started(t, { current: "jig-lime", ansi: true });
    const { cellWidth } = await import("../src/width.ts");
    for (const width of [1, 5, 20, 40, 80]) {
        const list = await openList(pi, width);
        for (const line of list.raw().split("\n")) assert.ok(cellWidth(line) <= width, `${width}: ${line}`);
        list.press(ESC);
        await list.running;
    }
});
