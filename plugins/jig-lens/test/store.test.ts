// The index file: how it is made, what it holds, and what /lens status reads from it.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { CALL, TURN } from "../src/fields.ts";
import { importRecords } from "../src/import.ts";
import { deleteIndex, openIndex, readStatus } from "../src/store.ts";
import { appendLines, NOW, paths, sampleIndex, tempState, writeSample } from "./support.ts";

const mode = (file: string) => statSync(file).mode & 0o777;

/** An index that is closed when the test ends. */
function open(t: TestContext, file: string) {
    const db = openIndex(file);
    t.after(() => {
        if (db.isOpen) db.close();
    });
    return db;
}

test("the index is made in a private folder, as a private file, in WAL mode, with its tables", (t) => {
    const where = paths(tempState(t));
    const db = open(t, where.index);
    assert.equal(mode(where.lens), 0o700);
    assert.equal(mode(where.index), 0o600);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(
        tables.map((row) => row.name),
        ["call", "imported", "turn"],
    );
});

test("the files SQLite keeps beside the index are private too", (t) => {
    const where = paths(tempState(t));
    const db = open(t, where.index);
    db.exec("INSERT INTO imported (file, bytes, skipped, at) VALUES ('x', 1, 0, 1)");
    for (const suffix of ["-wal", "-shm"]) {
        assert.ok(existsSync(where.index + suffix), suffix);
        assert.equal(mode(where.index + suffix), 0o600, suffix);
    }
});

test("a folder that exists with looser permissions is made private", (t) => {
    const where = paths(tempState(t));
    mkdirSync(where.lens, { recursive: true });
    chmodSync(where.lens, 0o755);
    open(t, where.index);
    assert.equal(mode(where.lens), 0o700);
});

test("the columns of call and turn are the fields of the records, in order, with the types a viewer reads", (t) => {
    const db = open(t, paths(tempState(t)).index);
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all();
    assert.deepEqual(
        columns("call").map((column) => column.name),
        CALL.map((field) => field.name),
    );
    assert.deepEqual(
        columns("turn").map((column) => column.name),
        TURN.map((field) => field.name),
    );
    const types = Object.fromEntries(columns("call").map((column) => [column.name, column.type]));
    assert.equal(types.time, "REAL", "times are seconds since the epoch, which Grafana reads as a time");
    assert.equal(types.waitedMs, "INTEGER");
    assert.equal(types.facts, "TEXT");
    assert.equal(Object.fromEntries(columns("turn").map((column) => [column.name, column.type])).cost, "REAL");
    assert.deepEqual(
        columns("imported").map((column) => column.name),
        ["file", "bytes", "skipped", "at"],
    );
});

test("the id is the key, so a record cannot be in a table twice", (t) => {
    const db = open(t, paths(tempState(t)).index);
    const key = db
        .prepare("PRAGMA table_info(call)")
        .all()
        .filter((column) => column.pk === 1);
    assert.deepEqual(
        key.map((column) => column.name),
        ["id"],
    );
});

test("opening the index again keeps what it holds", async (t) => {
    const state = tempState(t);
    const where = await sampleIndex(state);
    const db = open(t, where.index);
    assert.equal(db.prepare("SELECT count(*) AS n FROM call").get()?.n, 14);
    assert.equal(db.prepare("SELECT count(*) AS n FROM turn").get()?.n, 6);
});

test("with no index there is no status, and asking makes nothing", (t) => {
    const where = paths(tempState(t));
    assert.equal(readStatus(where.index), undefined);
    assert.equal(existsSync(where.lens), false);
});

test("the status counts the rows and files, and says when the last import was", async (t) => {
    const where = await sampleIndex(tempState(t));
    const status = readStatus(where.index);
    assert.ok(status);
    assert.equal(status.file, where.index);
    assert.equal(status.calls, 14);
    assert.equal(status.turns, 6);
    assert.equal(status.files, 4);
    assert.equal(status.lastImport, NOW.getTime() / 1000);
    assert.deepEqual(status.skipped, []);
    assert.ok(status.bytes >= statSync(where.index).size);
});

test("the status lists the files with lines that were skipped", async (t) => {
    const state = tempState(t);
    writeSample(state);
    appendLines(state, "2026-10-29", ["not a record", "{}"]);
    const where = paths(state);
    const db = open(t, where.index);
    await importRecords(db, { records: where.records, now: NOW });
    db.close();
    assert.deepEqual(readStatus(where.index)?.skipped, [{ file: "2026-10-29.jsonl", lines: 2 }]);
});

test("asking for the status leaves the index as it was", async (t) => {
    const where = await sampleIndex(tempState(t));
    const before = readFileSync(where.index);
    const status = readStatus(where.index);
    assert.equal(status?.calls, 14);
    // A read-only connection may leave SQLite's own -wal and -shm files, and nothing else, and cannot write the index.
    assert.deepEqual(
        readdirSync(where.lens).filter((name) => !name.startsWith("index.sqlite")),
        [],
    );
    assert.deepEqual(readFileSync(where.index), before);
});

test("deleting the index removes the files beside it, and a missing index is not an error", (t) => {
    const where = paths(tempState(t));
    const db = openIndex(where.index);
    db.exec("INSERT INTO imported (file, bytes, skipped, at) VALUES ('x', 1, 0, 1)");
    assert.ok(existsSync(where.index + "-wal"));
    deleteIndex(where.index);
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) assert.equal(existsSync(where.index + suffix), false, suffix);
    deleteIndex(where.index);
    assert.ok(existsSync(path.dirname(where.index)), "only the index goes, not its folder");
});
