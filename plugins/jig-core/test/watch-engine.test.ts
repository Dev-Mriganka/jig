// The watch engine, driven by a clock a test moves by hand: polling, finishing, timing out, pausing, restarts, stopping,
// and what the agent is told and when.
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PollOutcome, WatchKind } from "../src/contract.ts";
import { FIRST_POLL_MS, LIST_WINDOW_MS, POLL_TIMEOUT_MS, RETENTION_MS } from "../src/watch/engine.ts";
import { createWatchEngine } from "../src/watch/engine.ts";
import { createWatchStore } from "../src/watch/store.ts";
import { tempState } from "./support/state.ts";
import { passed, rig, savedFile, scripted, seconds } from "./support/watches.ts";
import type { Rig } from "./support/watches.ts";

const state = tempState();
beforeEach(() => { state.start(); });
afterEach(() => { state.stop(); });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

let sessions = 0;

/** A rig with a session started and one kind registered, and a started watch. Each call has a session of its own, so
 *  the watches of one call are not picked up by the next in the same state folder. */
function started(answer: Parameters<typeof scripted>[2], extra: Partial<WatchKind<unknown, unknown>> = {}, watch: { timeoutMinutes?: number; stallMinutes?: number } = {}) {
    const r = rig();
    const { kind, polls } = scripted(r.clock, "k", answer, extra);
    r.engine.registerKind(kind);
    const session = `session-${++sessions}`;
    r.begin(session);
    const id = r.engine.start({ kind: "k", spec: { pr: 42 }, title: "checks of pull request 42", ...watch });
    return { r, polls, id, from: r.clock.now(), session };
}

describe("registering kinds", () => {
    test("a watch needs a registered kind, and the error says what is missing", () => {
        const r = rig();
        r.begin();
        assert.throws(() => r.engine.start({ kind: "nope", spec: {}, title: "t" }), /no watch kind is registered as "nope": is the plugin that supplies it loaded\?/);
        assert.equal(existsSync(path.join(state.dir, "watches")), false, "nothing was saved");
        assert.deepEqual(r.engine.list(), []);
    });

    test("registering the same kind again replaces it, because Pi loads plugins again on a reload", async () => {
        const r = rig();
        const first = scripted(r.clock, "k", () => ({ state: 1 }));
        const second = scripted(r.clock, "k", () => ({ state: 2 }));
        r.engine.registerKind(first.kind);
        r.engine.registerKind(second.kind);
        r.begin();
        r.engine.start({ kind: "k", spec: {}, title: "t" });
        await r.clock.advance(FIRST_POLL_MS);
        assert.equal(first.polls.length, 0);
        assert.equal(second.polls.length, 1);
    });

    test("kinds are unique by name, so different kinds live side by side", async () => {
        const r = rig();
        const one = scripted(r.clock, "one", () => ({ state: 1 }));
        const two = scripted(r.clock, "two", () => ({ state: 2 }));
        r.engine.registerKind(one.kind);
        r.engine.registerKind(two.kind);
        r.begin();
        r.engine.start({ kind: "two", spec: {}, title: "t" });
        await r.clock.advance(FIRST_POLL_MS);
        assert.deepEqual([one.polls.length, two.polls.length], [0, 1]);
    });

    test("a kind that is not shaped like one is refused where it is registered", () => {
        const r = rig();
        const ok = scripted(r.clock, "k", () => ({ state: 1 })).kind;
        for (const bad of [
            undefined, {}, { ...ok, kind: "" }, { ...ok, plugin: "" }, { ...ok, intervalMs: 0 }, { ...ok, intervalMs: Number.NaN },
            { ...ok, intervalMs: "30000" }, { ...ok, poll: undefined }, { ...ok, describe: undefined },
        ]) {
            assert.throws(() => r.engine.registerKind(bad as never), TypeError, JSON.stringify(bad));
        }
    });
});

describe("starting a watch", () => {
    test("returns an id at once, and saves the watch in a private file", () => {
        const { r, id, from, session } = started(() => ({ state: 1 }), {}, { timeoutMinutes: 45, stallMinutes: 20 });
        assert.match(id, /^[0-9a-hjkmnp-tv-z]{8}$/);
        const file = path.join(state.dir, "watches", `${id}.json`);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
        assert.deepEqual(savedFile(state.dir, id), {
            version: 1,
            id,
            kind: "k",
            plugin: "jig-test",
            title: "checks of pull request 42",
            spec: { pr: 42 },
            status: "open",
            startedAt: new Date(from).toISOString(),
            deadlineAt: new Date(from + 45 * MINUTE).toISOString(),
            stallAt: new Date(from + 20 * MINUTE).toISOString(),
            session,
            failures: 0,
        });
        assert.equal(r.clock.pending(), 1, "only the first poll is waiting");
    });

    test("the defaults are 60 minutes to give up and 30 to say that it is still waiting", () => {
        const { id, from } = started(() => ({ state: 1 }));
        const saved = savedFile(state.dir, id);
        assert.equal(Date.parse(saved.deadlineAt) - from, 60 * MINUTE);
        assert.equal(Date.parse(saved.stallAt) - from, 30 * MINUTE);
    });

    test("ids are short, random and not repeated", () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "k", () => ({ state: 1 })).kind);
        r.begin();
        const ids = Array.from({ length: 200 }, () => r.engine.start({ kind: "k", spec: {}, title: "t" }));
        assert.equal(new Set(ids).size, 200);
        assert.ok(ids.every((id) => /^[0-9a-hjkmnp-tv-z]{8}$/.test(id)));
    });

    test("needs a session: Pi starts no timers before one", () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "k", () => ({ state: 1 })).kind);
        assert.throws(() => r.engine.start({ kind: "k", spec: {}, title: "t" }), /only while a session is running/);
        assert.equal(r.clock.pending(), 0);
    });

    test("checks what it is given", () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "k", () => ({ state: 1 })).kind);
        r.begin();
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        assert.throws(() => r.engine.start({ kind: "k", spec: circular, title: "t" }), /spec must be plain JSON/);
        assert.throws(() => r.engine.start({ kind: "k", spec: {}, title: "" }), /needs a title/);
        assert.throws(() => r.engine.start({ kind: "k", spec: {}, title: "  " }), /needs a title/);
        for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "30" as unknown as number]) {
            assert.throws(() => r.engine.start({ kind: "k", spec: {}, title: "t", timeoutMinutes: bad }), /timeoutMinutes must be a number of minutes above 0/);
            assert.throws(() => r.engine.start({ kind: "k", spec: {}, title: "t", stallMinutes: bad }), /stallMinutes must be a number of minutes above 0/);
        }
        assert.equal(r.engine.list().length, 0, "nothing was started");
    });

    test("keeps the title on one line without control characters, and short", () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "k", () => ({ state: 1 })).kind);
        r.begin();
        const id = r.engine.start({ kind: "k", spec: {}, title: `checks\nof\u001b[31m pull\u0007 request ${"x".repeat(300)}` });
        const title = savedFile(state.dir, id).title;
        assert.ok(title.startsWith("checks of pull request "), title);
        assert.ok(!/[\u0000-\u001f]/.test(title));
        assert.ok(title.length <= 200);
    });

    test("keeps its own copy of the spec, as JSON, so a poll sees the same before and after a restart", async () => {
        const r = rig();
        const { kind, polls } = scripted(r.clock, "k", () => ({ state: 1 }));
        r.engine.registerKind(kind);
        r.begin();
        const spec = { when: new Date(0), skipped: undefined, list: [1, 2] };
        r.engine.start({ kind: "k", spec, title: "t" });
        spec.list.push(3);
        await r.clock.advance(FIRST_POLL_MS);
        assert.deepEqual(polls[0]?.spec, { when: "1970-01-01T00:00:00.000Z", list: [1, 2] });
    });
});

