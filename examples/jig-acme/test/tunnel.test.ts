// `acme-bastion`, the tunnel provider: `ssh -L` through a bastion host, with the kind `forward`. The `ssh` here is a fake script that
// comes first on PATH: it listens on the port it was asked to forward, writes a line that names the host and port it was asked to
// reach, and records how it was started. Nothing real is run, and no network is used.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BASTION_TUNNEL, sshArguments } from "../src/tunnel.ts";
import { fakePrograms } from "./support/programs.ts";
import type { FakePrograms } from "./support/programs.ts";
import { startWorld } from "./support/world.ts";
import type { World } from "./support/world.ts";

const TARGET = { host: "mongo.staging.acme.example", port: 27017 };
const personal = { acme: { bastion: { user: "jdoe" } } };

let programs: FakePrograms;
let world: World | undefined;
const saved = { path: process.env.PATH, agent: process.env.SSH_AUTH_SOCK, other: process.env.ACME_TEST_OTHER_SECRET };
beforeEach(() => {
    programs = fakePrograms();
    process.env.PATH = `${programs.bin}:${saved.path ?? ""}`;
    process.env.SSH_AUTH_SOCK = "/run/user/1000/agent.sock";
    process.env.ACME_TEST_OTHER_SECRET = "must-not-reach-ssh";
});
afterEach(async () => {
    await world?.close();
    world = undefined;
    for (const [name, value] of [
        ["PATH", saved.path],
        ["SSH_AUTH_SOCK", saved.agent],
        ["ACME_TEST_OTHER_SECRET", saved.other],
    ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    programs.close();
});

/** Reads what the port sends. */
function readFrom(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        let text = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            text += chunk;
        });
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
    });
}

async function refused(port: number, withinMs = 3000): Promise<boolean> {
    const until = Date.now() + withinMs;
    while (Date.now() < until) {
        try {
            await readFrom(port);
        } catch {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/** Waits until the fake ssh has started and written its record, so that its process id is known. */
async function started(withinMs = 5000): Promise<number> {
    const until = Date.now() + withinMs;
    while (Date.now() < until) {
        const [first] = programs.sshCalls();
        if (first !== undefined) return first.pid;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the fake ssh did not start");
}

async function gone(pid: number, withinMs = 3000): Promise<boolean> {
    const until = Date.now() + withinMs;
    while (Date.now() < until) {
        if (!alive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
}

describe("a tunnel through the bastion", () => {
    test("is a forward: the port reaches the one host and port that was asked for", async () => {
        world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs: 5000, pollMs: 20 } } });
        const tunnel = await world.api.tunnels.open(BASTION_TUNNEL, TARGET);
        try {
            assert.equal(tunnel.kind, "forward");
            assert.ok(tunnel.port > 0);
            assert.equal(await readFrom(tunnel.port), "fake-db mongo.staging.acme.example:27017\n");
        } finally {
            await tunnel.close();
        }
    });

    test("starts ssh with an argument list that reads no configuration and asks no question", async () => {
        world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs: 5000, pollMs: 20 } } });
        const tunnel = await world.api.tunnels.open(BASTION_TUNNEL, TARGET);
        await tunnel.close();
        const [started] = programs.sshCalls();
        assert.deepEqual(
            started?.args,
            sshArguments({ host: "bastion.acme.example", user: "jdoe" }, tunnel.port, TARGET),
        );
        const args = started?.args ?? [];
        assert.deepEqual(args.slice(0, 3), ["-N", "-L", `127.0.0.1:${tunnel.port}:mongo.staging.acme.example:27017`]);
        assert.ok(args.includes("BatchMode=yes") && args.includes("StrictHostKeyChecking=yes"));
        assert.equal(args[args.indexOf("-F") + 1], "/dev/null");
        assert.equal(args.at(-1), "jdoe@bastion.acme.example");
    });

    test("passes ssh the user's agent and nothing else of Pi's environment", async () => {
        world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs: 5000, pollMs: 20 } } });
        await (await world.api.tunnels.open(BASTION_TUNNEL, TARGET)).close();
        const [started] = programs.sshCalls();
        assert.equal(started?.agent, "/run/user/1000/agent.sock");
        assert.equal(started?.env.includes("ACME_TEST_OTHER_SECRET"), false, started?.env.join(","));
    });

    test("closing it stops ssh", async () => {
        world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs: 5000, pollMs: 20 } } });
        const tunnel = await world.api.tunnels.open(BASTION_TUNNEL, TARGET);
        const pid = await started();
        assert.ok(alive(pid), "ssh is running while the tunnel is open");
        await tunnel.close();
        assert.equal(await gone(pid), true, "ssh has stopped");
        assert.equal(await refused(tunnel.port), true, "and the port is closed");
    });

    test("a tool can open it for a connection of the mongo section: that is what the company default names", async () => {
        world = await startWorld({ personal });
        const mongo = world.api.config.section("mongo") as { connections: Record<string, { via?: unknown }> };
        assert.deepEqual(mongo.connections.staging?.via, { tunnel: BASTION_TUNNEL });
        assert.deepEqual(mongo.connections.prod?.via, { tunnel: BASTION_TUNNEL });
        assert.equal(mongo.connections.dev?.via, undefined, "dev is reached directly");
    });
});

