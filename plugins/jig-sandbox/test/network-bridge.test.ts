// The localhost bridge, without namespaces: how a task's listening ports are read, what the forwarders in each command look
// like, and the listener on this machine that carries a connection to a task's server. The helper that enters the task's
// namespace is replaced by one that connects directly; the real thing is in `network-real.test.ts`.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, test } from "node:test";
import type { Task } from "../src/background/types.ts";
import { Bridge, CANNOT_ENTER, ENTER_SCRIPT, listeningPorts } from "../src/network/bridge.ts";
import type { BridgeDeps, BridgeProcesses, Enter, Listening } from "../src/network/bridge.ts";
import type { NetworkMode } from "../src/config.ts";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const line = (index: number, local: string, state: string) =>
    `  ${index}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 20838363 1 0000000000000000 100 0 0 10 0\n`;

describe("reading a namespace's listening ports", () => {
    test("loopback and any-address listeners count, as the address to dial", () => {
        const tcp =
            HEADER +
            line(0, "0100007F:480C", "0A") + // 127.0.0.1:18444
            line(1, "00000000:0BB8", "0A") + // 0.0.0.0:3000
            line(2, "0100007F:1F90", "01") + // established, not listening
            line(3, "0A0A0A0A:1234", "0A") + // 10.10.10.10, not reachable from the loopback
            line(4, "0200007F:2328", "0A"); // 127.0.0.2:9000
        const tcp6 =
            HEADER +
            line(0, "00000000000000000000000000000000:1388", "0A") + // [::]:5000
            line(1, "00000000000000000000000001000000:1771", "0A") + // [::1]:6001
            line(2, "0000000000000000FFFF00000100007F:1B58", "0A") + // [::ffff:127.0.0.1]:7000
            line(3, "20010DB8000000000000000000000001:2710", "0A") + // a public-looking address
            line(4, "00000000000000000000000000000000:0BB8", "0A"); // [::]:3000, the same port as the IPv4 one
        assert.deepEqual(listeningPorts(tcp, tcp6), [
            { port: 3000, address: "127.0.0.1" },
            { port: 5000, address: "::1" },
            { port: 6001, address: "::1" },
            { port: 7000, address: "127.0.0.1" },
            { port: 9000, address: "127.0.0.2" },
            { port: 18444, address: "127.0.0.1" },
        ]);
    });

    test("an empty or damaged table lists nothing", () => {
        assert.deepEqual(listeningPorts("", ""), []);
        assert.deepEqual(listeningPorts(`${HEADER}garbage\n  0: zz:zz 0:0 0A\n`, ""), []);
    });
});

describe("the helper that enters a namespace", () => {
    test("is a fixed script that takes a pid, an address and a port, and exits with a known code when it cannot enter", () => {
        assert.match(ENTER_SCRIPT, /sys\.argv\[1\]/);
        assert.match(ENTER_SCRIPT, new RegExp(`sys\\.exit\\(${CANNOT_ENTER}\\)`));
        assert.match(
            ENTER_SCRIPT,
            /0xb701/,
            "the user namespace that owns the network namespace is found through the kernel",
        );
    });
});

function task(id: string, pid = 4000): Task {
    return {
        id,
        name: id,
        command: "serve",
        cwd: "/work",
        pid,
        startedAt: 0,
        state: "running",
        deadline: 0,
        timeoutMs: 0,
        notifyOn: { ready: [], error: [] },
        cursor: 0,
        ready: false,
        errorMatches: 0,
        streamBytes: 0,
        sandboxLines: [],
        ports: [],
        notes: [],
        settled: Promise.resolve(),
        markSettled: () => undefined,
    };
}

/** A port nothing is listening on now. */
async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

interface World {
    bridge: Bridge;
    /** What the task's namespace listens on now. */
    listening: Listening[];
    namespaces: Map<number, string | undefined>;
    entered: Array<[number, string, number]>;
    notes: string[];
    mode: { value: NetworkMode };
    /** The server the fake helper connects to instead of entering a namespace. */
    upstream: { port: number };
}

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