describe("polling", () => {
    test("the first poll comes after 2 seconds, and gets the spec and no state", async () => {
        const { r, polls } = started(() => ({ state: { n: 1 } }));
        await r.clock.advance(FIRST_POLL_MS - 1);
        assert.equal(polls.length, 0);
        await r.clock.advance(1);
        assert.equal(polls.length, 1);
        assert.deepEqual(polls[0]?.spec, { pr: 42 });
        assert.equal(polls[0]?.state, undefined);
        assert.equal(polls[0]?.signal.aborted, false);
    });

    test("then every interval of the kind, with the state of the poll before", async () => {
        const { r, polls, from } = started((n) => ({ state: { n } }));
        await r.clock.advance(5 * MINUTE);
        assert.deepEqual(seconds(polls, from), [2, 32, 62, 92, 122, 152, 182, 212, 242, 272]);
        assert.deepEqual(polls.map((polled) => polled.state), [undefined, ...Array.from({ length: 9 }, (_, i) => ({ n: i + 1 }))]);
    });

    test("saves the state after every poll, so a restart goes on from there", async () => {
        const { r, id } = started((n) => ({ state: { n } }));
        await r.clock.advance(FIRST_POLL_MS);
        assert.deepEqual(savedFile(state.dir, id).state, { n: 1 });
        await r.clock.advance(30 * SECOND);
        assert.deepEqual(savedFile(state.dir, id).state, { n: 2 });
        assert.equal(savedFile(state.dir, id).status, "open");
    });

    test("the poll can ask for the next one sooner or later (nextPollMs)", async () => {
        const asks = [12_000, 45_000, undefined];
        const { r, polls, from } = started((n) => ({ state: n, ...(asks[n - 1] === undefined ? {} : { nextPollMs: asks[n - 1] as number }) }));
        await r.clock.advance(2 * MINUTE);
        assert.deepEqual(seconds(polls, from), [2, 14, 59, 89, 119]);
    });

    test("however it is asked, the wait stays between 5 seconds and 10 minutes", async () => {
        const asks = [1, 0, -50, 7 * HOUR, 5_000, 600_000];
        const { r, polls, from } = started((n) => ({ state: n, nextPollMs: asks[n - 1] ?? 5_000 }));
        await r.clock.advance(40 * MINUTE);
        // 1, 0 and -50 ask for less than 5 s; 7 h asks for more than 10 min; 5 s and 10 min are the limits themselves.
        assert.deepEqual(seconds(polls, from).slice(0, 7), [2, 7, 12, 17, 617, 622, 1222]);
    });

    test("the interval of the kind is kept between the same limits", async () => {
        const quick = started((n) => ({ state: n }), { intervalMs: 100 });
        await quick.r.clock.advance(30 * SECOND);
        assert.deepEqual(seconds(quick.polls, quick.from), [2, 7, 12, 17, 22, 27]);
        const slow = started((n) => ({ state: n }), { intervalMs: 3 * HOUR });
        await slow.r.clock.advance(25 * MINUTE);
        assert.deepEqual(seconds(slow.polls, slow.from), [2, 602, 1202]);
    });

    test("a nextPollMs that is not a number is ignored", async () => {
        const { r, polls, from } = started((n) => ({ state: n, nextPollMs: n === 1 ? ("soon" as unknown as number) : Number.NaN }));
        await r.clock.advance(70 * SECOND);
        assert.deepEqual(seconds(polls, from), [2, 32, 62]);
    });

    test("the next poll waits for a slow poll to end: they never overlap", async () => {
        let release: (() => void) | undefined;
        const { r, polls, from } = started((n) => (n === 1
            ? new Promise<PollOutcome<unknown>>((resolve) => { release = () => resolve({ state: 1 }); })
            : { state: n }));
        await r.clock.advance(50 * SECOND);
        assert.equal(polls.length, 1, "the first poll is still out");
        release?.();
        await r.clock.settle();
        await r.clock.advance(29 * SECOND);
        assert.equal(polls.length, 1);
        await r.clock.advance(SECOND);
        assert.deepEqual(seconds(polls, from), [2, 80], "30 s after the slow poll ended, at 50 s");
    });

    test("a poll that answers nothing within 60 seconds is cancelled and counted as failed", async () => {
        const { r, polls, id } = started((n) => (n === 1 ? new Promise<PollOutcome<unknown>>(() => {}) : { state: n }));
        await r.clock.advance(FIRST_POLL_MS + POLL_TIMEOUT_MS - 1);
        assert.equal(polls[0]?.signal.aborted, false);
        await r.clock.advance(1);
        assert.equal(polls[0]?.signal.aborted, true);
        assert.equal(savedFile(state.dir, id).failures, 1);
        await r.clock.advance(30 * SECOND);
        assert.equal(polls.length, 2, "and the watch tries again");
        assert.equal(savedFile(state.dir, id).failures, 0);
    });

    test("an answer that is not an outcome is a failed poll, like a throw", async () => {
        const answers: unknown[] = [
            undefined, null, 42, "done",
            { state: 1, done: { outcome: "great", summary: "x" } },
            { state: 1, done: { outcome: "passed" } },
            { state: 1, done: { outcome: "passed", summary: "x", links: "https://x" } },
            { state: 1n },
        ];
        for (const [index, answer] of answers.entries()) {
            const { r, id } = started(() => answer as never);
            await r.clock.advance(FIRST_POLL_MS);
            assert.equal(savedFile(state.dir, id).failures, 1, `answer ${index}`);
            assert.equal(savedFile(state.dir, id).status, "open");
        }
    });

    test("a state that is not plain JSON is a failed poll, because a restart could not give it back", async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const { r, id } = started(() => ({ state: circular }));
        await r.clock.advance(FIRST_POLL_MS);
        assert.equal(savedFile(state.dir, id).failures, 1);
    });

    test("the state is kept as JSON, so it is what a restart would hand back", async () => {
        const { r, polls } = started((n) => ({ state: { at: new Date(0), gone: undefined, n } }));
        await r.clock.advance(FIRST_POLL_MS + 30 * SECOND);
        assert.deepEqual(polls[1]?.state, { at: "1970-01-01T00:00:00.000Z", n: 1 });
    });

    test("a poll function that throws before it returns a promise is a failed poll too", async () => {
        const { r, id } = started(() => ({ state: 1 }), { poll: (() => { throw new Error("not even a promise"); }) as never });
        await r.clock.advance(FIRST_POLL_MS);
        assert.equal(savedFile(state.dir, id).failures, 1);
    });
});