describe("a tunnel that cannot be opened says why, in one line, and runs nothing it should not", () => {
    // A fake ssh that fails does so as soon as it starts, so a long time to wait costs nothing; it is generous because the
    // machine running the tests may be busy.
    const open = async (readyTimeoutMs = 10_000, over: Parameters<typeof startWorld>[0] = {}) => {
        world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs, pollMs: 20 } }, ...over });
        return world.api.tunnels.open(BASTION_TUNNEL, TARGET);
    };

    test("without a login on the bastion, ssh is not started at all", async () => {
        await assert.rejects(open(1000, { personal: {} }), /set acme\.bastion\.user in your jig\.json/);
        assert.deepEqual(programs.sshCalls(), []);
    });

    test("a host key that is not trusted", async () => {
        programs.ssh("hostkey");
        await assert.rejects(open(), /host key is not trusted: connect to it once with ssh yourself/);
    });

    test("a login the bastion refuses: ssh's own words are not repeated", async () => {
        programs.ssh("denied");
        await assert.rejects(open(), (error: Error) => {
            assert.match(error.message, /refused your login: check acme\.bastion\.user/);
            assert.equal(error.message.includes("publickey"), false);
            return true;
        });
    });

    test("a bastion that cannot be reached", async () => {
        programs.ssh("unreachable");
        await assert.rejects(open(), /cannot reach the bastion/);
    });

    test("an ssh that never sets the forward up is stopped when the time runs out", async () => {
        programs.ssh("hang");
        await assert.rejects(open(2500), /did not become ready in time/);
        assert.equal(await gone(await started()), true, "the ssh that hung is stopped, not left behind");
    });

    test("a call that is cancelled while it waits stops ssh, too", async () => {
        programs.ssh("hang");
        world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs: 5000, pollMs: 20 } } });
        const controller = new AbortController();
        const pending = world.api.tunnels.open(BASTION_TUNNEL, TARGET, controller.signal);
        const outcome = assert.rejects(pending, /cancelled/);
        const pid = await started();
        controller.abort();
        await outcome;
        assert.equal(await gone(pid), true, "the ssh that was waited for is stopped");
    });

    test("a host that could be read as an option or as a command is refused before ssh is started", async () => {
        world = await startWorld({ personal });
        for (const host of ["-oProxyCommand=evil", "mongo.staging.acme.example;ls", "a b", ""]) {
            await assert.rejects(world.api.tunnels.open(BASTION_TUNNEL, { host, port: 27017 }), /host|target/i, host);
        }
        for (const port of [0, 70000, 1.5]) {
            await assert.rejects(
                world.api.tunnels.open(BASTION_TUNNEL, { host: TARGET.host, port }),
                /port/,
                String(port),
            );
        }
        assert.deepEqual(programs.sshCalls(), []);
    });

    test("a login or a bastion name that could be read as an option is refused when the file is read", async () => {
        world = await startWorld({ personal: { acme: { bastion: { user: "-oProxyCommand=evil", host: "-x" } } } });
        const problems = (await world.problems()).join("\n");
        assert.match(problems, /acme\.bastion\.user: must be a login name/);
        assert.match(problems, /acme\.bastion\.host: must be a host name/);
    });
});

describe("ssh is found only where the agent cannot have put it", () => {
    test("an ssh in the folder Pi was started in is not run", async () => {
        // jig-core's `exec.run` leaves out of PATH any folder the agent's shell can write, the working folder first. Pi is
        // "started" in the folder the fake ssh is in, so the fake is the only ssh there is, and it must not be run.
        const before = process.cwd();
        process.chdir(programs.bin);
        // Only that folder is on PATH, so that no real ssh is run if the guard fails.
        process.env.PATH = programs.bin;
        try {
            world = await startWorld({ personal, acme: { tunnel: { readyTimeoutMs: 1000, pollMs: 20 } } });
            await assert.rejects(world.api.tunnels.open(BASTION_TUNNEL, TARGET), /ssh could not start/);
            assert.deepEqual(programs.sshCalls(), []);
        } finally {
            process.chdir(before);
        }
    });
});
