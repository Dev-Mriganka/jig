// The plugin as Pi loads it: the entry, what it registers, what it is allowed to import, and where it is listed.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import factory, { theme } from "../src/index.ts";
import type { PaletteSpec } from "../src/config.ts";
import { FakePi, rig, tempAgentDir, useJig } from "./support.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SRC = path.resolve(import.meta.dirname, "../src");
const sea: PaletteSpec = { base: "jig-signal", vars: { accent: "#4FD6BE" }, colors: {} };

test("the default export is the factory Pi loads, and it only registers", (t) => {
    assert.equal(typeof factory, "function");
    const pi = new FakePi({ agentDir: tempAgentDir(t) });
    factory(pi.api);
    assert.ok(pi.handlers.has("session_start"));
    assert.deepEqual(pi.notices, []);
});

test("the extension is listed in the package, last, after jig-core, and every listed file exists", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        pi: { extensions: string[]; themes: string[] };
    };
    const listed = manifest.pi.extensions;
    assert.ok(listed.includes("./plugins/jig-theme/src/index.ts"));
    assert.equal(listed.at(-1), "./plugins/jig-theme/src/index.ts");
    assert.ok(listed.indexOf("./plugins/jig-core/src/index.ts") < listed.indexOf("./plugins/jig-theme/src/index.ts"));
    for (const extension of listed) assert.ok(existsSync(path.join(ROOT, extension)), extension);
    assert.deepEqual(manifest.pi.themes, ["./plugins/jig-theme/themes/*.json"]);
});

test("it reaches jig-core only through its client, the way plugins are meant to", () => {
    let found = 0;
    for (const name of readdirSync(SRC)) {
        for (const match of readFileSync(path.join(SRC, name), "utf8").matchAll(/from "(\.\.\/\.\.\/jig-core\/[^"]+)"/g)) {
            found++;
            assert.equal(match[1], "../../jig-core/src/client.ts", `${name} imports ${match[1]}`);
        }
    }
    assert.ok(found >= 1);
});

test("the plugin registers its section with jig-core, and the check is the plugin's own", (t) => {
    const jig = useJig(t);
    rig(t);
    const check = jig.checks.get("theme");
    assert.ok(check);
    assert.deepEqual(check({}), []);
    assert.deepEqual(check({ palete: 1 }), ["theme.palete: unknown field"]);
});

test("without jig-core it still loads, and the defaults apply", async (t) => {
    const { pi, agentDir } = rig(t, { viaJig: true });
    await pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(pi.notices, []);
    assert.deepEqual(readdirSync(agentDir), []);
});

test("a session start in a terminal writes your palettes, from the section jig-core loaded", async (t) => {
    useJig(t, { theme: { palettes: { sea } } });
    const { pi, agentDir } = rig(t, { viaJig: true });
    await pi.fire("session_start", { reason: "startup" });
    assert.ok(existsSync(path.join(agentDir, "themes", "sea.json")));
    assert.deepEqual(pi.notices, []);
    assert.ok(pi.ctx.ui.getTheme("sea"), "Pi can load what was written");
});

test("an invalid section means no palettes at all: jig-core gives the plugin nothing", async (t) => {
    useJig(t, {});
    const { pi, agentDir } = rig(t, { viaJig: true });
    await pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(readdirSync(agentDir), []);
});

test("nothing is written without a terminal, or in a child the parent started", async (t) => {
    for (const mode of ["rpc", "json", "print"] as const) {
        const { pi, agentDir } = rig(t, { mode, settings: { palettes: { sea } } });
        await pi.fire("session_start", { reason: "startup" });
        assert.deepEqual(readdirSync(agentDir), [], mode);
    }
    for (const env of [{ PI_SUBAGENT_ID: "child-1" }, { PI_SUBAGENT_CHILD: "1" }]) {
        const { pi, agentDir } = rig(t, { env, settings: { palettes: { sea } } });
        await pi.fire("session_start", { reason: "startup" });
        assert.deepEqual(readdirSync(agentDir), [], JSON.stringify(env));
    }
});

test("a problem is said once as a warning, in words, and never with a colour", async (t) => {
    const { pi, agentDir } = rig(t, { settings: { palettes: { sea: { base: "jig-lime", vars: { accent: "#ABCDEF" }, colors: {} } } } });
    await pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(pi.notices, []);
    // The file is changed by hand, and the palette changes too.
    appendFileSync(path.join(agentDir, "themes", "sea.json"), "\n");
    const second = rig(t, { agentDir, settings: { palettes: { sea: { base: "jig-lime", vars: { accent: "#123456" }, colors: {} } } } });
    await second.pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(second.pi.notices, [{ text: "jig-theme: themes/sea.json was changed by hand; jig-theme leaves it", level: "warning" }]);
    assert.doesNotMatch(second.pi.texts().join("\n"), /ABCDEF|123456/i);
});

test("Pi failing to load a palette it was given is named", async (t) => {
    const { pi } = rig(t, { settings: { palettes: { sea } } });
    pi.ctx.ui.getTheme = () => undefined;
    await pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(pi.notices, [{ text: 'jig-theme: Pi cannot load the theme "sea"; check its base, vars and colors', level: "warning" }]);
});