describe("finishing", () => {
    test("a poll that is done ends the watch: saved, announced once, and the agent told once", async () => {
        const { r, polls, id } = started((n) => (n < 3 ? { state: n } : {
            state: n,
            done: { outcome: "passed", summary: "12 of 12 checks passed", details: "build ok\ntest ok", links: ["https://ci.example/run/7"], facts: { passed: 12 } },
        }));
        await r.clock.advance(FIRST_POLL_MS + 60 * SECOND);
        assert.equal(polls.length, 3);

        const saved = savedFile(state.dir, id);
        assert.equal(saved.status, "done");
        assert.deepEqual(saved.result, {
            outcome: "passed", summary: "12 of 12 checks passed", details: "build ok\ntest ok", links: ["https://ci.example/run/7"], facts: { passed: 12 },
        });
        assert.equal(saved.finishedAt, new Date(polls[2]?.at ?? 0).toISOString());
        assert.equal("state" in saved, false, "a finished watch needs no poll state");

        assert.deepEqual(r.events, [{ id, kind: "k", plugin: "jig-test", title: "checks of pull request 42", result: saved.result }]);
        assert.equal(r.sent.length, 0, "the agent is told after the 1 s that results are given to arrive together");
        await r.clock.advance(SECOND);
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0]?.customType, "jig-watch");
        assert.equal(r.sent[0]?.display, true);

        await r.clock.advance(10 * MINUTE);
        assert.equal(polls.length, 3, "no poll after the end");
        assert.equal(r.sent.length, 1);
        assert.equal(r.events.length, 1);
        assert.equal(r.clock.pending(), 0);
    });

    test("every outcome a plugin can give ends the watch and tells the agent", async () => {
        for (const outcome of ["passed", "failed", "timed-out", "stopped", "error"] as const) {
            const { r } = started(() => ({ state: 1, done: { outcome, summary: `it ${outcome}` } }));
            await r.clock.advance(FIRST_POLL_MS + SECOND);
            assert.equal(r.sent.length, 1, outcome);
            assert.equal(r.events[0]?.result.outcome, outcome);
            assert.match(r.sent[0]?.content ?? "", new RegExp(`it ${outcome}`));
        }
    });

    test("the agent's message is built from the title, the outcome, the summary, a few detail lines and the links", async () => {
        const details = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
        const links = Array.from({ length: 7 }, (_, i) => `https://ci.example/${i + 1}`);
        const { r } = started(() => ({ state: 1, done: { outcome: "failed", summary: "2 of 12 checks failed: build, lint", details, links } }));
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(r.sent[0]?.content, [
            'The watch "checks of pull request 42" failed.',
            "2 of 12 checks failed: build, lint",
            "Details:",
            ...Array.from({ length: 10 }, (_, i) => `  line ${i + 1}`),
            "  [4 more lines not shown]",
            "Links:",
            ...links.slice(0, 5).map((link) => `  ${link}`),
            "  [2 more links not shown]",
        ].join("\n"));
    });

    test("a watch with only a summary gets a short message", async () => {
        const { r } = started(() => passed("all 3 jobs passed"));
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(r.sent[0]?.content, 'The watch "checks of pull request 42" passed.\nall 3 jobs passed');
    });

    test("the message carries what a screen or another plugin needs, besides its text", async () => {
        const { r, id } = started(() => passed());
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        assert.deepEqual(r.sent[0]?.details, { watches: [{ id, kind: "k", plugin: "jig-test", title: "checks of pull request 42", event: "finished", outcome: "passed" }] });
    });

    test("a plugin that ends a watch with the outcome stopped still tells the agent: nobody asked for that one", async () => {
        const { r } = started(() => ({ state: 1, done: { outcome: "stopped", summary: "the pull request was closed" } }));
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(r.sent.length, 1);
        assert.match(r.sent[0]?.content ?? "", /was stopped\.\nthe pull request was closed/);
    });
});

describe("the deadline", () => {
    test("is 60 minutes by default: the last poll is made at that moment, and a watch still not done ends as timed out", async () => {
        const { r, polls, from, id } = started((n) => ({ state: n }));
        await r.clock.advance(HOUR + 10 * MINUTE);
        const times = seconds(polls, from);
        assert.equal(times.at(-1), 3600, "the last poll is exactly at the deadline");
        assert.equal(times.at(-2), 3572, "the one before it keeps the cadence, and the next would have been past the deadline");
        assert.ok(times.every((time) => time <= 3600));

        const saved = savedFile(state.dir, id);
        assert.equal(saved.status, "done");
        assert.equal(saved.result?.outcome, "timed-out");
        assert.equal(saved.result?.summary, "It was not finished after 1 h, so Pi stopped watching.");
        assert.equal(saved.finishedAt, new Date(from + HOUR).toISOString());
        assert.equal(r.events.length, 1);
        assert.equal(r.events[0]?.result.outcome, "timed-out");
        assert.equal(r.sent.length, 1);
        assert.match(r.sent[0]?.content ?? "", /^The watch "checks of pull request 42" timed out\.\nIt was not finished after 1 h/);
        assert.equal(r.clock.pending(), 0);
    });

    test("can be set per watch", async () => {
        const { r, polls, from, id } = started((n) => ({ state: n }), {}, { timeoutMinutes: 2 });
        await r.clock.advance(5 * MINUTE);
        assert.deepEqual(seconds(polls, from), [2, 32, 62, 92, 120]);
        assert.equal(savedFile(state.dir, id).result?.summary, "It was not finished after 2 min, so Pi stopped watching.");
    });

    test("the last poll can still find the watch done, and then it is not timed out", async () => {
        const { r, polls, id } = started((n) => (n === 5 ? passed("finished at the last moment") : { state: n }), {}, { timeoutMinutes: 2 });
        await r.clock.advance(5 * MINUTE);
        assert.equal(polls.length, 5);
        assert.equal(savedFile(state.dir, id).result?.outcome, "passed");
        assert.equal(savedFile(state.dir, id).result?.summary, "finished at the last moment");
    });

    test("a last poll that fails ends the watch as timed out, and says why", async () => {
        const { r, id } = started((n) => { if (n === 5) throw new Error("GitHub said 502"); return { state: n }; }, {}, { timeoutMinutes: 2 });
        await r.clock.advance(5 * MINUTE);
        const result = savedFile(state.dir, id).result;
        assert.equal(result?.outcome, "timed-out");
        assert.equal(result?.summary, "It was not finished after 2 min, so Pi stopped watching. The last check failed: GitHub said 502");
    });

    test("a poll that was out when the deadline passed is the last one", async () => {
        let release: (() => void) | undefined;
        // The deadline is at 120 s. The poll at 92 s is slow and answers at 130 s.
        const { r, polls, id } = started((n) => (n === 4
            ? new Promise<PollOutcome<unknown>>((resolve) => { release = () => resolve({ state: 4 }); })
            : { state: n }), {}, { timeoutMinutes: 2 });
        await r.clock.advance(100 * SECOND);
        assert.equal(polls.length, 4);
        await r.clock.advance(30 * SECOND);
        release?.();
        await r.clock.settle();
        assert.equal(savedFile(state.dir, id).result?.outcome, "timed-out");
        assert.equal(polls.length, 4, "it was not polled once more");
    });
});

describe("a watch that outlives its stall time", () => {
    test("shows the user one notice, and does not wake the agent", async () => {
        const { r, polls, from } = started((n) => ({ state: n }));
        await r.clock.advance(29 * MINUTE);
        assert.equal(r.shown.length, 0);
        await r.clock.advance(2 * MINUTE);
        assert.equal(r.shown.length, 1);
        assert.equal(r.shown[0]?.level, "warning");
        assert.match(r.shown[0]?.message ?? "", /^Still waiting for "checks of pull request 42": it has been running for 30 min\.$/);
        assert.ok((polls.at(-1)?.at ?? 0) > from + 30 * MINUTE);
        await r.clock.advance(20 * MINUTE);
        assert.equal(r.shown.length, 1, "once, however long it goes on");
        assert.deepEqual(r.sent, []);
        assert.deepEqual(r.events, []);
    });

    test("can be set per watch", async () => {
        const { r } = started((n) => ({ state: n }), {}, { stallMinutes: 1 });
        await r.clock.advance(61 * SECOND);
        assert.equal(r.shown.length, 0, "the poll at 62 s is the first after the minute");
        await r.clock.advance(SECOND);
        assert.match(r.shown[0]?.message ?? "", /running for 1 min\./);
    });

    test("is not shown when the watch ends first", async () => {
        const { r } = started((n) => (n === 3 ? passed() : { state: n }), {}, { stallMinutes: 1 });
        await r.clock.advance(2 * MINUTE);
        assert.deepEqual(r.shown, []);
    });

    test("is owed until there is a screen: print mode shows nothing, and a session with a screen shows it", async () => {
        const first = rig({ screen: false });
        const { kind } = scripted(first.clock, "k", (n) => ({ state: n }));
        first.engine.registerKind(kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t", stallMinutes: 1 });
        await first.clock.advance(5 * MINUTE);
        assert.deepEqual(first.shown, []);
        assert.equal(savedFile(state.dir, id).stalled, undefined);
        first.engine.end();

        const second = rig({ clock: first.clock });
        second.engine.registerKind(scripted(second.clock, "k", (n) => ({ state: n })).kind);
        second.begin();
        await second.clock.advance(FIRST_POLL_MS);
        assert.equal(second.shown.length, 1);
        assert.equal(savedFile(state.dir, id).stalled, true);
    });

    test("is not shown again after a restart", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        first.engine.start({ kind: "k", spec: {}, title: "t", stallMinutes: 1 });
        await first.clock.advance(5 * MINUTE);
        assert.equal(first.shown.length, 1);
        first.engine.end();

        const second = rig({ clock: first.clock });
        second.engine.registerKind(scripted(second.clock, "k", (n) => ({ state: n })).kind);
        second.begin();
        await second.clock.advance(5 * MINUTE);
        assert.deepEqual(second.shown, []);
    });
});

