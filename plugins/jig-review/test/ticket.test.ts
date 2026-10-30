// Ticket scope: the repositories jig-memory bound to a ticket, read from `<ticket folder>/<KEY>/ticket.json`, and nothing
// found by guessing from names.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseCodeReviewCommand } from "../src/command.ts";
import { bindingPath, isTicketKey, readBinding, ticketFolder } from "../src/ticket.ts";
import { WorkspaceReviewSource } from "../src/workspace.ts";
import { installFakeJig } from "./support/fake-jig.ts";
import type { FakeJig } from "./support/fake-jig.ts";
import { git } from "./support/git.ts";

let root = "";
let elsewhere = "";
let tickets = "";
let jig: FakeJig;

/** A repository with a develop branch and one committed change on `branch`. */
function ticketRepo(dir: string, branch: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "develop");
    writeFileSync(path.join(dir, "A.java"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    if (branch !== "develop") git(dir, "checkout", "-q", "-b", branch);
    writeFileSync(path.join(dir, "A.java"), `one\n${path.basename(dir)}\n`);
    git(dir, "commit", "-qam", "change");
}

function bind(ticket: string, repositories: unknown): void {
    mkdirSync(path.join(tickets, ticket), { recursive: true });
    writeFileSync(path.join(tickets, ticket, "ticket.json"), typeof repositories === "string" ? repositories : JSON.stringify({ repositories }));
}

before(() => {
    jig = installFakeJig();
    root = mkdtempSync(path.join(os.tmpdir(), "jig-review-ticket-"));
    elsewhere = mkdtempSync(path.join(os.tmpdir(), "jig-review-elsewhere-"));
    tickets = mkdtempSync(path.join(os.tmpdir(), "jig-review-tickets-"));
    jig.setSection("memory", { folder: tickets });
    ticketRepo(path.join(root, "worktrees", "PROJ-7", "orders-api"), "feature/PROJ-7");
    ticketRepo(path.join(root, "shipping-api"), "feature/PROJ-7-order-fix");
    ticketRepo(path.join(root, "invoices-api"), "feature/PROJ-70");
    ticketRepo(path.join(elsewhere, "ledger-api"), "feature/PROJ-7");
});
after(() => {
    jig.remove();
    for (const dir of [root, elsewhere, tickets]) rmSync(dir, { recursive: true, force: true });
});

test("the ticket's repositories are the ones jig-memory bound, and no others, whatever the branches are called", async () => {
    bind("PROJ-7", ["worktrees/PROJ-7/orders-api", "shipping-api"]);
    const files = await new WorkspaceReviewSource(root).getChangedFiles({ scope: "branch", ticket: "PROJ-7" });
    assert.deepEqual(files, ["worktrees/PROJ-7/orders-api/A.java", "shipping-api/A.java"], "in the order the binding lists them");
    assert.ok(!files.some((file) => file.startsWith("invoices-api")), "PROJ-70 is another ticket and was not bound");
});

test("a repository outside Pi's folder is allowed and shows under its own folder name", () => {
    bind("PROJ-7", [path.join(elsewhere, "ledger-api"), "shipping-api"]);
    assert.deepEqual(readBinding("PROJ-7", root).map((repo) => repo.prefix), ["ledger-api", "shipping-api"]);
});

test("two outside repositories with one name do not collide", () => {
    const other = path.join(elsewhere, "more", "ledger-api");
    ticketRepo(other, "develop");
    bind("PROJ-7", [path.join(elsewhere, "ledger-api"), other]);
    const prefixes = readBinding("PROJ-7", root).map((repo) => repo.prefix);
    assert.equal(prefixes[0], "ledger-api");
    assert.notEqual(prefixes[1], "ledger-api");
    assert.ok(!prefixes[1]!.startsWith("/"), "a path inside a diff header has no leading slash");
});

test("Pi's own folder may be the bound repository: its paths need no prefix", () => {
    bind("PROJ-8", ["."]);
    assert.deepEqual(readBinding("PROJ-8", path.join(root, "shipping-api")).map((repo) => repo.prefix), [""]);
});

test("a ticket that is not bound says ticket scope needs jig-memory with bound repositories", async () => {
    const needs = /Ticket scope needs jig-memory with bound repositories: PROJ-404 has none/;
    assert.throws(() => readBinding("PROJ-404", root), needs, "no ticket folder");
    bind("PROJ-404", []);
    assert.throws(() => readBinding("PROJ-404", root), needs, "an empty list");
    await assert.rejects(new WorkspaceReviewSource(root).getChangedFiles({ scope: "branch", ticket: "PROJ-404" }), needs);
});

test("a binding with a bad entry is refused with the reason", () => {
    bind("PROJ-9", ["notes"]);
    assert.throws(() => readBinding("PROJ-9", root), /names notes, which is not a git repository/);
    bind("PROJ-9", { repositories: "shipping-api" });
    assert.throws(() => readBinding("PROJ-9", root), /needs "repositories": a list of repository paths/);
    bind("PROJ-9", "{not json");
    assert.throws(() => readBinding("PROJ-9", root), /is not valid JSON/);
});

test("a ticket key is a folder name: a path in its place is refused", () => {
    assert.throws(() => bindingPath("../escape"), /is not a ticket key/);
    assert.throws(() => bindingPath("a/b"), /is not a ticket key/);
});

test("the ticket folder follows the memory section, with ~/ expanded, else the XDG data folder", () => {
    assert.equal(ticketFolder(), tickets);
    jig.setSection("memory", { folder: "~/work/tickets" });
    assert.equal(ticketFolder(), path.join(os.homedir(), "work", "tickets"));
    jig.setSection("memory", undefined);
    assert.equal(ticketFolder({ XDG_DATA_HOME: "/data" }), "/data/jig/tickets");
    assert.equal(ticketFolder({ XDG_DATA_HOME: "relative" }), path.join(os.homedir(), ".local", "share", "jig", "tickets"), "a relative XDG_DATA_HOME is ignored");
    jig.setSection("memory", { folder: tickets });
});

test("a ticket key is the memory section's pattern when it sets one, else a generic ABC-123", () => {
    assert.ok(isTicketKey("PROJ-1") && isTicketKey("abc-22"));
    assert.ok(!isTicketKey("worktrees/PROJ-1") && !isTicketKey("PROJ") && !isTicketKey("orders-api"));
    jig.setSection("memory", { folder: tickets, ticketPattern: "TKT\\d+" });
    assert.ok(isTicketKey("TKT42"));
    assert.ok(!isTicketKey("PROJ-1"), "the pattern replaces the generic form");
    jig.setSection("memory", { folder: tickets });
});

test("/code-review <ticket> reviews the whole branch unless a scope is given", () => {
    assert.deepEqual(parseCodeReviewCommand("proj-7"), { selection: { scope: "branch", ticket: "PROJ-7" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("PROJ-7 --unstaged"), { selection: { scope: "unstaged", ticket: "PROJ-7" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("worktrees/PROJ-7"), { selection: { scope: "all", folder: "worktrees/PROJ-7" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("--staged"), { selection: { scope: "staged" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("--touched"), { selection: { scope: "touched" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("--branch orders-api"), { selection: { scope: "branch", folder: "orders-api" }, subcommand: "review" });
    assert.deepEqual(parseCodeReviewCommand("settings"), { subcommand: "settings" });
});

test("a ticket with no repositories bound says so when asked to review", async () => {
    await assert.rejects(new WorkspaceReviewSource(root).requireGitRepo({ ticket: "PROJ-500" }), /Ticket scope needs jig-memory with bound repositories/);
});
