// The connections kept for the session: reuse, the idle close, the start that fails, and what the driver is told to connect to when
// a route sits in front of the database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Backend, ConnectTarget } from "../src/backend.ts";
import { settingsOf } from "../src/config.ts";
import type { Connection } from "../src/config.ts";
import { RouteError } from "../src/errors.ts";
import { freePort, probe } from "../src/route.ts";
import { Session } from "../src/session.ts";
import type { SessionDeps, Timer } from "../src/session.ts";
import { fakeBackend } from "./support/fake-backend.ts";
import type { FakeBackend } from "./support/fake-backend.ts";
import { fakeSsh } from "./support/fake-ssh.ts";
import type { FakeSsh } from "./support/fake-ssh.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";

let jig: FakeJig;
let ssh: FakeSsh;
let scratch: string;
let backends: FakeBackend[];
let targets: ConnectTarget[];
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
let session: Session;

before(() => void (jig = installFakeJig()));
after(() => jig.remove());
beforeEach(() => {
    jig.reset();
    ssh = fakeSsh();
    jig.useProgramsIn(ssh.bin);
    jig.secrets.set("pass:mongo/staging", "db-pass-staging");
    jig.secrets.set("pass:ssh/bastion", "key-text");
    scratch = mkdtempSync(path.join(tmpdir(), "jig-mongo-scratch-"));
    backends = [];
    targets = [];
    timers = [];
    session = new Session(deps());
});
afterEach(async () => {
    await session.closeAll();
    ssh.remove();
    rmSync(scratch, { recursive: true, force: true });
});

function deps(extra: Partial<SessionDeps> = {}): SessionDeps {
    return {
        async connect(target) {
            targets.push(target);
            const backend = fakeBackend();
            backends.push(backend);
            return backend as Backend;
        },
        route: {
            run: (file, args, options) => jig.api.exec.run(file, args, options),
            openTunnel: (name, target, signal) => jig.api.tunnels.open(name, target, signal),
            resolveSecret: (reference, signal) => jig.api.secrets.resolve(reference, signal),
            freePort,
            probe,
            tmpDir: () => scratch,
            readyTimeoutMs: 5000,
            pollMs: 20,
            lifetimeMs: 60_000,
        },
        idleMs: 300_000,
        setTimer(fn, ms): Timer {
            const timer = { fn, ms, cancelled: false };
            timers.push(timer);
            return { cancel: () => void (timer.cancelled = true) };
        },
        ...extra,
    };
}

const connection = (
    via: Record<string, unknown> | undefined,
    uri = "mongodb://db.example.com:27017/orders?appName=x",
): Connection => {
    const settings = settingsOf({
        connections: {
            staging: {
                uri,
                user: "agent",
                password: "pass:mongo/staging",
                tls: true,
                authSource: "admin",
                ...(via === undefined ? {} : { via }),
            },
        },
    });
    return settings?.connections.get("staging") as Connection;
};
/** The connections of one environment that has several, as the section gives them: by name. */
const clusters = (via?: Record<string, unknown>, extra: Record<string, unknown> = {}): Map<string, Connection> => {
    const make = (host: string) => ({
        uri: `mongodb://${host}:27017/orders`,
        user: "agent",
        password: "pass:mongo/staging",
        ...(via === undefined ? {} : { via }),
        ...extra,
    });
    const settings = settingsOf({
        connections: { staging: { orders: make("orders.example.com"), billing: make("billing.example.com") } },
    });
    return settings?.connections as Map<string, Connection>;
};
const SSH = { ssh: { host: "bastion.example.com", user: "agent", key: "pass:ssh/bastion" } };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const active = () => timers.filter((timer) => !timer.cancelled);

describe("a direct connection", () => {
    test("connects as configured, with the password resolved only now, and with no route", async () => {
        const lease = await session.acquire(connection(undefined), false);
        assert.deepEqual(targets, [
            {
                environment: "staging",
                uri: "mongodb://db.example.com:27017/orders?appName=x",
                user: "agent",
                password: "db-pass-staging",
                production: false,
                authSource: "admin",
                tls: true,
            },
        ]);
        assert.ok(!targets[0]?.uri.includes("db-pass"), "the address holds no credential");
        assert.deepEqual(jig.resolved, ["pass:mongo/staging"]);
        assert.equal(jig.started.length, 0);
        lease.release();
    });

    test("the connection is reused, and the password is not read again", async () => {
        (await session.acquire(connection(undefined), false)).release();
        (await session.acquire(connection(undefined), false)).release();
        assert.equal(targets.length, 1);
        assert.deepEqual(jig.resolved, ["pass:mongo/staging"]);
        assert.deepEqual(session.environments(), ["staging"]);
    });

    test("calls that arrive while it starts share one start", async () => {
        const leases = await Promise.all([1, 2, 3].map(() => session.acquire(connection(undefined), false)));
        assert.equal(targets.length, 1);
        for (const lease of leases) lease.release();
    });

    test("production is passed on, for the choice of a secondary", async () => {
        (await session.acquire(connection(undefined), true)).release();
        assert.equal(targets[0]?.production, true);
    });
});

