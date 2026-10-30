// The route to a database that is not reachable directly: an SSH local forward through a bastion host. The forward is started with
// jig-core's `exec.run` (a program from an argument list, never a shell) and lives until it is stopped. The key is written to a
// private temporary file for the time ssh needs it to sign in, and the file is deleted as soon as the forward works or fails.
//
// A route named `tunnel` is for a company plugin that provides one, through jig-core's tunnels. What the provider gives is a
// `forward` (a local port that reaches the one host and port, used as the SSH forward is) or a `socks` proxy (the driver reaches
// every host of the address through it, so a replica set or a `mongodb+srv` address works).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import type { OpenedTunnel, RunOptions, RunResult } from "../../jig-core/src/contract.ts";
import type { HostPort, Route, SshRoute } from "./config.ts";
import { RouteError } from "./errors.ts";
import { oneLine } from "./values.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A running route. `forward`: connect to `127.0.0.1:port` to reach the database. `socks`: `127.0.0.1:port` is a SOCKS5 proxy, and
 * the database is reached at its own address through it.
 */
export interface Forward {
    kind: "forward" | "socks";
    port: number;
    alive(): boolean;
    /** Ends ssh. Safe to call twice. */
    stop(): void;
}

export interface RouteDeps {
    run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
    /** Opens a tunnel that a company plugin provides, by name (jig-core's `tunnels.open`). */
    openTunnel(name: string, target: HostPort, signal?: AbortSignal): Promise<OpenedTunnel>;
    resolveSecret(reference: string, signal?: AbortSignal): Promise<string>;
    freePort(): Promise<number>;
    /** Whether something accepts connections on `127.0.0.1:port`. */
    probe(port: number): Promise<boolean>;
    /** Where the key file is made. */
    tmpDir(): string;
    /** How long to wait for the forward to accept connections. */
    readyTimeoutMs: number;
    pollMs: number;
    /** The longest a forward lives; the session closes it sooner when it is idle. */
    lifetimeMs: number;
}

/**
 * A port nothing listens on. A listener that was just closed can go on accepting connections for a few milliseconds, which would
 * look like a forward that is up, so the port is only handed out once it refuses connections.
 */
export async function freePort(): Promise<number> {
    const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", () => reject(new RouteError("cannot find a free local port for the SSH forward")));
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const found = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() =>
                found > 0
                    ? resolve(found)
                    : reject(new RouteError("cannot find a free local port for the SSH forward")),
            );
        });
    });
    for (let attempt = 0; attempt < 100 && (await probe(port)); attempt++) await sleep(10);
    return port;
}

export function probe(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const done = (ok: boolean): void => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(2000, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

/** What ssh said, as one line the user can act on. The text of ssh itself is not repeated: it can hold addresses and paths. */
export function classifySshFailure(code: number | null, stderr: string): RouteError {
    if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
        return new RouteError(
            "the bastion's host key is not trusted: connect to it once with ssh yourself to add it to known_hosts",
        );
    }
    if (/permission denied|too many authentication failures/i.test(stderr)) {
        return new RouteError("the bastion refused the SSH key: check the key behind the key reference and the user");
    }
    if (/invalid format|error in libcrypto|load key|bad permissions|passphrase/i.test(stderr)) {
        return new RouteError("the SSH key could not be read: it must be an unencrypted private key");
    }
    if (/could not resolve|timed out|no route to host|connection refused|network is unreachable/i.test(stderr)) {
        return new RouteError("cannot reach the bastion: check the network and the VPN, then try again");
    }
    if (/forwarding failed|address already in use|bind/i.test(stderr)) {
        return new RouteError("the SSH forward could not be set up: the local port was refused");
    }
    return new RouteError(
        `the SSH forward failed${code === null ? "" : ` (ssh exit ${code})`}; check the bastion, the user and the key`,
    );
}

/** The argument list of ssh. Every value that came from configuration is checked to be a plain word, so none can be an option. */
export function sshArguments(route: SshRoute, local: number, target: HostPort, keyFile: string): string[] {
    return [
        "-N",
        "-L",
        `127.0.0.1:${local}:${target.host}:${target.port}`,
        "-i",
        keyFile,
        // Only this key, and no configuration file that could add a command to run.
        "-F",
        "/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        ...(route.port === undefined ? [] : ["-p", String(route.port)]),
        `${route.user}@${route.host}`,
    ];
}

/** Writes the key where only this user can read it, and returns how to delete it. */
function writeKey(deps: RouteDeps, key: string): { file: string; remove(): void } {
    const dir = mkdtempSync(path.join(deps.tmpDir(), "jig-mongo-"));
    const file = path.join(dir, "key");
    const remove = (): void => rmSync(dir, { recursive: true, force: true });
    try {
        // ssh refuses a key that does not end with a newline.
        writeFileSync(file, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600, flag: "wx" });
        chmodSync(file, 0o600);
    } catch (error) {
        remove();
        throw new RouteError(`the SSH key could not be written to a private file: ${(error as Error).message}`);
    }
    return { file, remove };
}

