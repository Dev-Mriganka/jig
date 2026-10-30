import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { EVIDENCE_LIMIT, indexCount, isFileTool, saveEvidence } from "../src/evidence.ts";
import { ensureTicket, ticketPaths } from "../src/store.ts";
import { tempFolder } from "./support.ts";

const NOW = new Date("2026-10-30T10:15:00.123Z");
const LINE = /^- 2026-10-30T10:15:00\.123Z \| logs \| query \| 2026-10-30T10-15-00\.123Z-logs-query-[0-9a-f]{6}\.txt$/;

function setup(t: TestContext) {
    const folder = tempFolder(t);
    ensureTicket(folder, "ACME-1");
    return { folder, paths: ticketPaths(folder, "ACME-1") };
}

test("a result is one file of its text and one index line: time, tool, action and file name", (t) => {
    const { folder, paths } = setup(t);
    const line = saveEvidence(
        folder,
        "ACME-1",
        { tool: "logs", input: { action: "query", env: "staging" }, text: "131 hits" },
        NOW,
    );
    assert.match(line, LINE);
    const name = line.split(" | ").at(-1)!;
    assert.equal(readFileSync(path.join(paths.evidence, name), "utf8"), "131 hits");
    assert.ok(readFileSync(paths.index, "utf8").endsWith(`${line}\n`), "the line is the last one in the index");
});

test("only the action of a call is stored, so a secret in another argument is not", (t) => {
    const { folder, paths } = setup(t);
    saveEvidence(
        folder,
        "ACME-1",
        { tool: "logs", input: { action: "query", apiKey: "sk-live-SECRET123", note: "Bearer abc.def" }, text: "ok" },
        NOW,
    );
    const everything =
        readdirSync(paths.evidence)
            .map((name) => readFileSync(path.join(paths.evidence, name), "utf8"))
            .join("\n") + readFileSync(paths.index, "utf8");
    assert.doesNotMatch(everything, /SECRET123|Bearer|sk-live/);
    assert.match(readFileSync(paths.index, "utf8"), /\| query \|/);
});

test("an action that is not a plain word, such as a token typed into the field, is not stored", (t) => {
    const { folder, paths } = setup(t);
    const line = saveEvidence(folder, "ACME-1", { tool: "logs", input: { action: "sk_4f9aB7xQ2" }, text: "ok" }, NOW);
    assert.match(line, /^- \S+ \| logs \| - \| /);
    assert.doesNotMatch(readFileSync(paths.index, "utf8"), /sk_4f9aB7xQ2/);
});

test("a result over 8 KB is clipped to 8 KB, and the file says so", (t) => {
    const { folder, paths } = setup(t);
    const line = saveEvidence(
        folder,
        "ACME-1",
        { tool: "logs", input: { action: "query" }, text: "line of output\n".repeat(2000) },
        NOW,
    );
    const saved = readFileSync(path.join(paths.evidence, line.split(" | ").at(-1)!), "utf8");
    assert.ok(Buffer.byteLength(saved) <= EVIDENCE_LIMIT, `${Buffer.byteLength(saved)} bytes`);
    assert.match(saved, /^line of output\n/);
    assert.match(saved, /\[clipped: the rest of this result is not kept\]\n$/);
});

test("each result adds one index line, in order, and the count follows them", (t) => {
    const { folder, paths } = setup(t);
    for (const text of ["first", "second", "third"])
        saveEvidence(folder, "ACME-1", { tool: "logs", input: { action: "query" }, text }, NOW);
    assert.equal(indexCount(folder, "ACME-1"), 3);
    assert.equal(readdirSync(paths.evidence).filter((name) => name.endsWith(".txt")).length, 3);
});

test("a tool name that is not a plain name is saved as unnamed", (t) => {
    const { folder, paths } = setup(t);
    const line = saveEvidence(folder, "ACME-1", { tool: "bad name | x", input: {}, text: "ok" }, NOW);
    assert.match(line, /^- \S+ \| unnamed \| - \| /);
    assert.doesNotMatch(readFileSync(paths.index, "utf8"), /bad name/);
});

test("Pi's file tools are not evidence; other tools are", () => {
    for (const tool of ["read", "ls", "find", "grep", "write", "edit"]) assert.equal(isFileTool(tool), true, tool);
    for (const tool of ["bash", "logs", "mongo", "mcp__jira__search"]) assert.equal(isFileTool(tool), false, tool);
});
