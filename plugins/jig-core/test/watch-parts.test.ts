// The small parts of the watch engine, on their own: ages, cleaning a result, the text of a message, the saved files, the
// outbox and the timers.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WatchResult } from "../src/contract.ts";
import { cleanLine, cleanResult, clip, isWatchResult, MAX_DETAIL_LINES, sanitize, WITHHELD } from "../src/watch/clean.ts";
import type { Protect } from "../src/watch/clean.ts";
import { formatAge } from "../src/watch/format.ts";
import { composeMessage } from "../src/watch/message.ts";
import type { Notice } from "../src/watch/message.ts";
import { COALESCE_MS, createOutbox, MIN_GAP_MS } from "../src/watch/outbox.ts";
import { createWatchStore, parseSaved } from "../src/watch/store.ts";
import type { SavedWatch } from "../src/watch/store.ts";
import { realTimers } from "../src/watch/timers.ts";
import { fakeClock } from "./support/clock.ts";
import { tempState } from "./support/state.ts";
import { PLAIN } from "./support/watches.ts";

const state = tempState();
beforeEach(() => { state.start(); });
afterEach(() => { state.stop(); });

describe("formatAge", () => {
    test("is short, rounded down, and never negative", () => {
        const cases: Array<[number, string]> = [
            [-5_000, "0 s"], [0, "0 s"], [999, "0 s"], [45_000, "45 s"], [59_999, "59 s"], [60_000, "1 min"], [12 * 60_000, "12 min"],
            [59 * 60_000 + 59_000, "59 min"], [60 * 60_000, "1 h"], [125 * 60_000, "2 h 5 min"], [23 * 3_600_000 + 59 * 60_000, "23 h 59 min"],
            [24 * 3_600_000, "1 d"], [100 * 3_600_000, "4 d 4 h"],
        ];
        for (const [ms, text] of cases) assert.equal(formatAge(ms), text, String(ms));
    });
});

describe("sanitize and clip", () => {
    test("sanitize removes colour codes, titles and links that act on the terminal, and control characters", () => {
        assert.equal(sanitize("\u001b[31mred\u001b[0m and \u001b[1;32;40mgreen\u001b[K"), "red and green");
        assert.equal(sanitize("a\u001b]0;a new title\u0007b"), "ab", "an OSC ended by BEL");
        assert.equal(sanitize("a\u001b]52;c;c2VjcmV0\u001b\\b"), "ab", "an OSC ended by ST: the clipboard");
        assert.equal(sanitize("a\u001b]8;;https://x\u0007link\u001b]8;;\u0007b"), "alinkb");
        assert.equal(sanitize("bell\u0007 nul\u0000 del\u007f c1\u009b done"), "bell nul del c1 done");
        assert.equal(sanitize("an unfinished \u001b"), "an unfinished ");
    });

    test("sanitize keeps tabs and line breaks, and makes a carriage return a line break", () => {
        assert.equal(sanitize("a\tb\nc\r\nd\re"), "a\tb\nc\nd\ne");
    });

    test("sanitize leaves ordinary text, including other languages and emoji, as it is", () => {
        const text = "Größe: 42 — 日本語 ✓ \u{1F600} [ok] (done) <b>";
        assert.equal(sanitize(text), text);
    });

    test("clip cuts with an ellipsis, and never between the halves of a surrogate pair", () => {
        assert.equal(clip("short", 10), "short");
        assert.equal(clip("exactly ten", 11), "exactly ten");
        assert.equal(clip("a long sentence", 8), "a long …");
        const emoji = "ab\u{1F600}cd";
        assert.equal(clip(emoji, 4), "ab…", "the cut would fall inside the emoji, so the emoji goes whole");
        assert.equal(clip(emoji, 5), "ab\u{1F600}…");
    });
});

