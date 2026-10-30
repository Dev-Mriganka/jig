// The SSH route: the argument list ssh gets, and the life of the key file, with a fake `ssh` on PATH that behaves as ssh does for a
// local forward. The `tunnel` route is a company plugin's tunnel, a forward or a SOCKS proxy; without a provider it reports that
// none is registered.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { HostPort, SshRoute } from "../src/config.ts";
import { RouteError } from "../src/errors.ts";
import { freePort, probe, sshArguments, startForward } from "../src/route.ts";
import type { Forward, RouteDeps } from "../src/route.ts";
import { fakeSsh } from "./support/fake-ssh.ts";
import type { FakeSsh } from "./support/fake-ssh.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";

const KEY = ["not-a-real-key", "line-1", "line-2"].join("\n");
const route: SshRoute = {
    kind: "ssh",
    host: "bastion.example.com",
    user: "agent",
    key: "pass:ssh/bastion",
    port: 2222,
};
const target: HostPort = { host: "db.example.com", port: 27017 };

let jig: FakeJig;
let ssh: FakeSsh;
let scratch: string;
const forwards: Forward[] = [];

before(() => void (jig = installFakeJig()));
after(() => jig.remove());
beforeEach(() => {
    ssh = fakeSsh();
    jig.reset();
    jig.useProgramsIn(ssh.bin);
    jig.secrets.set("pass:ssh/bastion", KEY);
    scratch = mkdtempSync(path.join(tmpdir(), "jig-mongo-scratch-"));
});
afterEach(() => {
    for (const forward of forwards.splice(0)) forward.stop();
    ssh.remove();
    rmSync(scratch, { recursive: true, force: true });
});

const deps = (extra: Partial<RouteDeps> = {}): RouteDeps => ({
    run: (file, args, options) => jig.api.exec.run(file, args, options),
    openTunnel: (name, target, signal) => jig.api.tunnels.open(name, target, signal),
    resolveSecret: (reference, signal) => jig.api.secrets.resolve(reference, signal),
    freePort,
    probe,
    tmpDir: () => scratch,
    readyTimeoutMs: 5000,
    pollMs: 20,
    lifetimeMs: 60_000,
    ...extra,
});

/**
 * A probe that finds nothing listening, for the tests where the forward must NOT come up. `freePort` hands out a port that is free
 * for a moment; in a full run other test files open servers on port 0 at the same time, and one of them can be given the same
 * port. The real probe would then connect to it and call that a forward that works, and a call that has to fail would succeed.
 */
const nobodyListens: Partial<RouteDeps> = { probe: async () => false };

const start = async (extra: Partial<RouteDeps> = {}, signal?: AbortSignal): Promise<Forward> => {
    const forward = await startForward(route, target, deps(extra), signal);
    forwards.push(forward);
    return forward;
};

/** The files and folders the route left in its temporary folder. */
const leftBehind = (): string[] => readdirSync(scratch);

const waitUntil = async (condition: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(what);
};

describe("the arguments of ssh", () => {
    test("a local forward, only the key given, no configuration file, no prompt, and a failed forward ends ssh", async () => {
        const forward = await start();
        const [run] = ssh.runs();
        assert.ok(run);
        const args = run.argv;
        const keyFile = args[args.indexOf("-i") + 1] as string;
        assert.deepEqual(args, [
            "-N",
            "-L",
            `127.0.0.1:${forward.port}:db.example.com:27017`,
            "-i",
            keyFile,
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
            "-p",
            "2222",
            "agent@bastion.example.com",
        ]);
        assert.ok(forward.port > 0);
    });

    test("the port is left out when the route has none, and the user and host are one word", () => {
        const args = sshArguments({ ...route, port: undefined }, 41000, target, "/tmp/k");
        assert.ok(!args.includes("-p"));
        assert.equal(args.at(-1), "agent@bastion.example.com");
        assert.ok(
            args.filter((arg) => arg.startsWith("-")).every((arg) => ["-N", "-L", "-i", "-F", "-o"].includes(arg)),
        );
    });

    test("it is started through jig-core's exec: ssh by name, an argument list, a lifetime, a signal, and no input or environment of its own", async () => {
        await start();
        assert.equal(jig.started.length, 1);
        const started = jig.started[0];
        assert.equal(started?.file, "ssh");
        assert.ok(Array.isArray(started?.args));
        assert.equal(started?.options.timeoutMs, 60_000);
        assert.ok(started?.options.signal instanceof AbortSignal);
        assert.equal(started?.options.input, undefined);
        assert.equal(started?.options.env, undefined);
    });
});