describe("polls that fail", () => {
    const fails = (message = "GitHub said 502") => { throw new Error(message); };

    test("three in a row pause the watch, with one notice to the user and one message to the agent", async () => {
        const { r, polls, id } = started(() => fails("the login expired"));
        await r.clock.advance(5 * MINUTE);
        assert.equal(polls.length, 3, "and no more polls");
        assert.equal(savedFile(state.dir, id).status, "paused");
        assert.equal(savedFile(state.dir, id).failures, 3);

        assert.equal(r.shown.length, 1);
        assert.equal(r.shown[0]?.level, "warning");
        assert.match(r.shown[0]?.message ?? "", /^Paused "checks of pull request 42": 3 polls in a row failed \(the login expired\)\. It starts again when this session next starts\.$/);
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0]?.content, [
            'The watch "checks of pull request 42" is paused: its last 3 polls in a row failed. The last error was: the login expired',
            `It starts again when this session next starts. To give it up now, stop it with the watch tool (id ${id}).`,
        ].join("\n"));
        assert.deepEqual(r.sent[0]?.details, { watches: [{ id, kind: "k", plugin: "jig-test", title: "checks of pull request 42", event: "paused" }] });
        assert.deepEqual(r.events, [], "a paused watch has not ended");
        assert.equal(r.clock.pending(), 0);
        assert.deepEqual(r.engine.list().map((watch) => watch.status), ["paused"]);
    });

    test("a poll that works in between starts the count again", async () => {
        // Two failures, then a poll that works, over and over: three in a row never happen.
        const { r, polls, id } = started((n) => (n % 3 === 0 ? { state: n } : fails()));
        await r.clock.advance(10 * MINUTE);
        assert.ok(polls.length > 15, "never paused");
        assert.equal(savedFile(state.dir, id).status, "open");
        assert.deepEqual(r.shown, []);
    });

    test("the count is saved with the watch", async () => {
        const { r, id } = started(() => fails());
        await r.clock.advance(FIRST_POLL_MS);
        assert.equal(savedFile(state.dir, id).failures, 1);
        await r.clock.advance(30 * SECOND);
        assert.equal(savedFile(state.dir, id).failures, 2);
    });

    test("the error in the notices is cleaned, on one line, and short", async () => {
        const cleaning = rig({ protect: { redact: (text) => text.replaceAll("SECRET", "[redacted]"), mask: (text) => text } });
        cleaning.engine.registerKind(scripted(cleaning.clock, "k", () => fails(`line one\nline two SECRET ${"y".repeat(400)}`)).kind);
        cleaning.begin();
        cleaning.engine.start({ kind: "k", spec: {}, title: "t" });
        await cleaning.clock.advance(5 * MINUTE);
        const notice = cleaning.shown[0]?.message ?? "";
        assert.match(notice, /\(line one line two \[redacted\] y+…\)/);
        assert.ok(!notice.includes("SECRET") && !notice.includes("\n"));
        assert.ok(notice.length < 400, String(notice.length));
    });

    test("with no screen the user is not shown a notice, but the agent is still told", async () => {
        const r = rig({ screen: false });
        r.engine.registerKind(scripted(r.clock, "k", () => fails()).kind);
        r.begin();
        r.engine.start({ kind: "k", spec: {}, title: "t" });
        await r.clock.advance(5 * MINUTE);
        assert.deepEqual(r.shown, []);
        assert.equal(r.sent.length, 1);
    });

    test("a paused watch is picked up again at the next session start, with a fresh count", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", () => fails()).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t" });
        await first.clock.advance(5 * MINUTE);
        assert.equal(savedFile(state.dir, id).status, "paused");
        first.engine.end();

        const second = rig({ clock: first.clock });
        const { kind, polls } = scripted(second.clock, "k", (n) => (n < 3 ? fails() : { state: n }));
        second.engine.registerKind(kind);
        second.begin();
        assert.equal(savedFile(state.dir, id).status, "open");
        assert.equal(savedFile(state.dir, id).failures, 0);
        assert.deepEqual(second.engine.list().map((watch) => watch.status), ["open"]);
        await second.clock.advance(5 * MINUTE);
        assert.ok(polls.length > 3, "polled again, and two failures do not pause it");
        assert.equal(savedFile(state.dir, id).status, "open");
    });

    test("and paused again, with a new notice, if it fails three more times", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", () => fails()).kind);
        first.begin();
        first.engine.start({ kind: "k", spec: {}, title: "t" });
        await first.clock.advance(5 * MINUTE);
        first.engine.end();

        const second = rig({ clock: first.clock });
        second.engine.registerKind(scripted(second.clock, "k", () => fails()).kind);
        second.begin();
        await second.clock.advance(5 * MINUTE);
        assert.equal(second.shown.length, 1);
        assert.equal(second.sent.length, 1);
    });
});

