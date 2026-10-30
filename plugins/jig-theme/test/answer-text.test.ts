import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { colourAnswers, installAnswerText, uninstallAnswerText } from "../src/answer-text.ts";

const theme = {
    heading: (t: string) => t,
    link: (t: string) => t,
    linkUrl: (t: string) => t,
    code: (t: string) => t,
    codeBlock: (t: string) => t,
    codeBlockBorder: (t: string) => t,
    quote: (t: string) => t,
    quoteBorder: (t: string) => t,
    hr: (t: string) => t,
    listBullet: (t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
} as never;
const WHITE = (text: string) => `<w>${text}</w>`;

test("answer blocks get the colour; thinking blocks keep their own style", () => {
    const answer = new Markdown("The answer", 1, 0, theme);
    const thinking = new Markdown("Thinking", 1, 0, theme, { color: (t: string) => `<dim>${t}</dim>`, italic: true });
    const component = { contentContainer: { children: [thinking, answer, { notMarkdown: true }] } };
    assert.equal(colourAnswers(component, WHITE), 1);
    assert.ok(answer.render(40).join("").includes("<w>"), "the answer is painted");
    assert.ok(!thinking.render(40).join("").includes("<w>"), "thinking keeps its own colour");
    assert.equal(colourAnswers(component, WHITE), 0, "already-styled blocks are left alone");
    assert.equal(colourAnswers({}, WHITE), 0);
    assert.equal(colourAnswers(undefined, WHITE), 0);
    assert.equal(colourAnswers(component, undefined), 0);
});

test("the patch wraps Pi's assistant message once and follows the current painter", () => {
    assert.equal(
        installAnswerText(() => WHITE),
        true,
    );
    const update = (AssistantMessageComponent.prototype as { updateContent: unknown }).updateContent;
    assert.equal(
        installAnswerText(() => WHITE),
        true,
    );
    assert.equal(
        (AssistantMessageComponent.prototype as { updateContent: unknown }).updateContent,
        update,
        "patched only once",
    );
    uninstallAnswerText();
});

test("a patched update colours an answer through the painter that is current, and nothing once it is removed", () => {
    const proto = AssistantMessageComponent.prototype as unknown as { updateContent: (...args: unknown[]) => unknown };
    const original = proto.updateContent;
    try {
        // A stand-in for Pi's own update, under the patch: it builds one answer block, as Pi does.
        const block = new Markdown("The answer", 1, 0, theme);
        const fake = { contentContainer: { children: [block] } };
        proto.updateContent = () => "updated";
        // The patch is installed over whatever updateContent is now, once; remove its mark so this test installs over the stand-in.
        delete (proto as unknown as Record<symbol, unknown>)[Symbol.for("jig-theme.answer-text.patched")];
        let paint: ((text: string) => string) | undefined = (text) => `<one>${text}</one>`;
        installAnswerText(() => paint);
        assert.equal(proto.updateContent.call(fake), "updated", "the result of Pi's own update is returned");
        assert.ok(block.render(40).join("").includes("<one>"));
        uninstallAnswerText();
        const other = new Markdown("Another", 1, 0, theme);
        proto.updateContent.call({ contentContainer: { children: [other] } });
        assert.ok(!other.render(40).join("").includes("<"), "with no painter, nothing changes");
        paint = (text) => `<two>${text}</two>`;
        installAnswerText(() => paint);
        const third = new Markdown("Third", 1, 0, theme);
        proto.updateContent.call({ contentContainer: { children: [third] } });
        assert.ok(third.render(40).join("").includes("<two>"));
    } finally {
        uninstallAnswerText();
        proto.updateContent = original;
        delete (proto as unknown as Record<symbol, unknown>)[Symbol.for("jig-theme.answer-text.patched")];
    }
});

test("a painter that throws never breaks the message", () => {
    const proto = AssistantMessageComponent.prototype as unknown as { updateContent: (...args: unknown[]) => unknown };
    const original = proto.updateContent;
    try {
        proto.updateContent = () => "ok";
        delete (proto as unknown as Record<symbol, unknown>)[Symbol.for("jig-theme.answer-text.patched")];
        installAnswerText(() => {
            throw new Error("boom");
        });
        assert.equal(proto.updateContent.call({}), "ok");
    } finally {
        uninstallAnswerText();
        proto.updateContent = original;
        delete (proto as unknown as Record<symbol, unknown>)[Symbol.for("jig-theme.answer-text.patched")];
    }
});
