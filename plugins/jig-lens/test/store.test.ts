// The index file: how it is made, what it holds, and what /lens status reads from it.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CALL, SCHEMA, TURN } from "../src/fields.ts";
import { importRecords } from "../src/import.ts";
import { hasRecords, summarize } from "../src/queries.ts";
import { deleteIndex, openForReading, openIndex, readStatus } from "../src/store.ts";
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

// ---- the indexes ----------------------------------------------------------------------------------------------------

/** The indexes of a database, by table, with their columns. */
function indexesOf(db: DatabaseSync): Record<string, string[]> {
    const found: Record<string, string[]> = {};
    for (const row of db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()) {
        const columns = db
            .prepare(`PRAGMA index_info(${String(row.name)})`)
            .all()
            .map((column) => String(column.name));
        found[String(row.name)] = columns;
    }
    return found;
}

test("each scope of the summary has an index on both tables: a time range, a session and a ticket", (t) => {
    const db = open(t, paths(tempState(t)).index);
    assert.deepEqual(indexesOf(db), {
        call_session: ["session", "time"],
        call_ticket: ["ticket", "time"],
        call_time: ["time"],
        turn_session: ["session", "time"],
        turn_ticket: ["ticket", "time"],
        turn_time: ["time"],
    });
});

test("an index made before the ticket indexes gets them when it is next opened, and keeps everything", async (t) => {
    const state = tempState(t);
    writeSample(state);
    const where = paths(state);

    // The schema as it was: the same script without the ticket indexes.
    const before = SCHEMA.split("\n")
        .filter((line) => !/^CREATE INDEX IF NOT EXISTS (call|turn)_ticket /.test(line))
        .join("\n");
    assert.notEqual(before, SCHEMA);
    mkdirSync(where.lens, { recursive: true });
    const old = new DatabaseSync(where.index);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(before);
    await importRecords(old, { records: where.records, now: NOW });
    assert.deepEqual(Object.keys(indexesOf(old)), ["call_session", "call_time", "turn_session", "turn_time"]);
    const imported = old
        .prepare("SELECT file, bytes, skipped, at FROM imported ORDER BY file")
        .all()
        .map((row) => ({ ...row }));
    old.close();

    const db = open(t, where.index);
    assert.deepEqual(Object.keys(indexesOf(db)), [
        "call_session",
        "call_ticket",
        "call_time",
        "turn_session",
        "turn_ticket",
        "turn_time",
    ]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM call").get()?.n, 14);
    assert.equal(db.prepare("SELECT count(*) AS n FROM turn").get()?.n, 6);
    assert.deepEqual(
        db
            .prepare("SELECT file, bytes, skipped, at FROM imported ORDER BY file")
            .all()
            .map((row) => ({ ...row })),
        imported,
        "the offsets are kept",
    );

    // Nothing needs importing again, and the new index is the one a ticket is read by.
    const again = await importRecords(db, { records: where.records, now: NOW });
    assert.deepEqual([again.calls, again.turns, again.removed], [0, 0, 0]);
    const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM call WHERE ticket = 'T-1'")
        .all()
        .map((row) => String(row.detail));
    assert.match(plan.join(" | "), /USING (COVERING )?INDEX call_ticket/);
});

test("opening the index again changes nothing, and a rebuild makes the same indexes", async (t) => {
    const where = await sampleIndex(tempState(t));
    const first = open(t, where.index);
    const indexes = indexesOf(first);
    first.close();
    assert.deepEqual(indexesOf(open(t, where.index)), indexes);
    deleteIndex(where.index);
    assert.deepEqual(indexesOf(open(t, where.index)), indexes, "from nothing, the same ones");
});

// ---- reading --------------------------------------------------------------------------------------------------------

test("an index for reading is read only, and asking for one that is missing does not make it", async (t) => {
    const where = paths(tempState(t));
    assert.equal(openForReading(where.index), undefined);
    assert.equal(existsSync(where.lens), false, "asking made nothing");

    const made = await sampleIndex(tempState(t));
    const db = openForReading(made.index);
    assert.ok(db);
    t.after(() => db.close());
    assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    assert.throws(() => db.exec("INSERT INTO imported (file, bytes, skipped, at) VALUES ('x', 1, 0, 1)"), /readonly/i);
    assert.throws(() => db.exec("CREATE INDEX extra ON call (tool)"), /readonly/i);
    assert.equal(summarize(db, { kind: "ticket", ticket: "T-1" }).tools?.calls, 8);
});

test("a file that is not a database is opened, and the first question it is asked fails with the reason", (t) => {
    const where = paths(tempState(t));
    mkdirSync(where.lens, { recursive: true });
    writeFileSync(
        where.index,
        "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
    );
    const db = openForReading(where.index);
    assert.ok(db);
    t.after(() => db.close());
    assert.throws(() => hasRecords(db), /not a database/i);
    assert.throws(() => readStatus(where.index), /not a database/i);
});