describe("saved watches and a restart of Pi", () => {
    test("a new engine on the same folder picks up the watch where it stopped, with its saved state", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: { n } })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: { pr: 42 }, title: "checks of pull request 42" });
        await first.clock.advance(FIRST_POLL_MS + 30 * SECOND);
        first.engine.end();
        assert.equal(first.clock.pending(), 0);

        // Pi is closed for ten minutes.
        await first.clock.advance(10 * MINUTE);
        const second = rig({ clock: first.clock });
        const { kind, polls } = scripted(second.clock, "k", (n) => ({ state: { n: 100 + n } }));
        second.engine.registerKind(kind);
        second.begin();
        assert.deepEqual(second.engine.list().map((watch) => [watch.id, watch.title, watch.status]), [[id, "checks of pull request 42", "open"]]);
        const reopened = second.clock.now();
        await second.clock.advance(FIRST_POLL_MS - 1);
        assert.equal(polls.length, 0);
        await second.clock.advance(1);
        assert.equal(polls.length, 1, "the first poll is 2 s after the session starts");
        assert.deepEqual(polls[0]?.spec, { pr: 42 });
        assert.deepEqual(polls[0]?.state, { n: 2 }, "the state the first engine saved");
        assert.equal(polls[0]?.at, reopened + FIRST_POLL_MS);
        await second.clock.advance(30 * SECOND);
        assert.deepEqual(polls[1]?.state, { n: 101 });
    });

    test("a result that arrives at the first poll after a restart is told as 'While Pi was closed: '", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        first.engine.start({ kind: "k", spec: {}, title: "checks of pull request 42" });
        await first.clock.advance(FIRST_POLL_MS);
        first.engine.end();
        await first.clock.advance(5 * MINUTE);

        const second = rig({ clock: first.clock });
        second.engine.registerKind(scripted(second.clock, "k", () => passed("all 12 checks passed")).kind);
        second.begin();
        await second.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(second.sent.length, 1);
        assert.equal(second.sent[0]?.content, 'While Pi was closed: the watch "checks of pull request 42" passed.\nall 12 checks passed');
        assert.equal(second.sent[0]?.details.watches[0]?.afterRestart, true);
        assert.equal(second.events.length, 1);
    });

    test("but a result that arrives at a later poll is told as an ordinary one", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        first.engine.start({ kind: "k", spec: {}, title: "t" });
        await first.clock.advance(FIRST_POLL_MS);
        first.engine.end();

        const second = rig({ clock: first.clock });
        second.engine.registerKind(scripted(second.clock, "k", (n) => (n < 2 ? { state: n } : passed())).kind);
        second.begin();
        await second.clock.advance(FIRST_POLL_MS + 30 * SECOND + SECOND);
        assert.equal(second.sent.length, 1);
        assert.ok(second.sent[0]?.content.startsWith('The watch "t" passed.'), second.sent[0]?.content ?? "");
        assert.equal(second.sent[0]?.details.watches[0]?.afterRestart, undefined);
    });

    test("a deadline that passed while Pi was closed makes the first poll the last", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t", timeoutMinutes: 10 });
        await first.clock.advance(FIRST_POLL_MS);
        first.engine.end();
        await first.clock.advance(2 * HOUR);

        const second = rig({ clock: first.clock });
        const { kind, polls } = scripted(second.clock, "k", (n) => ({ state: n }));
        second.engine.registerKind(kind);
        second.begin();
        await second.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(polls.length, 1);
        assert.equal(savedFile(state.dir, id).result?.outcome, "timed-out");
        assert.match(second.sent[0]?.content ?? "", /^While Pi was closed: the watch "t" timed out\./);
    });

    test("only this session's watches are picked up; another session's stay as they are", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin("session-a");
        const mine = first.engine.start({ kind: "k", spec: { who: "mine" }, title: "mine" });
        first.engine.end();
        first.begin("session-b");
        const theirs = first.engine.start({ kind: "k", spec: { who: "theirs" }, title: "theirs" });
        first.engine.end();
        const before = savedFile(state.dir, theirs);

        const second = rig({ clock: first.clock });
        const { kind, polls } = scripted(second.clock, "k", (n) => ({ state: n }));
        second.engine.registerKind(kind);
        second.begin("session-a");
        assert.deepEqual(second.engine.list().map((watch) => watch.id), [mine]);
        assert.equal(second.engine.stop(theirs), false, "it is not this session's to stop");
        await second.clock.advance(10 * MINUTE);
        assert.deepEqual(savedFile(state.dir, theirs), before, "untouched");
        assert.ok(polls.length > 0);
        assert.ok(polls.every((polled) => (polled.spec as { who: string }).who === "mine"), "only this session's watch was polled");
    });

    test("a watch whose kind is not registered stays saved, and shows as waiting for its plugin", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "checks of pull request 42" });
        first.engine.end();
        const before = savedFile(state.dir, id);

        const second = rig({ clock: first.clock });
        second.begin();
        assert.equal(second.clock.pending(), 0, "nothing is waiting on a timer");
        const [entry] = second.engine.entries();
        assert.deepEqual([entry?.id, entry?.status, entry?.waiting, entry?.plugin], [id, "open", true, "jig-test"]);
        assert.equal(second.engine.list().length, 1);
        await second.clock.advance(HOUR);
        assert.deepEqual(savedFile(state.dir, id), before, "not polled, not timed out, not changed");
        second.engine.end();
        assert.deepEqual(savedFile(state.dir, id), before);
    });

    test("and it starts polling when its plugin registers the kind, even after the session started", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t" });
        first.engine.end();

        const second = rig({ clock: first.clock });
        second.begin();
        await second.clock.advance(10 * MINUTE);
        const { kind, polls } = scripted(second.clock, "k", () => passed("late but done"));
        second.engine.registerKind(kind);
        assert.equal(second.engine.entries()[0]?.waiting, false);
        await second.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(polls.length, 1);
        assert.equal(savedFile(state.dir, id).status, "done");
        assert.match(second.sent[0]?.content ?? "", /^While Pi was closed: /);
    });

    test("a file that cannot be read is skipped and reported, and the others still load", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "good" });
        first.engine.end();
        const folder = path.join(state.dir, "watches");
        writeFileSync(path.join(folder, "abcdefgh.json"), "{ not json");
        writeFileSync(path.join(folder, "bcdefghj.json"), JSON.stringify({ version: 1, id: "someone-else", kind: "k" }));
        writeFileSync(path.join(folder, "notes.txt"), "not a watch");

        const second = rig({ clock: first.clock });
        second.engine.registerKind(scripted(second.clock, "k", (n) => ({ state: n })).kind);
        second.begin();
        assert.deepEqual(second.engine.list().map((watch) => watch.id), [id]);
        assert.equal(second.engine.problem(), "2 saved watch files could not be read");
        assert.ok(existsSync(path.join(folder, "notes.txt")), "other files are left alone");
    });

    test("a watch file that was damaged by hand is not trusted", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t" });
        first.engine.end();
        const file = path.join(state.dir, "watches", `${id}.json`);
        const good = savedFile(state.dir, id);
        for (const damage of [
            { version: 2 }, { status: "stuck" }, { deadlineAt: "tomorrow" }, { failures: -1 }, { failures: 1.5 }, { session: 7 }, { title: null },
            { status: "done" },
        ]) {
            writeFileSync(file, JSON.stringify({ ...good, ...damage }));
            const again = rig({ clock: first.clock });
            again.begin();
            assert.deepEqual(again.engine.list(), [], JSON.stringify(damage));
            assert.match(again.engine.problem() ?? "", /1 saved watch file could not be read/);
        }
    });

    test("a folder that does not exist yet holds nothing, and is not an error", () => {
        const r = rig();
        r.begin();
        assert.equal(r.engine.problem(), undefined);
        assert.equal(existsSync(path.join(state.dir, "watches")), false, "starting a session creates no folder");
    });
});

describe("stopping a watch", () => {
    test("is false unless an open or paused watch of this session has that id", async () => {
        const { r, id } = started((n) => ({ state: n }));
        assert.equal(r.engine.stop("zzzzzzzz"), false);
        assert.equal(r.engine.stop(""), false);
        assert.equal(r.engine.stop(undefined as never), false);
        assert.equal(r.engine.stop(42 as never), false);
        assert.equal(r.engine.stop(id), true);
        assert.equal(r.engine.stop(id), false, "a stopped watch is done");
    });

    test("ends the watch as stopped: saved, announced, and no message to the agent", async () => {
        const { r, polls, id } = started((n) => ({ state: n }));
        await r.clock.advance(FIRST_POLL_MS + 30 * SECOND);
        assert.equal(r.engine.stop(id), true);
        const saved = savedFile(state.dir, id);
        assert.equal(saved.status, "done");
        assert.deepEqual(saved.result, { outcome: "stopped", summary: "Stopped before it finished." });
        assert.equal(r.events.length, 1);
        assert.equal(r.events[0]?.result.outcome, "stopped");
        assert.equal(r.events[0]?.id, id);
        assert.equal(r.clock.pending(), 0);

        await r.clock.advance(10 * MINUTE);
        assert.deepEqual(r.sent, [], "the agent or the user asked for this, so nobody needs a message");
        assert.equal(polls.length, 2);
    });

    test("works on a paused watch", async () => {
        const { r, id } = started(() => { throw new Error("down"); });
        await r.clock.advance(5 * MINUTE);
        assert.equal(r.engine.list()[0]?.status, "paused");
        assert.equal(r.engine.stop(id), true);
        assert.equal(savedFile(state.dir, id).result?.outcome, "stopped");
    });

    test("works on a watch that waits for its plugin", () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t" });
        first.engine.end();
        const second = rig({ clock: first.clock });
        second.begin();
        assert.equal(second.engine.stop(` ${id} `), true, "and a stray space around the id is forgiven");
        assert.equal(savedFile(state.dir, id).result?.outcome, "stopped");
    });

    test("cancels the poll that is out, and its late answer changes nothing", async () => {
        let release: (() => void) | undefined;
        const { r, polls, id } = started(() => new Promise<PollOutcome<unknown>>((resolve) => { release = () => resolve(passed("too late")); }));
        await r.clock.advance(FIRST_POLL_MS);
        assert.equal(polls.length, 1);
        assert.equal(r.engine.stop(id), true);
        assert.equal(polls[0]?.signal.aborted, true);
        release?.();
        await r.clock.settle();
        await r.clock.advance(5 * MINUTE);
        assert.equal(savedFile(state.dir, id).result?.outcome, "stopped");
        assert.equal(r.events.length, 1);
        assert.deepEqual(r.sent, []);
    });
});

