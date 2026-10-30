// Connections kept for the session: for each connection (one per environment, or one per name where an environment has several)
// one route (when it needs one) and one client, reused by the calls that follow, closed after five idle minutes and when the
// session ends. A failed start is not kept, and a connection that failed in use is dropped so the next call starts clean.
import { tmpdir } from "node:os";
import { jig } from "../../jig-core/src/client.ts";
import type { Backend, Connect } from "./backend.ts";
import { connectionKey, isReference } from "./config.ts";
import type { Connection, HostPort } from "./config.ts";
import { RouteError } from "./errors.ts";
import { placeOf } from "./params.ts";
import { DEFAULT_ROUTE_TIMINGS, freePort, probe, startForward } from "./route.ts";
import type { Forward, RouteDeps } from "./route.ts";

export interface Timer {
    cancel(): void;
}

export interface SessionDeps {
    connect: Connect;
    route: RouteDeps;
    idleMs: number;
    setTimer(fn: () => void, ms: number): Timer;
}

export const IDLE_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 3000;

/** Routes and secrets as the running jig-core has them. */
export function systemRouteDeps(): RouteDeps {
    return {
        run: (file, args, options) => jig().exec.run(file, args, options),
        openTunnel: (name, target, signal) => jig().tunnels.open(name, target, signal),
        resolveSecret: (reference, signal) => jig().secrets.resolve(reference, signal),
        freePort,
        probe,
        tmpDir: () => tmpdir(),
        ...DEFAULT_ROUTE_TIMINGS,
    };
}

export function systemSessionDeps(connect: Connect): SessionDeps {
    return {
        connect,
        route: systemRouteDeps(),
        idleMs: IDLE_MS,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref();
            return { cancel: () => clearTimeout(handle) };
        },
    };
}

export interface Lease {
    backend: Backend;
    /** `failed` drops the connection, so the next call starts clean. */
    release(failed?: boolean): void;
}

interface Entry {
    /** The connection's `connectionKey`. */
    key: string;
    forward?: Forward;
    backend?: Backend;
    ready: Promise<void>;
    active: number;
    timer?: Timer;
    closed: boolean;
}

const gone = (): RouteError => new RouteError("the connection was closed while it was being opened");

/** Settles like `promise`, but rejects as soon as `signal` aborts, so a step that hangs cannot outlive the call. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(new RouteError("the call was cancelled while connecting"));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(new RouteError("the call was cancelled while connecting"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

/** Whether the uri names one host and port, which is all a forward reaches. */
function singleHost(connection: Connection): boolean {
    return connection.uri.scheme === "mongodb" && connection.uri.hosts.length === 1;
}

/** The address a forward listens on, in place of the database's own. */
function localUri(connection: Connection, port: number): string {
    const options = connection.uri.options === "" ? "" : `?${connection.uri.options}`;
    return `mongodb://127.0.0.1:${port}/${connection.uri.database}${options}`;
}

export class Session {
    private readonly entries = new Map<string, Entry>();
    private readonly deps: SessionDeps;

    constructor(deps: SessionDeps) {
        this.deps = deps;
    }

    async acquire(connection: Connection, production: boolean, signal?: AbortSignal): Promise<Lease> {
        let entry = this.entries.get(connectionKey(connection.environment, connection.cluster));
        if (entry?.forward !== undefined && !entry.forward.alive()) {
            await this.close(entry);
            entry = undefined;
        }
        entry ??= this.create(connection, production, signal);
        entry.active++;
        entry.timer?.cancel();
        entry.timer = undefined;
        const held = entry;
        try {
            await raceAbort(held.ready, signal);
        } catch (error) {
            held.active--;
            if (!held.closed && held.active === 0) this.idle(held);
            throw error;
        }
        let released = false;
        return {
            backend: held.backend as Backend,
            release: (failed = false) => {
                if (released) return;
                released = true;
                held.active--;
                if (failed) void this.close(held);
                else if (held.active === 0) this.idle(held);
            },
        };
    }