function world(
    options: Omit<Partial<BridgeDeps>, "localhost"> & { localhost?: number[]; exitWith?: number } = {},
): World {
    const { localhost, exitWith, ...over } = options;
    const mode = { value: "filtered" as NetworkMode };
    const namespaces = new Map<number, string | undefined>([
        [process.pid, "net:[1]"],
        [4000, undefined],
        [4001, "net:[77]"],
    ]);
    const state: World = {
        bridge: undefined as never,
        listening: [],
        namespaces,
        entered: [],
        notes: [],
        mode,
        upstream: { port: 0 },
    };
    const processes: BridgeProcesses = {
        descendants: (pid) => (pid === 4000 ? [4001] : []),
        netNamespace: (pid) => namespaces.get(pid),
        listening: () => state.listening,
        alive: (pid) => namespaces.has(pid),
    };
    // The helper, replaced: it connects to the test's own server and carries bytes, as the real one does inside a namespace.
    const enter: Enter = (pid, address, port) => {
        state.entered.push([pid, address, port]);
        const child = new EventEmitter() as ChildProcess;
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        Object.assign(child, { stdin, stdout });
        (child as unknown as { kill: () => boolean }).kill = () => true;
        if (exitWith !== undefined) {
            setImmediate(() => child.emit("exit", exitWith));
            return child;
        }
        const upstream = net.connect(state.upstream.port, "127.0.0.1");
        upstream.on("error", () => undefined);
        stdin.pipe(upstream);
        upstream.pipe(stdout);
        upstream.once("close", () => child.emit("exit", 0));
        (child as unknown as { kill: () => boolean }).kill = () => {
            upstream.destroy();
            return true;
        };
        return child;
    };
    state.bridge = new Bridge({
        mode: () => mode.value,
        localhost: () => localhost ?? [],
        socat: () => "/usr/bin/socat",
        python: () => "/usr/bin/python3",
        platform: "linux",
        processes,
        enter,
        notify: (message) => state.notes.push(message),
        ...over,
    });
    closers.push(() => state.bridge.close());
    return state;
}

async function ask(port: number, request = "ping"): Promise<string> {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let got = "";
        socket.on("data", (chunk) => {
            got += chunk;
        });
        socket.on("error", () => resolve(`error`));
        socket.on("close", () => resolve(got));
        socket.write(request);
    });
}

