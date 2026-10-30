import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { folderOf, ticketRegex, validateMemory } from "../src/config.ts";
import { PATTERN } from "./support.ts";

test("a section with no fields, or with its fields set correctly, is valid", () => {
    assert.deepEqual(validateMemory({}), []);
    assert.deepEqual(validateMemory({ ticketPattern: PATTERN, folder: "/data/tickets" }), []);
    assert.deepEqual(validateMemory({ folder: "~/tickets" }), []);
});

test("a misspelt field is an error that names it, not a silent default", () => {
    assert.deepEqual(validateMemory({ ticketPatern: PATTERN }), ["memory.ticketPatern: unknown field"]);
});

test("the section must be an object", () => {
    for (const raw of [null, "memory", ["ACME-1"], 3]) {
        assert.deepEqual(validateMemory(raw), ["memory: must be an object"], JSON.stringify(raw));
    }
});

test("ticketPattern must be a regular expression, and the error names the key", () => {
    assert.match(validateMemory({ ticketPattern: "[A-Z" })[0]!, /^memory\.ticketPattern: not a regular expression \(/);
    assert.match(validateMemory({ ticketPattern: "" })[0]!, /^memory\.ticketPattern: /);
    assert.match(validateMemory({ ticketPattern: 7 })[0]!, /^memory\.ticketPattern: /);
});

test("folder is an absolute path or starts with ~/, and the error names the key", () => {
    assert.match(validateMemory({ folder: "tickets" })[0]!, /^memory\.folder: use an absolute path/);
    assert.match(validateMemory({ folder: 4 })[0]!, /^memory\.folder: must be a path/);
});

test("the default folder is under XDG_DATA_HOME; an empty or relative XDG_DATA_HOME is ignored", (t) => {
    const saved = process.env.XDG_DATA_HOME;
    t.after(() => {
        if (saved === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = saved;
    });
    const fallback = path.join(os.homedir(), ".local", "share", "jig", "tickets");
    process.env.XDG_DATA_HOME = "/var/data";
    assert.equal(folderOf(undefined), path.join("/var/data", "jig", "tickets"));
    for (const value of ["", "relative/dir"]) {
        process.env.XDG_DATA_HOME = value;
        assert.equal(folderOf({}), fallback, JSON.stringify(value));
    }
    delete process.env.XDG_DATA_HOME;
    assert.equal(folderOf(undefined), fallback);
});

test("a folder setting replaces the default, and ~/ means the home folder", () => {
    assert.equal(folderOf({ folder: "/srv/tickets" }), "/srv/tickets");
    assert.equal(folderOf({ folder: "~/tickets" }), path.join(os.homedir(), "tickets"));
});

test("the ticket pattern finds whole keys only: a key must not touch a letter or digit", () => {
    const keysIn = (text: string) =>
        [...text.matchAll(ticketRegex({ ticketPattern: PATTERN })!)].map((match) => match[0]);
    assert.deepEqual(keysIn("debug ACME-12 and ACME-7."), ["ACME-12", "ACME-7"]);
    assert.deepEqual(keysIn("aACME-12 and ACME-12b"), [], "glued to a letter before or after");
});

test("without a ticketPattern there is no regular expression, so no message activates a ticket", () => {
    assert.equal(ticketRegex(undefined), undefined);
    assert.equal(ticketRegex({ folder: "/srv/tickets" }), undefined);
});
