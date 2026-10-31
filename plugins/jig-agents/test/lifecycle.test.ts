// A child ends with its parent: when the session ends, when the parent dies and leaves the child to the next session's sweep, and when
// a child notices that its parent has gone. A process is only touched when its recorded start time still matches.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { realHost } from "../src/host.ts";
import type { Host } from "../src/host.ts";
import { sweep, watchParent, WATCHDOG_MS } from "../src/orphans.ts";
import { listChildren, readMeta, removeOld, runDirOf, writeMeta } from "../src/store.ts";
import type { Meta } from "../src/store.ts";
import { FAKE_CHILD, sleep, startWorld, until } from "./world.ts";
import type { World } from "./world.ts";

let w: World | undefined;
const processes: Array<ReturnType<typeof spawn>> = [];
afterEach(async () => {
    await w?.close();
    w = undefined;
    for (const proc of processes.splice(0)) {
        try {
            if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
        } catch {
            // Gone already.
        }
    }
});

const real = realHost();
const alive = (pid: number) => real.alive(pid);

/** A real fake-child process of its own, as a child an earlier session left behind. */
async function leftover(root: string): Promise<{ pid: number; start: string }> {
    const script = path.join(root, "orphan-script.json");
    writeFileSync(script, JSON.stringify({ steps: [{ hold: true }] }));
    const proc = spawn(process.execPath, [FAKE_CHILD], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { PI_FAKE_SCRIPT: script, PATH: process.env.PATH ?? "" },
    });
    processes.push(proc);
    const pid = proc.pid as number;
    await until(() => alive(pid), "the process");
    const start = await real.processStart(pid);
    assert.ok(start, "a start time for the process");
    return { pid, start };
}

/** A parent that is gone: a process that started and ended, with its start time as it was. */
async function deadParent(): Promise<{ pid: number; start: string }> {
    const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    processes.push(proc);
    const pid = proc.pid as number;
    await until(() => alive(pid), "the process");
    const start = (await real.processStart(pid)) as string;
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid), "the process to end");
    return { pid, start };
}

function meta(over: Partial<Meta>): Meta {
    return {
        version: 1,
        id: "old001",
        name: "scout-1",
        role: "scout",
        session: "old-session",
        parentPid: 1,
        state: "running",
        startedAt: "2026-10-30T10:00:00.000Z",
        updatedAt: "2026-10-30T10:00:00.000Z",
        cwd: "/tmp",
        generation: 1,
        ...over,
    };
}

describe("the end of the parent's session", () => {
    test("ends every child: its input is closed, it is signalled, and its record says it was stopped", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        await w.tool({ action: "start", role: "scout", task: "one" });
        await w.tool({ action: "start", role: "scout", task: "two" });
        const pids = w
            .log()
            .all.filter((e) => e.type === "start")
            .map((e) => e.pid as number);
        assert.equal(pids.length, 2);
        assert.ok(pids.every(alive));
        const dirs = [...w.rt.children.values()].map((child) => child.spec.dir);
        await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        for (const pid of pids) await until(() => !alive(pid), "a child to end");
        for (const dir of dirs) {
            const saved = readMeta(dir);
            assert.equal(saved?.state, "stopped");
            assert.match(saved?.note ?? "", /parent session ended/);
        }
    });

    test("ends a child that ignores its input and SIGTERM, with SIGKILL", { timeout: 30_000 }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }], ignoreStdinEnd: true, ignoreSigterm: true } });
        await w.tool({ action: "start", role: "scout", task: "stubborn" });
        const pid = w.log().start?.pid as number;
        await w.close();
        w = undefined;
        await until(() => !alive(pid), "the child to end");
    });

    test("a reload (session_shutdown for any reason) ends the children too; message resumes them from their sessions", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({ script: { steps: [{ hold: true }] } });
        await w.tool({ action: "start", role: "scout", task: "one" });
        const pid = w.log().start?.pid as number;
        await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
        await until(() => !alive(pid), "the child to end");
        assert.equal(w.rt.children.size, 0);
    });
});

