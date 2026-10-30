// Cap: a long result is cut for the model, and the whole text goes to a private spill file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { CAP_CHARS, capContent, cleanupSpill, HEAD_CHARS, SELF_TRUNCATING_TOOLS, textOf } from "../src/cap.ts";
import type { Content } from "../src/cap.ts";
import { tempState } from "./support/state.ts";

const state = tempState();
before(() => {
    state.start();
});
after(() => state.stop());

const text = (value: string): Content[] => [{ type: "text", text: value }];
const mode = (file: string) => statSync(file).mode & 0o777;
/** A text of exactly this many characters in which every stretch is different, so a cut can be told by position. */
const long = (length: number) =>
    Array.from({ length: Math.ceil(length / 3) }, (_, index) => `${index},`)
        .join("")
        .padEnd(length, "~")
        .slice(0, length);

describe("when a result is cut", () => {
    test("the limits are 50 000 characters, of which 8 000 are kept", () => {
        assert.equal(CAP_CHARS, 50_000);
        assert.equal(HEAD_CHARS, 8_000);
    });

    test("a result of exactly 50 000 characters is left alone, and one more is cut", () => {
        const input = { tool: "mongo", toolCallId: "c1", sessionId: "s1" };
        assert.equal(capContent({ ...input, content: text(long(50_000)) }), undefined);
        assert.notEqual(capContent({ ...input, content: text(long(50_001)) }), undefined);
    });

    test("Pi's own tools that cut their output themselves are skipped", () => {
        for (const tool of ["read", "bash", "powershell", "grep", "find", "ls"]) {
            assert.equal(
                capContent({ tool, toolCallId: "c2", sessionId: "s1", content: text(long(80_000)) }),
                undefined,
                tool,
            );
        }
        assert.deepEqual([...SELF_TRUNCATING_TOOLS].sort(), ["bash", "find", "grep", "ls", "powershell", "read"]);
        assert.notEqual(
            capContent({ tool: "write", toolCallId: "c2", sessionId: "s1", content: text(long(80_000)) }),
            undefined,
        );
    });

    test("a result that holds no text is left alone", () => {
        assert.equal(
            capContent({
                tool: "shot",
                toolCallId: "c3",
                sessionId: "s1",
                content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
            }),
            undefined,
        );
    });
});