describe("listing", () => {
    test("holds the contract's fields, and the result once a watch is done", async () => {
        const { r, id, from } = started((n) => (n === 2 ? passed("done") : { state: n }));
        assert.deepEqual(r.engine.list(), [{ id, kind: "k", plugin: "jig-test", title: "checks of pull request 42", status: "open", startedAt: new Date(from).toISOString() }]);
        await r.clock.advance(2 * MINUTE);
        assert.deepEqual(r.engine.list(), [{
            id, kind: "k", plugin: "jig-test", title: "checks of pull request 42", status: "done", startedAt: new Date(from).toISOString(),
            result: { outcome: "passed", summary: "done" },
        }]);
    });

    test("is this session's open and paused watches, oldest first, with the ones that finished in the last 24 hours", async () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "quick", () => passed()).kind);
        r.engine.registerKind(scripted(r.clock, "slow", (n) => ({ state: n }), { intervalMs: 10 * MINUTE }).kind);
        r.engine.registerKind(scripted(r.clock, "broken", () => { throw new Error("down"); }).kind);
        r.begin();
        const ids: string[] = [];
        ids.push(r.engine.start({ kind: "slow", spec: {}, title: "first", timeoutMinutes: 3 * 24 * 60 }));
        await r.clock.advance(SECOND);
        ids.push(r.engine.start({ kind: "quick", spec: {}, title: "second" }));
        await r.clock.advance(SECOND);
        ids.push(r.engine.start({ kind: "broken", spec: {}, title: "third" }));
        await r.clock.advance(10 * MINUTE);
        assert.deepEqual(r.engine.list().map((watch) => [watch.title, watch.status]), [["first", "open"], ["second", "done"], ["third", "paused"]]);
        assert.deepEqual(r.engine.list().map((watch) => watch.id), ids);

        // The finished one drops out 24 hours after it finished; the others stay for as long as they are not finished.
        const finishedAt = Date.parse(savedFile(state.dir, ids[1] as string).finishedAt as string);
        await r.clock.advance(finishedAt + LIST_WINDOW_MS - SECOND - r.clock.now());
        assert.ok(r.engine.list().some((watch) => watch.title === "second"), "a second inside the window");
        await r.clock.advance(2 * SECOND);
        assert.deepEqual(r.engine.list().map((watch) => watch.title), ["first", "third"]);
    });

    test("does not hold what a caller changes in what it was given", async () => {
        const { r } = started(() => passed());
        await r.clock.advance(5 * SECOND);
        const [info] = r.engine.list();
        assert.ok(info?.result);
        info.result.summary = "changed";
        info.title = "changed";
        assert.equal(r.engine.list()[0]?.result?.summary, "all good");
        assert.equal(r.engine.list()[0]?.title, "checks of pull request 42");
    });

    test("a watch finished in an earlier run of this session is listed when it finished in the last 24 hours", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", () => passed("done")).kind);
        first.begin();
        const id = first.engine.start({ kind: "k", spec: {}, title: "t" });
        await first.clock.advance(5 * SECOND);
        first.engine.end();
        await first.clock.advance(23 * HOUR);

        const second = rig({ clock: first.clock });
        second.begin();
        assert.deepEqual(second.engine.list().map((watch) => [watch.id, watch.status]), [[id, "done"]]);
        const third = rig({ clock: first.clock });
        await third.clock.advance(2 * HOUR);
        third.begin();
        assert.deepEqual(third.engine.list(), [], "25 hours later");
    });

    test("the entries the watch tool shows say which watches wait for their plugin, how old they are, and what the kind watches", async () => {
        const { r } = started((n) => ({ state: n }), { describe: (spec) => `pull request ${(spec as { pr: number }).pr}\nin the repository` });
        await r.clock.advance(90 * SECOND);
        const [entry] = r.engine.entries();
        assert.equal(entry?.ageMs, 90 * SECOND);
        assert.equal(entry?.waiting, false);
        assert.equal(entry?.describes, "pull request 42 in the repository");
    });

    test("a describe that throws or answers with something else is left out", () => {
        for (const describe of [() => { throw new Error("no"); }, () => 42, () => ""]) {
            const { r } = started((n) => ({ state: n }), { describe: describe as never });
            assert.equal(r.engine.entries()[0]?.describes, undefined);
        }
    });
});

describe("old files", () => {
    test("finished watches are deleted 7 days after they ended, whichever session they belong to", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", () => passed()).kind);
        first.begin("session-a");
        const old = first.engine.start({ kind: "k", spec: {}, title: "old" });
        await first.clock.advance(5 * SECOND);
        first.engine.end();
        first.begin("session-b");
        const other = first.engine.start({ kind: "k", spec: {}, title: "other" });
        await first.clock.advance(5 * SECOND);
        first.engine.end();
        await first.clock.advance(RETENTION_MS - 20 * SECOND);

        const kept = rig({ clock: first.clock });
        kept.begin("session-a");
        const folder = path.join(state.dir, "watches");
        assert.deepEqual(readdirSync(folder).sort(), [`${old}.json`, `${other}.json`].sort(), "6 days and 23 hours later, nothing is deleted yet");
        kept.engine.end();

        await first.clock.advance(30 * SECOND);
        const later = rig({ clock: first.clock });
        later.begin("session-a");
        assert.deepEqual(readdirSync(folder), [], "just past 7 days");
    });

    test("open and paused watches are never deleted, however old, and neither are other sessions' unfinished ones", async () => {
        const first = rig();
        first.engine.registerKind(scripted(first.clock, "k", (n) => ({ state: n })).kind);
        first.engine.registerKind(scripted(first.clock, "broken", () => { throw new Error("down"); }).kind);
        first.begin("session-a");
        const open = first.engine.start({ kind: "k", spec: {}, title: "open", timeoutMinutes: 30 * 24 * 60 });
        const paused = first.engine.start({ kind: "broken", spec: {}, title: "paused" });
        await first.clock.advance(5 * MINUTE);
        first.engine.end();
        first.begin("session-b");
        const elsewhere = first.engine.start({ kind: "k", spec: {}, title: "elsewhere", timeoutMinutes: 30 * 24 * 60 });
        first.engine.end();
        await first.clock.advance(20 * 24 * HOUR);

        const later = rig({ clock: first.clock });
        later.begin("session-c");
        assert.deepEqual(readdirSync(path.join(state.dir, "watches")).sort(), [open, paused, elsewhere].map((id) => `${id}.json`).sort());
    });

    test("a temporary file left by a writer that crashed is removed once it is an hour old", () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "k", () => ({ state: 1 })).kind);
        r.begin();
        r.engine.start({ kind: "k", spec: {}, title: "t" });
        r.engine.end();
        const folder = path.join(state.dir, "watches");
        const stale = path.join(folder, "abcdefgh.json.123.0a1b2c3d.tmp");
        const fresh = path.join(folder, "bcdefghj.json.123.0a1b2c3d.tmp");
        writeFileSync(stale, "{}");
        writeFileSync(fresh, "{}");
        const old = new Date(Date.now() - 2 * HOUR);
        utimesSync(stale, old, old);

        rig({ clock: r.clock }).begin();
        assert.equal(existsSync(stale), false);
        assert.equal(existsSync(fresh), true, "a writer may still be using it");
    });
});

