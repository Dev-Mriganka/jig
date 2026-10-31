import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isReviewableWrite } from "../src/code-path.ts";
import { activeTicket } from "../src/ticket.ts";

test("only writes inside a git work tree, outside the agent's folders, count as code", () => {
    const root = mkdtempSync(path.join(tmpdir(), "code-path-"));
    try {
        mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
        mkdirSync(path.join(root, "worktree"), { recursive: true });
        writeFileSync(path.join(root, "worktree", ".git"), "gitdir: elsewhere\n");
        assert.equal(isReviewableWrite(path.join(root, "repo", "src", "Main.java")), true);
        assert.equal(isReviewableWrite(path.join(root, "worktree", "a.ts")), true, "a worktree's .git file counts");
        assert.equal(
            isReviewableWrite(path.join(root, "repo", ".pi", "notes.md")),
            false,
            "the agent's own folder is not code",
        );
        assert.equal(isReviewableWrite(path.join(root, "loose.md")), false, "outside any repository");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the active ticket is the latest ticket entry of the session", () => {
    const ctx = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries } }) as never;
    const entry = (key: unknown) => ({ type: "custom", customType: "jig-memory-ticket", data: { key } });
    assert.equal(activeTicket(ctx([])), undefined);
    assert.equal(activeTicket(ctx([entry("PROJ-1"), { type: "message" }, entry("PROJ-10877")])), "PROJ-10877");
    assert.equal(activeTicket(ctx([entry("PROJ-1"), entry(null)])), undefined, "cleared");
    assert.equal(activeTicket(ctx([entry("../../x")])), undefined, "not a ticket key");
    assert.equal(
        activeTicket(ctx([{ type: "custom", customType: "another-plugin", data: { key: "PROJ-2" } }])),
        undefined,
        "another plugin's entry",
    );
});