describe("cleaning a result", () => {
    const base: WatchResult = { outcome: "failed", summary: "build failed" };

    test("redacts first and masks second, in the summary and in the details", () => {
        const calls: string[] = [];
        const protect: Protect = {
            redact: (text) => { calls.push("redact"); return text.replaceAll("SECRET", "[redacted]"); },
            mask: (text) => { calls.push("mask"); return text.replaceAll("PERSONAL", "[masked]").replaceAll("[redacted]", "[seen after redaction]"); },
        };
        const result = cleanResult({ ...base, summary: "SECRET and PERSONAL", details: "line SECRET\nline PERSONAL" }, protect);
        assert.equal(result.summary, "[seen after redaction] and [masked]", "the masker saw the text the redactor had left");
        assert.equal(result.details, "line [seen after redaction]\nline [masked]");
        assert.deepEqual(calls, ["redact", "mask", "redact", "mask"]);
    });

    test("keeps the outcome, and leaves out what the result did not have", () => {
        assert.deepEqual(cleanResult(base, PLAIN), { outcome: "failed", summary: "build failed" });
        assert.deepEqual(cleanResult({ outcome: "passed", summary: "", details: "  \n\n", links: [], facts: {} }, PLAIN), { outcome: "passed", summary: "" });
    });

    test("puts the summary on one line, at most 500 characters", () => {
        const result = cleanResult({ ...base, summary: `first line\n\n   second line\r\nthird ${"x".repeat(600)}` }, PLAIN);
        assert.ok(result.summary.startsWith("first line second line third xxx"));
        assert.ok(!result.summary.includes("\n"));
        assert.equal(result.summary.length, 500);
        assert.ok(result.summary.endsWith("…"));
    });

    test("keeps up to 40 lines of details, and the last of them says how many were cut", () => {
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
        const result = cleanResult({ ...base, details: lines.join("\n") }, PLAIN);
        const kept = result.details?.split("\n") ?? [];
        assert.equal(kept.length, MAX_DETAIL_LINES);
        assert.deepEqual(kept.slice(0, 39), lines.slice(0, 39));
        assert.equal(kept[39], "[61 more lines cut]");
    });

    test("exactly 40 lines are all kept, and one more is cut to 39 and a note", () => {
        const forty = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
        assert.equal(cleanResult({ ...base, details: forty.join("\n") }, PLAIN).details, forty.join("\n"));
        const cut = cleanResult({ ...base, details: [...forty, "line 41"].join("\n") }, PLAIN).details?.split("\n") ?? [];
        assert.equal(cut.length, 40);
        assert.equal(cut[39], "[2 more lines cut]");
    });

    test("cuts each detail line at 1 000 characters, and drops blank lines at both ends", () => {
        const result = cleanResult({ ...base, details: `\n\n  \nfirst\n\nthird ${"y".repeat(2000)}\n\n\n` }, PLAIN);
        const lines = result.details?.split("\n") ?? [];
        assert.equal(lines.length, 3);
        assert.equal(lines[0], "first");
        assert.equal(lines[1], "", "a blank line in the middle stays");
        assert.equal(lines[2]?.length, 1000);
    });

    test("removes colour codes before anything else, so they cannot hide a secret from the redactor", () => {
        const seen: string[] = [];
        const protect: Protect = { redact: (text) => { seen.push(text); return text.replaceAll("hunter2", "[redacted]"); }, mask: (text) => text };
        const result = cleanResult({ ...base, summary: "pass\u001b[1mhunter2\u001b[0m", details: "\u001b[31merror\u001b[0m hunt\u001b[1mer2" }, protect);
        assert.equal(result.summary, "pass[redacted]");
        assert.equal(result.details, "error [redacted]", "a code in the middle of the secret did not hide it");
        assert.deepEqual(seen, ["passhunter2", "error hunter2"]);
    });

    test("when the masker cannot mask, the text is withheld and the outcome and links stay", () => {
        const protect: Protect = { redact: (text) => text, mask: () => { throw new Error("masking is broken"); } };
        const result = cleanResult({
            outcome: "failed", summary: "customer jane.doe@example.com", details: "more of it", links: ["https://ci.example/run/1"], facts: { passed: 3 },
        }, protect);
        assert.deepEqual(result, { outcome: "failed", summary: `summary ${WITHHELD}`, links: ["https://ci.example/run/1"], facts: { passed: 3 } });
        assert.ok(!JSON.stringify(result).includes("jane"));
    });

    test("redacts links but does not mask them, because a link has to stay a link", () => {
        const protect: Protect = { redact: (text) => text.replaceAll("SECRET", "[redacted]"), mask: () => "[masked]" };
        const result = cleanResult({ ...base, links: ["https://ci.example/run/1?token=SECRET", "https://ci.example/u/jane%40example.com"] }, protect);
        assert.deepEqual(result.links, ["https://ci.example/run/1?token=[redacted]", "https://ci.example/u/jane%40example.com"]);
    });

    test("keeps at most 10 links of 500 characters", () => {
        const links = Array.from({ length: 15 }, (_, i) => `https://ci.example/${i}/${"z".repeat(600)}`);
        const result = cleanResult({ ...base, links }, PLAIN);
        assert.equal(result.links?.length, 10);
        assert.ok(result.links?.every((link) => link.length === 500));
    });

    test("cleans facts like a record's facts: numbers, flags and short codes, redacted", () => {
        const protect: Protect = { redact: (text) => text.replaceAll("SECRET", "[redacted]"), mask: (text) => text };
        const result = cleanResult({
            ...base, facts: { passed: 3, ok: true, conclusion: "SECRET-code", essay: "x".repeat(100), nested: { a: 1 } as never, nan: Number.NaN },
        }, protect);
        assert.deepEqual(result.facts, { passed: 3, ok: true, conclusion: "[redacted]-code" });
    });

    test("is a copy: the result it was given is not changed", () => {
        const given: WatchResult = { outcome: "passed", summary: "PERSONAL", details: "PERSONAL\nPERSONAL", links: ["a"], facts: { n: 1 } };
        const before = JSON.stringify(given);
        cleanResult(given, { redact: (t) => t, mask: (t) => t.replaceAll("PERSONAL", "x") });
        assert.equal(JSON.stringify(given), before);
    });

    test("cleanLine: one cleaned line, at most the length asked, or the withheld note", () => {
        const protect: Protect = { redact: (text) => text.replaceAll("SECRET", "[redacted]"), mask: (text) => text };
        assert.equal(cleanLine("a\nb SECRET\u001b[0m", protect, 50), "a b [redacted]");
        assert.equal(cleanLine("x".repeat(100), protect, 10), `${"x".repeat(9)}…`);
        assert.equal(cleanLine("anything", { redact: (t) => t, mask: () => { throw new Error("no"); } }, 50), WITHHELD);
    });

    test("isWatchResult accepts what the contract describes and nothing else", () => {
        assert.equal(isWatchResult({ outcome: "passed", summary: "ok" }), true);
        assert.equal(isWatchResult({ outcome: "error", summary: "", details: "d", links: ["a"], facts: { n: 1 } }), true);
        for (const bad of [
            undefined, null, "passed", [], {}, { outcome: "passed" }, { summary: "x" }, { outcome: "great", summary: "x" },
            { outcome: "passed", summary: 1 }, { outcome: "passed", summary: "x", details: 1 }, { outcome: "passed", summary: "x", links: "a" },
            { outcome: "passed", summary: "x", links: [1] }, { outcome: "passed", summary: "x", facts: [] },
        ]) {
            assert.equal(isWatchResult(bad), false, JSON.stringify(bad));
        }
    });
});

