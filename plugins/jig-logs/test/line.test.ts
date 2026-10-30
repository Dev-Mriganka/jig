import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DEFAULT_CHARS,
    describeHit,
    hitsPerPage,
    hitTime,
    rawMessage,
    windowAround,
    withoutStamp,
} from "../src/line.ts";
import type { Fields } from "../src/line.ts";
import { CONTROL } from "../src/values.ts";

const FIELDS: Fields = { timeField: "@timestamp", messageField: "message" };

/** A hit's `_source` as the backend returns it. */
const source = (over: Record<string, unknown> = {}) => ({
    "@timestamp": "2026-10-13T10:00:01.000Z",
    message: "a message",
    ...over,
});

// A time and a message in the forms two kinds of service write them, with the time the index gives the hit beside it.
const BRACKETED_TIME = "2026-10-16T10:31:12.123456";
const BRACKETED =
    "[2026-10-16 10:31:12.123] DEBUG [pool-1-thread-5] 5c1d7f0e-aaaa-bbbb-cccc-0123456789ab Sending request";
const BARE_TIME = "2026-10-16T10:31:12.123+01:00";
const BARE =
    "2026-10-16 10:31:12.123 DEBUG [http-nio-8080-exec-5] 5c1d7f0e-aaaa-bbbb-cccc-0123456789ab Sending request";

test("a message is one line, cut at about 300 characters", () => {
    const long = `line one\n\tline two ${"x".repeat(400)}`;
    const line = describeHit(source({ message: long }), FIELDS);
    assert.ok(!/[\n\t]/.test(line.message));
    assert.equal(line.message.length, 300);
    assert.ok(line.message.endsWith("…"));
    assert.ok(line.message.startsWith("line one line two x"));
});

test("a long JSON payload in a message is dropped whole, not cut in half", () => {
    const payload = JSON.stringify({
        requests: Array.from({ length: 20 }, (_, i) => ({ chargeNumber: `C-${i}`, quantity: 3 })),
    });
    assert.equal(describeHit(source({ message: `Batch request: ${payload}` }), FIELDS).message, "Batch request: {…}");
});

test("the time and the message come from the fields the environment names", () => {
    const fields: Fields = { timeField: "timestamp", messageField: "log.message" };
    assert.deepEqual(describeHit({ timestamp: "2026-10-13T10:00:01Z", "log.message": "stored flat" }, fields), {
        time: "2026-10-13T10:00:01Z",
        message: "stored flat",
    });
    assert.deepEqual(describeHit({ timestamp: "2026-10-13T10:00:01Z", log: { message: "stored nested" } }, fields), {
        time: "2026-10-13T10:00:01Z",
        message: "stored nested",
    });
    assert.deepEqual(
        describeHit({}, fields),
        { time: "", message: "" },
        "a hit without them is an empty line, not an error",
    );
    assert.equal(rawMessage({ log: "text" }, fields), "", "a dotted path that does not lead to text");
});

test("a time stored as epoch milliseconds is shown as an instant; anything else is left out", () => {
    assert.equal(hitTime({ "@timestamp": Date.UTC(2026, 9, 13, 10, 0, 1) }, FIELDS), "2026-10-13T10:00:01.000Z");
    assert.equal(hitTime({ "@timestamp": 1e20 }, FIELDS), "100000000000000000000");
    assert.equal(hitTime({ "@timestamp": { nested: true } }, FIELDS), "");
    assert.equal(rawMessage({ message: 42 }, FIELDS), "42");
    assert.equal(rawMessage({ message: ["a"] }, FIELDS), "");
});

test("a hostile message cannot carry a terminal escape sequence, a line break or a separator into a line", () => {
    const hostile = "start \u001b[2J\u001b]0;title\u0007 end \u009b31m \u2028 next\r\nline\tx";
    const line = describeHit(source({ message: hostile, "@timestamp": "2026-10-13T10:00:01Z\u001b[0m" }), FIELDS);
    assert.ok(!CONTROL.test(line.message) && !CONTROL.test(line.time), JSON.stringify(line));
    assert.equal(line.message, "start [2J ]0;title end 31m next line x");
    assert.equal(line.time, "2026-10-13T10:00:01Z [0m");
    assert.equal(
        hitTime({ "@timestamp": `${"2026".repeat(40)}` }, FIELDS).length,
        64,
        "a time that is not one is cut short",
    );
});

