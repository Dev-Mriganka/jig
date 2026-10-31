// A tunnel provider: a local port that reaches a host the machine cannot reach directly. A real company puts here how it gets to
// its databases: an SSH jump host, a cloud port forward (AWS SSM, kubectl port-forward), a VPN client's command. A tool names the
// provider in its section (`"via": { "tunnel": "acme-bastion" }` in `mongo`), and jig-core opens it when a call needs the route.
//
// This one is `ssh -L` through a bastion host. Its `kind` is `forward`: the port on 127.0.0.1 reaches exactly the one host and
// port that was asked for, and the tool connects to it as to that host. (A provider that has to reach every member of a replica
// set is `ssh -D` and has the kind `socks`.)
//
// ssh is started with jig-core's `exec.run`: a program from an argument list, never a shell, found only in folders the agent
// cannot write. `ssh -N` does not return until it is stopped, so the call is not awaited: it settles when ssh ends, and closing the
// tunnel stops it with a signal. ssh signs in with your own agent (`SSH_AUTH_SOCK`), reads no configuration file that the agent
// could have changed (`-F /dev/null`), and never asks a question (`BatchMode`), so an unknown host key is a clear failure, not a
// prompt: connect to the bastion once with ssh yourself to add it to known_hosts.
import { connect, createServer } from "node:net";
import type { JigApi, RunOptions, RunResult, TunnelProvider } from "./jig/types.ts";

export const BASTION_TUNNEL = "acme-bastion";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface BastionDeps {
    /** jig-core's `exec.run`. */
    run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
    /** The bastion host and your login on it, asked for each time a tunnel opens. */
    settings(): { host: string; user: string | undefined };
    /** The environment ssh takes `SSH_AUTH_SOCK` from. */
    env: NodeJS.ProcessEnv;
    freePort(): Promise<number>;
    /** Whether something accepts connections on 127.0.0.1:port. */
    probe(port: number): Promise<boolean>;
    /** How long ssh may take to sign in and set up the forward. */
    readyTimeoutMs: number;
    pollMs: number;
    /** The longest a tunnel lives; the tool closes it sooner. */
    lifetimeMs: number;
}

/**
 * A port nothing listens on. A listener that was just closed can go on accepting connections for a few milliseconds, which would
 * look like a tunnel that is up, so the port is only handed out once it refuses connections.
 */
export async function freePort(): Promise<number> {
    const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        const fail = (): void => reject(new Error("cannot find a free local port for the tunnel"));
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const found = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => (found > 0 ? resolve(found) : fail()));
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

export function systemDeps(run: BastionDeps["run"], settings: BastionDeps["settings"]): BastionDeps {
    return {
        run,
        settings,
        env: process.env,
        freePort,
        probe,
        readyTimeoutMs: 15_000,
        pollMs: 100,
        lifetimeMs: 4 * 60 * 60_000,
    };
}

/** A host or login that is a plain word, so that ssh cannot read it as an option. */
const WORD = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The argument list of ssh. Every value that came from configuration or from a call is a plain word. */
export function sshArguments(
    bastion: { host: string; user: string },
    local: number,
    target: { host: string; port: number },
): string[] {
    return [
        "-N",
        "-L",
        `127.0.0.1:${local}:${target.host}:${target.port}`,
        "-F",
        "/dev/null",
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
        `${bastion.user}@${bastion.host}`,
    ];
}

/** What ssh said, as one line the user can act on. ssh's own words are not repeated: they can hold addresses and paths. */
export function failureOf(code: number | null, stderr: string): Error {
    if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
        return new Error(
            "the bastion's host key is not trusted: connect to it once with ssh yourself to add it to known_hosts",
        );
    }
    if (/permission denied|too many authentication failures/i.test(stderr)) {
        return new Error(
            "the bastion refused your login: check acme.bastion.user and that your ssh agent holds your key",
        );
    }
    if (/could not resolve|timed out|no route to host|connection refused|network is unreachable/i.test(stderr)) {
        return new Error("cannot reach the bastion: check the network and the VPN, then try again");
    }
    return new Error(
        `ssh failed${code === null ? "" : ` (exit ${code})`}; check the bastion host, your login and your agent`,
    );
}

export function createBastionTunnels(deps: BastionDeps): TunnelProvider {
    return {
        async open(target, signal) {
            const { host, user } = deps.settings();
            if (user === undefined) {
                throw new Error("set acme.bastion.user in your jig.json: your login on the bastion host");
            }
            // jig-core has already refused a port outside 1 to 65535; the names are checked here, since they reach ssh's command line.
            if (!WORD.test(target.host) || !WORD.test(host))
                throw new Error("the database address is not a host name and a port");
            const cancelled = (): boolean => signal?.aborted === true;
            if (cancelled()) throw new Error("the call was cancelled while the tunnel was opening");

            const port = await deps.freePort();
            const stopper = new AbortController();
            let ended: RunResult | Error | undefined;
            const sshAgent = deps.env.SSH_AUTH_SOCK;
            void deps
                .run("ssh", sshArguments({ host, user }, port, target), {
                    timeoutMs: deps.lifetimeMs,
                    signal: stopper.signal,
                    ...(sshAgent === undefined ? {} : { env: { SSH_AUTH_SOCK: sshAgent } }),
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
                    if (cancelled()) throw new Error("the call was cancelled while the tunnel was opening");
                    if (ended !== undefined) {
                        throw ended instanceof Error
                            ? new Error(`ssh could not start: ${ended.message.slice(0, 120)}`)
                            : failureOf(ended.code, ended.stderr);
                    }
                    if (await deps.probe(port)) break;
                    if (Date.now() > deadline)
                        throw new Error("the tunnel did not become ready in time: check the bastion and the network");
                    await sleep(deps.pollMs);
                }
            } catch (error) {
                stop();
                throw error;
            } finally {
                // After this the call's own signal no longer ends the tunnel: the tool closes it when it is done.
                signal?.removeEventListener("abort", stop);
            }
            return { kind: "forward", port, close: stop };
        },
    };
}

export function registerTunnel(
    api: JigApi,
    settings: BastionDeps["settings"],
    overrides: Partial<BastionDeps> = {},
): void {
    api.tunnels.register(
        BASTION_TUNNEL,
        createBastionTunnels({
            ...systemDeps((file, args, options) => api.exec.run(file, args, options), settings),
            ...overrides,
        }),
    );
}
