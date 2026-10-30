// How the summary reaches the user: as a session entry in a terminal, as a short notification over RPC, and not at all
// when there is no screen. And that the model never receives it, which is checked against everything the plugin can
// send to Pi, so a new way of sending would have to be added to the fake to go unnoticed.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ENTRY, registerDisplay } from "../src/display.ts";
import type { SummaryEntry } from "../src/display.ts";
import { summaryFor } from "../src/scopes.ts";
import { plain, short } from "../src/summary.ts";
import { FakePi, NOW, rig, sampleDb, writeSample } from "./support.ts";

// "Today" is the user's day. These tests are written for a clock on UTC.
process.env.TZ = "UTC";

/** A theme that writes down what it was asked to do, as markers in the text. */
const marking = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
    bg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => `<b>${text}</b>`,
};

/** A theme that dresses text in terminal colours, as Pi's does: the codes are in the string and take no width. */
const ansi = {
    fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`,
    bg: (_color: string, text: string) => `\u001b[44m${text}\u001b[49m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

/** No colours at all, so the text is the text. */
const bare = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
};

type Draw = (entry: unknown, options: unknown, theme: unknown) => Component | undefined;

function renderer(pi: FakePi): Draw {
    const draw = pi.renderers.get(ENTRY);
    assert.ok(draw, "the plugin registered a renderer for its entry");
    return draw as Draw;
}

const entryOf = (pi: FakePi): SummaryEntry => {
    assert.equal(pi.entries.length, 1, "one entry");
    assert.equal(pi.entries[0]?.type, ENTRY);
    return pi.entries[0]?.data as SummaryEntry;
};

// ---- with a terminal ------------------------------------------------------------------------------------------------

test("in a terminal the summary is one session entry, drawn by the plugin's renderer", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    const notices = await r.pi.lens("");
    assert.deepEqual(notices, [], "nothing is said in a status line");
    const data = entryOf(r.pi);
    assert.deepEqual(
        data.blocks.map((block) => block.title),
        ["Today, 2026-10-30", "This session", "Ticket T-1, all time"],
    );
    assert.match(plain(data.blocks), /Cost {7}\$0\.07 over 1 turn/);
});

test("the model never receives the summary: nothing the plugin does reaches the conversation", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    for (const args of [
        "",
        "ticket T-1",
        "session",
        "session s2",
        "days 7",
        "days 1",
        "status",
        "rebuild",
        "ticket nope",
    ]) {
        await r.pi.lens(args);
    }
    // `sent` collects pi.sendMessage and pi.sendUserMessage, the only calls that put text in the conversation. The
    // entries are session entries, which Pi's types say "do not participate in LLM context".
    assert.deepEqual(r.pi.sent, []);
    assert.ok(r.pi.entries.length >= 5, "and the summaries did go to the screen");
    assert.deepEqual([...r.pi.handlers.keys()], ["agent_end"], "no hook that could add to a prompt or to the context");
});

test("what the plugin keeps in the session is plain data that comes back the same from a session file", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    await r.pi.lens("");
    const data = entryOf(r.pi);
    const fromFile = JSON.parse(JSON.stringify(data)) as SummaryEntry;
    assert.deepEqual(fromFile, data);
    const draw = renderer(r.pi);
    const lines = (entry: SummaryEntry) => draw({ data: entry }, { expanded: false }, bare)?.render(100);
    assert.deepEqual(lines(fromFile), lines(data));
});

test("a summary can be asked for again and again: each is its own entry", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    await r.pi.lens("days 7");
    await r.pi.lens("days 7");
    assert.equal(r.pi.entries.length, 2);
    assert.deepEqual(r.pi.entries[0], r.pi.entries[1]);
});

// ---- the entry renderer ---------------------------------------------------------------------------------------------

test("the renderer draws the blocks with the colours of the theme it is given", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    await r.pi.lens("session s3");
    const component = renderer(r.pi)({ data: entryOf(r.pi) }, { expanded: false }, marking);
    assert.ok(component);
    const text = component.render(120).join("\n");
    assert.match(text, /<b><accent>Session s3<\/><\/b>/, "the title in the accent colour, bold");
    assert.match(text, /<b>Cost {5}<\/b> {2}\$0\.03 over 1 turn/, "the section names in bold");
    assert.match(text, /\[customMessageBg\]/, "on the background Pi gives custom messages");
});

test("a note under a title is dim", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    await r.pi.lens("ticket T-9");
    const text =
        renderer(r.pi)({ data: entryOf(r.pi) }, { expanded: false }, marking)
            ?.render(120)
            .join("\n") ?? "";
    assert.match(text, /<b><accent>Ticket T-9, all time<\/><\/b><dim>: no records<\/>/);
});

