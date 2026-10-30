// Importing record files into the index: what is read, what is counted once, and what is left alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { callRecord, cleanupRecords, turnRecord, writeRecord } from "../../jig-core/src/records.ts";
import { cutoffOf, importFile, importRecords, RETENTION_DAYS } from "../src/import.ts";
import { deleteIndex, openIndex } from "../src/store.ts";
import { appendLines, call, NOW, paths, sampleRecords, tempState, turn, writeRecords, writeSample } from "./support.ts";

const WORKER = new URL("./import-worker.ts", import.meta.url).pathname;

/** The sample lines of one call, as a record file holds them. */
const callLine = (id: string, at: string, session = "s1") => JSON.stringify(call(id, at, session, "read"));
const turnLine = (id: string, at: string, session = "s1") => JSON.stringify(turn(id, at, session, "model-a", 0.01));

/** A state folder with an index, closed when the test ends. */
function setup(t: TestContext) {
    const state = tempState(t);
    const where = paths(state);
    const db = openIndex(where.index);
    t.after(() => {
        if (db.isOpen) db.close();
    });
    return {
        state,
        where,
        db,
        run: (now = NOW) => importRecords(db, { records: where.records, now }),
        count: (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n),
        imported: () =>
            db
                .prepare("SELECT file, bytes, skipped FROM imported ORDER BY file")
                .all()
                .map((row) => ({ ...row })),
    };
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("an import fills the call and turn tables from the record files", async (t) => {
    const { state, run, count, imported } = setup(t);
    writeSample(state);
    const result = await run();
    assert.deepEqual(result, { calls: 14, turns: 6, skipped: 0, removed: 0, problems: [] });
    assert.equal(count("call"), 14);
    assert.equal(count("turn"), 6);
    assert.deepEqual(
        imported().map((row) => row.file),
        ["2026-10-27.jsonl", "2026-10-28.jsonl", "2026-10-29.jsonl", "2026-10-30.jsonl"],
    );
});

test("a row holds the fields of its record, and times are seconds since the epoch", async (t) => {
    const { state, db, run } = setup(t);
    const record = call("c1", "2026-10-30T09:00:00.250Z", "s1", "git", {
        ticket: "T-1",
        action: "push",
        plugin: "jig-git",
        environment: "external",
        environmentKind: "external",
        effect: "write",
        decision: "ask",
        decisionSource: "table",
        approval: "review",
        answer: "allow",
        waitedMs: 3000,
        durationMs: 2100,
        facts: { passed: 3 },
    });
    appendLines(state, "2026-10-30", [JSON.stringify(record)]);
    await run();
    const row = db.prepare("SELECT *, typeof(time) AS timeType, typeof(waitedMs) AS waitedType FROM call").get();
    assert.equal(row?.id, record.id);
    assert.equal(row?.time, Date.parse("2026-10-30T09:00:00.250Z") / 1000);
    assert.equal(row?.timeType, "real");
    assert.equal(row?.waitedType, "integer");
    assert.equal(row?.tool, "git");
    assert.equal(row?.action, "push");
    assert.equal(row?.waitedMs, 3000);
    assert.equal(row?.ticket, "T-1");
    assert.equal(row?.parentSession, null);
    assert.equal(row?.facts, '{"passed":3}');
    assert.equal(db.prepare("SELECT json_extract(facts, '$.passed') AS passed FROM call").get()?.passed, 3);
});

test("a repeated import does not count anything twice", async (t) => {
    const { state, run, count, imported } = setup(t);
    writeSample(state);
    await run();
    const before = imported();
    const again = await run();
    assert.deepEqual(again, { calls: 0, turns: 0, skipped: 0, removed: 0, problems: [] });
    assert.equal(count("call"), 14);
    assert.equal(count("turn"), 6);
    assert.deepEqual(imported(), before);
});

test("lines read again, because the offset was lost, are not counted twice", async (t) => {
    const { state, db, run, count } = setup(t);
    writeSample(state);
    await run();
    db.exec("DELETE FROM imported");
    const again = await run();
    assert.equal(again.calls + again.turns, 0, "every id was there already");
    assert.equal(count("call"), 14);
    assert.equal(count("turn"), 6);
    assert.equal(count("imported"), 4, "and the offsets are back");
});

test("a line still being written waits, and is imported once when it is complete", async (t) => {
    const { state, run, count, imported } = setup(t);
    const first = callLine("c1", "2026-10-30T09:00:00Z");
    const second = callLine("c2", "2026-10-30T09:01:00Z");
    const file = path.join(state, "records", "2026-10-30.jsonl");
    appendLines(state, "2026-10-30", [first]);
    appendFileSync(file, second.slice(0, 50));

    assert.equal((await run()).calls, 1);
    assert.equal(count("call"), 1);
    assert.equal(imported()[0]?.bytes, Buffer.byteLength(first) + 1, "the offset stops after the last complete line");

    assert.equal((await run()).calls, 0, "the partial line is still waiting");
    appendFileSync(file, `${second.slice(50)}\n`);
    assert.equal((await run()).calls, 1);
    assert.equal(count("call"), 2);
    assert.equal(imported()[0]?.bytes, statSync(file).size);
    assert.equal((await run()).calls, 0);
});

test("a file that only holds a partial line is read again later, and records nothing now", async (t) => {
    const { state, run, count, imported } = setup(t);
    const line = callLine("c1", "2026-10-30T09:00:00Z");
    mkdirSync(path.join(state, "records"), { recursive: true });
    const file = path.join(state, "records", "2026-10-30.jsonl");
    appendFileSync(file, line);
    assert.equal((await run()).calls, 0);
    assert.deepEqual(imported(), []);
    appendFileSync(file, "\n");
    assert.equal((await run()).calls, 1);
    assert.equal(count("call"), 1);
});

test("a file that grows is read from where it stopped", async (t) => {
    const { state, run, count, imported } = setup(t);
    appendLines(state, "2026-10-30", [callLine("c1", "2026-10-30T09:00:00Z"), turnLine("t1", "2026-10-30T09:01:00Z")]);
    assert.deepEqual(await run(), { calls: 1, turns: 1, skipped: 0, removed: 0, problems: [] });
    const file = appendLines(state, "2026-10-30", [callLine("c2", "2026-10-30T09:02:00Z")]);
    assert.deepEqual(await run(), { calls: 1, turns: 0, skipped: 0, removed: 0, problems: [] });
    assert.equal(count("call"), 2);
    assert.equal(imported()[0]?.bytes, statSync(file).size);
});

test("importers that take turns, file by file, count every line once", async (t) => {
    const state = tempState(t);
    const where = paths(state);
    const a = openIndex(where.index);
    const b = openIndex(where.index);
    t.after(() => {
        a.close();
        b.close();
    });
    const day = (n: number) => `2026-10-2${n}.jsonl`;
    const lines = (first: number, last: number, d: number) =>
        Array.from({ length: last - first + 1 }, (_, i) =>
            callLine(`d${d}-${first + i}`, `2026-10-2${d}T09:00:0${i}Z`),
        );
    appendLines(state, "2026-10-27", lines(1, 3, 7));
    appendLines(state, "2026-10-28", lines(1, 3, 8));
    appendLines(state, "2026-10-29", lines(1, 3, 9));

    const step = (db: typeof a, d: number) => importFile(db, where.records, day(d), NOW).calls;
    assert.equal(step(a, 7), 3);
    assert.equal(step(b, 7), 0, "the other session has done it");
    appendLines(state, "2026-10-27", lines(4, 5, 7));
    assert.equal(step(b, 7), 2);
    assert.equal(step(a, 7), 0);
    assert.equal(step(b, 8), 3);
    assert.equal(step(a, 8), 0);
    assert.equal(step(a, 9), 3);
    assert.equal(step(b, 9), 0);

    const total = Number(a.prepare("SELECT count(*) AS n FROM call").get()?.n);
    const distinct = Number(b.prepare("SELECT count(DISTINCT id) AS n FROM call").get()?.n);
    assert.equal(total, 11);
    assert.equal(distinct, 11);
    for (const row of a.prepare("SELECT file, bytes FROM imported").all()) {
        assert.equal(row.bytes, statSync(path.join(where.records, String(row.file))).size, String(row.file));
    }
});

test("two processes importing at the same moment count every line once", async (t) => {
    const state = tempState(t);
    // Enough that the two imports overlap, and a few files so each has to wait for the other more than once.
    const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
    let calls = 0;
    let turns = 0;
    for (const [d, day] of days.entries()) {
        const lines: string[] = [];
        for (let i = 0; i < 1200; i++) {
            const minute = String(Math.floor(i / 60) % 60).padStart(2, "0");
            const at = `${day}T09:${minute}:${String(i % 60).padStart(2, "0")}Z`;
            if (i % 5 === 0) {
                lines.push(turnLine(`t${d}-${i}`, at));
                turns++;
            } else {
                lines.push(callLine(`c${d}-${i}`, at));
                calls++;
            }
        }
        appendLines(state, day, lines);
    }

    const start = Date.now() + 500;
    const worker = () =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
            const child = spawn(process.execPath, [WORKER, state, NOW.toISOString(), String(start)], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.stderr.on("data", (chunk) => (err += chunk));
            child.on("close", (code) => resolve({ code, out, err }));
        });
    const [one, two] = await Promise.all([worker(), worker()]);
    assert.equal(one.code, 0, one.err);
    assert.equal(two.code, 0, two.err);

    const db = openIndex(paths(state).index);
    t.after(() => db.close());
    const n = (sql: string) => Number(db.prepare(sql).get()?.n);
    assert.equal(n("SELECT count(*) AS n FROM call"), calls);
    assert.equal(n("SELECT count(DISTINCT id) AS n FROM call"), calls);
    assert.equal(n("SELECT count(*) AS n FROM turn"), turns);
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    for (const row of db.prepare("SELECT file, bytes FROM imported").all()) {
        assert.equal(row.bytes, statSync(path.join(paths(state).records, String(row.file))).size, String(row.file));
    }
    // What the two reported adds up to every line, once: each new row was counted by exactly one of them.
    const added = [one, two].map((w) => JSON.parse(w.out) as { calls: number; turns: number });
    assert.equal(added[0]!.calls + added[1]!.calls, calls);
    assert.equal(added[0]!.turns + added[1]!.turns, turns);
});

