// `/lens usage` as a command in a session: it opens the view over Pi's session files, needs a terminal, takes no arguments,
// shows the names other plugins send, and does nothing else (no import, no viewer, no entry in the session).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NOW, rig, writeSample } from "./support.ts";

process.env.TZ = "UTC";

const session = (state: string, lines: unknown[]) => {
    const folder = path.join(state, "pi-sessions", "project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "s.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
};
const reply = (id: string, model: string, input: number, cost: number) => ({
    type: "message",
    id,
    timestamp: NOW.toISOString(),
    message: {
        role: "assistant",
        timestamp: +NOW,
        provider: "gateway",
        model,
        usage: { input, cost: { total: cost } },
    },
});
const until = async (check: () => boolean) => {
    for (let index = 0; index < 300 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check(), "timed out");
};

test("/lens usage opens the view over Pi's session files, and starts and shows nothing else", async (t) => {
    const r = rig(t, { session: "s1" });
    session(r.state, [reply("a", "model-a", 100, 0.05)]);
    const running = r.pi.lens("usage");
    // The view is loaded when the command runs, so it opens a moment later.
    await until(() => r.pi.customs.length === 1);
    const view = r.pi.customs[0]?.component;
    await until(() => (view?.render(100) ?? []).join("\n").includes("100 tokens"));
    assert.match((view?.render(100) ?? []).join("\n"), /100 tokens · est\. \$0\.05/);
    view?.handleInput("q");
    assert.deepEqual(await running, []);
    assert.deepEqual([r.spawned, r.opened, r.probes], [[], [], []], "no viewer is started");
    assert.deepEqual([r.pi.entries, r.pi.sent], [[], []], "nothing goes into the session");
});

test("the view reads Pi's own session files and not Jig's records, and does not import them", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    session(r.state, [reply("a", "model-a", 100, 0.05)]);
    const running = r.pi.lens("usage");
    await until(() => r.pi.customs.length === 1);
    const view = r.pi.customs[0]?.component;
    await until(() => (view?.render(100) ?? []).join("\n").includes("100 tokens"));
    assert.match(
        (view?.render(100) ?? []).join("\n"),
        /^100 tokens · est\. \$0\.05$/m,
        "only the session file's usage",
    );
    view?.handleInput("q");
    await running;
    assert.equal(r.pi.entries.length, 0);
});

test("without a terminal it says so, and opens nothing", async (t) => {
    for (const mode of ["rpc", "json", "print"] as const) {
        const r = rig(t, { mode });
        const notices = await r.pi.lens("usage");
        assert.deepEqual(
            notices,
            mode === "print" || mode === "json" ? [] : [{ level: "info", text: "/lens usage needs the terminal." }],
            mode,
        );
        assert.equal(r.pi.customs.length, 0, mode);
    }
});

test("it takes no arguments: more words are the usage line, and do nothing", async (t) => {
    const r = rig(t);
    const notices = await r.pi.lens("usage week");
    assert.deepEqual(notices, [
        {
            level: "warning",
            text: "/lens usage takes no arguments.\nUsage: /lens [ticket KEY | session [id] | days N | usage | grafana | datasette | rebuild | status]",
        },
    ]);
    assert.equal(r.pi.customs.length, 0);
});

test("names sent on the event bus are shown, also when they were sent before the command ran", async (t) => {
    const r = rig(t, { session: "s1" });
    session(r.state, [reply("a", "m-2f9c", 100, 0.05), reply("b", "m-other", 7, 0.01)]);
    r.pi.events.emit("jig-lens:model-names", {
        models: [{ recorded: "m-2f9c", name: "Claude Sonnet", provider: "anthropic" }],
    });
    r.pi.events.emit("jig-lens:model-names", "garbage");
    const running = r.pi.lens("usage");
    await until(() => r.pi.customs.length === 1);
    const view = r.pi.customs[0]?.component;
    await until(() => (view?.render(100) ?? []).join("\n").includes("107 tokens"));
    view?.handleInput("v");
    const table = (view?.render(100) ?? []).join("\n");
    assert.match(table, /anthropic \/ Claude Sonnet\s+\$0\.05/);
    assert.match(table, /gateway \/ m-other\s+\$0\.01/);
    assert.doesNotMatch(table, /m-2f9c/);
    view?.handleInput("q");
    await running;
});

test("a second /lens usage closes the first view before it opens its own", async (t) => {
    const r = rig(t, { session: "s1" });
    session(r.state, [reply("a", "model-a", 100, 0.05)]);
    const first = r.pi.lens("usage");
    await until(() => r.pi.customs.length === 1);
    const second = r.pi.lens("usage");
    // The first view is told to close by its signal; the second is the one left to close with a key.
    await first;
    await until(() => r.pi.customs.length === 2);
    r.pi.customs[1]?.component.handleInput("q");
    await second;
    assert.equal(r.pi.customs.length, 2);
});

test("the view is not loaded by a session that never runs /lens usage", async (t) => {
    const r = rig(t, { session: "s1" });
    await r.pi.lens("status");
    assert.equal(r.pi.customs.length, 0);
});