describe("ending the session", () => {
    test("clears every timer, cancels the polls that are out, and keeps the saved watches", async () => {
        const r = rig();
        const { kind, polls } = scripted(r.clock, "k", (n) => (n === 1 ? new Promise<PollOutcome<unknown>>(() => {}) : { state: n }));
        r.engine.registerKind(kind);
        r.begin();
        const first = r.engine.start({ kind: "k", spec: {}, title: "its poll never answers" });
        const second = r.engine.start({ kind: "k", spec: {}, title: "waits for its next poll" });
        await r.clock.advance(FIRST_POLL_MS + 10 * SECOND);
        assert.equal(polls.length, 2);
        assert.equal(r.clock.pending(), 2, "the time limit of the poll that is out, and the next poll of the other");

        r.engine.end();
        assert.equal(r.clock.pending(), 0);
        assert.equal(polls[0]?.signal.aborted, true);
        assert.deepEqual(readdirSync(path.join(state.dir, "watches")).sort(), [`${first}.json`, `${second}.json`].sort());
        assert.equal(savedFile(state.dir, first).status, "open");
        assert.equal(savedFile(state.dir, second).status, "open");
        assert.deepEqual(r.engine.list(), []);

        await r.clock.advance(HOUR);
        assert.equal(r.sent.length, 0);
        assert.equal(r.events.length, 0);
    });

    test("an answer that comes after the end is ignored", async () => {
        let release: (() => void) | undefined;
        const { r, id } = started(() => new Promise<PollOutcome<unknown>>((resolve) => { release = () => resolve(passed("too late")); }));
        await r.clock.advance(FIRST_POLL_MS);
        r.engine.end();
        release?.();
        await r.clock.settle();
        assert.equal(savedFile(state.dir, id).status, "open");
        assert.deepEqual(r.events, []);
        assert.deepEqual(r.sent, []);
        assert.equal(r.clock.pending(), 0);
    });

    test("drops the message that waits, because the session it was for is gone", async () => {
        const { r } = started(() => passed());
        await r.clock.advance(FIRST_POLL_MS + 100);
        assert.equal(r.sent.length, 0);
        r.engine.end();
        await r.clock.advance(HOUR);
        assert.equal(r.sent.length, 0);
        assert.equal(r.clock.pending(), 0);
    });

    test("is safe twice, and a watch cannot be started after it", () => {
        const { r } = started((n) => ({ state: n }));
        r.engine.end();
        assert.doesNotThrow(() => r.engine.end());
        assert.throws(() => r.engine.start({ kind: "k", spec: {}, title: "t" }), /only while a session is running/);
    });

    test("beginning again without an end starts clean", async () => {
        const { r, polls, session } = started((n) => ({ state: n }));
        r.begin(session);
        assert.equal(r.clock.pending(), 1, "one timer for the one watch, not two");
        await r.clock.advance(FIRST_POLL_MS);
        assert.equal(polls.length, 1);
    });
});

describe("telling the agent", () => {
    /** Starts `count` watches of a kind that ends at its first poll, each `gap` ms after the one before. */
    async function endingWatches(r: Rig, gaps: number[]) {
        r.engine.registerKind(scripted(r.clock, "quick", (_n, polled) => passed(`result ${String((polled.spec as { n: number }).n)}`)).kind);
        r.begin();
        let n = 0;
        for (const gap of gaps) {
            await r.clock.advance(gap);
            r.engine.start({ kind: "quick", spec: { n: ++n }, title: `watch ${n}` });
        }
    }

    test("results that end within a second of each other go in one message", async () => {
        const r = rig();
        await endingWatches(r, [0, 300, 400]);
        // The watches end at 2.0 s, 2.3 s and 2.7 s after the first one started.
        await r.clock.advance(FIRST_POLL_MS + 5 * SECOND);
        assert.equal(r.sent.length, 1);
        assert.deepEqual(r.sent[0]?.details.watches.map((watch) => watch.title), ["watch 1", "watch 2", "watch 3"]);
        assert.equal(
            r.sent[0]?.content,
            [1, 2, 3].map((n) => `The watch "watch ${n}" passed.\nresult ${n}`).join("\n\n"),
            "one block for each, a blank line between",
        );
    });

    test("the message goes out one second after the first result, not before", async () => {
        const r = rig();
        await endingWatches(r, [0]);
        const started = r.clock.now();
        await r.clock.advance(FIRST_POLL_MS + 999);
        assert.equal(r.sent.length, 0);
        await r.clock.advance(1);
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0]?.at, started + FIRST_POLL_MS + 1000);
    });

    test("a result a little later than the second goes in the next message, which waits until 10 seconds after the first", async () => {
        const r = rig();
        await endingWatches(r, [0, 1_500]);
        const first = r.clock.now() - 1_500;
        await r.clock.advance(60 * SECOND);
        assert.deepEqual(r.sent.map((sent) => (sent.at - first) / 1000), [3, 13]);
        assert.deepEqual(r.sent.map((sent) => sent.details.watches.map((watch) => watch.title)), [["watch 1"], ["watch 2"]]);
    });

    test("messages are at least 10 seconds apart, and one waiting message takes every later result", async () => {
        const r = rig();
        // Results at 2 s, 5 s, 8 s and 11 s after the first start.
        await endingWatches(r, [0, 3_000, 3_000, 3_000]);
        const first = r.clock.now() - 9_000;
        await r.clock.advance(60 * SECOND);
        assert.deepEqual(r.sent.map((sent) => (sent.at - first) / 1000), [3, 13], "the first at 3 s; the next waits for 13 s");
        assert.deepEqual(
            r.sent.map((sent) => sent.details.watches.map((watch) => watch.title)),
            [["watch 1"], ["watch 2", "watch 3", "watch 4"]],
            "everything that ended while the second message waited is in it",
        );
    });

    test("after a quiet time a result goes out a second after it ended, with no further wait", async () => {
        const r = rig();
        await endingWatches(r, [0]);
        await r.clock.advance(5 * MINUTE);
        const before = r.clock.now();
        r.engine.start({ kind: "quick", spec: { n: 2 }, title: "watch 2" });
        await r.clock.advance(FIRST_POLL_MS + 1000);
        assert.equal(r.sent.length, 2);
        assert.equal(r.sent[1]?.at, before + FIRST_POLL_MS + 1000);
    });

    test("a pause is told the same way, and is combined with a result that ends just before it", async () => {
        const r = rig();
        r.engine.registerKind(scripted(r.clock, "quick", () => passed("fine")).kind);
        r.engine.registerKind(scripted(r.clock, "broken", () => { throw new Error("down"); }, { intervalMs: 5_000 }).kind);
        r.begin();
        r.engine.start({ kind: "broken", spec: {}, title: "broken one" }); // fails at 2 s, 7 s and 12 s
        await r.clock.advance(9_500);
        r.engine.start({ kind: "quick", spec: {}, title: "quick one" }); // ends at 11.5 s, so its message leaves at 12.5 s
        await r.clock.advance(10 * SECOND);
        assert.equal(r.sent.length, 1);
        assert.deepEqual(r.sent[0]?.details.watches.map((watch) => [watch.title, watch.event]), [["quick one", "finished"], ["broken one", "paused"]]);
        assert.match(r.sent[0]?.content ?? "", /passed\.\nfine\n\nThe watch "broken one" is paused/);
    });

});