test("records older than the retention are not imported, and a day exactly at it is", async (t) => {
    const { state, run, count, imported } = setup(t);
    // From 2026-10-30, 90 days back is 2026-08-01: jig-core keeps that day's file, and deletes the one before it.
    appendLines(state, "2026-07-02", [callLine("old", "2026-07-02T10:00:00Z")]);
    appendLines(state, "2026-07-31", [callLine("justOld", "2026-07-31T23:59:59Z")]);
    appendLines(state, "2026-08-01", [callLine("edge", "2026-08-01T00:00:00Z")]);
    appendLines(state, "2026-10-30", [callLine("new", "2026-10-30T09:00:00Z")]);
    const result = await run();
    assert.equal(result.calls, 2);
    assert.equal(count("call"), 2);
    assert.deepEqual(
        imported().map((row) => row.file),
        ["2026-08-01.jsonl", "2026-10-30.jsonl"],
    );
    assert.equal(RETENTION_DAYS, 90);
});

test("rows that have grown too old are removed at import, with the record of their file", async (t) => {
    const { state, db, run, count, imported } = setup(t);
    appendLines(state, "2026-07-31", [callLine("a", "2026-07-31T10:00:00Z"), turnLine("b", "2026-07-31T10:01:00Z")]);
    appendLines(state, "2026-08-01", [callLine("c", "2026-08-01T10:00:00Z")]);
    // Six weeks earlier, both files were inside the retention.
    const earlier = new Date("2026-09-15T00:00:00Z");
    assert.equal((await run(earlier)).removed, 0);
    assert.equal(count("call") + count("turn"), 3);

    const result = await run(NOW);
    assert.equal(result.removed, 2, "the two rows of the day before the cutoff");
    assert.equal(count("call"), 1);
    assert.equal(count("turn"), 0);
    assert.deepEqual(
        imported().map((row) => row.file),
        ["2026-08-01.jsonl"],
    );
    assert.equal(db.prepare("SELECT id FROM call").get()?.id !== undefined, true);
    assert.equal((await run(NOW)).removed, 0, "nothing more to remove");
});