describe("a task's server", () => {
    test("is carried to a listener on this machine's loopback at the same port, which dials it through the helper", async () => {
        const w = world();
        const server = net.createServer((socket) => socket.on("data", (data) => socket.end(`echo:${data}`)));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        closers.push(() => void server.close());
        w.upstream.port = (server.address() as net.AddressInfo).port;
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        const t = task("bg-1");
        w.bridge.taskStarted(t);
        await w.bridge.sync();
        assert.equal(w.bridge.serves(port), true);
        assert.deepEqual(t.ports, [port]);
        assert.deepEqual(w.bridge.forwarderPorts(), [port]);
        assert.equal(await ask(port), "echo:ping");
        assert.deepEqual(w.entered[0], [4001, "127.0.0.1", port]);
    });

    test("ports of the runtime's own relays are never carried", async () => {
        const w = world();
        w.listening = [
            { port: 3128, address: "127.0.0.1" },
            { port: 1080, address: "::1" },
        ];
        w.bridge.taskStarted(task("bg-1"));
        await w.bridge.sync();
        assert.deepEqual(w.bridge.forwarderPorts(), []);
        assert.equal(w.bridge.serves(3128), false);
    });

    test("when the task ends its listener goes, and the port is no longer served", async () => {
        const w = world();
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        const t = task("bg-1");
        w.bridge.taskStarted(t);
        await w.bridge.sync();
        assert.equal(w.bridge.serves(port), true);
        w.bridge.taskEnded(t);
        assert.equal(w.bridge.serves(port), false);
        assert.deepEqual(t.ports, []);
        assert.equal(await ask(port), "error", "nothing listens there now");
    });

    test("a port the server stopped listening on is dropped after two looks, not one", async () => {
        const w = world();
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        w.bridge.taskStarted(task("bg-1"));
        await w.bridge.sync();
        w.listening = [];
        // Looks are at least 150 ms apart, and a server restarting is gone for one of them.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await w.bridge.sync();
        assert.equal(w.bridge.serves(port), true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await w.bridge.sync();
        assert.equal(w.bridge.serves(port), false);
    });

    test("a port that is in use on this machine is not carried, and the task says why: it could be a tunnel", async () => {
        const w = world();
        const taken = net.createServer();
        await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
        closers.push(() => void taken.close());
        const port = (taken.address() as net.AddressInfo).port;
        w.listening = [{ port, address: "127.0.0.1" }];
        const t = task("bg-1");
        w.bridge.taskStarted(t);
        await w.bridge.sync();
        assert.equal(w.bridge.serves(port), false, "so the callback does not allow a connection to what is there");
        assert.deepEqual(t.ports, []);
        assert.match(t.notes[0] ?? "", new RegExp(`port ${port} is also in use on this machine`));
        assert.match(w.notes[0] ?? "", /^bg-1: port \d+ is also in use/);
    });

    test("two tasks on one port: the first is carried and the second says it is not", async () => {
        const w = world();
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        const first = task("bg-1", 4000);
        const second = task("bg-2", 4000);
        w.bridge.taskStarted(first);
        w.bridge.taskStarted(second);
        await w.bridge.sync();
        assert.deepEqual([first.ports.length, second.ports.length], [1, 0]);
        assert.match(second.notes[0] ?? "", /already bridged to bg-1's server/);
    });

    test("a connection is dropped when the process it would enter is not the one that was found (a pid used again)", async () => {
        const w = world();
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        w.bridge.taskStarted(task("bg-1"));
        await w.bridge.sync();
        w.namespaces.set(4001, "net:[999]");
        assert.ok(["", "error"].includes(await ask(port)), "the connection was closed");
        assert.deepEqual(w.entered, [], "nothing was entered");
    });

    test("without python3 nothing is entered, and the problem is said", async () => {
        const w = world({ python: () => undefined });
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        w.bridge.taskStarted(task("bg-1"));
        await w.bridge.sync();
        assert.match(w.bridge.problem ?? "", /python3 is not installed/);
        assert.ok(["", "error"].includes(await ask(port)), "the connection was closed");
    });

    test("a helper that could not enter the namespace is reported once as a problem", async () => {
        const w = world({ exitWith: CANNOT_ENTER });
        const port = await freePort();
        w.listening = [{ port, address: "127.0.0.1" }];
        const t = task("bg-1");
        w.bridge.taskStarted(t);
        await w.bridge.sync();
        await ask(port);
        await ask(port);
        assert.match(w.bridge.problem ?? "", /does not let the bridge enter a task's network namespace/);
        assert.equal(t.notes.length, 1);
    });

    test("the bridge does nothing in open and off, or off Linux", async () => {
        for (const mode of ["open", "off"] as const) {
            const w = world();
            w.mode.value = mode;
            w.listening = [{ port: await freePort(), address: "127.0.0.1" }];
            w.bridge.taskStarted(task("bg-1"));
            await w.bridge.sync();
            assert.equal(w.bridge.active, false);
            assert.deepEqual(w.bridge.forwarderPorts(), []);
            assert.equal(w.bridge.preamble(), "");
            assert.equal(w.bridge.problem, undefined);
        }
        const mac = world({ platform: "darwin", localhost: [5432] });
        assert.equal(mac.bridge.active, false);
        assert.equal(mac.bridge.preamble(), "");
    });
});

describe("what each command starts with", () => {
    test("nothing, when no port is listed and no server is carried", () => {
        assert.equal(world().bridge.preamble(), "");
    });

    test("a forwarder per listed port, on one line, that waits for them to listen", () => {
        const w = world({ localhost: [5432, 6379] });
        const text = w.bridge.preamble();
        assert.equal(text.includes("\n"), false, "one line, so the command's line numbers do not move");
        assert.match(text, /^\( _s='\/usr\/bin\/socat'; /);
        assert.match(text, /for _p in 5432 6379; do/);
        assert.match(text, /TCP6-LISTEN:\$_p,ipv6only=0,fork,reuseaddr/);
        assert.match(text, /PROXY:127\.0\.0\.1:127\.0\.0\.1:\$_p,proxyport=3128,proxyauth="\$_a"/);
        assert.match(text, /_a="\$CLOUDSDK_PROXY_USERNAME:\$CLOUDSDK_PROXY_PASSWORD"/);
        assert.match(text, /for _h in 1538 18EB; do/, "the ports as the table of sockets writes them");
        assert.match(text, /; $/, "it ends so that the command follows on the same line");
    });

    test("listed ports and carried servers together, in order, without the relays, and at most sixteen", async () => {
        const many = Array.from({ length: 30 }, (_, index) => 20_000 + index);
        const w = world({ localhost: [6379, 3128, 1080, 5432, ...many] });
        const ports = w.bridge.forwarderPorts();
        assert.equal(ports.length, 16);
        assert.deepEqual(ports.slice(0, 2), [5432, 6379]);
        assert.ok(!ports.includes(3128) && !ports.includes(1080));
    });

    test("the path of socat is quoted", () => {
        const w = world({ localhost: [5432], socat: () => "/opt/it's here/socat" });
        assert.match(w.bridge.preamble(), /^\( _s='\/opt\/it'\\''s here\/socat'; /);
    });

    test("it is plain shell that a shell accepts", async () => {
        const { execFileSync } = await import("node:child_process");
        const text = world({ localhost: [5432, 6379] }).bridge.preamble();
        execFileSync("bash", ["-n", "-c", `${text}echo done`]);
        execFileSync("bash", ["-n", "-c", `${text}`]);
    });
});