describe("the key file", () => {
    test("is private while ssh signs in, holds the key, and is gone once the forward works", async () => {
        const forward = await start();
        const [run] = ssh.runs();
        assert.equal(run?.key?.mode, "600");
        assert.equal(run?.key?.dirMode, "700");
        assert.equal(run?.key?.content, `${KEY}\n`);
        assert.deepEqual(leftBehind(), [], "the file and its folder are deleted");
        assert.equal(await probe(forward.port), true, "the forward still works without the file");
        assert.deepEqual(jig.resolved, ["pass:ssh/bastion"]);
    });

    test("a key that already ends with a newline is not given a second one", async () => {
        jig.secrets.set("pass:ssh/bastion", `${KEY}\n`);
        await start();
        assert.equal(ssh.runs()[0]?.key?.content, `${KEY}\n`);
    });

    test("is deleted when ssh fails, whatever the failure", async () => {
        for (const mode of ["denied", "hostkey", "unreachable", "badkey"] as const) {
            ssh.mode(mode);
            await assert.rejects(startForward(route, target, deps(nobodyListens)), RouteError, mode);
            assert.deepEqual(leftBehind(), [], mode);
        }
    });

    test("is deleted when the forward never comes up, and ssh is stopped", async () => {
        ssh.mode("silent");
        await assert.rejects(
            startForward(route, target, deps({ ...nobodyListens, readyTimeoutMs: 300 })),
            /did not become ready in time/,
        );
        assert.deepEqual(leftBehind(), []);
        assert.equal(jig.started.length, 1, "ssh was started once, and is not started again");
    });

    test("is deleted when the call is cancelled while ssh starts", async () => {
        ssh.mode("silent");
        const controller = new AbortController();
        const pending = startForward(route, target, deps(nobodyListens), controller.signal);
        // Once ssh has been started: a fixed delay would be too short on a busy machine.
        await waitUntil(() => jig.started.length > 0, "ssh was started");
        controller.abort();
        await assert.rejects(pending, /cancelled/);
        assert.deepEqual(leftBehind(), []);
    });

    test("is never made when the call was cancelled before ssh could start", async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(startForward(route, target, deps(), controller.signal), /cancelled/);
        assert.deepEqual(leftBehind(), []);
        assert.equal(ssh.runs().length, 0);
    });

    test("is never made when the secret cannot be read", async () => {
        jig.secrets.clear();
        await assert.rejects(startForward(route, target, deps()), /could not be resolved/);
        assert.deepEqual(leftBehind(), []);
        assert.equal(ssh.runs().length, 0);
    });
});