describe("a child left behind by a dead parent", () => {
    test("is found at the next session start and stopped, and its record says why", { timeout: 30_000 }, async () => {
        let orphan: { pid: number; start: string } | undefined;
        w = await startWorld({
            prepare: async ({ root, stateDir }) => {
                orphan = await leftover(root);
                const parent = await deadParent();
                writeMeta(
                    runDirOf(stateDir, "old-session", "old001"),
                    meta({ pid: orphan.pid, pidStart: orphan.start, parentPid: parent.pid, parentStart: parent.start }),
                );
            },
        });
        await w.swept();
        const pid = orphan?.pid as number;
        await until(() => !alive(pid), "the orphan to be stopped");
        const saved = readMeta(runDirOf(w.stateDir, "old-session", "old001"));
        assert.equal(saved?.state, "lost");
        assert.match(saved?.note ?? "", /stopped at a later session start: its parent was gone/);
        assert.ok(w.notices().some((text) => /Stopped 1 child agent an earlier session left running/.test(text)));
    });

    test("is left alone when its parent is another live Pi", { timeout: 30_000 }, async () => {
        let orphan: { pid: number; start: string } | undefined;
        let other: { pid: number; start: string } | undefined;
        w = await startWorld({
            prepare: async ({ root, stateDir }) => {
                orphan = await leftover(root);
                const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
                    stdio: "ignore",
                    detached: true,
                });
                processes.push(proc);
                await until(() => alive(proc.pid as number), "the other Pi");
                other = { pid: proc.pid as number, start: (await real.processStart(proc.pid as number)) as string };
                writeMeta(
                    runDirOf(stateDir, "other-session", "live01"),
                    meta({
                        id: "live01",
                        pid: orphan.pid,
                        pidStart: orphan.start,
                        parentPid: other.pid,
                        parentStart: other.start,
                    }),
                );
            },
        });
        await w.swept();
        await sleep(100);
        assert.ok(alive(orphan?.pid as number), "another session's child is not touched");
        assert.equal(readMeta(runDirOf(w.stateDir, "other-session", "live01"))?.state, "running");
    });

    test("is not touched when the process id belongs to a different process now (the start time differs)", {
        timeout: 30_000,
    }, async () => {
        let orphan: { pid: number; start: string } | undefined;
        w = await startWorld({
            prepare: async ({ root, stateDir }) => {
                orphan = await leftover(root);
                const parent = await deadParent();
                writeMeta(
                    runDirOf(stateDir, "old-session", "reuse1"),
                    meta({
                        id: "reuse1",
                        pid: orphan.pid,
                        pidStart: "1",
                        parentPid: parent.pid,
                        parentStart: parent.start,
                    }),
                );
            },
        });
        await w.swept();
        assert.ok(alive(orphan?.pid as number), "an unrelated process with a reused id is left alone");
        const saved = readMeta(runDirOf(w.stateDir, "old-session", "reuse1"));
        assert.equal(saved?.state, "lost", "the record is closed, because its child is not there");
    });

    test("a child whose process is gone is marked lost, and its parent's own earlier session counts as dead", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({
            prepare: ({ stateDir }) => {
                writeMeta(
                    runDirOf(stateDir, "old-session", "gone01"),
                    meta({ id: "gone01", pid: 2_000_000_000, pidStart: "5", parentPid: process.pid }),
                );
            },
        });
        await w.swept();
        assert.equal(readMeta(runDirOf(w.stateDir, "old-session", "gone01"))?.state, "lost");
    });

    test("children of this session that an earlier run recorded are listed as lost and can be resumed", {
        timeout: 30_000,
    }, async () => {
        let sessionId = "";
        w = await startWorld({ script: { steps: [{ settle: { text: "First report." } }] } });
        sessionId = w.session.sessionManager.getSessionId();
        const started = await w.tool({ action: "start", role: "scout", task: "first" });
        await w.deliver();
        // A new runtime in the same session id, as after `/resume`: the record is on disk, the child is not in memory.
        const dir = runDirOf(w.stateDir, sessionId, started.details.child);
        const saved = readMeta(dir) as Meta;
        writeMeta(dir, { ...saved, state: "running", pid: 2_000_000_001, pidStart: "9" });
        w.rt.children.clear();
        await (w.rt as unknown as { tidy(state: string): Promise<void> }).tidy(w.stateDir);
        const status = await w.tool({ action: "status" });
        assert.match(status.text, /scout-1 \(.*\) scout: lost;/);
        w.script({ steps: [{ settle: { text: "Second report." } }] });
        const resumed = await w.tool({ action: "message", child: "scout-1", text: "carry on" });
        assert.match(resumed.text, /running again in a new process/);
        const message = await w.deliver(2);
        assert.match(message.content, /Second report\./);
    });
});

