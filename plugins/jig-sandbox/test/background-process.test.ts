// Stopping a task (the polite signal, the wait, the hard one) against a fake process table, and what a session that crashed
// leaves behind, found and cleaned at the next session start.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GRACE_MS, parseStat, terminate } from "../src/background/process.ts";
import type { ProcessPort, TerminateDeps } from "../src/background/process.ts";
import {
    backgroundRoot,
    cleanupSessions,
    ensureSessionFolder,
    writeManifest,
    writeOwner,
} from "../src/background/sessions.ts";

/** A process table that records the signals it is sent. */
function fakePort(over: Partial<ProcessPort> & { groups?: number[][] } = {}) {
    const signals: Array<[number, string]> = [];
    const groups = [...(over.groups ?? [[]])];
    const port: ProcessPort = {
        innerGroups: () => groups.shift() ?? groups.at(-1) ?? [],
        descendants: () => [],
        signal: (target, signal) => {
            signals.push([target, signal]);
            return true;
        },
        alive: () => false,
        startTicks: () => undefined,
        ...over,
    };
    return { port, signals };
}

function deps(port: ProcessPort, over: Partial<TerminateDeps> = {}): TerminateDeps {
    let clock = 0;
    return {
        port,
        ended: async () => true,
        sleep: async (ms) => void (clock += ms),
        now: () => clock,
        ...over,
    };
}

describe("stopping a task", () => {
    test("the inner groups get the polite signal first, and the outer group is left alone while they exist", async () => {
        const { port, signals } = fakePort({ groups: [[777, 778]] });
        const outcome = await terminate(500, 10_000, deps(port));
        assert.deepEqual(signals, [
            [-777, "SIGTERM"],
            [-778, "SIGTERM"],
        ]);
        assert.equal(outcome.how, "term");
    });

    test("with no inner group the task's own group gets it", async () => {
        const { port, signals } = fakePort();
        await terminate(500, 10_000, deps(port));
        assert.deepEqual(signals, [[-500, "SIGTERM"]]);
    });

    test("a task that has only just started is looked at again, since its groups may not exist yet", async () => {
        const slept: number[] = [];
        const { port, signals } = fakePort({ groups: [[], [901]] });
        await terminate(500, 100, deps(port, { sleep: async (ms) => void slept.push(ms) }));
        assert.deepEqual(slept, [50]);
        assert.deepEqual(signals, [[-901, "SIGTERM"]]);
    });

    test("a task that does not stop within the grace period gets the hard signal in every group", async () => {
        const waits: number[] = [];
        const { port, signals } = fakePort({ groups: [[777], [777], [777]] });
        let answers = [false, true];
        const outcome = await terminate(
            500,
            10_000,
            deps(port, {
                ended: async (ms) => {
                    waits.push(ms);
                    return answers.shift() ?? true;
                },
            }),
        );
        assert.deepEqual(waits, [GRACE_MS, 1_000]);
        assert.equal(GRACE_MS, 3_000);
        assert.deepEqual(signals.slice(-3), [
            [-500, "SIGKILL"],
            [-777, "SIGKILL"],
            [-777, "SIGKILL"],
        ]);
        assert.equal(outcome.how, "kill");
        answers = [false, false];
        const stuck = await terminate(
            500,
            10_000,
            deps(fakePort().port, { ended: async () => answers.shift() ?? false }),
        );
        assert.equal(stuck.how, "stuck");
    });

    test("it will not signal init, a negative pid or a fraction", async () => {
        for (const pid of [0, 1, -5, 2.5]) {
            await assert.rejects(() => terminate(pid, 0, deps(fakePort().port)), /refusing to signal/);
        }
    });
});

describe("reading /proc", () => {
    test("a name with spaces and parentheses does not confuse the fields", () => {
        const line =
            "4242 (my (odd) name) S 100 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 100 18446744073709551615";
        assert.deepEqual(parseStat(line), { pid: 4242, ppid: 100, pgrp: 4242, startTicks: "987654" });
        assert.equal(parseStat("garbage"), undefined);
    });
});

