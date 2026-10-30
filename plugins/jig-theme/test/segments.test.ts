// The parts other plugins add: what is accepted, how it is cleaned, and the limits that keep the footer one row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LABEL_CELLS, MAX_PLUGIN_SEGMENTS, PluginSegments, SEGMENT_EVENT, toneRole } from "../src/segments.ts";
import { cellWidth } from "../src/width.ts";

const ids = (parts: PluginSegments) => parts.list().map((part) => part.id);

test("the event is named as the README says", () => {
    assert.equal(SEGMENT_EVENT, "jig-theme:segment");
});

test("a part has an id, a label, a tone and an order, and the tone and order have defaults", () => {
    const parts = new PluginSegments();
    assert.equal(parts.accept({ id: "spend", label: "Oct $120 / $200" }), true);
    assert.deepEqual(parts.list(), [{ id: "spend", label: "Oct $120 / $200", tone: "normal", order: 0 }]);
    parts.accept({ id: "spend", label: "Oct $130 / $200", tone: "warning", order: 5 });
    assert.deepEqual(parts.list(), [{ id: "spend", label: "Oct $130 / $200", tone: "warning", order: 5 }]);
});

test("an unknown tone is normal, and an order that is not a number is 0", () => {
    const parts = new PluginSegments();
    parts.accept({ id: "a", label: "x", tone: "purple", order: "first" });
    parts.accept({ id: "b", label: "x", order: Number.NaN });
    parts.accept({ id: "c", label: "x", order: Number.POSITIVE_INFINITY });
    assert.deepEqual(
        parts.list().map((part) => [part.tone, part.order]),
        [
            ["normal", 0],
            ["normal", 0],
            ["normal", 0],
        ],
    );
});

test("parts are listed by order, then by id", () => {
    const parts = new PluginSegments();
    for (const [id, order] of [
        ["b", 1],
        ["a", 1],
        ["z", -1],
        ["c", 0],
    ] as const)
        parts.accept({ id, label: id, order });
    assert.deepEqual(ids(parts), ["z", "c", "a", "b"]);
});

test("an empty or missing label removes the part", () => {
    const parts = new PluginSegments();
    parts.accept({ id: "a", label: "one" });
    parts.accept({ id: "b", label: "two" });
    assert.equal(parts.accept({ id: "a", label: "" }), true);
    assert.deepEqual(ids(parts), ["b"]);
    assert.equal(parts.accept({ id: "b" }), true);
    assert.deepEqual(ids(parts), []);
    parts.accept({ id: "c", label: "three" });
    assert.equal(parts.accept({ id: "c", label: null }), true);
    parts.accept({ id: "d", label: "four" });
    assert.equal(
        parts.accept({ id: "d", label: "\u001b[31m\u0007 \t" }),
        true,
        "a label that is nothing once cleaned is empty",
    );
    assert.deepEqual(ids(parts), []);
    assert.equal(parts.accept({ id: "never-there", label: "" }), false, "removing what is not there changes nothing");
});

test("what is not an event of the right shape is ignored, and the parts stay", () => {
    const parts = new PluginSegments();
    parts.accept({ id: "keep", label: "kept" });
    for (const payload of [
        undefined,
        null,
        "spend",
        5,
        [],
        {},
        { label: "no id" },
        { id: 5, label: "x" },
        { id: "", label: "x" },
        { id: "has space", label: "x" },
        { id: "-lead", label: "x" },
        { id: "x".repeat(41), label: "x" },
        { id: "keep", label: 42 },
        { id: "keep", label: {} },
    ]) {
        assert.equal(parts.accept(payload), false, JSON.stringify(payload));
    }
    assert.deepEqual(parts.list(), [{ id: "keep", label: "kept", tone: "normal", order: 0 }]);
});

test("a label is plain text: escapes, control characters and bidirectional controls are gone", () => {
    const parts = new PluginSegments();
    parts.accept({ id: "a", label: "\u001b]52;c;evil\u0007ok\u001b[31m red\u0000\n‮" });
    assert.equal(parts.list()[0]?.label, "ok red");
});

test("a label is cut to 40 cells, counting wide characters twice", () => {
    const parts = new PluginSegments();
    parts.accept({ id: "a", label: "x".repeat(100) });
    assert.equal(cellWidth(parts.list()[0]?.label ?? ""), MAX_LABEL_CELLS);
    assert.ok(parts.list()[0]?.label.endsWith("…"));
    parts.accept({ id: "b", label: "日".repeat(30) });
    assert.ok(cellWidth(parts.list()[1]?.label ?? "") <= MAX_LABEL_CELLS);
    parts.accept({ id: "c", label: "x".repeat(MAX_LABEL_CELLS) });
    assert.equal(parts.list()[2]?.label, "x".repeat(MAX_LABEL_CELLS), "a label of exactly 40 cells is whole");
});

test("at most twelve parts: a new id beyond that is ignored, an existing one can change, and room comes back on removal", () => {
    const parts = new PluginSegments();
    for (let index = 0; index < MAX_PLUGIN_SEGMENTS; index++)
        assert.equal(parts.accept({ id: `p${index}`, label: "x" }), true);
    assert.equal(parts.accept({ id: "one-more", label: "x" }), false);
    assert.equal(parts.list().length, 12);
    assert.equal(parts.accept({ id: "p3", label: "changed" }), true);
    assert.equal(parts.accept({ id: "p3", label: "" }), true);
    assert.equal(parts.accept({ id: "one-more", label: "x" }), true);
    assert.equal(parts.list().length, 12);
});

test("an event that changes nothing says so, so the footer is not drawn again for it", () => {
    const parts = new PluginSegments();
    assert.equal(parts.accept({ id: "a", label: "x", tone: "error", order: 2 }), true);
    assert.equal(parts.accept({ id: "a", label: "x", tone: "error", order: 2 }), false);
    assert.equal(parts.accept({ id: "a", label: "x", tone: "muted", order: 2 }), true);
});

test("clear forgets every part", () => {
    const parts = new PluginSegments();
    parts.accept({ id: "a", label: "x" });
    parts.clear();
    assert.deepEqual(parts.list(), []);
});

test("each tone is a Pi text role, and normal is the colour the footer sets for plugin parts", () => {
    assert.equal(toneRole("normal", "mdLink"), "mdLink");
    assert.deepEqual(
        (["muted", "accent", "success", "warning", "error"] as const).map((tone) => toneRole(tone, "text")),
        ["muted", "accent", "success", "warning", "error"],
    );
});