async function startSsh(
    route: SshRoute,
    target: HostPort,
    deps: RouteDeps,
    signal: AbortSignal | undefined,
): Promise<Forward> {
    // A function and not a check of the flag, because the flag changes while this waits.
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) throw new RouteError("the call was cancelled while the SSH forward was starting");
    const key = await deps.resolveSecret(route.key, signal);
    const keyFile = writeKey(deps, key);
    try {
        const port = await deps.freePort();
        const stopper = new AbortController();
        let ended: RunResult | Error | undefined;
        // `ssh -N` does not return until it is stopped, so the call is not waited for: it settles when ssh ends.
        void deps
            .run("ssh", sshArguments(route, port, target, keyFile.file), {
                timeoutMs: deps.lifetimeMs,
                signal: stopper.signal,
            })
            .then(
                (result) => {
                    ended = result;
                },
                (error: unknown) => {
                    ended = error instanceof Error ? error : new Error(String(error));
                },
            );
        const stop = (): void => stopper.abort();
        signal?.addEventListener("abort", stop, { once: true });

        const deadline = Date.now() + deps.readyTimeoutMs;
        try {
            for (;;) {
                if (cancelled()) throw new RouteError("the call was cancelled while the SSH forward was starting");
                if (ended !== undefined) {
                    throw ended instanceof Error
                        ? new RouteError(`the SSH forward could not start: ${ended.message}`)
                        : classifySshFailure(ended.code, ended.stderr);
                }
                if (await deps.probe(port)) break;
                if (Date.now() > deadline)
                    throw new RouteError(
                        "the SSH forward did not become ready in time: check the bastion and the network",
                    );
                await sleep(deps.pollMs);
            }
        } catch (error) {
            stop();
            throw error;
        } finally {
            signal?.removeEventListener("abort", stop);
        }
        return { kind: "forward", port, alive: () => ended === undefined, stop };
    } finally {
        // ssh has signed in by now, or has failed: the key is not needed any more.
        keyFile.remove();
    }
}

/** Opens a company's tunnel. What the provider says is shortened to a line: it can hold addresses. */
async function startTunnel(
    name: string,
    target: HostPort,
    deps: RouteDeps,
    signal: AbortSignal | undefined,
): Promise<Forward> {
    // A function and not a check of the flag, because the flag changes while this waits.
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) throw new RouteError("the call was cancelled while the tunnel was opening");
    let tunnel: OpenedTunnel;
    try {
        tunnel = await deps.openTunnel(name, target, signal);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // jig-core's words for a name nobody registered, kept short and in the words this tool has always used for it.
        if (/^no tunnel provider named /.test(message)) {
            throw new RouteError(
                `no tunnel provider is registered: the route "${name}" needs a company plugin that provides it`,
            );
        }
        throw new RouteError(`the tunnel "${name}" could not be opened: ${oneLine(message, 160)}`);
    }
    let stopped = false;
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        // A provider closes in its own way, perhaps slowly or with an error; neither may hold up a session that is ending.
        void Promise.resolve()
            .then(() => tunnel.close())
            .catch(() => undefined);
    };
    if (cancelled()) {
        // The provider did not stop for the signal: its tunnel is closed here, and not left open.
        stop();
        throw new RouteError("the call was cancelled while the tunnel was opening");
    }
    return { kind: tunnel.kind, port: tunnel.port, alive: () => !stopped, stop };
}

/** Starts the route of a connection to a database host. A direct route needs none and is not given here. */
export async function startForward(
    route: Exclude<Route, { kind: "direct" }>,
    target: HostPort,
    deps: RouteDeps,
    signal?: AbortSignal,
): Promise<Forward> {
    if (route.kind === "tunnel") return startTunnel(route.name, target, deps, signal);
    return startSsh(route, target, deps, signal);
}

export const DEFAULT_ROUTE_TIMINGS = { readyTimeoutMs: 15_000, pollMs: 100, lifetimeMs: 4 * 60 * 60_000 } as const;
