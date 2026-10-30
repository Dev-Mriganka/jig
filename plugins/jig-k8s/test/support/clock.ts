// A clock that only moves when a wait sleeps, so a rollout that takes minutes is checked in a few milliseconds. The
// kubectl calls still run for real, but they do not move this clock.
import type { Waiting } from "../../src/status.ts";

/** An hour after the pods of the fixtures were created. */
export const NOW = Date.parse("2026-10-15T09:00:00Z");

export interface FakeClock {
    deps: Waiting;
    /** The length of every sleep, in order. */
    sleeps: number[];
    /** The progress notes, in order. */
    progress: string[];
    /** Runs after each sleep, with the number of sleeps so far. The place to stop the call, or to change the cluster. */
    afterSleep: ((count: number) => void) | undefined;
    now(): number;
}

export function fakeClock(start = NOW): FakeClock {
    let time = start;
    const clock: FakeClock = {
        sleeps: [],
        progress: [],
        afterSleep: undefined,
        now: () => time,
        deps: {
            now: () => time,
            async sleep(ms, signal) {
                if (signal?.aborted) throw signal.reason ?? new Error("aborted");
                clock.sleeps.push(ms);
                time += ms;
                clock.afterSleep?.(clock.sleeps.length);
                if (signal?.aborted) throw signal.reason ?? new Error("aborted");
            },
            progress: (text) => void clock.progress.push(text),
        },
    };
    return clock;
}
