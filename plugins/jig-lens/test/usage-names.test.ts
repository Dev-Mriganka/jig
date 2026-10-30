// Names for the models in the usage view, from the event another plugin sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelNames, MAX_MODEL_NAMES, MODEL_NAMES_EVENT } from "../src/usage-names.ts";

test("the event is named as the README says", () => {
    assert.equal(MODEL_NAMES_EVENT, "jig-lens:model-names");
});

test("a recorded id shows as the name sent for it, with the provider when one is sent", () => {
    const { learn, names } = createModelNames();
    learn({
        models: [
            { recorded: "m-2f9c", name: "Claude Sonnet", provider: "anthropic" },
            { recorded: "m-77", name: "Small" },
        ],
    });
    assert.deepEqual(names("some-provider", "m-2f9c"), { provider: "anthropic", model: "Claude Sonnet" });
    assert.deepEqual(
        names("some-provider", "m-77"),
        { provider: "some-provider", model: "Small" },
        "without a provider, the recorded one stays",
    );
});

test("only an exact match is renamed; everything else is shown as recorded", () => {
    const { learn, names } = createModelNames();
    learn({ models: [{ recorded: "m-1", name: "One" }] });
    for (const recorded of ["M-1", "m-1 ", "m-", "m-10", "", "constructor", "__proto__"])
        assert.equal(names("p", recorded), undefined, JSON.stringify(recorded));
});

test("events add to what is known, and a later one renames", () => {
    const book = createModelNames();
    const { learn, names } = book;
    learn({ models: [{ recorded: "a", name: "one" }] });
    learn({ models: [{ recorded: "b", name: "two" }] });
    assert.equal(names("p", "a")?.model, "one");
    assert.equal(names("p", "b")?.model, "two");
    learn({ models: [{ recorded: "a", name: "renamed" }] });
    assert.equal(names("p", "a")?.model, "renamed");
    assert.equal(book.size, 2);
});

test("a payload that is malformed changes nothing, and the good entries around a bad one are kept", () => {
    const book = createModelNames();
    const { learn, names } = book;
    learn(undefined);
    learn(null);
    learn("models");
    learn({});
    learn({ models: "no" });
    learn({
        models: [
            null,
            "text",
            5,
            {},
            { recorded: 5, name: "n" },
            { recorded: "r", name: 5 },
            { recorded: "", name: "n" },
            { recorded: "r", name: "" },
            { recorded: "x".repeat(600), name: "n" },
            { recorded: "r", name: "\u0007 " },
        ],
    });
    assert.equal(book.size, 0);
    learn({ models: [null, { recorded: "ok", name: "Fine" }, 3] });
    assert.equal(names("p", "ok")?.model, "Fine");
});

test("a name is one line of plain text, cut to 80 characters, and a provider to 60", () => {
    const { learn, names } = createModelNames();
    learn({
        models: [{ recorded: "m", name: `a\u001b[31mb\nc${"x".repeat(200)}`, provider: `p\u0000${"y".repeat(100)}` }],
    });
    const shown = names("p", "m");
    assert.ok(shown);
    assert.doesNotMatch(`${shown.model}${shown.provider}`, /[\u0000-\u001f]/);
    assert.equal(shown.model.length, 80);
    assert.equal(shown.provider.length, 60);
});

test("at most 4096 names are kept: a new one past that is ignored, and a known one can still change", () => {
    const book = createModelNames();
    const { learn, names } = book;
    learn({
        models: Array.from({ length: MAX_MODEL_NAMES + 10 }, (_, index) => ({
            recorded: `m${index}`,
            name: `n${index}`,
        })),
    });
    assert.equal(book.size, MAX_MODEL_NAMES);
    assert.equal(names("p", "m0")?.model, "n0");
    assert.equal(names("p", `m${MAX_MODEL_NAMES}`), undefined);
    learn({
        models: [
            { recorded: "m0", name: "changed" },
            { recorded: "late", name: "late" },
        ],
    });
    assert.equal(names("p", "m0")?.model, "changed");
    assert.equal(names("p", "late"), undefined);
    assert.equal(book.size, MAX_MODEL_NAMES);
});
