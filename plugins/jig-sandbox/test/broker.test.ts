// The broker process: started with a working folder of its own, asked over the pipe, stopped when the pipe closes.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { BrokerError, startBroker } from "../src/broker-client.ts";
import type { Broker, BrokerLaunch } from "../src/broker-client.ts";

const script = path.resolve(import.meta.dirname, "../broker/broker.mjs");

describe("the broker process", () => {
    let folder: string;
    before(() => {
        folder = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-broker-test-")));
    });
    after(() => rmSync(folder, { recursive: true, force: true }));

    const launch = (over: Partial<BrokerLaunch> = {}): BrokerLaunch => ({
        script,
        cwd: folder,
        env: { PATH: process.env.PATH ?? "" },
        ...over,
    });

    test("it runs with the folder it was given, in a process of its own, and leaves when it is stopped", async () => {
        const broker = await startBroker(launch());
        const hello = await broker.request<{ pid: number; cwd: string }>("hello");
        assert.equal(hello.cwd, folder);
        assert.equal(hello.pid, broker.pid);
        assert.notEqual(hello.pid, process.pid);
        assert.equal(broker.alive, true);
        const exited = new Promise<number | null>((resolve) => broker.onExit(resolve));
        await broker.stop();
        assert.equal(await exited, 0);
        assert.equal(broker.alive, false);
        await broker.stop();
    });

    test("it starts without Pi's loader options, whatever Node was started with", async () => {
        const broker = await startBroker(launch());
        try {
            await broker.request("hello");
        } finally {
            await broker.stop();
        }
    });

    test("an unknown request is an error with a message, and the broker goes on", async () => {
        const broker = await startBroker(launch());
        try {
            await assert.rejects(broker.request("no-such-request"), /unknown request: no-such-request/);
            await assert.rejects(broker.request("wrap", { command: "true", commandId: "x" }), /not started/);
            assert.equal((await broker.request<{ cwd: string }>("hello")).cwd, folder);
        } finally {
            await broker.stop();
        }
    });

    test("a request that gets no answer in time is rejected as timed out", async () => {
        const slow = path.join(folder, "slow-broker.mjs");
        writeFileSync(slow, "process.send({ event: 'ready' }); setInterval(() => {}, 1000);\n");
        const broker = await startBroker(launch({ script: slow, stopGraceMs: 200 }));
        try {
            await assert.rejects(
                broker.request("hello", {}, 100),
                (error: unknown) => error instanceof BrokerError && error.timedOut,
            );
        } finally {
            await broker.stop();
        }
    });

    test("a broker that dies fails what was waiting for it, and says it stopped", async () => {
        const dying = path.join(folder, "dying-broker.mjs");
        writeFileSync(dying, "process.send({ event: 'ready' }); process.on('message', () => process.exit(3));\n");
        const broker = await startBroker(launch({ script: dying }));
        await assert.rejects(broker.request("hello"), /the sandbox broker stopped/);
        assert.equal(broker.alive, false);
        await assert.rejects(broker.request("hello"), /is not running/);
    });

    test("a script that fails at start is reported with what it wrote", async () => {
        const failing = path.join(folder, "failing-broker.mjs");
        writeFileSync(failing, "process.stderr.write('no good\\n'); process.exit(2);\n");
        await assert.rejects(startBroker(launch({ script: failing })), /exited at start \(2\): no good/);
        const silent = path.join(folder, "silent-broker.mjs");
        writeFileSync(silent, "setInterval(() => {}, 1000);\n");
        await assert.rejects(startBroker(launch({ script: silent, startTimeoutMs: 200 })), /did not start in time/);
    });

    test("it writes nothing into its folder until the runtime wraps a command", async () => {
        const broker: Broker = await startBroker(launch());
        try {
            await broker.request("hello");
            assert.deepEqual(
                readdirSync(folder).filter((name) => name.startsWith(".")),
                [],
            );
        } finally {
            await broker.stop();
        }
    });
});