describe("the check in a child", () => {
    function fakeHost(): { host: Host; fire: () => void; set(alive: boolean): void; cleared: number } {
        let callback: (() => void) | undefined;
        let up = true;
        const state = { cleared: 0 };
        const host = {
            ...real,
            alive: () => up,
            timers: {
                setTimeout(cb: () => void, ms: number) {
                    assert.equal(ms, WATCHDOG_MS);
                    callback = cb;
                    return 1;
                },
                clearTimeout() {
                    state.cleared++;
                    callback = undefined;
                },
            },
        } as Host;
        return {
            host,
            fire: () => callback?.(),
            set: (value) => {
                up = value;
            },
            get cleared() {
                return state.cleared;
            },
        };
    }

    test("looks at its parent every 10 seconds and asks Pi to shut down when the parent has gone", () => {
        const f = fakeHost();
        let shutdowns = 0;
        watchParent(f.host, 4242, () => shutdowns++);
        f.fire();
        f.fire();
        assert.equal(shutdowns, 0, "the parent is there");
        f.set(false);
        f.fire();
        assert.equal(shutdowns, 1);
    });

    test("stops looking when told to", () => {
        const f = fakeHost();
        let shutdowns = 0;
        const stop = watchParent(f.host, 4242, () => shutdowns++);
        stop();
        f.set(false);
        f.fire();
        assert.equal(shutdowns, 0);
        assert.ok(f.cleared >= 1);
    });

    test("a session in a child starts the check with its parent's pid, and does not sweep or keep children", {
        timeout: 30_000,
    }, async () => {
        const calls: number[] = [];
        w = await startWorld({
            env: { PI_SUBAGENT_ID: "abc123", PI_SUBAGENT_PARENT_PID: "999999" },
            host: {
                alive: (pid: number) => {
                    calls.push(pid);
                    return false;
                },
            },
        });
        assert.equal(w.rt.isChild, true);
        await w.advance(WATCHDOG_MS + 1000);
        assert.ok(calls.includes(999999), "the parent's pid was checked");
        // Pi, idle in RPC mode, only notes a request to shut down, so the plugin leaves by itself a few seconds later.
        assert.deepEqual(w.exits, []);
        await w.advance(6000);
        assert.deepEqual(w.exits, [0]);
    });
});

describe("the state folder", () => {
    test("old run folders are removed at session start, except those of a child that is recorded as running", {
        timeout: 30_000,
    }, async () => {
        w = await startWorld({
            prepare: ({ stateDir }) => {
                for (const [id, state] of [
                    ["old-done", "finished"],
                    ["old-run", "running"],
                    ["new-done", "finished"],
                ] as const) {
                    const dir = runDirOf(stateDir, "s", id);
                    writeMeta(dir, meta({ id, state, parentPid: process.pid }));
                    if (id.startsWith("old")) {
                        const old = new Date(Date.now() - 20 * 24 * 3600_000);
                        utimesSync(path.join(dir, "meta.json"), old, old);
                    }
                }
            },
        });
        await w.swept();
        const left = listChildren(path.join(w.stateDir, "agents"))
            .map((entry) => entry.meta.id)
            .sort();
        assert.deepEqual(left, ["new-done", "old-run"]);
    });

    test("removeOld takes the folder of an old child that ended, and tidies the session folder it leaves empty", (t) => {
        const root = mkdtempSync(path.join(tmpdir(), "jig-agents-old-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const dir = runDirOf(root, "s", "a");
        writeMeta(dir, meta({ id: "a", state: "finished" }));
        const old = new Date(Date.now() - 30 * 24 * 3600_000);
        utimesSync(path.join(dir, "meta.json"), old, old);
        assert.equal(
            removeOld(path.join(root, "agents"), Date.now(), 14 * 24 * 3600_000, () => false),
            1,
        );
        assert.deepEqual(listChildren(path.join(root, "agents")), []);
        assert.equal(existsSync(path.join(root, "agents", "s")), false);
    });

    test("sweep leaves a child of this very session alone", async (t) => {
        const root = mkdtempSync(path.join(tmpdir(), "jig-agents-sweep-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        writeMeta(
            runDirOf(root, "s", "mine01"),
            meta({ id: "mine01", pid: process.pid, pidStart: "1", parentPid: process.pid }),
        );
        const result = await sweep(real, root, new Set(["mine01"]));
        assert.deepEqual(result, { stopped: [], lost: [] });
    });
});