test("the index keeps exactly the days that jig-core keeps its files for", async (t) => {
    const days = ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-10-30"];
    const stateFor = () => {
        const state = tempState(t);
        for (const day of days) appendLines(state, day, [callLine(`id-${day}`, `${day}T12:00:00Z`)]);
        return state;
    };
    // jig-core's own cleanup, on one copy of the folder...
    const theirs = stateFor();
    const saved = process.env.JIG_STATE_DIR;
    process.env.JIG_STATE_DIR = theirs;
    try {
        cleanupRecords(RETENTION_DAYS, NOW);
    } finally {
        if (saved === undefined) delete process.env.JIG_STATE_DIR;
        else process.env.JIG_STATE_DIR = saved;
    }
    const kept = readdirSync(path.join(theirs, "records")).sort();
    // ...and this import, on another.
    const ours = setup(t);
    for (const day of days) appendLines(ours.state, day, [callLine(`id-${day}`, `${day}T12:00:00Z`)]);
    await ours.run();
    assert.deepEqual(
        ours.imported().map((row) => row.file),
        kept,
    );
    assert.equal(cutoffOf(new Date("2026-10-30T23:59:59Z"), 90), Date.UTC(2026, 7, 1) / 1000);
});

test("a rebuild gives the same index: delete it, import again", async (t) => {
    const { state, where, db, run } = setup(t);
    writeSample(state);
    await run();
    const rows = () =>
        db
            .prepare("SELECT * FROM call ORDER BY id")
            .all()
            .map((row) => ({ ...row }));
    const turns = () =>
        db
            .prepare("SELECT * FROM turn ORDER BY id")
            .all()
            .map((row) => ({ ...row }));
    const before = { calls: rows(), turns: turns() };
    const skipped = db
        .prepare("SELECT file, bytes, skipped FROM imported ORDER BY file")
        .all()
        .map((row) => ({ ...row }));

    db.close();
    deleteIndex(where.index);
    const fresh = openIndex(where.index);
    t.after(() => fresh.close());
    const result = await importRecords(fresh, { records: where.records, now: NOW });
    assert.equal(result.calls, 14);
    assert.equal(result.turns, 6);
    assert.deepEqual(
        fresh
            .prepare("SELECT * FROM call ORDER BY id")
            .all()
            .map((row) => ({ ...row })),
        before.calls,
    );
    assert.deepEqual(
        fresh
            .prepare("SELECT * FROM turn ORDER BY id")
            .all()
            .map((row) => ({ ...row })),
        before.turns,
    );
    assert.deepEqual(
        fresh
            .prepare("SELECT file, bytes, skipped FROM imported ORDER BY file")
            .all()
            .map((row) => ({ ...row })),
        skipped,
    );
});