test("a palette that changed and is not the theme in use is a note to run /reload; the one in use is not", async (t) => {
    const first = rig(t, { settings: { palettes: { sea } } });
    await first.pi.fire("session_start", { reason: "startup" });
    const changed: PaletteSpec = { ...sea, vars: { accent: "#112233" } };
    const idle = rig(t, { agentDir: first.agentDir, current: "dark", settings: { palettes: { sea: changed } } });
    await idle.pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(idle.pi.notices, [
        { text: 'jig-theme: "sea" changed on disk; run /reload to use it from /settings and /theme', level: "info" },
    ]);
    const another: PaletteSpec = { ...sea, vars: { accent: "#334455" } };
    const active = rig(t, { agentDir: first.agentDir, current: "sea", settings: { palettes: { sea: another } } });
    await active.pi.fire("session_start", { reason: "startup" });
    assert.deepEqual(active.pi.notices, [], "Pi reloads the theme in use by itself");
});

test("a failure while writing never reaches Pi", async (t) => {
    const { pi } = rig(t, { settings: { palettes: { sea } } });
    pi.ctx.ui.getAllThemes = () => {
        throw new Error("boom");
    };
    await assert.doesNotReject(pi.fire("session_start", { reason: "startup" }));
    assert.deepEqual(pi.notices, [{ text: "jig-theme: your palettes could not be written; the themes folder was left as it was", level: "warning" }]);
});

// ---- the footer in a session --------------------------------------------------------------------------------------------

const started = async (t: Parameters<typeof rig>[0], o: Parameters<typeof rig>[1] = {}) => {
    const made = rig(t, o);
    await made.pi.fire("session_start", { reason: "startup" });
    return made;
};
const text = (row: string) => row.replace(/<[a-zA-Z]+>|<\/>/g, "");

test("a session start in a terminal gives Pi the footer, and it shows the session", async (t) => {
    const { pi } = await started(t);
    assert.equal(pi.footers.length, 1);
    assert.equal(text(pi.row()), "Fixture Model · high · ctx 42k · est. $0.00 · ↑0 ↓0");
});

test("there is no footer without a terminal, in a child, with JIG_THEME_FOOTER=0, or when the settings turn it off", async (t) => {
    for (const mode of ["rpc", "json", "print"] as const) assert.equal((await started(t, { mode })).pi.footers.length, 0, mode);
    for (const env of [{ PI_SUBAGENT_ID: "child-1" }, { PI_SUBAGENT_CHILD: "1" }, { JIG_THEME_FOOTER: "0" }]) {
        assert.equal((await started(t, { env })).pi.footers.length, 0, JSON.stringify(env));
    }
    assert.equal((await started(t, { settings: { footer: { enabled: false } } })).pi.footers.length, 0);
    assert.equal((await started(t, { env: { JIG_THEME_FOOTER: "1" } })).pi.footers.length, 1, "only 0 turns it off");
});

test("the settings choose the parts, and the footer is drawn from them", async (t) => {
    const { pi } = await started(t, { settings: { footer: { segments: ["cost", "model", "cwd", "branch"], separator: " | " } } });
    assert.equal(text(pi.row()), "est. $0.00 | Fixture Model | orders-api | main");
});

test("a part another plugin sends before the session starts is still shown, and one sent later redraws the footer", async (t) => {
    const { pi } = rig(t);
    pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $120 / $200", tone: "warning" });
    await pi.fire("session_start", { reason: "startup" });
    assert.ok(pi.row().includes("<warning>Oct $120 / $200</>"));
    const before = pi.renders;
    pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $130 / $200", tone: "error" });
    assert.equal(pi.renders, before + 1);
    assert.ok(pi.row().includes("<error>Oct $130 / $200</>"));
    pi.events.emit("jig-theme:segment", { id: "spend", label: "Oct $130 / $200", tone: "error" });
    assert.equal(pi.renders, before + 1, "an event that changes nothing does not redraw");
    pi.events.emit("jig-theme:segment", { id: "spend", label: "" });
    assert.ok(!pi.row().includes("Oct"));
    pi.events.emit("jig-theme:segment", "garbage");
    pi.events.emit("jig-theme:segment", null);
    assert.equal(pi.renders, before + 2);
});

test("what the footer shows changes with these events, and each asks for a redraw", async (t) => {
    const { pi } = await started(t);
    for (const event of ["message_end", "thinking_level_select", "agent_settled", "session_compact", "session_tree", "model_select"]) {
        const before = pi.renders;
        await pi.fire(event);
        assert.equal(pi.renders, before + 1, event);
    }
});

test("starting again, as /new does, replaces the footer and does not leave the old one running", async (t) => {
    const { pi } = await started(t);
    await pi.fire("session_start", { reason: "new" });
    assert.equal(pi.footers.length, 2);
    assert.equal(pi.disposed, 1);
});

test("a session ending stops the footer's branch watch and clock, and stops listening, and a late event is harmless", async (t) => {
    const { pi } = await started(t, { settings: { footer: { segments: ["model", "branch"] } } });
    assert.equal(pi.branchListeners.size, 1);
    await pi.fire("session_shutdown", { reason: "quit" });
    assert.equal(pi.branchListeners.size, 0);
    assert.deepEqual(pi.listeners.get("jig-theme:segment"), []);
    assert.doesNotThrow(() => pi.events.emit("jig-theme:segment", { id: "late", label: "x" }));
    const before = pi.renders;
    await pi.fire("message_end");
    assert.equal(pi.renders, before);
});

test("theme() makes a factory with the parts a test replaces", () => {
    assert.equal(typeof theme({}), "function");
});
