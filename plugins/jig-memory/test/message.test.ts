import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTES_IN_MESSAGE, notesMessage, REMIND_AFTER, reminderText } from "../src/message.ts";

const base = { key: "ACME-1", folder: "/data/tickets/ACME-1", lead: "Active." };

test("the notes message names the ticket, its folder and the files, then the notes", () => {
    assert.equal(
        notesMessage({ ...base, notes: "# ACME-1\n\n## Now\nStatus: new\n" }),
        "[ticket ACME-1] Active. Folder: /data/tickets/ACME-1/ (notes.md, evidence/index.md).\n\n# ACME-1\n\n## Now\nStatus: new\n",
    );
});

test("empty notes are said to be empty", () => {
    assert.match(notesMessage({ ...base, notes: "  \n" }), /\n\n\(notes\.md is empty\)$/);
});

test("notes longer than 16 KB are cut, with a note that says where the rest is", () => {
    const message = notesMessage({ ...base, notes: "line of decisions\n".repeat(2000) });
    assert.ok(Buffer.byteLength(message) <= NOTES_IN_MESSAGE + 200, `${Buffer.byteLength(message)} bytes`);
    assert.match(message, /\n\[\.\.\. cut at 16 KB; read notes\.md for the rest\]$/);
});

test("the reminder names the count, the notes file and what to update", () => {
    const text = reminderText("ACME-1", "/data/tickets/ACME-1/notes.md");
    assert.equal(REMIND_AFTER, 15);
    assert.match(
        text,
        /^\[ticket ACME-1\] 15 tool results since notes\.md last changed: update the ## Now block in \/data\/tickets\/ACME-1\/notes\.md \(status, next step, open questions\)\.$/,
    );
});
