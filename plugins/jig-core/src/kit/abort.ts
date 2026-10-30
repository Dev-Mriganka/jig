// Waiting for work that may ignore its signal. Stateless: see values.ts.

/**
 * Rejects with the signal's reason when `signal` aborts, whatever `work` is doing: a transport or a `fetch` stub is
 * another package's code and may ignore its signal, and a time limit must hold anyway.
 *
 * `work` is always observed, also when the signal is already aborted, so a rejection that comes later is handled and is
 * never an unhandled rejection.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
    });
}