describe("idle, failure and the end of the session", () => {
    test("idle for the idle time closes the connection; use in between keeps it", async () => {
        const lease = await session.acquire(connection(undefined), false);
        assert.equal(active().length, 0, "no idle timer while a call is using it");
        lease.release();
        assert.equal(active().length, 1);
        assert.equal(active()[0]?.ms, 300_000);
        (await session.acquire(connection(undefined), false)).release();
        assert.equal(targets.length, 1);
        assert.equal(active().length, 1, "the timer was started again");
        active()[0]?.fn();
        await settle();
        assert.equal(backends[0]?.closed, 1);
        assert.deepEqual(session.environments(), []);
        (await session.acquire(connection(undefined), false)).release();
        assert.equal(targets.length, 2);
    });

    test("a connection that failed in use is dropped, and the next call opens a new one", async () => {
        (await session.acquire(connection(undefined), false)).release(true);
        await settle();
        assert.equal(backends[0]?.closed, 1);
        (await session.acquire(connection(undefined), false)).release();
        assert.equal(targets.length, 2);
    });

    test("a start that fails is not kept: the next call tries again", async () => {
        let failures = 1;
        session = new Session(
            deps({
                async connect(target) {
                    targets.push(target);
                    if (failures-- > 0) throw new Error("cannot connect");
                    return fakeBackend() as Backend;
                },
            }),
        );
        await assert.rejects(session.acquire(connection(undefined), false), /cannot connect/);
        assert.deepEqual(session.environments(), []);
        (await session.acquire(connection(undefined), false)).release();
        assert.equal(targets.length, 2);
    });

    test("a call cancelled while connecting stops waiting, and the connection closes when idle", async () => {
        let finish: (backend: Backend) => void = () => {};
        session = new Session(deps({ connect: () => new Promise<Backend>((resolve) => void (finish = resolve)) }));
        const controller = new AbortController();
        const pending = session.acquire(connection(undefined), false, controller.signal);
        controller.abort();
        await assert.rejects(
            pending,
            (error: unknown) => error instanceof RouteError && /cancelled while connecting/.test(error.message),
        );
        finish(fakeBackend() as Backend);
        await settle();
        assert.equal(active().length, 1, "the connection that finished anyway is closed after its idle time");
    });

    test("closeAll closes every connection and stops every forward, and is safe twice", async () => {
        (await session.acquire(connection(SSH), false)).release();
        const forwarded = jig.started[0];
        assert.ok(forwarded);
        await session.closeAll();
        assert.equal(backends[0]?.closed, 1);
        assert.deepEqual(session.environments(), []);
        await session.closeAll();
        assert.equal(backends[0]?.closed, 1);
    });
});

