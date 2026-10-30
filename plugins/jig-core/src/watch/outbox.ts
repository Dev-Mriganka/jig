// Telling the agent without flooding it.
//
// Every message that starts a turn costs the agent a turn, and watches often end together (a push starts several). So:
// - items that arrive within 1 s of the first one wait for it and go out in one message;
// - messages go out at least 10 s apart;
// - only one message waits at a time. Items that arrive while it waits join it, whether or not its time has come.
//
// The timer is the only thing that sends, so nothing is sent from inside a call that added an item.
import type { Timers } from "./timers.ts";

/** Items that arrive this soon after the first one share its message. */
export const COALESCE_MS = 1_000;
/** The shortest time between two messages. */
export const MIN_GAP_MS = 10_000;

export interface Outbox<T> {
    /** Queues an item. It goes out with the others that wait, once the delays allow. */
    add(item: T): void;
    /** Drops what waits and stops the timer. Nothing is sent after this. */
    clear(): void;
    /** How many items wait. */
    waiting(): number;
}

export interface OutboxOptions<T> {
    now: () => number;
    timers: Timers;
    /** Sends one message with these items. May throw: the items are then lost, and the outbox goes on. */
    send(items: T[]): void;
}

export function createOutbox<T>(options: OutboxOptions<T>): Outbox<T> {
    const { now, timers } = options;
    let items: T[] = [];
    let timer: unknown;
    let lastSentAt: number | undefined;

    function flush(): void {
        timer = undefined;
        const batch = items;
        items = [];
        // Counted before sending, so a send that fails still spaces the next message from this one.
        lastSentAt = now();
        try {
            options.send(batch);
        } catch {
            // The caller reports what it needs to; a timer callback must not throw.
        }
    }

    return {
        add(item) {
            items.push(item);
            if (timer !== undefined) return; // the message that waits takes it
            const earliest = Math.max(now() + COALESCE_MS, lastSentAt === undefined ? 0 : lastSentAt + MIN_GAP_MS);
            timer = timers.setTimeout(flush, earliest - now());
        },

        clear() {
            if (timer !== undefined) timers.clearTimeout(timer);
            timer = undefined;
            items = [];
            lastSentAt = undefined;
        },

        waiting: () => items.length,
    };
}