test("a field called __proto__ is data, and a missing path is not an error", () => {
    const parsed = JSON.parse('{"__proto__": {"message": "x"}, "message": "real"}');
    assert.equal(rawMessage(parsed, FIELDS), "real");
    assert.equal(rawMessage(JSON.parse('{"__proto__": {"message": "x"}}'), FIELDS), "");
});

test("chars sets how much of a message a line keeps", () => {
    const message = `start ${"word ".repeat(300)}`;
    const long = describeHit(source({ message }), FIELDS, { chars: 1000 }).message.length;
    assert.ok(long <= 1000 && long > 900, "a word at the limit is dropped whole, so it is a little under");
    assert.equal(describeHit(source({ message }), FIELDS, { chars: 60 }).message.length <= 60, true);
    const short = describeHit(source({ message }), FIELDS).message.length;
    assert.ok(short <= DEFAULT_CHARS && short > 200);
});

test("a leading timestamp that is the hit's own time is dropped, in brackets or bare", () => {
    assert.equal(
        withoutStamp(BRACKETED, BRACKETED_TIME),
        "DEBUG [pool-1-thread-5] 5c1d7f0e-aaaa-bbbb-cccc-0123456789ab Sending request",
    );
    assert.equal(
        withoutStamp(BARE, BARE_TIME),
        "DEBUG [http-nio-8080-exec-5] 5c1d7f0e-aaaa-bbbb-cccc-0123456789ab Sending request",
    );
    assert.equal(
        withoutStamp("[2026-10-16T10:31:12,123] warn", BRACKETED_TIME),
        "warn",
        "T and a comma before the fraction are the same time",
    );
    assert.equal(withoutStamp("[2026-10-16 10:31:12] seconds only", BRACKETED_TIME), "seconds only");
    const line = describeHit(source({ "@timestamp": BARE_TIME, message: BARE }), FIELDS);
    assert.equal(line.message, "DEBUG [http-nio-8080-exec-5] 5c1d7f0e-aaaa-bbbb-cccc-0123456789ab Sending request");
    assert.equal(line.time, BARE_TIME, "the line still starts with the time");
});

test("a timestamp that differs from the hit's time stays: it is information", () => {
    assert.equal(withoutStamp("[2026-10-16 10:31:13.123] later", BRACKETED_TIME), "[2026-10-16 10:31:13.123] later");
    assert.equal(
        withoutStamp("[2026-10-16 10:31:12.999] other fraction", BRACKETED_TIME),
        "[2026-10-16 10:31:12.999] other fraction",
    );
    assert.equal(
        withoutStamp("[2026-10-15 10:31:12.123] other day", BRACKETED_TIME),
        "[2026-10-15 10:31:12.123] other day",
    );
    assert.equal(
        withoutStamp("order created [2026-10-16 10:31:12.123]", BRACKETED_TIME),
        "order created [2026-10-16 10:31:12.123]",
    );
    assert.equal(
        withoutStamp("[2026-10-16 10:31:12.123 unclosed", BRACKETED_TIME),
        "[2026-10-16 10:31:12.123 unclosed",
    );
    assert.equal(
        withoutStamp("2026-10-16T10:31:12.123Z with a zone", BRACKETED_TIME),
        "2026-10-16T10:31:12.123Z with a zone",
    );
    assert.equal(
        withoutStamp("[2026-10-16 10:31:12.123]", BRACKETED_TIME),
        "[2026-10-16 10:31:12.123]",
        "only a timestamp: kept",
    );
    assert.equal(withoutStamp(BRACKETED, ""), BRACKETED, "a hit without a time keeps its message");
});

const filler = (label: string, length: number): string =>
    Array.from({ length: Math.ceil(length / (label.length + 1)) }, (_, i) => `${label}${i}`).join(" ");

