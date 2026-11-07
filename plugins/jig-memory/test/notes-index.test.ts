// The notes index: only ## Now and ## Decisions are kept, a large note costs no more than a small one, an entry is rebuilt
// when the note changes, and a written card wins over the derived entry for its ticket.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { writeCard } from "./support.ts";
import { loadCards } from "../src/cards.ts";
import { RECALL_DEFAULTS } from "../src/config.ts";
import { loadNoteIndex, NOTES_TEXT_LIMIT, notesIndexFile } from "../src/notes-index.ts";
import { buildQuery, recall } from "../src/recall.ts";
import { ticketPaths } from "../src/store.ts";
import { tempFolder } from "./support.ts";

const PATTERN = /[A-Z][A-Z0-9]+-\d+/g;

function writeNote(folder: string, key: string, text: string): void {
    mkdirSync(ticketPaths(folder, key).dir, { recursive: true });
    writeFileSync(ticketPaths(folder, key).notes, text);
}

test("a 73 KB note keeps only bounded ## Now and ## Decisions text", (t) => {
    const folder = tempFolder(t);
    const note = `# PROJ-1\n\n## Now\n${"Status: broken. ".repeat(5000)}\n\n## Decisions\n${"Use the queue. ".repeat(5000)}\n\n## History\n${"x".repeat(60000)}\n`;
    writeNote(folder, "PROJ-1", note);
    const entry = loadNoteIndex(folder, PATTERN)["PROJ-1"];
    assert.ok(entry !== undefined);
    assert.ok(entry.now.length <= NOTES_TEXT_LIMIT + 64, `${entry.now.length} now bytes`);
    assert.ok(entry.decisions.length <= NOTES_TEXT_LIMIT + 64, `${entry.decisions.length} decision bytes`);
    assert.equal(entry.terms.queu !== undefined, true);
    assert.equal(entry.terms.x !== undefined, false);
});

test("the index rebuilds when a note changes, and does not include the ticket's own key", (t) => {
    const folder = tempFolder(t);
    writeNote(folder, "PROJ-1", "# PROJ-1\n\n## Now\nStatus: first\n\n## Decisions\n");
    const first = loadNoteIndex(folder, PATTERN)["PROJ-1"];
    assert.deepEqual(first?.keys, []);
    writeNote(folder, "PROJ-1", "# PROJ-1\n\n## Now\nStatus: second, different text\n\n## Decisions\n");
    const second = loadNoteIndex(folder, PATTERN)["PROJ-1"];
    assert.notEqual(second?.terms.second, undefined);
});

test("a written card wins over the note entry for the same ticket", (t) => {
    const folder = tempFolder(t);
    writeCard(
        folder,
        "PROJ-1",
        { Problem: "The queue stalls.", Cause: "The worker is closed.", Fix: "Open it." },
        {
            identifiers: ["QueueWorker"],
        },
    );
    writeNote(folder, "PROJ-1", "# PROJ-1\n\n## Now\nStatus: QueueWorker is closed\n\n## Decisions\nOpen it.\n");
    const cards = loadCards(folder);
    const notes = loadNoteIndex(folder, PATTERN);
    const matches = recall(
        cards,
        buildQuery({ ticket: "PROJ-2", text: "QueueWorker is closed", pattern: PATTERN }),
        {
            max: RECALL_DEFAULTS.max,
            minScore: RECALL_DEFAULTS.minScore,
            maxNotes: 1,
        },
        notes,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.source, "card");
});