describe("what the model gets and what is saved", () => {
    const full = long(60_000);
    const capped = capContent({ tool: "mongo", toolCallId: "call_abc", sessionId: "session-1", content: text(full) });

    test("the first 8 000 characters, then a line that names the file and says to read it with the read tool", () => {
        assert.ok(capped !== undefined);
        assert.equal(capped.content.length, 1);
        const shown = textOf(capped.content);
        assert.ok(shown.startsWith(full.slice(0, HEAD_CHARS)));
        assert.equal(shown[HEAD_CHARS], "\n", "the head is exactly 8 000 characters");
        assert.ok(!shown.includes(full.slice(HEAD_CHARS, HEAD_CHARS + 50)), "nothing beyond the head");
        const pointer = shown.slice(HEAD_CHARS).trim();
        assert.match(pointer, /60000 characters in total/);
        assert.ok(pointer.includes(capped.spill ?? "no path"), pointer);
        assert.match(pointer, /read it with the read tool/);
    });

    test("the file is <state>/spill/<session>/<call id>.txt, holds the whole text, and is private", () => {
        assert.equal(capped?.spill, path.join(state.dir, "spill", "session-1", "call_abc.txt"));
        assert.equal(readFileSync(capped?.spill ?? "", "utf8"), full);
        assert.equal(mode(capped?.spill ?? ""), 0o600);
        assert.equal(mode(path.dirname(capped?.spill ?? "")), 0o700);
        assert.equal(mode(path.join(state.dir, "spill")), 0o700);
    });

    test("a nested call id has its slash replaced", () => {
        const nested = capContent({
            tool: "mongo",
            toolCallId: "call_abc/2",
            sessionId: "session-1",
            content: text(full),
        });
        assert.equal(path.basename(nested?.spill ?? ""), "call_abc_2.txt");
    });

    test("an id that tries to leave the folder stays inside it", () => {
        const sneaky = capContent({
            tool: "mongo",
            toolCallId: "../../escape",
            sessionId: "../other",
            content: text(full),
        });
        const spill = sneaky?.spill ?? "";
        // One folder for the session below the spill folder, and the file in it: the slashes became underscores.
        assert.equal(path.dirname(path.dirname(spill)), path.join(state.dir, "spill"));
        const dots = capContent({ tool: "mongo", toolCallId: "..", sessionId: ".", content: text(full) })?.spill ?? "";
        assert.equal(path.dirname(path.dirname(dots)), path.join(state.dir, "spill"));
        assert.ok(
            ![".", ".."].includes(path.basename(path.dirname(dots))) && ![".", ".."].includes(path.basename(dots)),
            dots,
        );
    });

    test("the same id twice gets a second file, and the first is not overwritten", () => {
        const first = capContent({
            tool: "mongo",
            toolCallId: "dup",
            sessionId: "session-2",
            content: text(`first ${full}`),
        });
        const second = capContent({
            tool: "mongo",
            toolCallId: "dup",
            sessionId: "session-2",
            content: text(`second ${full}`),
        });
        assert.notEqual(first?.spill, second?.spill);
        assert.ok(readFileSync(first?.spill ?? "", "utf8").startsWith("first "));
        assert.ok(readFileSync(second?.spill ?? "", "utf8").startsWith("second "));
    });

    test("several text blocks are joined, and images stay after the text", () => {
        const image: Content = { type: "image", data: "AAAA", mimeType: "image/png" };
        const result = capContent({
            tool: "mongo",
            toolCallId: "multi",
            sessionId: "session-3",
            content: [...text(long(30_000)), image, ...text(long(30_000))],
        });
        assert.equal(result?.content.length, 2);
        assert.equal(result?.content[0]?.type, "text");
        assert.deepEqual(result?.content[1], image);
        assert.equal(readFileSync(result?.spill ?? "", "utf8").length, 60_001, "two blocks joined by one newline");
    });

    test("the cut does not split a character made of two halves", () => {
        const emoji = "😀";
        const input = "a".repeat(HEAD_CHARS - 1) + emoji + "b".repeat(CAP_CHARS);
        const result = capContent({ tool: "mongo", toolCallId: "emoji", sessionId: "session-3", content: text(input) });
        const shown = textOf(result?.content ?? []);
        assert.ok(!/[\ud800-\udbff]\n/.test(shown), "a lone half would be followed by the newline of the note");
        assert.ok(shown.startsWith("a".repeat(HEAD_CHARS - 1)));
    });
});

describe("when the file cannot be written", () => {
    test("the result is still cut, and the note says the text could not be saved", () => {
        const saved = process.env.JIG_STATE_DIR;
        const blocker = path.join(state.dir, "a-file");
        writeFileSync(blocker, "not a folder");
        process.env.JIG_STATE_DIR = path.join(blocker, "inside");
        try {
            const result = capContent({
                tool: "mongo",
                toolCallId: "nope",
                sessionId: "s",
                content: text(long(60_000)),
            });
            assert.ok(result !== undefined);
            assert.equal(result.spill, undefined);
            const shown = textOf(result.content);
            assert.ok(shown.length < 9_000);
            assert.match(shown, /could not be saved/);
        } finally {
            process.env.JIG_STATE_DIR = saved ?? state.dir;
        }
    });
});

describe("retention", () => {
    test("files older than the limit are deleted, and a session folder left empty goes with them", () => {
        const day = 24 * 60 * 60 * 1000;
        const now = Date.now();
        const oldDir = path.join(state.dir, "spill", "old-session");
        const mixedDir = path.join(state.dir, "spill", "mixed-session");
        mkdirSync(oldDir, { recursive: true });
        mkdirSync(mixedDir, { recursive: true });
        const ancient = path.join(oldDir, "a.txt");
        const stale = path.join(mixedDir, "stale.txt");
        const fresh = path.join(mixedDir, "fresh.txt");
        for (const file of [ancient, stale, fresh]) writeFileSync(file, "x");
        for (const file of [ancient, stale]) utimesSync(file, new Date(now - 9 * day), new Date(now - 9 * day));
        assert.equal(cleanupSpill(7, now), 2);
        assert.equal(existsSync(ancient), false);
        assert.equal(existsSync(oldDir), false, "the empty session folder is removed");
        assert.equal(existsSync(stale), false);
        assert.equal(existsSync(fresh), true);
        assert.ok(readdirSync(path.join(state.dir, "spill")).includes("mixed-session"));
    });

    test("with nothing to clean it does nothing", () => {
        assert.equal(cleanupSpill(7), 0);
    });
});