    private create(connection: Connection, production: boolean, signal: AbortSignal | undefined): Entry {
        const entry: Entry = {
            key: connectionKey(connection.environment, connection.cluster),
            active: 0,
            closed: false,
            ready: Promise.resolve(),
        };
        this.entries.set(entry.key, entry);
        entry.ready = (async () => {
            const target = connection.uri.hosts[0] as HostPort;
            if (connection.via.kind !== "direct") {
                entry.forward = await startForward(connection.via, target, this.deps.route, signal);
                if (entry.closed) {
                    entry.forward.stop();
                    throw gone();
                }
            }
            try {
                const forwarded = entry.forward;
                // A forward reaches one host and port. A replica set or a `mongodb+srv` address needs every member reached, which
                // only a proxy does, so a forward that cannot is said so here and not left to fail as a timeout.
                if (forwarded?.kind === "forward" && connection.via.kind === "tunnel" && !singleHost(connection)) {
                    throw new RouteError(
                        `the tunnel "${connection.via.name}" reaches one host and port, and the uri of ${placeOf(connection)} ` +
                            "names a replica set or mongodb+srv: give one mongodb://host:27017 address, or a tunnel that is a SOCKS proxy",
                    );
                }
                // The user may be a reference too. Both are read once the route is up, and neither is kept.
                const user = isReference(connection.user)
                    ? await this.deps.route.resolveSecret(connection.user, signal)
                    : connection.user;
                const password = await this.deps.route.resolveSecret(connection.password, signal);
                const local = forwarded?.kind === "forward";
                entry.backend = await this.deps.connect({
                    environment: connection.environment,
                    ...(connection.cluster === undefined ? {} : { cluster: connection.cluster }),
                    // Behind a forward the address is local. Behind a proxy it is the real one: the driver reaches each host.
                    uri: local ? localUri(connection, forwarded.port) : connection.uri.text,
                    user,
                    password,
                    production,
                    ...(connection.authSource === undefined ? {} : { authSource: connection.authSource }),
                    ...(connection.tls === undefined ? {} : { tls: connection.tls }),
                    ...(local ? { serverName: target.host, directConnection: true } : {}),
                    ...(forwarded?.kind === "socks" ? { proxyHost: "127.0.0.1", proxyPort: forwarded.port } : {}),
                });
                if (entry.closed) {
                    await entry.backend.close().catch(() => undefined);
                    throw gone();
                }
            } catch (error) {
                entry.forward?.stop();
                throw error;
            }
        })();
        // A failed start must not stay cached; the callers waiting on it still see the rejection.
        entry.ready.catch(() => {
            entry.closed = true;
            if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        });
        return entry;
    }

    private idle(entry: Entry): void {
        entry.timer?.cancel();
        entry.timer = this.deps.setTimer(() => {
            if (entry.active === 0) void this.close(entry);
        }, this.deps.idleMs);
    }

    private async close(entry: Entry): Promise<void> {
        entry.closed = true;
        entry.timer?.cancel();
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        const { backend, forward } = entry;
        entry.backend = undefined;
        entry.forward = undefined;
        await backend?.close().catch(() => undefined);
        forward?.stop();
    }

    /** Idempotent. Stops the forwards first, so that shutting down never waits on a network that may be gone. */
    async closeAll(): Promise<void> {
        const entries = [...this.entries.values()];
        for (const entry of entries) entry.forward?.stop();
        const closing = Promise.allSettled(entries.map((entry) => this.close(entry)));
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([closing, new Promise((resolve) => (timer = setTimeout(resolve, SHUTDOWN_GRACE_MS)))]);
        clearTimeout(timer);
    }

    /** For tests and diagnostics: the environments with a live entry. */
    environments(): string[] {
        return [...this.entries.keys()];
    }
}