describe("the text of a message", () => {
    const watch = { id: "k3m9x2ab", kind: "ci", plugin: "jig-test", title: "checks of pull request 42" };
    const finished = (result: WatchResult, extra: Partial<Notice> = {}): Notice => ({ event: "finished", ...watch, result, ...extra });

    test("each outcome ends the first sentence in its own words", () => {
        const phrases: Array<[WatchResult["outcome"], string]> = [
            ["passed", "passed"], ["failed", "failed"], ["timed-out", "timed out"], ["stopped", "was stopped"], ["error", "ended with an error"],
        ];
        for (const [outcome, phrase] of phrases) {
            assert.equal(composeMessage([finished({ outcome, summary: "" })]).content, `The watch "checks of pull request 42" ${phrase}.`);
        }
    });

    test("after a restart the sentence follows 'While Pi was closed: '", () => {
        const content = composeMessage([finished({ outcome: "passed", summary: "all good" }, { afterRestart: true })]).content;
        assert.equal(content, 'While Pi was closed: the watch "checks of pull request 42" passed.\nall good');
    });

    test("shows 10 lines of details and 5 links and says how many it left out", () => {
        const details = Array.from({ length: 11 }, (_, i) => `d${i + 1}`).join("\n");
        const links = Array.from({ length: 6 }, (_, i) => `https://x/${i + 1}`);
        const lines = composeMessage([finished({ outcome: "failed", summary: "s", details, links })]).content.split("\n");
        assert.deepEqual(lines.slice(2, 14), ["Details:", ...Array.from({ length: 10 }, (_, i) => `  d${i + 1}`), "  [1 more lines not shown]"]);
        assert.deepEqual(lines.slice(14), ["Links:", ...links.slice(0, 5).map((link) => `  ${link}`), "  [1 more links not shown]"]);
    });

    test("a paused watch says what is wrong, what happens next, and how to give it up", () => {
        const content = composeMessage([{ event: "paused", ...watch, failures: 3, error: "the login expired" }]).content;
        assert.equal(content, [
            'The watch "checks of pull request 42" is paused: its last 3 polls in a row failed. The last error was: the login expired',
            "It starts again when this session next starts. To give it up now, stop it with the watch tool (id k3m9x2ab).",
        ].join("\n"));
        assert.ok(!composeMessage([{ event: "paused", ...watch, failures: 3 }]).content.includes("The last error"));
    });

    test("several notices make several blocks, in order, with a blank line between", () => {
        const message = composeMessage([
            finished({ outcome: "passed", summary: "one" }),
            { event: "paused", ...watch, id: "bbbbbbbb", title: "second", failures: 3 },
            finished({ outcome: "failed", summary: "three" }, { id: "cccccccc", title: "third" } as Partial<Notice>),
        ]);
        assert.deepEqual(message.content.split("\n\n").map((block) => block.split("\n")[0]), [
            'The watch "checks of pull request 42" passed.',
            'The watch "second" is paused: its last 3 polls in a row failed.',
            'The watch "third" failed.',
        ]);
        assert.deepEqual(message.details.watches.map((entry) => [entry.id, entry.event, entry.outcome]), [
            ["k3m9x2ab", "finished", "passed"], ["bbbbbbbb", "paused", undefined], ["cccccccc", "finished", "failed"],
        ]);
        assert.equal(message.customType, "jig-watch");
        assert.equal(message.display, true);
    });
});

