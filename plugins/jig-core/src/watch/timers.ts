// The timers the watch engine uses, behind a small interface so a test can drive time by hand.

export interface Timers {
    /** Runs `callback` once, after `ms`. The engine treats the handle as opaque and only gives it to `clearTimeout`. */
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** Node's timers, none of which keeps the process alive. Pi in print mode must be able to exit with a watch open: the
 *  watch is saved, and the next session picks it up. */
export const realTimers: Timers = {
    setTimeout(callback, ms) {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
    },
    clearTimeout(handle) {
        clearTimeout(handle as NodeJS.Timeout);
    },
};
