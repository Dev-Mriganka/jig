// Review records live in one folder per Pi folder, shared by every Pi started there: a second terminal, a subagent child,
// `pi -p`. Cleaning up "pending" reviews when the extension loads deleted the open review of the session that started the
// scout. Only a session start in an interactive session cleans up, and only records nobody can still be using.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { ReviewCoordinator } from "../src/coordinator.ts";
import { SettingsStore, workspaceDirFor } from "../src/settings.ts";
import { ReviewStore } from "../src/store.ts";
import type { ReviewRecord } from "../src/types.ts";
import { context, fakeHost, openReview } from "./support/harness.ts";
import type { ReviewSession } from "./support/harness.ts";

const DAY = 24 * 60 * 60 * 1000;
const MANAGED = ["PI_SUBAGENT_ID", "PI_SUBAGENT_CHILD"] as const;
const saved: Record<string, string | undefined> = {};
let temporary: string[] = [];
let session: ReviewSession | undefined;
let sequence = 0;

beforeEach(() => {
    for (const name of MANAGED) saved[name] = process.env[name];
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_CHILD;
});
afterEach(async () => {
    await session?.close();
    session = undefined;
    for (const name of MANAGED) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    }
    for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
    temporary = [];
});

/** Pi's folder, and the review root (what the plugin keeps under Pi's agent folder). */
function folders(): { cwd: string; state: string } {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "jig-review-cwd-"));
    const state = mkdtempSync(path.join(os.tmpdir(), "jig-review-root-"));
    temporary.push(cwd, state);
    roots.set(cwd, state);
    return { cwd, state };
}

/** The review root each Pi folder of this test uses. */
const roots = new Map<string, string>();

/** Time for background work to finish: the cleanup used to start from the factory and run after it returned. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

/** The process id of a process that has exited, as a dead session's records carry. */
function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(child.pid, "the helper process ran");
    return child.pid;
}

/** A pending review as another session left it: owned by `ownerPid`, last touched `ageMs` ago. */
async function pendingReview(
    cwd: string,
    options: { ownerPid?: number; ageMs?: number; discussed?: boolean } = {},
): Promise<{ store: ReviewStore; id: string; file: string }> {
    const settings = new SettingsStore(workspaceDirFor(roots.get(cwd)!, cwd));
    const store = new ReviewStore(settings);
    const review = await store.create("head", "diff", "all");
    if (options.discussed)
        await store.addIteration(await store.addSubmittedComments(review, [{ body: "Please check." }]), "second diff");
    // Ids are timestamps to the second: give each record its own file so records made together do not collide.
    const created = path.join(settings.reviewsDir, `${review.id}.json`);
    const record = JSON.parse(readFileSync(created, "utf8")) as ReviewRecord;
    record.id = `${review.id}-${++sequence}`;
    if (options.ownerPid === undefined) delete record.ownerPid;
    else record.ownerPid = options.ownerPid;
    record.updatedAt = new Date(Date.now() - (options.ageMs ?? 0)).toISOString();
    const file = path.join(settings.reviewsDir, `${record.id}.json`);
    rmSync(created);
    writeFileSync(file, JSON.stringify(record));
    return { store, id: record.id, file };
}

/** Starts a Pi session in `cwd` the way Pi does: the factory, then session_start. */
async function startSession(cwd: string, mode: "tui" | "print" | "json" = "tui"): Promise<void> {
    const host = fakeHost();
    new ReviewCoordinator(host.pi, cwd, {
        root: roots.get(cwd) ?? mkdtempSync(path.join(os.tmpdir(), "jig-review-root-")),
    }).register();
    await host.fire("session_start", context(cwd, mode).ctx);
}

describe("loading the extension", () => {
    test("writes nothing: the factory only registers", async () => {
        const { cwd, state } = folders();
        new ReviewCoordinator(fakeHost().pi, cwd, { root: state }).register();
        await settle();
        assert.deepEqual(readdirSync(state), [], "no review folder is created");
    });

    test("a scout started in the same folder does not delete the open review of the session that started it", async () => {
        session = await openReview();
        const before = session.records();
        assert.equal(before.length, 1);

        process.env.PI_SUBAGENT_ID = "ab12cd34";
        roots.set(session.root, session.agentRoot);
        await startSession(session.root);
        delete process.env.PI_SUBAGENT_ID;
        await startSession(session.root, "print"); // pi -p
        await startSession(session.root); // another terminal: its owner, this process, is alive
        await settle();

        assert.deepEqual(session.records(), before);
    });
});

describe("session_start", () => {
    test("removes the empty pending review of a session that has ended, and keeps its discussion as history", async () => {
        const { cwd } = folders();
        const empty = await pendingReview(cwd, { ownerPid: deadPid() });
        const discussed = await pendingReview(cwd, { ownerPid: deadPid(), discussed: true });

        await startSession(cwd);

        assert.equal(existsSync(empty.file), false);
        assert.equal((await empty.store.listAll()).find((review) => review.id === discussed.id)?.status, "abandoned");
    });

    test("removes a pending review untouched for more than a day, whoever owns it", async () => {
        const { cwd } = folders();
        const old = await pendingReview(cwd, { ownerPid: process.pid, ageMs: DAY + 60_000 });
        const legacy = await pendingReview(cwd, { ageMs: DAY + 60_000 });

        await startSession(cwd);

        assert.equal(existsSync(old.file), false);
        assert.equal(existsSync(legacy.file), false);
    });

    test("keeps what a live session may be using", async () => {
        const { cwd } = folders();
        const live = await pendingReview(cwd, { ownerPid: process.pid });
        const recent = await pendingReview(cwd, { ownerPid: process.pid, ageMs: DAY - 60_000 });
        const legacy = await pendingReview(cwd, { ageMs: 60_000 }); // written before records named an owner

        await startSession(cwd);

        for (const kept of [live, recent, legacy]) assert.equal(existsSync(kept.file), true, kept.id);
    });

    test("is skipped in a subagent child and in print and json mode", async () => {
        const { cwd } = folders();
        const stale = await pendingReview(cwd, { ownerPid: deadPid(), ageMs: 2 * DAY });

        process.env.PI_SUBAGENT_ID = "ab12cd34";
        await startSession(cwd);
        delete process.env.PI_SUBAGENT_ID;
        process.env.PI_SUBAGENT_CHILD = "1"; // the older name of the same marker
        await startSession(cwd);
        delete process.env.PI_SUBAGENT_CHILD;
        await startSession(cwd, "print");
        await startSession(cwd, "json");
        assert.equal(existsSync(stale.file), true, "no headless session cleans up");

        await startSession(cwd);
        assert.equal(existsSync(stale.file), false, "an interactive one does");
    });

    test("does not fail when the folder has no reviews yet or a record is unreadable", async () => {
        const { cwd, state } = folders();
        await startSession(cwd);
        assert.deepEqual(readdirSync(state), [], "nothing to clean, so nothing is created");

        const stale = await pendingReview(cwd, { ownerPid: deadPid() });
        writeFileSync(path.join(path.dirname(stale.file), "2026-01-01T00-00-00Z.json"), "{ half written");
        await startSession(cwd);
        assert.equal(existsSync(stale.file), false);
        assert.equal(
            existsSync(path.join(path.dirname(stale.file), "2026-01-01T00-00-00Z.json")),
            true,
            "a record it cannot read is left alone",
        );
    });
});
