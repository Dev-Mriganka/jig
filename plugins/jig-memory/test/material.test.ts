import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ticketRegex } from "../src/config.ts";
import {
    boundRepositories,
    EVIDENCE_SCAN_LIMIT,
    frontOf,
    hasContent,
    hasNoNotes,
    readMaterial,
} from "../src/material.ts";
import { ensureTicket, ticketPaths } from "../src/store.ts";
import { PATTERN, tempFolder } from "./support.ts";

const NOW = new Date("2026-10-31T10:15:00.000Z");

test("a new ticket has no notes yet and nothing to put on a card; a changed note or saved result is something", (t) => {
    const folder = tempFolder(t);
    assert.equal(hasNoNotes(folder, "PROJ-1"), true, "no folder at all");
    ensureTicket(folder, "PROJ-1");
    assert.equal(hasNoNotes(folder, "PROJ-1"), true, "the template");
    assert.equal(hasContent(readMaterial(folder, "PROJ-1")), false);

    const paths = ticketPaths(folder, "PROJ-1");
    writeFileSync(paths.notes, "# PROJ-1\n\n## Now\nStatus: found it\n");
    assert.equal(hasNoNotes(folder, "PROJ-1"), false);
    assert.equal(hasContent(readMaterial(folder, "PROJ-1")), true);

    ensureTicket(folder, "PROJ-2");
    writeFileSync(path.join(ticketPaths(folder, "PROJ-2").evidence, "a.txt"), "ERROR x");
    assert.equal(hasContent(readMaterial(folder, "PROJ-2")), true, "evidence alone is something");
});

test("the material is the notes with their history, the evidence in time order, and the bound repositories", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "PROJ-1");
    const paths = ticketPaths(folder, "PROJ-1");
    writeFileSync(paths.notes, "notes line\n");
    writeFileSync(path.join(paths.history, "2026-10-30T10-00-00.000Z.md"), "older line\n");
    writeFileSync(path.join(paths.evidence, "2026-10-30T11-00-00.000Z-logs.txt"), "second\n");
    writeFileSync(path.join(paths.evidence, "2026-10-30T10-00-00.000Z-logs.txt"), "first\n");
    writeFileSync(paths.ticket, JSON.stringify({ repositories: ["/home/me/work/orders-api/", "payments-worker"] }));
    const material = readMaterial(folder, "PROJ-1");
    assert.match(material.notes, /notes line[\s\S]*older line/);
    assert.equal(material.evidence, "first\n\nsecond\n");
    assert.deepEqual(material.repositories, ["orders-api", "payments-worker"]);
});

test("a ticket whose folders were deleted by hand has empty material", (t) => {
    const material = readMaterial(tempFolder(t), "PROJ-1");
    assert.deepEqual(material, { key: "PROJ-1", notes: "", evidence: "", repositories: [] });
});

test("repositories are folder names, each once; anything that is not a list of paths gives none", () => {
    assert.deepEqual(boundRepositories('{"repositories":["a/orders-api","b/orders-api","..",7,""]}'), ["orders-api"]);
    for (const text of ["", "not json", "{}", '{"repositories":"x"}'])
        assert.deepEqual(boundRepositories(text), [], text);
});

test("the evidence read for one card stops at its byte budget", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "PROJ-1");
    const dir = ticketPaths(folder, "PROJ-1").evidence;
    const chunk = "x".repeat(1024 * 1024);
    for (let n = 0; n < 6; n++) writeFileSync(path.join(dir, `r${n}.txt`), chunk);
    const read = readMaterial(folder, "PROJ-1").evidence.length;
    assert.ok(read >= EVIDENCE_SCAN_LIMIT && read <= EVIDENCE_SCAN_LIMIT + 2 * 1024 * 1024, `${read}`);
});

test("the front matter is made from the material alone", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "PROJ-1");
    const paths = ticketPaths(folder, "PROJ-1");
    mkdirSync(paths.evidence, { recursive: true });
    writeFileSync(paths.notes, "# PROJ-1\n\nSame as PROJ-98. OrderMapper.toDto fails.\n");
    writeFileSync(
        path.join(paths.evidence, "a.txt"),
        "2026-10-30T10:00:00Z ERROR java.lang.NullPointerException: customer is null\n  at OrderMapper.toDto(OrderMapper.java:12)\n",
    );
    writeFileSync(paths.ticket, JSON.stringify({ repositories: ["orders-api"] }));
    assert.deepEqual(frontOf(readMaterial(folder, "PROJ-1"), ticketRegex({ ticketPattern: PATTERN }), NOW), {
        ticket: "PROJ-1",
        closedAt: "2026-10-31T10:15:00.000Z",
        repositories: ["orders-api"],
        keys: ["PROJ-98"],
        identifiers: ["OrderMapper", "toDto", "NullPointerException"],
        errors: ["ERROR java.lang.NullPointerException: customer is null"],
    });
});
