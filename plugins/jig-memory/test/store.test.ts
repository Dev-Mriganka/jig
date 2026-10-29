import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ensureTicket, isSafeKey, mentionedTickets, settleNotes, stampOf, ticketPaths } from "../src/store.ts";
import { tempFolder } from "./support.ts";

const mode = (file: string) => statSync(file).mode & 0o777;
const read = (file: string) => readFileSync(file, "utf8");

test("activating a ticket creates its folders at 0700 and its files at 0600, with their starting text", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "ACME-1");
    const paths = ticketPaths(folder, "ACME-1");
    for (const dir of [paths.dir, paths.evidence, paths.history]) assert.equal(mode(dir), 0o700, dir);
    for (const file of [paths.notes, paths.plan, paths.ticket, paths.index]) assert.equal(mode(file), 0o600, file);
    assert.match(read(paths.notes), /^# ACME-1\n\n## Now\nStatus: new\nNext:\nOpen questions:\n\n## Decisions\n$/);
    assert.deepEqual(JSON.parse(read(paths.ticket)), { repositories: [] });
    assert.match(read(paths.index), /^# Evidence\n/);
});

test("activating a ticket again never overwrites what is there", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "ACME-1");
    const paths = ticketPaths(folder, "ACME-1");
    writeFileSync(paths.notes, "# kept\n");
    ensureTicket(folder, "ACME-1");
    assert.equal(read(paths.notes), "# kept\n");
});

test("notes over the limit move their older ## Now lines to history, keep the top, and leave a pointer", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "ACME-1");
    const paths = ticketPaths(folder, "ACME-1");
    const findings = Array.from({ length: 40 }, (_, n) => `- finding ${n}: ${"x".repeat(40)}`);
    writeFileSync(paths.notes, `# ACME-1\n\n## Now\nStatus: root cause found\nNext: check the queue\nOpen questions:\n${findings.join("\n")}\n\n## Decisions\n- Use the queue.\n`);

    const now = new Date("2026-10-30T10:15:00.123Z");
    const settled = settleNotes(folder, "ACME-1", now);
    const historyFile = path.join(paths.history, "2026-10-30T10-15-00.123Z.md");
    assert.equal(read(paths.notes), settled, "the file on disk is what is returned");
    assert.match(read(historyFile), /^# Moved from ## Now at 2026-10-30T10:15:00\.123Z\n\n- finding \d+: .*\n/);
    assert.match(read(historyFile), /- finding 39: /);
    assert.doesNotMatch(read(historyFile), /- finding 0: /);
    assert.match(settled, /^# ACME-1\n\n## Now\nStatus: root cause found\nNext: check the queue\nOpen questions:\n- finding 0: /);
    assert.doesNotMatch(settled, /- finding 39: /);
    assert.match(settled, /\(older lines moved to history\/2026-10-30T10-15-00\.123Z\.md\)\n\n## Decisions\n- Use the queue\.\n$/);
    assert.equal(mode(paths.notes), 0o600, "notes.md keeps its mode after the rewrite");
    assert.deepEqual(readdirSync(paths.dir).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
});

test("notes within the limit are not rewritten and no history file is made", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "ACME-1");
    const paths = ticketPaths(folder, "ACME-1");
    const before = read(paths.notes);
    assert.equal(settleNotes(folder, "ACME-1", new Date()), before);
    assert.deepEqual(readdirSync(paths.history), []);
});

test("a ticket whose folder was deleted by hand has no notes, and settling them is empty", (t) => {
    const folder = tempFolder(t);
    assert.equal(settleNotes(folder, "ACME-404", new Date()), "");
    assert.equal(existsSync(path.join(folder, "ACME-404")), false, "settling creates nothing");
});

test("a ticket key is a safe folder name: letters and digits first, then letters, digits and _ . -", () => {
    for (const key of ["ACME-1", "acme.12_x", "a"]) assert.equal(isSafeKey(key), true, key);
    for (const key of ["", "../x", "a/b", ".hidden", "-x", "a b", "x".repeat(65)]) assert.equal(isSafeKey(key), false, key);
});

test("mentioned tickets keep the safe keys, each once and in order", () => {
    assert.deepEqual(mentionedTickets("ACME-2 then ACME-1 and ACME-2", /ACME-\d+/g), ["ACME-2", "ACME-1"]);
    assert.deepEqual(mentionedTickets("../x and ACME-1", /\.\.\/x|ACME-\d+/g), ["ACME-1"], "a match that is not a safe name is left out");
});

test("the stamp that names history and evidence files sorts by time and has no colons", () => {
    assert.equal(stampOf(new Date("2026-10-30T10:15:00.123Z")), "2026-10-30T10-15-00.123Z");
});
