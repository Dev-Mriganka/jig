// A watch engine wired to fakes: a clock a test moves by hand, recorders for what it tells the user, other plugins and the
// agent, and the real store in the temporary state folder. A second rig on the same clock and folder is Pi opened again.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PollOutcome, WatchDoneEvent, WatchKind } from "../../src/contract.ts";
import type { Protect } from "../../src/watch/clean.ts";
import { createWatchEngine } from "../../src/watch/engine.ts";
import type { WatchEngine } from "../../src/watch/engine.ts";
import type { WatchMessage } from "../../src/watch/message.ts";
import { createWatchStore } from "../../src/watch/store.ts";
import type { SavedWatch } from "../../src/watch/store.ts";
import { fakeClock } from "./clock.ts";
import type { FakeClock } from "./clock.ts";

/** Cleans nothing: for tests that are about something else. */
export const PLAIN: Protect = { redact: (text) => text, mask: (text) => text };

export interface Rig {
    clock: FakeClock;
    engine: WatchEngine;
    /** What the user was shown, in order. */
    shown: Array<{ message: string; level: string }>;
    /** What other plugins were told, in order. */
    events: WatchDoneEvent[];
    /** What the agent was sent, in order, with the time it was sent. */
    sent: Array<WatchMessage & { at: number }>;
    /** Whether the session has a screen. Set to false for print mode. */
    screen: { on: boolean };
    /** Starts the session. */
    begin(session?: string): void;
}

export interface RigOptions {
    clock?: FakeClock;
    protect?: Protect;
    screen?: boolean;
}

export function rig(options: RigOptions = {}): Rig {
    const clock = options.clock ?? fakeClock();
    const shown: Rig["shown"] = [];
    const events: WatchDoneEvent[] = [];
    const sent: Rig["sent"] = [];
    const screen = { on: options.screen ?? true };
    const engine = createWatchEngine({
        now: clock.now,
        timers: clock.timers,
        store: createWatchStore(),
        protect: options.protect ?? PLAIN,
        notify(message, level) {
            if (!screen.on) return false;
            shown.push({ message, level });
            return true;
        },
        emit: (event) => { events.push(event); },
        send: (message) => { sent.push({ ...message, at: clock.now() }); },
    });
    return { clock, engine, shown, events, sent, screen, begin: (session = "session-1") => engine.begin(session) };
}

/** One call of a kind's `poll`. */
export interface Polled {
    /** When it was made, in milliseconds since the epoch. */
    at: number;
    spec: unknown;
    state: unknown;
    signal: AbortSignal;
}

/** What a scripted poll does: answers, or throws (a thrown value is a failed poll). */
export type Answer = PollOutcome<unknown> | Promise<PollOutcome<unknown>>;

/** A kind whose polls are recorded and answered by `answer`, which is given the number of this poll (from 1). */
export function scripted(
    clock: FakeClock,
    name: string,
    answer: (n: number, polled: Polled) => Answer,
    extra: Partial<WatchKind<unknown, unknown>> = {},
): { kind: WatchKind<unknown, unknown>; polls: Polled[] } {
    const polls: Polled[] = [];
    const kind: WatchKind<unknown, unknown> = {
        kind: name,
        plugin: "jig-test",
        intervalMs: 30_000,
        describe: () => "a test watch",
        async poll(spec, state, signal) {
            const polled = { at: clock.now(), spec, state, signal };
            polls.push(polled);
            return answer(polls.length, polled);
        },
        ...extra,
    };
    return { kind, polls };
}

/** A finished result, for the polls that end a watch. */
export const passed = (summary = "all good"): PollOutcome<unknown> => ({ state: "end", done: { outcome: "passed", summary } });

/** The saved file of a watch, as the engine wrote it. */
export function savedFile(stateDir: string, id: string): SavedWatch {
    return JSON.parse(readFileSync(path.join(stateDir, "watches", `${id}.json`), "utf8")) as SavedWatch;
}

/** Offsets of the polls from a start time, in seconds, for comparing a cadence at a glance. */
export function seconds(polls: readonly Polled[], from: number): number[] {
    return polls.map((polled) => (polled.at - from) / 1000);
}