test("a malformed line is skipped and counted, and never stops the import", async (t) => {
    const { state, run, count, imported } = setup(t);
    const file = appendLines(state, "2026-10-30", [
        callLine("c1", "2026-10-30T09:00:00Z"),
        "this is not json",
        callLine("c2", "2026-10-30T09:01:00Z"),
        '{"kind":"call","id":"half"}',
        turnLine("t1", "2026-10-30T09:02:00Z"),
        "",
        '{"kind":',
    ]);
    const result = await run();
    assert.deepEqual(result, { calls: 2, turns: 1, skipped: 3, removed: 0, problems: [] });
    assert.equal(count("call"), 2);
    assert.deepEqual(imported(), [{ file: "2026-10-30.jsonl", bytes: statSync(file).size, skipped: 3 }]);

    // Read once, so it is not counted again; a new one adds to the file's count.
    assert.equal((await run()).skipped, 0);
    appendLines(state, "2026-10-30", ["garbage again"]);
    assert.equal((await run()).skipped, 1);
    assert.equal(imported()[0]?.skipped, 4);
});

test("a binary or very odd line is skipped like any other", async (t) => {
    const { state, run, count } = setup(t);
    appendLines(state, "2026-10-30", [
        callLine("c1", "2026-10-30T09:00:00Z"),
        "\u0000\u0001\u0002",
        "��",
        "}{",
        callLine("c2", "2026-10-30T09:01:00Z"),
    ]);
    const result = await run();
    assert.equal(result.calls, 2);
    assert.equal(result.skipped, 3);
    assert.equal(count("call"), 2);
});