describe("what a crashed session leaves", () => {
    let agentDir: string;
    beforeEach(() => {
        agentDir = mkdtempSync(path.join(tmpdir(), "jig-bg-sessions-"));
    });
    afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

    /** A session folder as a Pi that died would leave it. */
    function leftBehind(
        name: string,
        owner: [number, string] | undefined,
        tasks: Array<[string, number, string]>,
    ): string {
        const folder = ensureSessionFolder(agentDir, name);
        if (owner) writeOwner(folder, owner[0], owner[1]);
        writeManifest(
            folder,
            tasks.map(([id, pid, startTicks]) => ({ id, pid, startTicks })),
        );
        writeFileSync(path.join(folder, "bg-1.log"), "output\n");
        return folder;
    }

    test("the tasks of a dead owner are stopped, in their groups, and the folder is removed", () => {
        const folder = leftBehind("old", [111, "5"], [["bg-1", 222, "42"]]);
        const { port, signals } = fakePort({ groups: [[333]], startTicks: (pid) => (pid === 222 ? "42" : undefined) });
        const done = cleanupSessions({ agentDir, port, now: Date.now() });
        assert.deepEqual(done.killed, [222]);
        assert.deepEqual(signals, [
            [-333, "SIGKILL"],
            [-222, "SIGKILL"],
        ]);
        assert.equal(existsSync(folder), false);
        assert.deepEqual(done.removed, ["old"]);
    });

    test("a pid that has been used again by another process is never signalled", () => {
        leftBehind("old", [111, "5"], [["bg-1", 222, "42"]]);
        const { port, signals } = fakePort({ startTicks: () => "99999" });
        const done = cleanupSessions({ agentDir, port, now: Date.now() });
        assert.deepEqual(signals, []);
        assert.deepEqual(done.killed, []);
    });

    test("a folder whose owner is still running is left alone, and so is the session's own", () => {
        const alive = leftBehind("live", [111, "5"], [["bg-1", 222, "42"]]);
        const own = leftBehind("mine", undefined, []);
        const { port, signals } = fakePort({ alive: () => true, startTicks: () => "5" });
        const done = cleanupSessions({ agentDir, port, now: Date.now(), keep: own });
        assert.deepEqual(signals, []);
        assert.ok(existsSync(alive) && existsSync(own));
        assert.deepEqual(done.removed, []);
    });

    test("an owner whose pid now belongs to another process is dead", () => {
        const folder = leftBehind("old", [111, "5"], []);
        const { port } = fakePort({ alive: () => true, startTicks: () => "another" });
        cleanupSessions({ agentDir, port, now: Date.now() });
        assert.equal(existsSync(folder), false);
    });

    test("a folder with no owner file stays for a day, then goes", () => {
        const folder = leftBehind("ownerless", undefined, []);
        const { port } = fakePort();
        cleanupSessions({ agentDir, port, now: Date.now() });
        assert.ok(existsSync(folder));
        const old = new Date(Date.now() - 2 * 24 * 3_600_000);
        for (const file of readdirSync(folder)) utimesSync(path.join(folder, file), old, old);
        cleanupSessions({ agentDir, port, now: Date.now() });
        assert.equal(existsSync(folder), false);
    });

    test("only files of its own are removed: a folder with a stranger's file in it stays", () => {
        const folder = leftBehind("old", [111, "5"], []);
        writeFileSync(path.join(folder, "notes.txt"), "not ours");
        cleanupSessions({ agentDir, port: fakePort().port, now: Date.now() });
        assert.deepEqual(readdirSync(folder), ["notes.txt"]);
    });

    test("nothing to find is not a problem, and the folder is private", () => {
        assert.deepEqual(cleanupSessions({ agentDir, port: fakePort().port, now: 0 }), { removed: [], killed: [] });
        mkdirSync(backgroundRoot(agentDir), { recursive: true });
        const folder = ensureSessionFolder(agentDir, "../../escape");
        assert.ok(folder.startsWith(backgroundRoot(agentDir)), "a session id cannot name a folder outside");
    });
});
