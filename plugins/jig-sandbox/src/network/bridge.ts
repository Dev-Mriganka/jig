// The localhost bridge, for `filtered` and `ask` modes. There every command has a network namespace of its own (that is what
// keeps it off this machine's `localhost`), so a server in one command is not at `localhost` in the next. The bridge carries
// two kinds of port across:
//
//   * a port a background task listens on. Its namespace is read from `/proc/<pid>/net/tcp`, a listener on this machine's
//     loopback takes the same port number (you reach the server there too), and each connection to it enters the task's
//     namespace to dial the server (a short Python helper does the entering: Node cannot);
//   * a port you listed in `network.localhost`, which is a service on this machine.
//
// Every later command starts with a forwarder per port inside its own namespace: `socat` listens on the port there and asks the
// sandbox's proxy to connect to `127.0.0.1:<port>` on this machine. The proxy only needs TCP, so the forwarder runs after the
// command's Unix-socket filter is on, and the sandbox's own callback is what allows exactly these ports (see `policy.ts`).
// A port that no listener or listing serves is not allowed, so `jig-core`'s tunnel ports are never reachable unless listed.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import net from "node:net";
import { realPort } from "../background/process.ts";
import type { ProcessPort } from "../background/process.ts";
import type { Task } from "../background/types.ts";
import type { NetworkMode } from "../config.ts";

/** The runtime's own relays listen on these in every command's namespace: they are never a task's server. */
const RELAY_PORTS: ReadonlySet<number> = new Set([3128, 1080]);
/** No more ports than this are carried into a command: each costs a process there. */
const MAX_PORTS = 16;
/** A port that was listening and is not any more must be missing this many times in a row to be dropped. */
const MISSES = 2;
const RETRY_BUSY_MS = 10_000;
const MIN_SYNC_GAP_MS = 150;
const BIND_WAIT_MS = 1_000;

export interface Listening {
    port: number;
    /** The address to dial inside the namespace. */
    address: string;
}

/** The ports in LISTEN state in the text of `/proc/net/tcp` and `/proc/net/tcp6` that a local client can reach. */
export function listeningPorts(tcp: string, tcp6: string): Listening[] {
    const found = new Map<number, Listening>();
    for (const [text, v6] of [
        [tcp, false],
        [tcp6, true],
    ] as const) {
        for (const line of text.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);
            const local = fields[1];
            if (local === undefined || fields[3] !== "0A") continue;
            const [address, hexPort] = local.split(":");
            const port = Number.parseInt(hexPort ?? "", 16);
            if (!Number.isInteger(port) || port < 1 || address === undefined) continue;
            const dial = v6 ? dialV6(address) : dialV4(address);
            if (dial !== undefined && !found.has(port)) found.set(port, { port, address: dial });
        }
    }
    return [...found.values()].sort((a, b) => a.port - b.port);
}

/** `0100007F` is 127.0.0.1: the bytes of the address come in reverse. */
function dialV4(hex: string): string | undefined {
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return undefined;
    const bytes = [6, 4, 2, 0].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    if (bytes.every((byte) => byte === 0)) return "127.0.0.1";
    return bytes[0] === 127 ? bytes.join(".") : undefined;
}

function dialV6(hex: string): string | undefined {
    if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return undefined;
    const upper = hex.toUpperCase();
    if (/^0{32}$/.test(upper)) return "::1";
    if (upper === "00000000000000000000000001000000") return "::1";
    // IPv4 loopback in an IPv6 socket: ::ffff:127.0.0.1
    if (upper.startsWith("0000000000000000FFFF0000") && upper.endsWith("7F")) return dialV4(upper.slice(24));
    return undefined;
}

/** What the bridge asks of the machine: easy to replace in a test. */
export interface BridgeProcesses {
    /** The pids below `pid`, nearest first. */
    descendants(pid: number): number[];
    /** The network namespace of a process, as `net:[4026532233]`. */
    netNamespace(pid: number): string | undefined;
    /** The ports `pid`'s namespace listens on. */
    listening(pid: number): Listening[];
    alive(pid: number): boolean;
}

export function realProcesses(port: ProcessPort = realPort): BridgeProcesses {
    return {
        descendants: (pid) => port.descendants(pid),
        netNamespace: (pid) => {
            try {
                return readlinkSync(`/proc/${pid}/ns/net`);
            } catch {
                return undefined;
            }
        },
        listening: (pid) => {
            try {
                const tcp = readFileSync(`/proc/${pid}/net/tcp`, "utf8");
                let tcp6 = "";
                try {
                    tcp6 = readFileSync(`/proc/${pid}/net/tcp6`, "utf8");
                } catch {
                    // No IPv6 in that namespace.
                }
                return listeningPorts(tcp, tcp6);
            } catch {
                return [];
            }
        },
        alive: (pid) => port.alive(pid),
    };
}

