// Reading a child's request without trusting it, and the words of the question the user sees.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRequest, questionTitle, shownOptions } from "../src/forward.ts";
import type { Askable } from "../src/forward.ts";

describe("parseRequest", () => {
    test("reads a selector, a confirmation and an input, with the child's own timeout", () => {
        assert.deepEqual(
            parseRequest({
                type: "extension_ui_request",
                id: "a",
                method: "select",
                title: "t",
                options: ["x", "y"],
                timeout: 5000,
            }),
            {
                kind: "select",
                id: "a",
                title: "t",
                options: ["x", "y"],
                timeout: 5000,
            },
        );
        assert.deepEqual(
            parseRequest({ type: "extension_ui_request", id: "b", method: "confirm", title: "t", message: "m" }),
            { kind: "confirm", id: "b", title: "t", message: "m" },
        );
        assert.deepEqual(
            parseRequest({ type: "extension_ui_request", id: "c", method: "input", title: "t", placeholder: "p" }),
            { kind: "input", id: "c", title: "t", placeholder: "p" },
        );
    });

    test("ignores what needs no answer, and what has no usable id", () => {
        for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
            assert.deepEqual(
                parseRequest({ type: "extension_ui_request", id: "a", method }),
                { kind: "ignore" },
                method,
            );
        }
        assert.deepEqual(parseRequest({ type: "extension_ui_request", method: "select", title: "t", options: ["x"] }), {
            kind: "ignore",
        });
        assert.deepEqual(parseRequest({ type: "extension_ui_request", id: "", method: "select" }), { kind: "ignore" });
        assert.deepEqual(parseRequest({ type: "extension_ui_request", id: 5, method: "select" }), { kind: "ignore" });
        assert.deepEqual(parseRequest({ type: "extension_ui_request", id: "x".repeat(201), method: "select" }), {
            kind: "ignore",
        });
    });

    test("cancels what it cannot read, by its id", () => {
        const cancel = (rest: Record<string, unknown>) =>
            parseRequest({ type: "extension_ui_request", id: "a", ...rest });
        assert.equal(cancel({ method: "select", title: "t", options: [] }).kind, "cancel");
        assert.equal(cancel({ method: "select", title: "t", options: ["a", "b", "c", "d", "e", "f"] }).kind, "cancel");
        assert.equal(cancel({ method: "select", title: "t", options: ["x".repeat(101)] }).kind, "cancel");
        assert.equal(cancel({ method: "select", title: "t", options: [""] }).kind, "cancel");
        assert.equal(cancel({ method: "select", title: "t", options: [1] }).kind, "cancel");
        assert.equal(cancel({ method: "select", title: "x".repeat(5000), options: ["a"] }).kind, "cancel");
        assert.equal(cancel({ method: "select", options: ["a"] }).kind, "cancel");
        assert.equal(cancel({ method: "editor", title: "t" }).kind, "cancel");
        assert.equal(cancel({ method: "unheard-of", title: "t" }).kind, "cancel");
        assert.equal(cancel({ title: "t" }).kind, "cancel");
        assert.deepEqual(
            cancel({ method: "select", title: "t", options: ["a"], timeout: -5 }),
            { kind: "select", id: "a", title: "t", options: ["a"] },
            "a bad timeout is dropped",
        );
    });
});

describe("the question", () => {
    test("is the plugin's line, then the child's words indented, and says how many wait behind", () => {
        const parsed: Askable = { kind: "select", id: "a", title: "one\ntwo", options: ["x"] };
        assert.equal(
            questionTitle({ name: "w-1", role: "worker" }, parsed, 0),
            'Subagent "w-1" (worker) asks. The text below comes from the child.\n  one\n  two',
        );
        assert.match(
            questionTitle({ name: "w-1", role: "worker" }, parsed, 2),
            /from the child\. \(2 more waiting\)\n/,
        );
    });

    test("a confirmation shows its message under its title", () => {
        const parsed: Askable = { kind: "confirm", id: "a", title: "Sure?", message: "It deletes." };
        assert.match(questionTitle({ name: "w", role: "r" }, parsed, 0), /\n {2}Sure\?\n {2}It deletes\.$/);
    });

    test("options pass through, the stock session answer is renamed, and two that look alike make the request unusable", () => {
        assert.deepEqual(shownOptions(["Allow", "Allow for this session", "Decline"]), [
            { shown: "Allow", original: "Allow" },
            { shown: "Allow for this subagent", original: "Allow for this session" },
            { shown: "Decline", original: "Decline" },
        ]);
        assert.equal(shownOptions(["Allow", "Allow"]), undefined);
        assert.equal(shownOptions(["Allow\u001b[1m", "Allow"]), undefined);
        assert.equal(shownOptions(["\u001b[1m"]), undefined, "an option that is nothing once cleaned");
        assert.equal(
            shownOptions(["Allow for this subagent", "Allow for this session"]),
            undefined,
            "a child cannot pass one off as the other",
        );
    });
});
