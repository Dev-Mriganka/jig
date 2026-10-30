// A SOCKS5 proxy in front of the database, with the real driver: the proxy is a tiny SOCKS5 server written here, and behind it
// are small servers that speak enough of MongoDB's wire protocol to answer the driver's handshake and `listDatabases`. What this
// shows is that every member of an address is reached THROUGH the proxy, by its own name, which a forward cannot do.
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import * as driver from "mongodb";
import type { Backend, ConnectTarget } from "../src/backend.ts";
import type { Connection } from "../src/config.ts";
import { settingsOf } from "../src/config.ts";
import { adaptClient, clientOptions } from "../src/driver.ts";
import { describeFailure } from "../src/errors.ts";
import { freePort, probe } from "../src/route.ts";
import { Session } from "../src/session.ts";
import type { SessionDeps } from "../src/session.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";

// ---- a SOCKS5 server (RFC 1928, no authentication, CONNECT only) -------------------------------------------------------

interface Socks {
    port: number;
    /** What the clients asked to reach, as `host:port`, in order. */
    requests: string[];
    /** Where each name goes: the port of a server on this machine. A name that is not here is answered "host unreachable". */
    routes: Map<string, number>;
    close(): Promise<void>;
}

async function startSocks(): Promise<Socks> {
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    const routes = new Map<string, number>();
    const server = createServer((client) => {
        sockets.add(client);
        client.on("close", () => sockets.delete(client));
        client.on("error", () => client.destroy());
        let stage: "greeting" | "request" | "piping" = "greeting";
        let buffer = Buffer.alloc(0);
        client.on("data", (chunk: Buffer) => {
            if (stage === "piping") return;
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === "greeting") {
                // VER NMETHODS METHODS...: answer "no authentication".
                if (buffer.length < 2 || buffer.length < 2 + (buffer[1] as number)) return;
                client.write(Buffer.from([0x05, 0x00]));
                buffer = buffer.subarray(2 + (buffer[1] as number));
                stage = "request";
            }
            if (stage === "request") {
                // VER CMD RSV ATYP DST.ADDR DST.PORT
                if (buffer.length < 5) return;
                const type = buffer[3] as number;
                let host: string;
                let end: number;
                if (type === 0x03) {
                    const length = buffer[4] as number;
                    end = 5 + length;
                    if (buffer.length < end + 2) return;
                    host = buffer.subarray(5, end).toString("utf8");
                } else if (type === 0x01) {
                    end = 8;
                    if (buffer.length < end + 2) return;
                    host = [...buffer.subarray(4, 8)].join(".");
                } else {
                    client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    return;
                }
                const port = buffer.readUInt16BE(end);
                const rest = buffer.subarray(end + 2);
                requests.push(`${host}:${port}`);
                const local = buffer[1] === 0x01 ? routes.get(`${host}:${port}`) : undefined;
                if (local === undefined) {
                    // 0x04: host unreachable.
                    client.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    return;
                }
                stage = "piping";
                const upstream = connect({ host: "127.0.0.1", port: local });
                sockets.add(upstream);
                upstream.on("close", () => sockets.delete(upstream));
                upstream.on("error", () => client.destroy());
                upstream.once("connect", () => {
                    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    if (rest.length > 0) upstream.write(rest);
                    client.pipe(upstream);
                    upstream.pipe(client);
                });
                client.on("close", () => upstream.destroy());
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: (server.address() as AddressInfo).port,
        requests,
        routes,
        close: () => closeAll(server, sockets),
    };
}

function closeAll(server: Server, sockets: Set<Socket>): Promise<void> {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
}

// ---- a server that speaks enough MongoDB ---------------------------------------------------------------------------------

interface Mongod {
    port: number;
    /** How many connections it accepted. */
    connections: number;
    close(): Promise<void>;
}

const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

/**
 * Answers every command with one document that is a handshake reply and a `listDatabases` reply at once, so the driver sees a
 * server (a standalone one, or a member of a replica set) with one database, `orders`.
 */
async function startMongod(member?: { me: string; members: string[]; primary: boolean }): Promise<Mongod> {
    const sockets = new Set<Socket>();
    const reply = (): Buffer =>
        Buffer.from(
            driver.BSON.serialize({
                ismaster: member?.primary ?? true,
                isWritablePrimary: member?.primary ?? true,
                secondary: member !== undefined && !member.primary,
                helloOk: true,
                maxBsonObjectSize: 16_777_216,
                maxMessageSizeBytes: 48_000_000,
                maxWriteBatchSize: 100_000,
                localTime: new Date(),
                logicalSessionTimeoutMinutes: 30,
                connectionId: 1,
                minWireVersion: 0,
                maxWireVersion: 21,
                readOnly: false,
                ok: 1,
                databases: [{ name: "orders" }],
                ...(member === undefined
                    ? {}
                    : { setName: "rs0", hosts: member.members, primary: member.members[0], me: member.me }),
            }),
        );
    const result: Mongod = { port: 0, connections: 0, close: () => closeAll(server, sockets) };
    const server = createServer((socket) => {
        result.connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 16) {
                const length = buffer.readInt32LE(0);
                if (buffer.length < length) return;
                const requestId = buffer.readInt32LE(4);
                const opCode = buffer.readInt32LE(12);
                buffer = buffer.subarray(length);
                const doc = reply();
                if (opCode === OP_QUERY) {
                    // The first message, the handshake, is a legacy query and gets a legacy reply.
                    const head = Buffer.alloc(36);
                    head.writeInt32LE(36 + doc.length, 0);
                    head.writeInt32LE(1, 4);
                    head.writeInt32LE(requestId, 8);
                    head.writeInt32LE(OP_REPLY, 12);
                    head.writeInt32LE(8, 16); // AwaitCapable
                    head.writeInt32LE(1, 32); // one document
                    socket.write(Buffer.concat([head, doc]));
                } else if (opCode === OP_MSG) {
                    const head = Buffer.alloc(21);
                    head.writeInt32LE(21 + doc.length, 0);
                    head.writeInt32LE(1, 4);
                    head.writeInt32LE(requestId, 8);
                    head.writeInt32LE(OP_MSG, 12);
                    head.writeUInt32LE(0, 16); // no flags
                    head.writeUInt8(0, 20); // one section: a document
                    socket.write(Buffer.concat([head, doc]));
                }
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    result.port = (server.address() as AddressInfo).port;
    return result;
}

// ---- the driver, as the tool makes it, with a short wait ---------------------------------------------------------------

/** What `connectDriver` does, with the sign-in left out (the servers above ask for none) and a shorter wait to select a server. */
async function open(target: ConnectTarget): Promise<Backend> {
    const client = new driver.MongoClient(target.uri, {
        ...clientOptions({ ...target, user: "" }),
        serverSelectionTimeoutMS: 1500,
        connectTimeoutMS: 1000,
    } as never);
    try {
        await client.connect();
    } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
    }
    return adaptClient(client, driver);
}

const target = (uri: string, extra: Partial<ConnectTarget> = {}): ConnectTarget => ({
    environment: "staging",
    uri,
    user: "",
    password: "",
    production: false,
    ...extra,
});

let proxy: Socks;
const servers: Mongod[] = [];
const backends: Backend[] = [];
beforeEach(async () => {
    proxy = await startSocks();
});
afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close().catch(() => undefined);
    await proxy.close();
    for (const server of servers.splice(0)) await server.close();
});

async function mongod(...args: Parameters<typeof startMongod>): Promise<Mongod> {
    const server = await startMongod(...args);
    servers.push(server);
    return server;
}

describe("the driver through a SOCKS5 proxy", () => {
    test("reaches a host that exists only on the far side, by its own name and port", async () => {
        const far = await mongod();
        proxy.routes.set("db.staging.example.test:27017", far.port);
        const backend = await open(
            target("mongodb://db.staging.example.test:27017/orders", {
                proxyHost: "127.0.0.1",
                proxyPort: proxy.port,
            }),
        );
        backends.push(backend);
        assert.deepEqual(await backend.databases({ maxTimeMS: 3000 }), ["orders"]);
        assert.ok(far.connections >= 1);
        assert.deepEqual([...new Set(proxy.requests)], ["db.staging.example.test:27017"]);
    });

    test("reaches every member of a replica set through the proxy, which a forward to one host cannot", async () => {
        const a = "a.staging.example.test:27017";
        const b = "b.staging.example.test:27017";
        const first = await mongod({ me: a, members: [a, b], primary: true });
        const second = await mongod({ me: b, members: [a, b], primary: false });
        proxy.routes.set(a, first.port);
        proxy.routes.set(b, second.port);
        const backend = await open(
            target(`mongodb://${a},${b}/orders?replicaSet=rs0`, { proxyHost: "127.0.0.1", proxyPort: proxy.port }),
        );
        backends.push(backend);
        assert.deepEqual(await backend.databases({ maxTimeMS: 3000 }), ["orders"]);
        // The driver monitors every member, so both were asked for, each by its name.
        for (let attempt = 0; attempt < 100 && second.connections === 0; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual([...new Set(proxy.requests)].sort(), [a, b]);
        assert.ok(first.connections >= 1 && second.connections >= 1, "both members were connected to");
    });

    test("with the proxy refusing the name, the driver cannot reach the database, and the tool says so", async () => {
        const failure: unknown = await open(
            target("mongodb://db.staging.example.test:27017/orders", { proxyHost: "127.0.0.1", proxyPort: proxy.port }),
        ).catch((error: unknown) => error);
        assert.equal((failure as Error).name, "MongoServerSelectionError");
        assert.deepEqual(
            [...new Set(proxy.requests)],
            ["db.staging.example.test:27017"],
            "it did go through the proxy",
        );
        const told = describeFailure(failure, {
            environment: "staging",
            production: false,
            maxTimeMS: 1000,
            aborted: false,
        });
        assert.match(told.message, /^cannot reach the staging database/);
    });

    test("a proxy that is not there is a failure to select a server too, and nothing is reached directly", async () => {
        const far = await mongod();
        const closed = await freePort();
        const failure: unknown = await open(
            // The real address would work if the proxy were not in the way: it is the proxy that is asked.
            target(`mongodb://127.0.0.1:${far.port}/orders`, { proxyHost: "127.0.0.1", proxyPort: closed }),
        ).catch((error: unknown) => error);
        assert.equal((failure as Error).name, "MongoServerSelectionError");
        assert.equal(far.connections, 0, "the database was not connected to behind the proxy's back");
    });
});

describe("a tunnel from a company's provider, through the session", () => {
    let jig: FakeJig;
    before(() => void (jig = installFakeJig()));
    after(() => jig.remove());
    beforeEach(() => {
        jig.reset();
        jig.secrets.set("pass:mongo/staging", "db-pass-staging");
    });

    function deps(): SessionDeps {
        return {
            connect: open,
            route: {
                run: (file, args, options) => jig.api.exec.run(file, args, options),
                openTunnel: (name, to, signal) => jig.api.tunnels.open(name, to, signal),
                resolveSecret: (reference, signal) => jig.api.secrets.resolve(reference, signal),
                freePort,
                probe,
                tmpDir: () => "/tmp",
                readyTimeoutMs: 5000,
                pollMs: 20,
                lifetimeMs: 60_000,
            },
            idleMs: 300_000,
            setTimer: () => ({ cancel: () => undefined }),
        };
    }

    const connectionTo = (uri: string): Connection => {
        const settings = settingsOf({
            connections: {
                staging: { uri, user: "agent", password: "pass:mongo/staging", via: { tunnel: "corp-net" } },
            },
        });
        return settings?.connections.get("staging") as Connection;
    };

    test("a SOCKS tunnel carries a replica set: every member by its name, and the tunnel closes with the session", async () => {
        const a = "a.staging.example.test:27017";
        const b = "b.staging.example.test:27017";
        const first = await mongod({ me: a, members: [a, b], primary: true });
        const second = await mongod({ me: b, members: [a, b], primary: false });
        proxy.routes.set(a, first.port);
        proxy.routes.set(b, second.port);
        let closed = 0;
        const asked: Array<{ host: string; port: number }> = [];
        jig.api.tunnels.register("corp-net", {
            open: async (to) => {
                asked.push(to);
                return { kind: "socks", port: proxy.port, close: () => void closed++ };
            },
        });
        const session = new Session(deps());
        const lease = await session.acquire(connectionTo(`mongodb://${a},${b}/orders?replicaSet=rs0`), false);
        assert.deepEqual(await lease.backend.databases({ maxTimeMS: 3000 }), ["orders"]);
        lease.release();
        assert.deepEqual(asked, [{ host: "a.staging.example.test", port: 27017 }]);
        for (let attempt = 0; attempt < 100 && second.connections === 0; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual([...new Set(proxy.requests)].sort(), [a, b]);
        await session.closeAll();
        assert.equal(closed, 1);
    });

    test("a forward tunnel is connected to as to the host itself, as before: no proxy is involved", async () => {
        const far = await mongod();
        jig.api.tunnels.register("corp-net", {
            open: async () => ({ kind: "forward", port: far.port, close: () => undefined }),
        });
        const session = new Session(deps());
        const lease = await session.acquire(connectionTo("mongodb://db.staging.example.test:27017/orders"), false);
        assert.deepEqual(await lease.backend.databases({ maxTimeMS: 3000 }), ["orders"]);
        lease.release();
        assert.deepEqual(proxy.requests, [], "the proxy was not used");
        assert.ok(far.connections >= 1);
        await session.closeAll();
    });
});