describe("saved watches", () => {
    const sample = (id: string, extra: Partial<SavedWatch> = {}): SavedWatch => ({
        version: 1, id, kind: "ci", plugin: "jig-test", title: "t", spec: { a: 1 }, status: "open", session: "s",
        startedAt: "2026-10-30T10:00:00.000Z", deadlineAt: "2026-10-30T11:00:00.000Z", stallAt: "2026-10-30T10:30:00.000Z", failures: 0, ...extra,
    });

    test("a file is private, in a private folder, and holds the watch as JSON", () => {
        const store = createWatchStore();
        const watch = sample("abcdefgh", { state: { n: 1 } });
        store.save(watch);
        const file = path.join(state.dir, "watches", "abcdefgh.json");
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), watch);
    });

    test("saving again replaces the file in one step and leaves no temporary file behind", () => {
        const store = createWatchStore();
        for (let n = 1; n <= 5; n++) store.save(sample("abcdefgh", { failures: n }));
        assert.deepEqual(readdirSync(path.join(state.dir, "watches")), ["abcdefgh.json"]);
        assert.equal(store.load().watches[0]?.failures, 5);
    });

    test("load gives back what was saved, and an unreadable folder or file is told apart from an empty one", () => {
        const store = createWatchStore();
        assert.deepEqual(store.load(), { watches: [], unreadable: 0 }, "no folder");
        store.save(sample("abcdefgh"));
        store.save(sample("bcdefghj", { status: "done", result: { outcome: "passed", summary: "ok" }, finishedAt: "2026-10-30T10:05:00.000Z" }));
        const folder = path.join(state.dir, "watches");
        writeFileSync(path.join(folder, "cdefghjk.json"), "nonsense");
        writeFileSync(path.join(folder, "README"), "ignored");
        mkdirSync(path.join(folder, "defghjkm.json"));
        const loaded = store.load();
        assert.deepEqual(loaded.watches.map((watch) => watch.id).sort(), ["abcdefgh", "bcdefghj"]);
        assert.equal(loaded.unreadable, 2, "the nonsense, and the folder that has the name of a file");
    });

    test("remove deletes a file, and a file that is not there is not an error", () => {
        const store = createWatchStore();
        store.save(sample("abcdefgh"));
        store.remove("abcdefgh");
        assert.equal(existsSync(path.join(state.dir, "watches", "abcdefgh.json")), false);
        assert.doesNotThrow(() => store.remove("abcdefgh"));
    });

    test("ids are eight characters of a small lowercase alphabet, and a taken id is not given again", () => {
        const store = createWatchStore();
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) {
            const id = store.newId();
            assert.match(id, /^[0-9a-hjkmnp-tv-z]{8}$/);
            assert.ok(!/[ilou]/.test(id));
            seen.add(id);
        }
        assert.ok(seen.size > 495, "random");
    });

    test("parseSaved keeps only the fields it knows, and refuses a file for another id", () => {
        const text = JSON.stringify({ ...sample("abcdefgh"), extra: "ignored", stalled: true });
        const watch = parseSaved(text, "abcdefgh");
        assert.deepEqual(watch, sample("abcdefgh", { stalled: true }));
        assert.equal(parseSaved(text, "bcdefghj"), undefined);
        assert.equal(parseSaved("[]", "abcdefgh"), undefined);
        assert.equal(parseSaved("null", "abcdefgh"), undefined);
    });
});