/** The exit status of the helper when it could not enter the namespace. */
export const CANNOT_ENTER = 111;

/**
 * Enters the network namespace of `pid` and connects to `address:port` there, then carries bytes between its standard streams
 * and that connection. A network namespace belongs to the user namespace bubblewrap made, which no process is in, so a
 * process joins that one first (the kernel names it for a network namespace's file: `NS_GET_USERNS`) and then the network
 * namespace. This runs with this user's own rights; it can only reach what a process in that sandbox could.
 */
export const ENTER_SCRIPT = `
import os, sys, fcntl, ctypes, socket, selectors
pid, host, port = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
libc = ctypes.CDLL(None, use_errno=True)
net = os.open("/proc/%d/ns/net" % pid, os.O_RDONLY)
owner = fcntl.ioctl(net, 0xb701)
if libc.setns(owner, 0x10000000) != 0 or libc.setns(net, 0x40000000) != 0:
    sys.exit(${CANNOT_ENTER})
s = socket.create_connection((host, port), 5)
s.setblocking(False)
sel = selectors.DefaultSelector()
sel.register(s, selectors.EVENT_READ, "net")
sel.register(0, selectors.EVENT_READ, "in")
while True:
    for key, _ in sel.select():
        if key.data == "net":
            data = s.recv(65536)
            if not data:
                sys.exit(0)
            os.write(1, data)
        else:
            data = os.read(0, 65536)
            if not data:
                sel.unregister(0)
                s.shutdown(socket.SHUT_WR)
            else:
                s.sendall(data)
`;

/** Starts the helper. A test replaces it. */
export type Enter = (pid: number, address: string, port: number) => ChildProcess;

export function pythonEnter(python: string): Enter {
    return (pid, address, port) => {
        if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("refusing to enter that namespace");
        }
        return spawn(python, ["-I", "-S", "-c", ENTER_SCRIPT, String(pid), address, String(port)], {
            stdio: ["pipe", "pipe", "ignore"],
            env: { PATH: "/usr/bin:/bin" },
        });
    };
}

interface Served {
    port: number;
    taskId: string;
    /** True once the listener on this machine is up. A port being made already belongs to the task that began it. */
    ready: boolean;
    servers: net.Server[];
    sockets: Set<net.Socket>;
    missing: number;
}

interface Watched {
    task: Task;
    inner?: { pid: number; namespace: string };
    served: Map<number, Served>;
    /** Ports that could not be bridged, and when they may be tried again. */
    busy: Map<number, number>;
}

export interface BridgeDeps {
    mode: () => NetworkMode;
    /** `network.localhost`. */
    localhost: () => readonly number[];
    /** The absolute path of `socat`. */
    socat: () => string | undefined;
    /** The absolute path of `python3`, or undefined. */
    python: () => string | undefined;
    platform: NodeJS.Platform;
    processes?: BridgeProcesses;
    enter?: Enter;
    now?: () => number;
    /** Says something to the user once. */
    notify?: (message: string) => void;
}

export class Bridge {
    private readonly deps: BridgeDeps;
    private readonly processes: BridgeProcesses;
    private readonly now: () => number;
    private readonly watched = new Map<string, Watched>();
    private readonly served = new Map<number, Served>();
    private readonly binding = new Set<Promise<void>>();
    private lastSync = 0;
    private timer: NodeJS.Timeout | undefined;
    private enterFailed = false;
    private own: string | undefined;

    constructor(deps: BridgeDeps) {
        this.deps = deps;
        this.processes = deps.processes ?? realProcesses();
        this.now = deps.now ?? Date.now;
    }

    /** Whether the bridge does anything: in `filtered` and `ask` on Linux. Elsewhere commands share the machine's network or have none. */
    get active(): boolean {
        const mode = this.deps.mode();
        return (mode === "filtered" || mode === "ask") && this.deps.platform === "linux";
    }

    /** What stops task ports being bridged, when something does: shown by `/sandbox` and the doctor. */
    get problem(): string | undefined {
        if (!this.active) return undefined;
        if (this.deps.python() === undefined) {
            return "python3 is not installed, so a background task's server cannot be reached from other commands (ports in network.localhost still work)";
        }
        if (this.enterFailed) {
            return "this machine does not let the bridge enter a task's network namespace, so a background task's server cannot be reached from other commands";
        }
        return undefined;
    }

    // ---- tasks

