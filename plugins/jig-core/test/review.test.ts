// The review screen: what it shows, the keys that answer, and scrolling.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Preview } from "../src/contract.ts";
import { createReviewScreen } from "../src/review.ts";
import type { Answer } from "../src/records.ts";
import { fakeTerminal } from "./support/fakes.ts";

const ESC = "\u001b";
const keys = {
    up: `${ESC}[A`,
    down: `${ESC}[B`,
    pageUp: `${ESC}[5~`,
    pageDown: `${ESC}[6~`,
    home: `${ESC}[H`,
    end: `${ESC}[F`,
    escape: ESC,
    ctrlC: "\u0003",
};

/** A review screen with a plain theme, and what it did. */
function screen(preview: Preview, options: { rows?: number; open?: () => Promise<string> } = {}) {
    const answers: Answer[] = [];
    const terminal = fakeTerminal(options.rows ?? 24);
    const component = createReviewScreen(
        {
            header: "git · push · external · write",
            preview,
            openInBrowser: options.open ?? (async () => "opened in the browser"),
        },
        terminal.tui as never,
        terminal.theme as never,
        (answer) => answers.push(answer),
    );
    return { component, answers, rendered: terminal.rendered };
}

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `body line ${index + 1}`).join("\n");

describe("what it shows", () => {
    test("the question, the header, the summary, the body and the keys", () => {
        const { component } = screen({ summary: "Push 2 commits to origin/main", body: "first\nsecond" });
        const text = component.render(100).join("\n");
        assert.match(text, /Approve this call\?/);
        assert.match(text, /git · push · external · write/);
        assert.match(text, /Push 2 commits to origin\/main/);
        assert.match(text, /first\n.*second/);
        for (const key of ["y allow", "s allow for this session", "n/Esc decline", "o open in browser"])
            assert.ok(text.includes(key), key);
    });

    test("a preview with no body says there is no more detail", () => {
        assert.match(screen({ summary: "Just this" }).component.render(80).join("\n"), /\(no further detail\)/);
    });

    test("no line is wider than the screen, however long the text or narrow the screen", () => {
        const body = `${"word ".repeat(200)}\n${"x".repeat(500)}\n日本語のテキスト`.repeat(3);
        for (const width of [20, 40, 80, 200]) {
            const { component } = screen({ summary: "A long summary ".repeat(30), body });
            for (const line of component.render(width))
                assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)}`);
        }
    });

    test("the whole screen fits in the terminal", () => {
        for (const rows of [10, 24, 50]) {
            const { component } = screen({ summary: "s", body: numbered(500) }, { rows });
            assert.ok(component.render(80).length <= rows - 1, `${rows}: ${component.render(80).length}`);
        }
    });
});

describe("answering", () => {
    for (const [name, key, answer] of [
        ["y allows", "y", "allow"],
        ["s allows for the session", "s", "allow-session"],
        ["n declines", "n", "decline"],
        ["Esc declines", keys.escape, "decline"],
        ["Ctrl+C declines", keys.ctrlC, "decline"],
    ] as const) {
        test(name, () => {
            const { component, answers } = screen({ summary: "s", body: "b" });
            component.render(80);
            component.handleInput?.(key);
            assert.deepEqual(answers, [answer]);
        });
    }

    test("only the first answer counts", () => {
        const { component, answers } = screen({ summary: "s" });
        component.handleInput?.("y");
        component.handleInput?.("n");
        component.handleInput?.("s");
        assert.deepEqual(answers, ["allow"]);
    });

    test("other keys answer nothing", () => {
        const { component, answers } = screen({ summary: "s" });
        for (const key of ["a", "x", "\r", " ", "q", "z"]) component.handleInput?.(key);
        assert.deepEqual(answers, []);
    });
});

describe("opening the browser", () => {
    test("o opens the rendered preview, shows how it went, and does not answer", async () => {
        const opened: string[] = [];
        const { component, answers, rendered } = screen(
            { summary: "s", body: "b" },
            {
                open: async () => {
                    opened.push("yes");
                    return "opened in the browser";
                },
            },
        );
        component.render(80);
        component.handleInput?.("o");
        assert.match(component.render(80).join("\n"), /opening the preview in the browser/);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(opened, ["yes"]);
        assert.match(component.render(80).join("\n"), /opened in the browser/);
        assert.deepEqual(answers, [], "the browser never answers");
        assert.ok(rendered.count >= 2, "the screen asked to be drawn again");
    });

    test("a page that cannot even be written is a failure too, not an unhandled error", async () => {
        const { component, answers } = screen(
            { summary: "s" },
            {
                open: async () => {
                    throw new Error("no space left on device");
                },
            },
        );
        component.handleInput?.("o");
        await new Promise((resolve) => setImmediate(resolve));
        assert.match(component.render(80).join("\n"), /could not open the browser: no space left on device/);
        assert.deepEqual(answers, []);
    });

    test("a failure is shown, and the question stays open", async () => {
        const { component, answers } = screen(
            { summary: "s" },
            { open: async () => "could not open the browser: nothing to open it with" },
        );
        component.handleInput?.("o");
        await new Promise((resolve) => setImmediate(resolve));
        assert.match(component.render(80).join("\n"), /could not open the browser/);
        assert.deepEqual(answers, []);
        component.handleInput?.("y");
        assert.deepEqual(answers, ["allow"]);
    });
});

describe("scrolling", () => {
    const bodyLines = (component: { render(width: number): string[] }) =>
        component
            .render(80)
            .filter((line) => /body line \d+/.test(line))
            .map((line) => Number(/body line (\d+)/.exec(line)?.[1]));

    test("shows the start, and where the window is in a long body", () => {
        const { component } = screen({ summary: "s", body: numbered(100) }, { rows: 24 });
        const visible = bodyLines(component);
        assert.equal(visible[0], 1);
        assert.ok(visible.length >= 10 && visible.length < 24);
        assert.match(component.render(80).join("\n"), new RegExp(` 1-${visible.length} of 100 `));
    });

    test("the arrow keys move by a line", () => {
        const { component } = screen({ summary: "s", body: numbered(100) });
        component.render(80);
        component.handleInput?.(keys.down);
        component.handleInput?.(keys.down);
        assert.equal(bodyLines(component)[0], 3);
        component.handleInput?.(keys.up);
        assert.equal(bodyLines(component)[0], 2);
        component.handleInput?.("j");
        assert.equal(bodyLines(component)[0], 3);
        component.handleInput?.("k");
        assert.equal(bodyLines(component)[0], 2);
    });

    test("Page Down and Page Up move by a screen, Home and End jump", () => {
        const { component } = screen({ summary: "s", body: numbered(100) });
        component.render(80);
        const height = bodyLines(component).length;
        component.handleInput?.(keys.pageDown);
        assert.equal(bodyLines(component)[0], height);
        component.handleInput?.(keys.pageUp);
        assert.equal(bodyLines(component)[0], 1);
        component.handleInput?.(keys.end);
        const last = bodyLines(component);
        assert.equal(last[last.length - 1], 100);
        component.handleInput?.(keys.home);
        assert.equal(bodyLines(component)[0], 1);
    });

    test("cannot scroll past either end", () => {
        const { component } = screen({ summary: "s", body: numbered(100) });
        component.render(80);
        component.handleInput?.(keys.up);
        assert.equal(bodyLines(component)[0], 1);
        for (let i = 0; i < 30; i++) component.handleInput?.(keys.end);
        const last = bodyLines(component);
        assert.equal(last[last.length - 1], 100);
    });

    test("a short body does not scroll and shows no position", () => {
        const { component } = screen({ summary: "s", body: numbered(3) });
        component.render(80);
        component.handleInput?.(keys.down);
        assert.deepEqual(bodyLines(component), [1, 2, 3]);
        assert.ok(!/ of \d+ /.test(component.render(80).join("\n")));
    });

    test("scrolling asks to be drawn again", () => {
        const { component, rendered } = screen({ summary: "s", body: numbered(100) });
        component.render(80);
        const before = rendered.count;
        component.handleInput?.(keys.down);
        assert.equal(rendered.count, before + 1);
    });
});

describe("colour", () => {
    /** A theme that tags what it colours, so the test can see which colour a line got. */
    function tagged(preview: Preview) {
        const terminal = fakeTerminal(40);
        const theme = {
            fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
            bold: (text: string) => `<b>${text}</b>`,
        };
        return createReviewScreen(
            { header: "h", preview, openInBrowser: async () => "" },
            terminal.tui as never,
            theme as never,
            () => {},
        )
            .render(80)
            .join("\n");
    }

    test("a diff shows additions, removals and hunks in their own colours", () => {
        const text = tagged({
            summary: "s",
            format: "diff",
            body: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-gone\n+added\n same",
        });
        assert.match(text, /<error>-gone<\/error>/);
        assert.match(text, /<success>\+added<\/success>/);
        assert.match(text, /<accent>@@ -1 \+1 @@<\/accent>/);
        assert.match(text, /<muted>--- a\/x<\/muted>/);
        assert.match(text, / same/);
        assert.ok(!text.includes("<success> same"));
    });

    test("markdown headings are marked and code is dimmed", () => {
        const text = tagged({ summary: "s", format: "markdown", body: "# Heading\nplain\n```\ncode line\n```\nafter" });
        assert.match(text, /<b><accent># Heading<\/accent><\/b>/);
        assert.match(text, /<muted>code line<\/muted>/);
        assert.match(text, /\n plain/);
        assert.ok(!text.includes("<muted>after"));
    });
});