describe("the outbox", () => {
    function make() {
        const clock = fakeClock();
        const sent: Array<{ at: number; items: number[] }> = [];
        const outbox = createOutbox<number>({ now: clock.now, timers: clock.timers, send: (items) => { sent.push({ at: clock.now(), items }); } });
        return { clock, sent, outbox };
    }

    test("the limits are one second to gather and ten seconds between messages", () => {
        assert.equal(COALESCE_MS, 1000);
        assert.equal(MIN_GAP_MS, 10_000);
    });

    test("sends what it holds one second after the first item, and only then", async () => {
        const { clock, sent, outbox } = make();
        const start = clock.now();
        outbox.add(1);
        assert.equal(outbox.waiting(), 1);
        await clock.advance(400);
        outbox.add(2);
        await clock.advance(599);
        assert.equal(sent.length, 0);
        await clock.advance(1);
        assert.deepEqual(sent, [{ at: start + 1000, items: [1, 2] }]);
        assert.equal(outbox.waiting(), 0);
        assert.equal(clock.pending(), 0);
    });

    test("holds the next message until ten seconds after the last, and adds late items to it", async () => {
        const { clock, sent, outbox } = make();
        const start = clock.now();
        outbox.add(1);
        await clock.advance(1000);
        await clock.advance(2000);
        outbox.add(2);
        await clock.advance(4000);
        outbox.add(3);
        await clock.advance(20_000);
        assert.deepEqual(sent, [{ at: start + 1000, items: [1] }, { at: start + 11_000, items: [2, 3] }]);
    });

    test("an item that comes while a message waits does not move it", async () => {
        const { clock, sent, outbox } = make();
        const start = clock.now();
        outbox.add(1);
        await clock.advance(1000);
        outbox.add(2); // waits for 11 s
        await clock.advance(9000);
        outbox.add(3); // at 10 s: still before 11 s
        await clock.advance(5000);
        assert.deepEqual(sent.map((entry) => [entry.at - start, entry.items]), [[1000, [1]], [11_000, [2, 3]]]);
    });

    test("clear drops what waits, stops the timer, and forgets when the last message went", async () => {
        const { clock, sent, outbox } = make();
        outbox.add(1);
        await clock.advance(1000);
        outbox.add(2);
        outbox.clear();
        assert.equal(outbox.waiting(), 0);
        assert.equal(clock.pending(), 0);
        await clock.advance(60_000);
        assert.equal(sent.length, 1);
        const now = clock.now();
        outbox.add(3);
        await clock.advance(1000);
        assert.deepEqual(sent.at(-1), { at: now + 1000, items: [3] }, "no wait for a message that belonged to another session");
    });

    test("a send that throws does not break the outbox", async () => {
        const clock = fakeClock();
        const sent: number[][] = [];
        let fail = true;
        const outbox = createOutbox<number>({ now: clock.now, timers: clock.timers, send: (items) => { if (fail) throw new Error("no"); sent.push(items); } });
        outbox.add(1);
        await clock.advance(1000);
        assert.equal(outbox.waiting(), 0, "those items are lost");
        fail = false;
        outbox.add(2);
        await clock.advance(20_000);
        assert.deepEqual(sent, [[2]]);
    });
});

describe("the real timers", () => {
    test("never keep the process alive, and can be cleared", async () => {
        let ran = 0;
        const handle = realTimers.setTimeout(() => { ran++; }, 60_000) as NodeJS.Timeout;
        assert.equal(handle.hasRef(), false);
        realTimers.clearTimeout(handle);
        const quick = realTimers.setTimeout(() => { ran++; }, 5);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(ran, 1, "a timer that was not cleared runs");
        realTimers.clearTimeout(quick);
    });
});
