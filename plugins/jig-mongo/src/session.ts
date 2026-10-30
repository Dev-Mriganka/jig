// Connections kept for the session: for each environment one forward (when its route needs one) and one client, reused by the
// calls that follow, closed after five idle minutes and when the session ends. A failed start is not kept, and a connection that
// failed in use is dropped so the next call starts clean.
import { tmpdir } from "node:os";
import { jig } from "../../jig-core/src/client.ts";
import type { Backend, Connect } from "./backend.ts";
import type { Connection, HostPort } from "./config.ts";
import { RouteError } from "./errors.ts";
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
    /** `failed` drops the environment's connection, so the next call starts clean. */
    release(failed?: boolean): void;
}

interface Entry {
    environment: string;
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
        let entry = this.entries.get(connection.environment);
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
            environment: connection.environment,
            active: 0,
            closed: false,
            ready: Promise.resolve(),
        };
        this.entries.set(entry.environment, entry);
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
                const password = await this.deps.route.resolveSecret(connection.password, signal);
                const forwarded = entry.forward;
                entry.backend = await this.deps.connect({
                    environment: connection.environment,
                    uri: forwarded === undefined ? connection.uri.text : localUri(connection, forwarded.port),
                    user: connection.user,
                    password,
                    production,
                    ...(connection.authSource === undefined ? {} : { authSource: connection.authSource }),
                    ...(connection.tls === undefined ? {} : { tls: connection.tls }),
                    ...(forwarded === undefined ? {} : { serverName: target.host, directConnection: true }),
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
            if (this.entries.get(entry.environment) === entry) this.entries.delete(entry.environment);
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
        if (this.entries.get(entry.environment) === entry) this.entries.delete(entry.environment);
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