    taskStarted(task: Task): void {
        if (!this.active) return;
        this.watched.set(task.id, { task, served: new Map(), busy: new Map() });
        if (this.timer === undefined) {
            this.timer = setInterval(() => void this.sync(), 1_000);
            this.timer.unref();
        }
    }

    taskEnded(task: Task): void {
        const entry = this.watched.get(task.id);
        if (entry === undefined) return;
        this.watched.delete(task.id);
        for (const served of entry.served.values()) this.release(served);
        task.ports = [];
        if (this.watched.size === 0 && this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    // ---- what is carried

    /** Whether a port on this machine's loopback is bridged to a task's server right now. */
    serves(port: number): boolean {
        return this.active && this.served.get(port)?.ready === true;
    }

    /** The ports every command gets a forwarder for: those you listed and those a task's server is bridged on. */
    forwarderPorts(): number[] {
        if (!this.active) return [];
        const ports = new Set<number>(this.deps.localhost().filter((port) => !RELAY_PORTS.has(port)));
        for (const [port, served] of this.served) if (served.ready) ports.add(port);
        return [...ports].sort((a, b) => a - b).slice(0, MAX_PORTS);
    }

    /**
     * Reads the tasks' namespaces and brings the listeners up to date, then waits (briefly) for any listener that was being
     * made. Called before every command is wrapped, so a command sees a server that has just come up.
     */
    async sync(): Promise<void> {
        if (!this.active) return;
        if (this.now() - this.lastSync >= MIN_SYNC_GAP_MS) {
            this.lastSync = this.now();
            for (const entry of this.watched.values()) this.scan(entry);
        }
        if (this.binding.size > 0) {
            await Promise.race([
                Promise.all([...this.binding]),
                new Promise<void>((resolve) => setTimeout(resolve, BIND_WAIT_MS).unref()),
            ]);
        }
    }

    private innerOf(entry: Watched): { pid: number; namespace: string } | undefined {
        if (entry.inner !== undefined) {
            if (this.processes.netNamespace(entry.inner.pid) === entry.inner.namespace) return entry.inner;
            entry.inner = undefined;
        }
        if (this.own === undefined) this.own = this.processes.netNamespace(process.pid);
        for (const pid of this.processes.descendants(entry.task.pid)) {
            const namespace = this.processes.netNamespace(pid);
            // The first process below the task's shell that is in a network namespace of its own is the sandbox's.
            if (namespace !== undefined && namespace !== this.own) {
                entry.inner = { pid, namespace };
                return entry.inner;
            }
        }
        return undefined;
    }

    private scan(entry: Watched): void {
        const inner = this.innerOf(entry);
        if (inner === undefined) return;
        const listening = this.processes.listening(inner.pid).filter((item) => !RELAY_PORTS.has(item.port));
        const seen = new Set(listening.map((item) => item.port));
        for (const item of listening) {
            if (entry.served.has(item.port)) {
                (entry.served.get(item.port) as Served).missing = 0;
                continue;
            }
            const retryAt = entry.busy.get(item.port);
            if (retryAt !== undefined && retryAt > this.now()) continue;
            this.bind(entry, inner, item);
        }
        for (const [port, served] of entry.served) {
            if (seen.has(port)) continue;
            served.missing += 1;
            if (served.missing >= MISSES) {
                entry.served.delete(port);
                this.release(served);
                this.updatePorts(entry);
            }
        }
    }

    private updatePorts(entry: Watched): void {
        entry.task.ports = [...entry.served.values()]
            .filter((served) => served.ready)
            .map((served) => served.port)
            .sort((a, b) => a - b);
    }

    private note(entry: Watched, message: string): void {
        if (!entry.task.notes.includes(message)) {
            entry.task.notes.push(message);
            this.deps.notify?.(`${entry.task.id}: ${message}`);
        }
    }

    /** Makes the listener on this machine's loopback for a port a task listens on. */
    private bind(entry: Watched, inner: { pid: number; namespace: string }, item: Listening): void {
        const owner = this.served.get(item.port);
        if (owner !== undefined) {
            if (owner.taskId !== entry.task.id) {
                this.note(
                    entry,
                    `port ${item.port} is already bridged to ${owner.taskId}'s server, so ${entry.task.id}'s is not reachable from other commands`,
                );
            }
            return;
        }
        const served: Served = {
            port: item.port,
            taskId: entry.task.id,
            ready: false,
            servers: [],
            sockets: new Set(),
            missing: 0,
        };
        // Claimed now, so a second task on the same port, met in the same look, does not race for it.
        this.served.set(item.port, served);
        entry.served.set(item.port, served);
        const connection = (socket: net.Socket): void => this.connection(entry, inner, item, served, socket);
        const made = new Promise<void>((resolve) => {
            const server = net.createServer(connection);
            server.once("error", (error: NodeJS.ErrnoException) => {
                this.served.delete(item.port);
                entry.served.delete(item.port);
                entry.busy.set(item.port, this.now() + RETRY_BUSY_MS);
                this.note(
                    entry,
                    error.code === "EADDRINUSE"
                        ? `port ${item.port} is also in use on this machine, so other commands cannot reach this task's server there; use another port`
                        : `port ${item.port} could not be bridged (${error.message})`,
                );
                resolve();
            });
            server.listen({ host: "127.0.0.1", port: item.port }, () => {
                served.servers.push(server);
                served.ready = true;
                this.updatePorts(entry);
                // The same port on ::1, for programs that resolve `localhost` to it. Best effort.
                const second = net.createServer(connection);
                second.once("error", () => undefined);
                second.listen({ host: "::1", port: item.port, ipv6Only: true }, () => served.servers.push(second));
                resolve();
            });
        });
        const tracked = made.finally(() => this.binding.delete(tracked));
        this.binding.add(tracked);
    }

    /** One client of the listener: the helper enters the task's namespace and dials the server there. */
    private connection(
        entry: Watched,
        inner: { pid: number; namespace: string },
        item: Listening,
        served: Served,
        socket: net.Socket,
    ): void {
        served.sockets.add(socket);
        socket.once("close", () => served.sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        const python = this.deps.python();
        if (
            python === undefined ||
            this.processes.netNamespace(inner.pid) !== inner.namespace ||
            !this.processes.alive(inner.pid)
        ) {
            socket.destroy();
            return;
        }
        let child: ChildProcess;
        try {
            child = (this.deps.enter ?? pythonEnter(python))(inner.pid, item.address, item.port);
        } catch {
            socket.destroy();
            return;
        }
        const { stdin, stdout } = child;
        if (stdin === null || stdout === null) {
            child.kill();
            socket.destroy();
            return;
        }
        stdin.on("error", () => undefined);
        stdout.on("error", () => undefined);
        child.on("error", () => socket.destroy());
        socket.pipe(stdin);
        stdout.pipe(socket);
        socket.once("close", () => child.kill());
        child.once("exit", (code) => {
            if (code === CANNOT_ENTER) {
                this.enterFailed = true;
                this.note(
                    entry,
                    "the bridge could not enter this task's network namespace (this machine does not allow it)",
                );
            }
            socket.destroy();
        });
    }

    private release(served: Served): void {
        if (this.served.get(served.port) === served) this.served.delete(served.port);
        for (const server of served.servers) server.close();
        for (const socket of served.sockets) socket.destroy();
        served.servers = [];
    }

    // ---- inside each command

    /**
     * One line of shell to put before a command, or an empty string: it starts a `socat` per bridged port inside the command's
     * namespace and waits (a fraction of a second at most) until they listen. It is one line so the command's own line numbers
     * do not move, and everything it makes is in a subshell, so no variable of its own is left in the command's shell.
     */
    preamble(): string {
        const ports = this.forwarderPorts();
        const socat = this.deps.socat();
        if (ports.length === 0 || socat === undefined) return "";
        const quoted = `'${socat.replaceAll("'", "'\\''")}'`;
        const hex = ports.map((port) => port.toString(16).toUpperCase().padStart(4, "0")).join(" ");
        // The proxy's name and password are in the command's environment, set by the runtime for its own proxy clients.
        const proxy = (port: string): string => `PROXY:127.0.0.1:127.0.0.1:${port},proxyport=3128,proxyauth="$_a"`;
        return [
            `( _s=${quoted}; _a="$CLOUDSDK_PROXY_USERNAME:$CLOUDSDK_PROXY_PASSWORD";`,
            `for _p in ${ports.join(" ")}; do`,
            `{ "$_s" TCP6-LISTEN:$_p,ipv6only=0,fork,reuseaddr,backlog=128 ${proxy("$_p")} ||`,
            `exec "$_s" TCP4-LISTEN:$_p,fork,reuseaddr,backlog=128 ${proxy("$_p")}; } >/dev/null 2>&1 </dev/null & done;`,
            "_up() { for _f in /proc/net/tcp6 /proc/net/tcp; do while read -r _i _l _r _t _o; do",
            'case $_l in *:$1) [ "$_t" = 0A ] && return 0;; esac; done < $_f; done; return 1; };',
            `_all() { for _h in ${hex}; do _up $_h || return 1; done; return 0; };`,
            "_n=0; until _all; do [ $((_n+=1)) -gt 300 ] && break; done ); ",
        ].join(" ");
    }

    close(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
        for (const served of [...this.served.values()]) this.release(served);
        this.watched.clear();
    }
}