test("the record files are never written: not their content, their times, their modes or their folder", async (t) => {
    const state = mkdtempSync(path.join(os.tmpdir(), "jig-lens-ro-"));
    const records = path.join(state, "records");
    t.after(() => {
        chmodSync(records, 0o700);
        rmSync(state, { recursive: true, force: true });
    });
    writeSample(state);
    // A line that is still being written, and a bad line: the cases where an importer might be tempted to tidy up.
    appendFileSync(
        path.join(records, "2026-10-30.jsonl"),
        `bad line\n${callLine("p", "2026-10-30T10:00:00Z").slice(0, 30)}`,
    );
    const files = readdirSync(records).map((name) => path.join(records, name));
    for (const file of files) chmodSync(file, 0o444);
    const snapshot = () =>
        files.map((file) => ({
            file,
            sha: sha(file),
            mtime: statSync(file).mtimeMs,
            mode: statSync(file).mode,
            size: statSync(file).size,
        }));
    const before = snapshot();
    const listing = readdirSync(records).sort();
    // With the folder read only as well, any write or new file would be refused: the proof, unless the user is root.
    chmodSync(records, 0o555);

    const db = openIndex(paths(state).index);
    t.after(() => db.close());
    await importRecords(db, { records, now: NOW });
    await importRecords(db, { records, now: NOW });
    db.exec("DELETE FROM imported");
    await importRecords(db, { records, now: NOW });

    assert.deepEqual(snapshot(), before);
    assert.deepEqual(readdirSync(records).sort(), listing);
});

test("a file replaced by a smaller one is read from its start, and its old counts are forgotten", async (t) => {
    const { state, run, count, imported } = setup(t);
    const file = appendLines(state, "2026-10-30", [
        "garbage",
        callLine("a", "2026-10-30T09:00:00Z"),
        callLine("b", "2026-10-30T09:01:00Z"),
    ]);
    await run();
    assert.equal(imported()[0]?.skipped, 1);
    writeFileSync(file, `${callLine("c", "2026-10-30T09:02:00Z")}\n`);
    assert.ok(statSync(file).size < Number(imported()[0]?.bytes));
    const result = await run();
    assert.equal(result.calls, 1);
    assert.equal(count("call"), 3);
    assert.deepEqual(imported(), [{ file: "2026-10-30.jsonl", bytes: statSync(file).size, skipped: 0 }]);
});

test("a file that is cut shorter than what was read, and is empty, is not an error", async (t) => {
    const { state, run, imported } = setup(t);
    const file = appendLines(state, "2026-10-30", [callLine("a", "2026-10-30T09:00:00Z")]);
    await run();
    truncateSync(file, 0);
    assert.deepEqual(await run(), { calls: 0, turns: 0, skipped: 0, removed: 0, problems: [] });
    assert.deepEqual(imported(), [{ file: "2026-10-30.jsonl", bytes: 0, skipped: 0 }]);
});

test("lines that cross the edge of a chunk are imported whole", (t) => {
    const { state, where, db, count } = setup(t);
    const lines = Array.from({ length: 12 }, (_, i) =>
        callLine(`c${i}`, `2026-10-30T09:00:${String(i).padStart(2, "0")}Z`),
    );
    appendLines(state, "2026-10-30", lines);
    // Chunks far smaller than a line: every line is cut at least once, and a line is only ever read from its start.
    const chunk = Math.floor(lines[0]!.length * 1.5);
    const counts = importFile(db, where.records, "2026-10-30.jsonl", NOW, chunk);
    assert.equal(counts.calls, 12);
    assert.equal(counts.skipped, 0);
    assert.equal(count("call"), 12);
});

test("a stretch with no line break, longer than a chunk, is passed over; the lines after it are imported", (t) => {
    const { state, where, db, count } = setup(t);
    const line = callLine("after", "2026-10-30T09:00:00Z");
    const chunk = line.length + 10;
    appendLines(state, "2026-10-30", ["x".repeat(chunk * 3), line]);
    const counts = importFile(db, where.records, "2026-10-30.jsonl", NOW, chunk);
    assert.equal(counts.calls, 1);
    assert.ok(counts.skipped >= 1);
    assert.equal(count("call"), 1);
});