test("no line of the entry is wider than the terminal, however narrow: a line too wide would stop Pi", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    await r.pi.lens("");
    const draw = renderer(r.pi);
    for (const width of [200, 100, 80, 60, 40, 20, 10]) {
        const lines = draw({ data: entryOf(r.pi) }, { expanded: false }, ansi)?.render(width) ?? [];
        assert.ok(lines.length > 10, `width ${width}`);
        for (const line of lines)
            assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} in ${line}`);
    }
});

test("at 100 columns the columns line up as they were made: nothing wraps", async (t) => {
    const r = rig(t, { session: "s1" });
    writeSample(r.state);
    await r.pi.lens("days 7");
    const data = entryOf(r.pi);
    const lines = renderer(r.pi)({ data }, { expanded: false }, bare)?.render(100) ?? [];
    // The box adds a blank line and a margin on each side, and the text is the summary as it is.
    const text = lines.map((line) => line.trimEnd()).filter((line) => line !== "");
    assert.deepEqual(
        text.map((line) => line.slice(1)),
        plain(data.blocks)
            .split("\n")
            .filter((line) => line !== ""),
    );
});

test("an entry that holds something else is not drawn, and does not throw", (t) => {
    const r = rig(t);
    const draw = renderer(r.pi);
    const garbage: unknown[] = [
        undefined,
        {},
        { data: undefined },
        { data: null },
        { data: {} },
        { data: { blocks: "text" } },
        { data: { blocks: [null] } },
        { data: { blocks: [{ title: 3, sections: [] }] } },
        { data: { blocks: [{ title: "x", sections: "none" }] } },
        { data: { blocks: [{ title: "x", sections: [{ name: "Cost", lines: [1] }] }] } },
        { data: { blocks: [{ title: "x", sections: [], empty: 5 }] } },
    ];
    for (const entry of garbage)
        assert.equal(draw(entry ?? {}, { expanded: false }, bare), undefined, JSON.stringify(entry));
});

test("an entry from a session file that carries terminal escapes is drawn without them", (t) => {
    const r = rig(t);
    const hostile = {
        blocks: [
            {
                title: "Today\u001b[2J",
                empty: "no\u001b]0;pwned\u0007",
                sections: [],
            },
            { title: "Next", sections: [{ name: "Co\u001bst", lines: ["a\u001b[31mred", "b\u009bc"] }] },
        ],
    };
    const text = renderer(r.pi)({ data: hostile }, { expanded: false }, bare)?.render(100).join("\n") ?? "";
    assert.match(text, /Today\?\[2J: no\?\]0;pwned\?/);
    assert.match(text, /Co\?st {2,}a\?\[31mred/);
    assert.doesNotMatch(text, /[\u001b\u0007\u009b]/);
});

test("registering the renderer needs nothing from the session", () => {
    const pi = new FakePi();
    registerDisplay(pi.api);
    assert.deepEqual([...pi.renderers.keys()], [ENTRY]);
    assert.deepEqual([pi.entries, pi.notices, pi.sent], [[], [], []]);
});

// ---- over RPC -------------------------------------------------------------------------------------------------------

test("over RPC there is no transcript to draw in, so the shortened summary is a notification", async (t) => {
    const r = rig(t, { mode: "rpc", session: "s1" });
    writeSample(r.state);
    const notices = await r.pi.lens("");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "info");
    assert.equal(notices[0]?.text, short(summaryFor({ kind: "summary" }, await sampleDb(t), NOW, "s1")));
    assert.deepEqual(r.pi.entries, [], "no entry: an RPC client cannot draw it");
    assert.deepEqual(r.pi.sent, []);
});

test("the shortened summary has each section's first line, under the title of each scope", async (t) => {
    const r = rig(t, { mode: "rpc", session: "s2" });
    writeSample(r.state);
    const [notice] = await r.pi.lens("ticket T-1");
    assert.equal(
        notice?.text,
        [
            "Ticket T-1, all time",
            "  Cost       $0.35 over 3 turns, 22.5k tokens in (84% read from cache), 600 out",
            "  Tools      8 calls, 1 failed, 1 blocked",
            "  Your time  2 questions: 1 allowed, 1 allowed for the session",
            "  Blocked    1 call",
        ].join("\n"),
    );
});

test("over RPC an empty index is told in a line", async (t) => {
    const r = rig(t, { mode: "rpc" });
    const [notice] = await r.pi.lens("");
    assert.equal(notice?.text, "No records yet. jig-core writes them as tools run and model turns end.");
});

// ---- with no screen -------------------------------------------------------------------------------------------------

test("in print and JSON mode it returns quietly: nothing shown, nothing sent, nothing started", async (t) => {
    for (const mode of ["print", "json"] as const) {
        const r = rig(t, { mode, session: "s1" });
        writeSample(r.state);
        for (const args of ["", "ticket T-1", "session", "days 7", "bogus", "ticket"]) {
            assert.deepEqual(await r.pi.lens(args), [], `${mode} ${args}`);
        }
        assert.deepEqual([r.pi.entries, r.pi.sent, r.spawned, r.opened], [[], [], [], []], mode);
        assert.equal(
            existsSync(r.where.index),
            false,
            `${mode}: not even the import ran, which the end of each run does`,
        );
    }
});

test("the end of a run still imports in print mode", async (t) => {
    const r = rig(t, { mode: "print" });
    writeSample(r.state);
    await r.pi.fire("agent_end");
    assert.equal(existsSync(r.where.index), true);
});
