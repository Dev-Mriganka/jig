import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW_KEEP, NOW_LIMIT, notesTemplate, tidyNow } from "../src/notes.ts";

/** A ## Now block of `count` findings, each about 60 bytes, under a status line. */
function longNow(count: number): string {
    const findings = Array.from({ length: count }, (_, n) => `- finding ${n}: ${"x".repeat(45)}`);
    return `# ACME-1\n\n## Now\nStatus: root cause found\nNext: check the queue\nOpen questions:\n${findings.join("\n")}\n\n## Decisions\n- Use the queue.\n`;
}

test("the template starts with a ## Now block, then the decisions", () => {
    assert.equal(notesTemplate("ACME-1"), "# ACME-1\n\n## Now\nStatus: new\nNext:\nOpen questions:\n\n## Decisions\n");
});

test("a ## Now block within the limit is left alone", () => {
    assert.equal(tidyNow(notesTemplate("ACME-1"), "2026.md"), undefined);
});

test("over the limit, the top of the block stays, the rest moves, and a pointer names the history file", () => {
    const notes = longNow(40);
    assert.ok(Buffer.byteLength(notes.slice(notes.indexOf("## Now"), notes.indexOf("## Decisions"))) > NOW_LIMIT);
    const tidied = tidyNow(notes, "2026-10-30T10-15-00.123Z.md");
    assert.ok(tidied !== undefined);
    const block = tidied.notes.slice(tidied.notes.indexOf("## Now"), tidied.notes.indexOf("## Decisions"));
    assert.ok(Buffer.byteLength(block) < NOW_LIMIT, `${Buffer.byteLength(block)} bytes`);
    assert.match(block, /^## Now\nStatus: root cause found\nNext: check the queue\nOpen questions:\n- finding 0: /);
    assert.match(block, /\n\(older lines moved to history\/2026-10-30T10-15-00\.123Z\.md\)\n\n$/, "a blank line separates the block from the next heading");
    assert.match(tidied.notes, /\n\n## Decisions\n- Use the queue\.\n$/, "the decisions after the block are untouched");
    assert.match(tidied.moved, /^- finding \d+: /);
    assert.match(tidied.moved, /- finding 39: /, "the last finding moved");
    assert.doesNotMatch(tidied.notes, /- finding 39: /);
    assert.ok(Buffer.byteLength(block) <= NOW_KEEP + 200);
});

test("a second move replaces the pointer rather than adding one", () => {
    const once = tidyNow(longNow(40), "first.md");
    assert.ok(once !== undefined);
    const grown = once.notes.replace("## Decisions", `${Array.from({ length: 30 }, (_, n) => `- later ${n}: ${"y".repeat(45)}`).join("\n")}\n\n## Decisions`);
    const twice = tidyNow(grown, "second.md");
    assert.ok(twice !== undefined);
    assert.equal(twice.notes.match(/\(older lines moved to history\//g)?.length, 1);
    assert.match(twice.notes, /\(older lines moved to history\/second\.md\)/);
});

test("a single long line is never moved out of the block, which would empty it", () => {
    assert.equal(tidyNow(`## Now\n${"z".repeat(2000)}\n## Decisions\n`, "x.md"), undefined);
});

test("### subheadings belong to the block, and a # title ends it", () => {
    const notes = `## Now\nStatus: a\n### Detail\n${"d".repeat(1100)}\n# Title\nafter\n`;
    const tidied = tidyNow(notes, "x.md");
    assert.ok(tidied !== undefined);
    assert.match(tidied.notes, /### Detail/, "the ### line stays in the top of the block");
    assert.match(tidied.notes, /\n# Title\nafter\n$/, "the title and what follows it are untouched");
});