test("a missing records folder, or one with no records, imports nothing and is no problem", async (t) => {
    const { state, run } = setup(t);
    assert.deepEqual(await run(), { calls: 0, turns: 0, skipped: 0, removed: 0, problems: [] });
    mkdirSync(path.join(state, "records"));
    assert.deepEqual(await run(), { calls: 0, turns: 0, skipped: 0, removed: 0, problems: [] });
});

test("only regular files named for a day are record files", async (t) => {
    const { state, run, count, imported } = setup(t);
    const folder = path.join(state, "records");
    appendLines(state, "2026-10-30", [callLine("a", "2026-10-30T09:00:00Z")]);
    writeFileSync(path.join(folder, "notes.txt"), `${callLine("n", "2026-10-30T09:00:00Z")}\n`);
    writeFileSync(path.join(folder, "2026-10-30.jsonl.bak"), `${callLine("b", "2026-10-30T09:00:00Z")}\n`);
    writeFileSync(path.join(folder, "20261030.jsonl"), `${callLine("c", "2026-10-30T09:00:00Z")}\n`);
    mkdirSync(path.join(folder, "2026-10-29.jsonl"));
    symlinkSync(path.join(folder, "notes.txt"), path.join(folder, "2026-10-28.jsonl"));
    await run();
    assert.equal(count("call"), 1);
    assert.deepEqual(
        imported().map((row) => row.file),
        ["2026-10-30.jsonl"],
    );
});

test("a record file that cannot be read is reported, and the others are still imported", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root can read any file");
    const { state, run, count } = setup(t);
    appendLines(state, "2026-10-29", [callLine("locked", "2026-10-29T09:00:00Z")]);
    const locked = path.join(state, "records", "2026-10-29.jsonl");
    appendLines(state, "2026-10-30", [callLine("fine", "2026-10-30T09:00:00Z")]);
    chmodSync(locked, 0o000);
    const result = await run();
    assert.equal(result.calls, 1);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]!, /^2026-10-29\.jsonl: .*EACCES/);
    assert.equal(count("call"), 1);
    chmodSync(locked, 0o600);
    assert.equal((await run()).calls, 1, "readable again, it is imported");
});

test("what jig-core writes is what is imported", async (t) => {
    const { state, run, count, db } = setup(t);
    const saved = process.env.JIG_STATE_DIR;
    process.env.JIG_STATE_DIR = state;
    t.after(() => {
        if (saved === undefined) delete process.env.JIG_STATE_DIR;
        else process.env.JIG_STATE_DIR = saved;
    });
    const at = new Date("2026-10-30T10:00:00.123Z");
    writeRecord(
        callRecord(
            {
                session: "real",
                tool: "git",
                action: "push",
                environment: "external",
                environmentKind: "external",
                effect: "write",
                decision: "ask",
                decisionSource: "table",
                approval: "review",
                answer: "allow",
                waitedMs: 1234,
                outcome: "ok",
                durationMs: 50,
                toolCallId: "tc",
                facts: { passed: 3, ok: true, conclusion: "success" },
            },
            at,
        ),
        at,
    );
    writeRecord(
        turnRecord(
            { session: "real", model: "m", input: 10, output: 5, cacheRead: 100, cacheWrite: 2, cost: 0.0123 },
            at,
        ),
        at,
    );
    assert.deepEqual(await run(), { calls: 1, turns: 1, skipped: 0, removed: 0, problems: [] });
    assert.equal(count("call"), 1);
    const row = db
        .prepare("SELECT session, tool, waitedMs, json_extract(facts, '$.conclusion') AS conclusion FROM call")
        .get();
    assert.deepEqual({ ...row }, { session: "real", tool: "git", waitedMs: 1234, conclusion: "success" });
    assert.equal(db.prepare("SELECT cost FROM turn").get()?.cost, 0.0123);
});

test("the sample covers each kind of call the dashboards tell apart", async (t) => {
    const { state, db, run } = setup(t);
    writeRecords(state, sampleRecords());
    await run();
    const kinds = db
        .prepare("SELECT DISTINCT outcome, coalesce(errorKind, '') AS kind FROM call ORDER BY outcome, kind")
        .all()
        .map((row) => `${row.outcome}/${row.kind}`);
    assert.deepEqual(kinds, [
        "blocked/declined",
        "blocked/denied",
        "blocked/dismissed",
        "error/not-run",
        "error/tool",
        "ok/",
    ]);
});
