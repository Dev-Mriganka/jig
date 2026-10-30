// A clock and timers that a test moves by hand, so the watch engine can be driven through hours in a few milliseconds.
//
// `advance(ms)` runs each timer that falls due at its own time, in order, and lets promises settle between timers, so a
// poll that awaits something has finished before the next timer runs.
import type { Timers } from "../../src/watch/timers.ts";

interface Waiting {
    id: number;
    at: number;
    callback: () => void;
}

export interface FakeClock {
    /** Milliseconds since the epoch, as `Date.now()` would say. */
    now(): number;
    date(): Date;
    timers: Timers;
    /** Timers that have been set and have neither run nor been cleared. */
    pending(): number;
    /** Moves time forward by `ms`. */
    advance(ms: number): Promise<void>;
    /** Lets promises settle without moving time. */
    settle(): Promise<void>;
}

/** A time to start from that has nothing special about it: not midnight, not a month end. */
export const START = Date.parse("2026-10-30T10:00:00.000Z");

export function fakeClock(start: number = START): FakeClock {
    let time = start;
    let counter = 0;
    const waiting = new Map<number, Waiting>();

    // Real `setImmediate` runs after every pending promise callback, which is what "settled" means for code that only
    // awaits promises.
    const settle = async (): Promise<void> => {
        for (let round = 0; round < 3; round++) await new Promise<void>((resolve) => setImmediate(resolve));
    };

    return {
        now: () => time,
        date: () => new Date(time),
        timers: {
            setTimeout(callback, ms) {
                const id = ++counter;
                waiting.set(id, { id, at: time + Math.max(0, ms), callback });
                return id;
            },
            clearTimeout(handle) {
                waiting.delete(handle as number);
            },
        },
        pending: () => waiting.size,
        settle,
        async advance(ms) {
            const target = time + ms;
            for (;;) {
                const next = [...waiting.values()]
                    .filter((timer) => timer.at <= target)
                    .sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (next === undefined) break;
                waiting.delete(next.id);
                time = Math.max(time, next.at);
                next.callback();
                await settle();
            }
            time = target;
            await settle();
        },
    };
}