describe("a plugin or Pi that fails", () => {
    test("a listener of the done event that throws does not change how the watch ended", async () => {
        const r = rig();
        const events: unknown[] = [];
        const sent: unknown[] = [];
        const engine = createWatchEngine({
            now: r.clock.now, timers: r.clock.timers, store: createWatchStore(),
            protect: { redact: (text) => text, mask: (text) => text },
            notify: () => true, emit: (event) => { events.push(event); throw new Error("a listener broke"); }, send: (message) => { sent.push(message); },
        });
        engine.registerKind(scripted(r.clock, "k", () => passed()).kind);
        engine.begin("session-1");
        const id = engine.start({ kind: "k", spec: {}, title: "t" });
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(events.length, 1);
        assert.equal(sent.length, 1, "the agent is told all the same");
        assert.equal(savedFile(state.dir, id).status, "done");
    });

    test("a message that cannot be sent is reported by /jig, and the next one still goes", async () => {
        const r = rig();
        let breaks = true;
        const sent: unknown[] = [];
        const engine = createWatchEngine({
            now: r.clock.now, timers: r.clock.timers, store: createWatchStore(),
            protect: { redact: (text) => text, mask: (text) => text },
            notify: () => true, emit: () => {},
            send: (message) => { if (breaks) throw new Error("the session is gone"); sent.push(message); },
        });
        engine.registerKind(scripted(r.clock, "k", () => passed()).kind);
        engine.begin("session-1");
        engine.start({ kind: "k", spec: {}, title: "first" });
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        assert.equal(engine.problem(), "could not tell the agent about a watch: the session is gone");
        breaks = false;
        engine.start({ kind: "k", spec: {}, title: "second" });
        await r.clock.advance(FIRST_POLL_MS + 10 * SECOND);
        assert.equal(sent.length, 1);
    });

    test("a screen that throws is ignored", async () => {
        const r = rig();
        const engine = createWatchEngine({
            now: r.clock.now, timers: r.clock.timers, store: createWatchStore(),
            protect: { redact: (text) => text, mask: (text) => text },
            notify: () => { throw new Error("stale context"); }, emit: () => {}, send: () => {},
        });
        engine.registerKind(scripted(r.clock, "k", () => { throw new Error("down"); }).kind);
        engine.begin("session-1");
        const id = engine.start({ kind: "k", spec: {}, title: "t", stallMinutes: 0.01 });
        await r.clock.advance(5 * MINUTE);
        assert.equal(savedFile(state.dir, id).status, "paused", "the watch still paused");
    });

    test("a state folder that cannot be written does not stop the watch, and /jig says so", async () => {
        const r = rig();
        const real = createWatchStore();
        let saves = 0;
        const engine = createWatchEngine({
            now: r.clock.now, timers: r.clock.timers,
            store: { ...real, save: () => { saves++; throw new Error("EACCES: permission denied"); } },
            protect: { redact: (text) => text, mask: (text) => text },
            notify: () => true, emit: () => {}, send: (message) => { r.sent.push({ ...message, at: r.clock.now() }); },
        });
        const { kind, polls } = scripted(r.clock, "k", (n) => (n === 3 ? passed("still works") : { state: n }));
        engine.registerKind(kind);
        engine.begin("session-1");
        engine.start({ kind: "k", spec: {}, title: "t" });
        await r.clock.advance(2 * MINUTE);
        assert.equal(polls.length, 3);
        assert.ok(saves >= 4);
        assert.match(engine.problem() ?? "", /^could not save watch [0-9a-z]{8}: EACCES: permission denied$/);
        assert.equal(r.sent.length, 1, "and the agent was told");
        assert.equal(engine.list()[0]?.status, "done");
    });
});

describe("what a finished watch says is cleaned first", () => {
    const protect = {
        redact: (text: string) => text.replaceAll("SECRET", "[redacted]"),
        mask: (text: string) => text.replaceAll("PERSONAL", "[masked]"),
    };

    async function finishedWith(result: PollOutcome<unknown>["done"], options: Parameters<typeof rig>[0] = { protect }) {
        const r = rig(options);
        r.engine.registerKind(scripted(r.clock, "k", () => ({ state: 1, ...(result === undefined ? {} : { done: result }) })).kind);
        r.begin();
        const id = r.engine.start({ kind: "k", spec: {}, title: "t" });
        await r.clock.advance(FIRST_POLL_MS + SECOND);
        return { r, id };
    }

    test("the summary and the details are redacted, then masked, in the saved result, the event and the message", async () => {
        const { r, id } = await finishedWith({
            outcome: "failed",
            summary: "SECRET for PERSONAL",
            details: "log: SECRET\nlog: PERSONAL",
            links: ["https://ci.example/run?token=SECRET"],
        });
        const expected = { outcome: "failed", summary: "[redacted] for [masked]", details: "log: [redacted]\nlog: [masked]", links: ["https://ci.example/run?token=[redacted]"] };
        assert.deepEqual(savedFile(state.dir, id).result, expected);
        assert.deepEqual(r.events[0]?.result, expected);
        assert.equal(r.sent.length, 1);
        assert.ok(!r.sent[0]?.content.includes("SECRET") && !r.sent[0]?.content.includes("PERSONAL"));
        assert.match(r.sent[0]?.content ?? "", /\[redacted\] for \[masked\]\nDetails:\n {2}log: \[redacted\]\n {2}log: \[masked\]\nLinks:\n {2}https:\/\/ci\.example\/run\?token=\[redacted\]$/);
    });

    test("redaction runs before masking, so the masker never sees a secret that the redactor knows", async () => {
        const order: string[] = [];
        const { id } = await finishedWith(
            { outcome: "passed", summary: "SECRET" },
            { protect: { redact: (text) => { order.push("redact"); return text.replaceAll("SECRET", "[redacted]"); }, mask: (text) => { order.push(`mask:${text}`); return text; } } },
        );
        assert.deepEqual(order.slice(0, 2), ["redact", "mask:[redacted]"]);
        assert.equal(savedFile(state.dir, id).result?.summary, "[redacted]");
    });

    test("the details are cut to 40 lines in the result, and the message shows the first 10", async () => {
        const { r, id } = await finishedWith({
            outcome: "failed", summary: "s", details: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
        });
        const kept = savedFile(state.dir, id).result?.details?.split("\n") ?? [];
        assert.equal(kept.length, 40);
        assert.equal(kept.at(-1), "[61 more lines cut]");
        assert.equal(r.events[0]?.result.details, savedFile(state.dir, id).result?.details);
        const shown = (r.sent[0]?.content ?? "").split("\n");
        assert.equal(shown.filter((line) => /^ {2}line \d+$/.test(line)).length, 10);
        assert.ok(shown.includes("  [30 more lines not shown]"));
    });

    test("when the masker cannot mask, the outcome is kept and the text is withheld everywhere", async () => {
        const { r, id } = await finishedWith(
            { outcome: "failed", summary: "customer jane.doe@example.com", details: "and more" },
            { protect: { redact: (text) => text, mask: () => { throw new Error("masking is broken"); } } },
        );
        const result = savedFile(state.dir, id).result;
        assert.equal(result?.outcome, "failed");
        assert.equal(result?.summary, "summary withheld: it could not be masked");
        assert.equal(result?.details, undefined);
        assert.ok(!JSON.stringify(r.events).includes("jane.doe"));
        assert.ok(!(r.sent[0]?.content ?? "").includes("jane.doe"));
        assert.equal(r.sent.length, 1, "the agent still learns that it failed");
    });

    test("a timed-out watch's summary is cleaned too, because it carries the text of the last error", async () => {
        const r = rig({ protect });
        r.engine.registerKind(scripted(r.clock, "k", (n) => { if (n >= 2) throw new Error("login SECRET for PERSONAL"); return { state: n }; }).kind);
        r.begin();
        const id = r.engine.start({ kind: "k", spec: {}, title: "t", timeoutMinutes: 1 });
        await r.clock.advance(2 * MINUTE);
        assert.equal(savedFile(state.dir, id).result?.summary, "It was not finished after 1 min, so Pi stopped watching. The last check failed: login [redacted] for [masked]");
    });

    test("the title in the agent's message and in the notices is redacted; the saved title is what the plugin gave", async () => {
        const r = rig({ protect });
        r.engine.registerKind(scripted(r.clock, "k", (n) => (n < 3 ? { state: n } : passed())).kind);
        r.begin();
        const id = r.engine.start({ kind: "k", spec: {}, title: "deploy with SECRET", stallMinutes: 0.5 });
        // The poll at 32 s is the first after the half minute, so the notice comes then; the watch ends at 62 s.
        await r.clock.advance(FIRST_POLL_MS + 60 * SECOND + SECOND);
        assert.deepEqual(r.shown.map((notice) => notice.message), ['Still waiting for "deploy with [redacted]": it has been running for 32 s.']);
        assert.ok(r.sent[0]?.content.startsWith('The watch "deploy with [redacted]" passed.'));
        assert.equal(r.sent[0]?.details.watches[0]?.title, "deploy with [redacted]");
        assert.equal(savedFile(state.dir, id).title, "deploy with SECRET");
    });

    test("colour codes in a log are gone before the agent sees them", async () => {
        const { r } = await finishedWith({ outcome: "failed", summary: "\u001b[31mfailed\u001b[0m", details: "\u001b[1mbuild\u001b[0m: error\u001b]0;title\u0007" }, { protect: { redact: (t) => t, mask: (t) => t } });
        assert.equal(r.sent[0]?.content, 'The watch "t" failed.\nfailed\nDetails:\n  build: error');
    });
});