describe("the forward", () => {
    test("accepts connections on the local port until it is stopped, and stop is safe twice", async () => {
        const forward = await start();
        assert.equal(forward.alive(), true);
        assert.equal(await probe(forward.port), true);
        forward.stop();
        await waitUntil(async () => !forward.alive(), "ssh ended");
        await waitUntil(async () => !(await probe(forward.port)), "the port closed");
        forward.stop();
    });

    test("a forward that ssh ended is not alive", async () => {
        const forward = await start();
        forward.stop();
        await waitUntil(() => !forward.alive(), "the forward ended");
        assert.equal(forward.alive(), false);
    });

    test("each failure of ssh is one line that says what to do, and does not repeat what ssh printed", async () => {
        const expected: Record<string, RegExp> = {
            denied: /the bastion refused the SSH key/,
            hostkey: /host key is not trusted: connect to it once with ssh/,
            unreachable: /cannot reach the bastion: check the network and the VPN/,
            badkey: /the SSH key could not be read: it must be an unencrypted private key/,
        };
        for (const [mode, pattern] of Object.entries(expected)) {
            ssh.mode(mode as "denied");
            await assert.rejects(
                startForward(route, target, deps(nobodyListens)),
                (error: unknown) =>
                    error instanceof RouteError &&
                    pattern.test(error.message) &&
                    !/Permission denied|Connection timed out/.test(error.message),
                mode,
            );
        }
    });

    test("ssh missing from PATH is reported", async () => {
        jig.useProgramsIn(path.join(scratch, "no-such-folder"));
        const original = process.env.PATH;
        process.env.PATH = "";
        try {
            await assert.rejects(
                startForward(route, target, deps(nobodyListens)),
                /could not start: ssh is not installed or not on PATH/,
            );
        } finally {
            process.env.PATH = original;
        }
        assert.deepEqual(leftBehind(), []);
    });
});

describe("the tunnel route", () => {
    test("is accepted, and reports at call time that no tunnel provider is registered", async () => {
        await assert.rejects(
            startForward({ kind: "tunnel", name: "corp-net" }, target, deps()),
            (error: unknown) =>
                error instanceof RouteError &&
                /no tunnel provider is registered/.test(error.message) &&
                error.message.includes('"corp-net"'),
        );
        assert.equal(jig.started.length, 0, "nothing was started");
        assert.equal(existsSync(path.join(scratch, "x")), false);
        assert.deepEqual(leftBehind(), []);
    });
});

describe("a company's tunnel", () => {
    const tunnel = { kind: "tunnel", name: "corp-net" } as const;

    test("is opened by name for the database host, and gives its kind and its port", async () => {
        const asked: HostPort[] = [];
        for (const [kind, expected] of [
            ["forward", "forward"],
            ["socks", "socks"],
            [undefined, "forward"],
        ] as const) {
            jig.api.tunnels.register("corp-net", {
                open: async (host) => {
                    asked.push(host);
                    return { ...(kind === undefined ? {} : { kind }), port: 41_777, close: () => {} };
                },
            });
            const forward = await startForward(tunnel, target, deps());
            forwards.push(forward);
            assert.deepEqual([forward.kind, forward.port, forward.alive()], [expected, 41_777, true]);
        }
        assert.deepEqual(asked, [target, target, target]);
    });

    test("stops once: it is not alive any more, and the provider's close is called once", async () => {
        let closed = 0;
        jig.api.tunnels.register("corp-net", {
            open: async () => ({ kind: "socks", port: 41_778, close: () => void closed++ }),
        });
        const forward = await startForward(tunnel, target, deps());
        forward.stop();
        forward.stop();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(forward.alive(), false);
        assert.equal(closed, 1);
    });

    test("is reported without a provider as the route that needs a company plugin, and a failing provider in a line", async () => {
        await assert.rejects(
            startForward(tunnel, target, deps()),
            (error: unknown) =>
                error instanceof RouteError &&
                error.message ===
                    'no tunnel provider is registered: the route "corp-net" needs a company plugin that provides it',
        );
        jig.api.tunnels.register("corp-net", {
            open: async () => {
                throw new Error("the VPN is not connected");
            },
        });
        await assert.rejects(
            startForward(tunnel, target, deps()),
            /the tunnel "corp-net" could not be opened: tunnel provider "corp-net" failed: the VPN is not connected/,
        );
        jig.api.tunnels.register("corp-net", {
            open: async () => ({ kind: "udp", port: 41_779, close: () => {} }) as never,
        });
        await assert.rejects(startForward(tunnel, target, deps()), /whose kind is not forward or socks/);
    });

    test("a call that was cancelled before it started opens nothing", async () => {
        let opened = 0;
        jig.api.tunnels.register("corp-net", {
            open: async () => {
                opened++;
                return { port: 41_780, close: () => {} };
            },
        });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(startForward(tunnel, target, deps(), controller.signal), /cancelled/);
        assert.equal(opened, 0);
    });
});