test("common words alone do not surface a note; a rare word or a name does", (t) => {
    const folder = tempFolder(t);
    writeNote(folder, "PROJ-1", "# PROJ-1\n\n## Now\nStatus: review branch plan account\n\n## Decisions\n");
    writeNote(folder, "PROJ-2", "# PROJ-2\n\n## Now\nStatus: review branch plan account\n\n## Decisions\n");
    const notes = loadNoteIndex(folder, PATTERN);
    const query = buildQuery({ ticket: "PROJ-3", text: "review branch plan account", pattern: PATTERN });
    const noRule = recall({}, query, { max: 3, minScore: 0.5, maxNotes: 1, requireEvidence: false }, notes);
    assert.equal(noRule.length > 0, true, "without the rule, the shared common words score");
    const rule = recall({}, query, { max: 3, minScore: 0.5, maxNotes: 1, requireEvidence: true }, notes);
    assert.equal(rule.length, 0, "common words alone are not evidence");

    for (let n = 0; n < 6; n++) {
        writeNote(folder, `FILL-${n}`, `# FILL-${n}\n\n## Now\nStatus: filler${n}\n\n## Decisions\n`);
    }
    writeNote(folder, "PROJ-4", "# PROJ-4\n\n## Now\nStatus: quartz\n\n## Decisions\n");
    writeNote(folder, "PROJ-5", "# PROJ-5\n\n## Now\nStatus: quartz\n\n## Decisions\n");
    const rare = loadNoteIndex(folder, PATTERN);
    const rareQuery = buildQuery({ ticket: "PROJ-3", text: "quartz", pattern: PATTERN });
    assert.equal(rare["PROJ-4"]?.terms.quartz !== undefined, true, "quartz is a term");
    assert.equal(rareQuery.roots.has("quartz"), true, "quartz is in the query");
    assert.equal(
        recall({}, rareQuery, { max: 3, minScore: 0.1, maxNotes: 2, requireEvidence: false }, rare).length,
        2,
        "without the rule both notes are found",
    );
    assert.equal(
        recall({}, rareQuery, { max: 3, minScore: 0.1, maxNotes: 2, requireEvidence: true }, rare).length,
        2,
        "a rare shared word is evidence",
    );
    assert.equal(
        recall(
            {},
            rareQuery,
            { max: 3, minScore: 0.1, maxNotes: 2, requireEvidence: true, allowRareWords: false },
            rare,
        ).length,
        0,
        "automatic recall does not take a word alone",
    );
});

test("a note entry is labelled as from notes, dated and possibly out of date", (t) => {
    const folder = tempFolder(t);
    writeNote(folder, "PROJ-1", "# PROJ-1\n\n## Now\nStatus: QueueWorker is closed\n\n## Decisions\nOpen it.\n");
    const notes = loadNoteIndex(folder, PATTERN);
    const matches = recall(
        {},
        buildQuery({ ticket: "PROJ-2", text: "QueueWorker is closed", pattern: PATTERN }),
        {
            max: RECALL_DEFAULTS.max,
            minScore: RECALL_DEFAULTS.minScore,
            maxNotes: 1,
        },
        notes,
    );
    assert.equal(matches[0]?.source, "notes");
    assert.match(matches[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.match(matches[0]?.now ?? "", /QueueWorker/);
});

test("a CRLF note is indexed, with no trailing carriage return in a block", (t) => {
    const folder = tempFolder(t);
    writeNote(folder, "PROJ-1", "# PROJ-1\r\n\r\n## Now\r\nStatus: OrderService\r\n\r\n## Decisions\r\nCheck.\r\n");
    const entry = loadNoteIndex(folder, PATTERN)["PROJ-1"];
    assert.match(entry?.now ?? "", /OrderService/);
    assert.equal((entry?.now ?? "").includes("\r"), false);
});

test("a symlinked or FIFO note is skipped and never opened", (t) => {
    const folder = tempFolder(t);
    mkdirSync(ticketPaths(folder, "PROJ-1").dir, { recursive: true });
    const real = path.join(folder, "outside.md");
    writeFileSync(real, "# x\n\n## Now\nStatus: OrderService\n");
    symlinkSync(real, ticketPaths(folder, "PROJ-1").notes);
    assert.equal(loadNoteIndex(folder, PATTERN)["PROJ-1"], undefined, "symlink skipped");
    rmSync(ticketPaths(folder, "PROJ-1").notes);
    try {
        execFileSync("mkfifo", [ticketPaths(folder, "PROJ-1").notes]);
    } catch {
        t.skip("mkfifo is not available");
        return;
    }
    const started = Date.now();
    assert.equal(loadNoteIndex(folder, PATTERN)["PROJ-1"], undefined, "FIFO skipped without opening it");
    assert.ok(Date.now() - started < 2_000, "a FIFO must not hang the index");
});

test("an unreadable note does not rewrite the index on every read", (t) => {
    const folder = tempFolder(t);
    writeNote(folder, "PROJ-1", "# PROJ-1\n\n## Now\nStatus: first\n\n## Decisions\n");
    loadNoteIndex(folder, PATTERN);
    const index = notesIndexFile(folder);
    const before = readFileSync(index, "utf8");
    chmodSync(ticketPaths(folder, "PROJ-1").notes, 0o000);
    loadNoteIndex(folder, PATTERN);
    assert.equal(readFileSync(index, "utf8"), before, "the index is unchanged");
});
