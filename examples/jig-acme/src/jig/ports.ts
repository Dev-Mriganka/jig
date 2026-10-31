// Helpers for a tunnel that starts a program and waits for it to open a local port: a port that is really free, a test of
// whether a port accepts connections or answers a SOCKS greeting, and a wait for either. They hold no state and talk to nothing
// but 127.0.0.1. A company plugin cannot import this file (Pi gives each package its own module root), so it keeps a copy,
// the way it keeps `client.ts`; this file therefore imports nothing but Node's own `node:net`.
import { connect, createServer } from "node:net";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a test of a port waits for an answer before it says no. */
const PROBE_MS = 2000;

/** What a SOCKS5 client sends first: version 5, one method, "no authentication". */
const SOCKS_GREETING = Buffer.from([0x05, 0x01, 0x00]);

/** Whether something accepts connections on `127.0.0.1:port`. Never rejects. */
export function portAccepts(port: number, timeoutMs: number = PROBE_MS): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const done = (ok: boolean): void => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

/**
 * Whether a SOCKS5 proxy answers on `127.0.0.1:port`: a greeting is sent and a reply that starts with version 5 comes back.
 * A port that merely accepts (a proxy that has not finished starting, or a program that is not a proxy) is not enough.
 * Never rejects.
 */
export function socksAnswers(port: number, timeoutMs: number = PROBE_MS): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const done = (ok: boolean): void => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once("connect", () => socket.write(SOCKS_GREETING));
        socket.once("data", (reply: Buffer) => done(reply.length >= 2 && reply[0] === 0x05));
        socket.once("close", () => done(false));
        socket.once("error", () => done(false));
    });
}

export interface FreePortOptions {
    /** How a port is tested. Default: `portAccepts`. */
    accepts?: (port: number) => Promise<boolean>;
    /** The most times a port is tested while it still accepts. Default 100, 10 ms apart. */
    attempts?: number;
}

/**
 * A port nothing listens on. A listener that was just closed can go on accepting connections for a few milliseconds, which
 * would look like a program that is up, so the port is only handed out once it refuses connections. Rejects when no port can
 * be had at all.
 */
export async function freePort(options: FreePortOptions = {}): Promise<number> {
    const accepts = options.accepts ?? portAccepts;
    const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        const fail = (): void => reject(new Error("cannot find a free local port"));
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const found = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => (found > 0 ? resolve(found) : fail()));
        });
    });
    for (let attempt = 0; attempt < (options.attempts ?? 100) && (await accepts(port)); attempt++) await sleep(10);
    return port;
}

/** Why `waitForPort` stopped without the port being ready. */
export class PortWaitError extends Error {
    readonly reason: "timeout" | "cancelled";
    constructor(reason: "timeout" | "cancelled") {
        super(reason === "timeout" ? "the port did not become ready in time" : "the wait was cancelled");
        this.name = "PortWaitError";
        this.reason = reason;
    }
}

export interface WaitOptions {
    /** The longest to wait. */
    timeoutMs: number;
    /** The time between two tests. */
    pollMs: number;
    /** What ready means: `forward` (the default) accepts a connection, `socks` answers a SOCKS5 greeting. */
    kind?: "forward" | "socks";
    /** How long one test of the port waits for an answer. Default 2 seconds. */
    probeMs?: number;
    /** Replaces the test, for a caller that is tested with a fake. Default: by `kind`. */
    ready?: (port: number) => Promise<boolean>;
    /** Asked before each test: an error to throw because the program that should open the port has ended, or nothing. */
    failed?: () => Error | undefined;
    /** Cancels the wait. */
    signal?: AbortSignal;
}

/**
 * Waits until the port is ready. Each round it checks, in this order, whether the wait was cancelled, whether the program
 * has failed (which throws what `failed` gives), whether the port is ready, and whether the time is over. Rejects with a
 * `PortWaitError` on a cancel or a timeout.
 */
export async function waitForPort(port: number, options: WaitOptions): Promise<void> {
    const test = options.kind === "socks" ? socksAnswers : portAccepts;
    const ready = options.ready ?? ((candidate: number) => test(candidate, options.probeMs));
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        // A function and not a copy of the flag, because the flag changes while this waits.
        if (options.signal?.aborted === true) throw new PortWaitError("cancelled");
        const failure = options.failed?.();
        if (failure !== undefined) throw failure;
        if (await ready(port)) return;
        if (Date.now() > deadline) throw new PortWaitError("timeout");
        await sleep(options.pollMs);
    }
}