test("windowAround keeps the characters around the first occurrence, a quarter of them before it", () => {
    const message = `${filler("head", 900)} the NEEDLE is here ${filler("tail", 900)}`;
    const out = windowAround(message, "needle", 300);
    assert.ok(out.length <= 300, String(out.length));
    assert.ok(out.startsWith("…"), "it says it starts mid-message");
    assert.ok(out.endsWith("…"), "and that it stops before the end");
    const at = out.indexOf("NEEDLE");
    assert.ok(at > 40 && at < 120, `about a quarter in: ${at}`);
    assert.ok(out.length > 250, "and fills the window");
});

test("windowAround falls back to the head when the term is absent or near the start, and leaves a short message alone", () => {
    const message = `${filler("head", 900)} the needle`;
    assert.equal(windowAround(message, "missing", 300).startsWith("head0 head1"), true);
    assert.equal(windowAround(`early needle ${filler("tail", 900)}`, "needle", 300).startsWith("early needle"), true);
    assert.equal(windowAround("short needle line", "needle", 300), "short needle line");
});

test("windowAround treats the term as text, not as a pattern, and finds the first occurrence", () => {
    const message = `${filler("head", 700)} C-1.5(a) first ${filler("mid", 400)} C-1.5(a) second ${filler("tail", 400)}`;
    const out = windowAround(message, "c-1.5(A)", 300);
    assert.ok(out.includes("C-1.5(a) first"), out);
    assert.ok(!out.includes("second"));
    assert.equal(
        windowAround(`${filler("a", 800)} xyz`, ".*", 300).startsWith("a0 a1"),
        true,
        "a pattern character matches itself",
    );
});

test("windowAround starts at a word, not inside one, when a space is near", () => {
    const message = `${"w".repeat(30)} ${filler("head", 400)} needle ${filler("tail", 400)}`;
    const out = windowAround(message, "needle", 300);
    assert.match(out, /^…head\d+ /, out.slice(0, 40));
    assert.ok(out.includes("needle"));
});

test("windowAround never starts after the term, and keeps a term longer than the window in front", () => {
    const term = "t".repeat(80);
    const out = windowAround(`${filler("head", 500)} ${term} ${filler("tail", 500)}`, term, 60);
    assert.ok(out.length <= 60);
    assert.ok(out.includes("t".repeat(20)), out);
});

test("a window around a term inside a JSON payload is still cut safely at the end", () => {
    const payload = JSON.stringify({
        requests: Array.from({ length: 30 }, (_, i) => ({ chargeNumber: `C-${i}`, quantity: 3 })),
    });
    const out = windowAround(`${filler("head", 600)} ${payload}`, "C-12", 300);
    assert.ok(out.length <= 300);
    assert.ok(out.includes("C-12"));
    assert.doesNotMatch(out, /\{"chargeNumber":"C-\d+"$/, "no object is left open at the cut");
});

test("describeHit with around windows the message after its own timestamp is dropped", () => {
    const message = `[2026-10-16 10:31:12.123] DEBUG ${filler("head", 700)} needle ${filler("tail", 700)}`;
    const line = describeHit(source({ "@timestamp": BRACKETED_TIME, message }), FIELDS, {
        around: "needle",
        chars: 200,
    });
    assert.ok(line.message.length <= 200);
    assert.ok(line.message.includes("needle"));
    assert.ok(!line.message.includes("[2026-10-16 10:31:12.123]"));
});

test("a page holds 20 hits, fewer when long ones would not fit the text cap together", () => {
    assert.equal(hitsPerPage(), 20);
    assert.equal(hitsPerPage(300), 20);
    assert.equal(hitsPerPage(1000), 20);
    assert.equal(hitsPerPage(2000), 11);
    assert.equal(hitsPerPage(4000), 5);
    for (const chars of [40, 300, 999, 1500, 4000]) {
        assert.ok(hitsPerPage(chars) * (chars + 80) <= 24_000 || hitsPerPage(chars) === 1, String(chars));
    }
});
