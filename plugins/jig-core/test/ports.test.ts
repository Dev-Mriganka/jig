// The helpers a tunnel shares from `src/kit/ports.ts`: a port that is really free, a test of whether a port accepts or answers a
// SOCKS greeting, and the wait for either. Every server here is on 127.0.0.1 and belongs to the test.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { afterEach, describe, test } from "node:test";
import { freePort, PortWaitError, portAccepts, socksAnswers, waitForPort } from "../src/kit/ports.ts";

const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A server on this machine whose connections are handled by `onConnection`. Returns its port. */
async function listen(onConnection: (socket: Socket) => void, port = 0): Promise<number> {
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        // A client that goes away at once (a test of a port) must not take the server down with a reset.
        socket.on("error", () => {});
        onConnection(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
}

/** A SOCKS5 proxy that answers the greeting as the protocol says: version 5, no authentication. */
const socksProxy = (socket: Socket): void => {
    socket.once("data", (greeting: Buffer) => {
        if (greeting[0] === 0x05) socket.write(Buffer.from([0x05, 0x00]));
        else socket.destroy();
    });
};

describe("portAccepts", () => {
    test("is true for a port something listens on, and false for one nothing does", async () => {
        const port = await listen(() => {});
        assert.equal(await portAccepts(port), true);
        const closed = await freePort();
        assert.equal(await portAccepts(closed), false);
    });

    test("is false for a port nothing listens on, however short the time", async () => {
        assert.equal(await portAccepts(await freePort(), 50), false);
    });
});

describe("socksAnswers", () => {
    test("is true for a proxy that answers the greeting with version 5", async () => {
        assert.equal(await socksAnswers(await listen(socksProxy)), true);
    });

    test("is false for a port that accepts and says nothing, so the wait goes on", async () => {
        assert.equal(await socksAnswers(await listen(() => {}), 80), false);
    });

    test("is false for a server that is not a proxy, and for one that hangs up", async () => {
        assert.equal(
            await socksAnswers(await listen((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))),
            false,
        );
        assert.equal(await socksAnswers(await listen((socket) => socket.destroy())), false);
    });

    test("is false for a closed port", async () => {
        assert.equal(await socksAnswers(await freePort()), false);
    });
});

describe("freePort", () => {
    test("hands out a port that refuses connections", async () => {
        for (let round = 0; round < 5; round++) assert.equal(await portAccepts(await freePort()), false);
    });

    test("waits while the port it found still accepts, and hands it out once it refuses", async () => {
        const tested: number[] = [];
        let answers = [true, true, true, false];
        const port = await freePort({
            accepts: async (candidate) => {
                tested.push(candidate);
                return answers.shift() ?? false;
            },
        });
        assert.deepEqual(tested, [port, port, port, port], "the same port was asked about until it refused");
        answers = [];
    });

    test("gives up waiting after the attempts it was allowed, rather than for ever", async () => {
        let asked = 0;
        await freePort({
            accepts: async () => {
                asked++;
                return true;
            },
            attempts: 3,
        });
        assert.equal(asked, 3);
    });
});

describe("waitForPort", () => {
    test("returns at once for a port that is ready", async () => {
        const port = await listen(() => {});
        await waitForPort(port, { timeoutMs: 1000, pollMs: 10 });
    });

    test("waits for a port that opens later, asking again until it does", async () => {
        const port = await freePort();
        const opening = new Promise<void>((resolve) =>
            setTimeout(() => void listen(() => {}, port).then(() => resolve()), 120),
        );
        await waitForPort(port, { timeoutMs: 5000, pollMs: 10 });
        await opening;
        assert.equal(await portAccepts(port), true);
    });

    test("for a SOCKS proxy it waits for the greeting to be answered, not just for the connection", async () => {
        let ready = false;
        const port = await listen((socket) => {
            socket.on("data", (greeting: Buffer) => {
                if (ready && greeting[0] === 0x05) socket.write(Buffer.from([0x05, 0x00]));
            });
        });
        const waiting = waitForPort(port, { timeoutMs: 5000, pollMs: 10, probeMs: 60, kind: "socks" });
        let settled = false;
        void waiting.then(() => {
            settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(settled, false, "the port accepts, but no greeting was answered");
        ready = true;
        await waiting;
    });

    test("rejects with a timeout when the port never opens", async () => {
        const port = await freePort();
        const failure = await waitForPort(port, { timeoutMs: 60, pollMs: 10 }).catch((error: Error) => error);
        assert.ok(failure instanceof PortWaitError);
        assert.equal((failure as PortWaitError).reason, "timeout");
    });

    test("rejects as cancelled when the signal fires, without waiting for the time to run out", async () => {
        const controller = new AbortController();
        const waiting = waitForPort(await freePort(), { timeoutMs: 60_000, pollMs: 10, signal: controller.signal });
        setTimeout(() => controller.abort(), 40);
        const failure = await waiting.catch((error: Error) => error);
        assert.ok(failure instanceof PortWaitError);
        assert.equal((failure as PortWaitError).reason, "cancelled");
    });

    test("a signal that fired before the wait began stops it before the port is even tried", async () => {
        const controller = new AbortController();
        controller.abort();
        let tried = 0;
        const failure = await waitForPort(1, {
            timeoutMs: 1000,
            pollMs: 10,
            signal: controller.signal,
            ready: async () => {
                tried++;
                return true;
            },
        }).catch((error: Error) => error);
        assert.equal((failure as PortWaitError).reason, "cancelled");
        assert.equal(tried, 0);
    });

    test("throws what `failed` gives as soon as the program that should open the port has ended", async () => {
        let ended = false;
        setTimeout(() => {
            ended = true;
        }, 40);
        const failure = await waitForPort(await freePort(), {
            timeoutMs: 60_000,
            pollMs: 10,
            failed: () => (ended ? new Error("ssh ended") : undefined),
        }).catch((error: Error) => error);
        assert.equal((failure as Error).message, "ssh ended");
        assert.equal(failure instanceof PortWaitError, false);
    });

    test("a failure is reported before a port that happens to be ready, and a cancel before a failure", async () => {
        const port = await listen(() => {});
        await assert.rejects(
            waitForPort(port, { timeoutMs: 1000, pollMs: 10, failed: () => new Error("gone") }),
            /gone/,
        );
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            waitForPort(port, {
                timeoutMs: 1000,
                pollMs: 10,
                signal: controller.signal,
                failed: () => new Error("gone"),
            }),
            (error: Error) => error instanceof PortWaitError,
        );
    });

    test("tests the port the caller's way when it gives a test of its own", async () => {
        let asked = 0;
        await waitForPort(1, {
            timeoutMs: 1000,
            pollMs: 5,
            ready: async () => ++asked >= 3,
        });
        assert.equal(asked, 3);
    });
});