describe("a route in front of the database", () => {
    test("an SSH route: the driver is told to connect to the local end, one host, with the certificate of the database host", async () => {
        const lease = await session.acquire(connection(SSH), false);
        const target = targets[0] as ConnectTarget;
        const forward = ssh.runs()[0]?.argv[(ssh.runs()[0]?.argv.indexOf("-L") as number) + 1] as string;
        const [, port, host, remotePort] = forward.split(":");
        assert.equal(host, "db.example.com");
        assert.equal(remotePort, "27017");
        assert.equal(target.uri, `mongodb://127.0.0.1:${port}/orders?appName=x`);
        assert.equal(target.serverName, "db.example.com");
        assert.equal(target.directConnection, true);
        assert.equal(target.password, "db-pass-staging");
        assert.deepEqual(jig.resolved, ["pass:ssh/bastion", "pass:mongo/staging"]);
        lease.release();
    });

    test("the forward is stopped when the connection closes", async () => {
        (await session.acquire(connection(SSH), false)).release();
        const port = Number(targets[0]?.uri.match(/:(\d+)\//)?.[1]);
        assert.equal(await probe(port), true);
        active()[0]?.fn();
        await settle();
        for (let attempt = 0; attempt < 100 && (await probe(port)); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(await probe(port), false, "the port closed");
    });

    test("a forward that died is replaced by the next call, with a new connection behind it", async () => {
        const ends: Array<() => void> = [];
        session = new Session(
            deps({
                route: {
                    ...deps().route,
                    run: () =>
                        new Promise(
                            (resolve) =>
                                void ends.push(() => resolve({ code: 255, stdout: "", stderr: "", timedOut: false })),
                        ),
                    probe: async () => true,
                },
            }),
        );
        (await session.acquire(connection(SSH), false)).release();
        assert.equal(targets.length, 1);
        ends[0]?.();
        await settle();
        (await session.acquire(connection(SSH), false)).release();
        assert.equal(targets.length, 2);
        assert.equal(ends.length, 2);
        assert.equal(backends[0]?.closed, 1, "the connection behind the dead forward was closed");
    });

    test("a failing forward fails the call before any driver is asked, and is not kept", async () => {
        ssh.mode("denied");
        // Nothing listens: the port that was handed out can be given to another test's server in a full run, and the real probe
        // would call that a forward that works.
        session = new Session(deps({ route: { ...deps().route, probe: async () => false } }));
        await assert.rejects(session.acquire(connection(SSH), false), /the bastion refused the SSH key/);
        assert.equal(targets.length, 0);
        assert.deepEqual(session.environments(), []);
        assert.deepEqual(
            jig.resolved,
            ["pass:ssh/bastion"],
            "the database password was not read for a route that failed",
        );
    });

    test("a driver that fails to connect behind a forward stops the forward", async () => {
        session = new Session(
            deps({
                connect: async () => {
                    throw new Error("no server");
                },
            }),
        );
        await assert.rejects(session.acquire(connection(SSH), false), /no server/);
        const port = Number(ssh.runs()[0]?.argv[(ssh.runs()[0]?.argv.indexOf("-L") as number) + 1]?.split(":")[1]);
        for (let attempt = 0; attempt < 100 && (await probe(port)); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(await probe(port), false);
    });

    test("a tunnel route says no tunnel provider is registered, and reads no secret for it", async () => {
        await assert.rejects(
            session.acquire(connection({ tunnel: "corp-net" }), false),
            (error: unknown) => error instanceof RouteError && /no tunnel provider is registered/.test(error.message),
        );
        assert.equal(targets.length, 0);
        assert.deepEqual(jig.resolved, []);
        assert.deepEqual(session.environments(), []);
    });
});

/** A company's tunnel provider that records what it was asked and how it was closed. */
function provider(kind: "forward" | "socks" | undefined, port = 41_111) {
    const log = { opened: [] as Array<{ host: string; port: number }>, closed: 0 };
    jig.api.tunnels.register("corp-net", {
        open: async (target) => {
            log.opened.push(target);
            return {
                ...(kind === undefined ? {} : { kind }),
                port,
                close: () => {
                    log.closed++;
                },
            };
        },
    });
    return log;
}
const TUNNEL = { tunnel: "corp-net" };

describe("a company's tunnel that is a forward", () => {
    test("is used as the ssh forward is: the driver connects to the local port, with the certificate of the real host", async () => {
        const log = provider("forward");
        (await session.acquire(connection(TUNNEL), false)).release();
        assert.deepEqual(log.opened, [{ host: "db.example.com", port: 27017 }]);
        assert.deepEqual(targets, [
            {
                environment: "staging",
                uri: "mongodb://127.0.0.1:41111/orders?appName=x",
                user: "agent",
                password: "db-pass-staging",
                production: false,
                authSource: "admin",
                tls: true,
                serverName: "db.example.com",
                directConnection: true,
            },
        ]);
        assert.equal((targets[0] as ConnectTarget).proxyHost, undefined);
        assert.equal(jig.started.length, 0, "no ssh was run");
    });

    test("is the default for a provider that does not say its kind", async () => {
        provider(undefined, 41_222);
        (await session.acquire(connection(TUNNEL), false)).release();
        assert.equal(targets[0]?.uri, "mongodb://127.0.0.1:41222/orders?appName=x");
        assert.equal(targets[0]?.directConnection, true);
    });

    test("cannot carry a replica set or a mongodb+srv address, and says so, and is closed", async () => {
        const log = provider("forward");
        for (const uri of [
            "mongodb://a.example.com:27017,b.example.com:27017/orders?replicaSet=rs0",
            "mongodb+srv://cluster.example.com/orders",
        ]) {
            await assert.rejects(
                session.acquire(connection(TUNNEL, uri), false),
                (error: unknown) =>
                    error instanceof RouteError &&
                    /the tunnel "corp-net" reaches one host and port, and the uri of staging names a replica set or mongodb\+srv/.test(
                        error.message,
                    ) &&
                    /a tunnel that is a SOCKS proxy/.test(error.message),
                uri,
            );
        }
        await settle();
        assert.equal(log.closed, 2, "each tunnel was closed");
        assert.equal(targets.length, 0);
        assert.deepEqual(jig.resolved, [], "no secret was read for a route that cannot work");
    });

    test("is closed when the connection closes, once, even if the provider's close fails", async () => {
        let closes = 0;
        jig.api.tunnels.register("corp-net", {
            open: async () => ({
                kind: "forward",
                port: 41_333,
                close: async () => {
                    closes++;
                    throw new Error("already gone");
                },
            }),
        });
        (await session.acquire(connection(TUNNEL), false)).release();
        active()[0]?.fn();
        await settle();
        await session.closeAll();
        assert.equal(closes, 1);
        assert.deepEqual(session.environments(), []);
    });

    test("that fails to open fails the call, in a line that does not repeat the provider's address", async () => {
        jig.api.tunnels.register("corp-net", {
            open: async () => {
                throw new Error("jump host 10.9.8.7 refused the session\nsecond line");
            },
        });
        await assert.rejects(
            session.acquire(connection(TUNNEL), false),
            /^RouteError: the tunnel "corp-net" could not be opened: tunnel provider "corp-net" failed: jump host 10\.9\.8\.7 refused the session second line$/,
        );
        assert.deepEqual(session.environments(), []);
        assert.equal(targets.length, 0);
    });

    test("whose call is cancelled while the provider is opening is closed when it finally opens", async () => {
        let release: () => void = () => {};
        let closed = 0;
        jig.api.tunnels.register("corp-net", {
            open: () =>
                new Promise((resolve) => {
                    release = () => resolve({ kind: "forward", port: 41_444, close: () => void closed++ });
                }),
        });
        const controller = new AbortController();
        const acquiring = session.acquire(connection(TUNNEL), false, controller.signal);
        await settle();
        controller.abort();
        await assert.rejects(acquiring, /cancelled/);
        release();
        await settle();
        await settle();
        assert.equal(closed, 1, "a tunnel nobody is waiting for is not left open");
        assert.equal(targets.length, 0);
    });
});

describe("a company's tunnel that is a SOCKS proxy", () => {
    test("is handed to the driver as a proxy, and the address stays the real one, replica sets and all", async () => {
        const log = provider("socks", 41_555);
        const uri = "mongodb://a.example.com:27017,b.example.com:27017/orders?replicaSet=rs0";
        (await session.acquire(connection(TUNNEL, uri), false)).release();
        assert.deepEqual(log.opened, [{ host: "a.example.com", port: 27017 }]);
        assert.deepEqual(targets, [
            {
                environment: "staging",
                uri,
                user: "agent",
                password: "db-pass-staging",
                production: false,
                authSource: "admin",
                tls: true,
                proxyHost: "127.0.0.1",
                proxyPort: 41_555,
            },
        ]);
        assert.equal(
            (targets[0] as ConnectTarget).directConnection,
            undefined,
            "the members are discovered, each through the proxy",
        );
        assert.equal(
            (targets[0] as ConnectTarget).serverName,
            undefined,
            "the certificate is checked against each real host",
        );
    });

    test("carries a mongodb+srv address as it is, and asks the provider about its one host", async () => {
        const log = provider("socks");
        const uri = "mongodb+srv://cluster.example.com/orders";
        (await session.acquire(connection(TUNNEL, uri), false)).release();
        assert.deepEqual(log.opened, [{ host: "cluster.example.com", port: 27017 }]);
        assert.equal(targets[0]?.uri, uri);
        assert.equal(targets[0]?.proxyPort, 41_111);
    });

    test("is closed with the connection", async () => {
        const log = provider("socks");
        (await session.acquire(connection(TUNNEL), false)).release();
        await session.closeAll();
        assert.equal(log.closed, 1);
        assert.equal(backends[0]?.closed, 1);
    });

    test("is closed when the driver fails to connect through it", async () => {
        const log = provider("socks");
        session = new Session(
            deps({
                connect: async () => {
                    throw new Error("no server");
                },
            }),
        );
        await assert.rejects(session.acquire(connection(TUNNEL), false), /no server/);
        await settle();
        assert.equal(log.closed, 1);
    });
});

describe("the user as a secret reference", () => {
    test("is read when the connection opens, like the password, and the driver gets the value", async () => {
        jig.secrets.set("pass:mongo/staging-user", "svc-orders-7f3a");
        const settings = settingsOf({
            connections: {
                staging: {
                    uri: "mongodb://db.example.com:27017",
                    user: "pass:mongo/staging-user",
                    password: "pass:mongo/staging",
                },
            },
        });
        const lease = await session.acquire(settings?.connections.get("staging") as Connection, false);
        assert.equal(targets[0]?.user, "svc-orders-7f3a");
        assert.deepEqual(jig.resolved, ["pass:mongo/staging-user", "pass:mongo/staging"]);
        lease.release();
        (await session.acquire(settings?.connections.get("staging") as Connection, false)).release();
        assert.equal(jig.resolved.length, 2, "not read again for the connection that is kept");
    });

    test("that cannot be read fails the call without repeating the reference, and keeps nothing", async () => {
        const settings = settingsOf({
            connections: {
                staging: {
                    uri: "mongodb://db.example.com:27017",
                    user: "pass:mongo/missing-user",
                    password: "pass:mongo/staging",
                },
            },
        });
        await assert.rejects(
            session.acquire(settings?.connections.get("staging") as Connection, false),
            (error: Error) => error.message === "the secret could not be resolved",
        );
        assert.equal(targets.length, 0);
        assert.deepEqual(session.environments(), []);
    });

    test("plain text is used as it is and is not looked up", async () => {
        (await session.acquire(connection(undefined), false)).release();
        assert.equal(targets[0]?.user, "agent");
        assert.deepEqual(jig.resolved, ["pass:mongo/staging"]);
    });
});

describe("an environment with several connections", () => {
    test("keeps one connection for each, opened by the first call that names it", async () => {
        const all = clusters();
        const orders = all.get("staging/orders") as Connection;
        const billing = all.get("staging/billing") as Connection;
        (await session.acquire(orders, false)).release();
        (await session.acquire(billing, false)).release();
        (await session.acquire(orders, false)).release();
        assert.equal(targets.length, 2);
        assert.deepEqual(
            targets.map((target) => [target.environment, target.cluster, target.uri]),
            [
                ["staging", "orders", "mongodb://orders.example.com:27017/orders"],
                ["staging", "billing", "mongodb://billing.example.com:27017/orders"],
            ],
        );
        assert.deepEqual(session.environments().sort(), ["staging/billing", "staging/orders"]);
        assert.deepEqual(jig.resolved, ["pass:mongo/staging", "pass:mongo/staging"], "each reads its own");
    });

    test("a connection that failed in use is dropped alone, and the other stays", async () => {
        const all = clusters();
        const orders = await session.acquire(all.get("staging/orders") as Connection, false);
        const billing = await session.acquire(all.get("staging/billing") as Connection, false);
        orders.release(true);
        await settle();
        assert.deepEqual(session.environments(), ["staging/billing"]);
        assert.equal(backends[0]?.closed, 1);
        assert.equal(backends[1]?.closed, 0);
        billing.release();
    });

    test("each has a route of its own: a tunnel for one and a direct connection for the other", async () => {
        const log = provider("socks", 41_666);
        const all = clusters();
        const orders = {
            ...(all.get("staging/orders") as Connection),
            via: { kind: "tunnel", name: "corp-net" } as const,
        };
        (await session.acquire(orders, false)).release();
        (await session.acquire(all.get("staging/billing") as Connection, false)).release();
        assert.equal(log.opened.length, 1);
        assert.equal(targets[0]?.proxyPort, 41_666);
        assert.equal(targets[1]?.proxyPort, undefined);
    });

    test("closing the session closes every connection", async () => {
        const all = clusters();
        (await session.acquire(all.get("staging/orders") as Connection, false)).release();
        (await session.acquire(all.get("staging/billing") as Connection, false)).release();
        await session.closeAll();
        assert.deepEqual(
            backends.map((backend) => backend.closed),
            [1, 1],
        );
    });
});
