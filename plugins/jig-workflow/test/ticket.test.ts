// The ticket: which one the session works on, where its folder is, and the repositories bound to it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { activeTicket, addBound, isTicketKey, readBound, ticketPaths, ticketsFolder } from "../src/ticket.ts";

let root: string;
beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-workflow-ticket-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (customType: string, data: unknown): SessionEntry =>
    ({ type: "custom", customType, data }) as unknown as SessionEntry;

describe("the active ticket", () => {
    test("the last entry jig-memory wrote, and none after /ticket off", () => {
        const entries = [
            entry("jig-memory-ticket", { key: "PROJ-1" }),
            entry("other", { key: "X" }),
            entry("jig-memory-ticket", { key: "PROJ-2" }),
        ];
        assert.equal(activeTicket(entries), "PROJ-2");
        assert.equal(activeTicket([...entries, entry("jig-memory-ticket", { key: null })]), undefined);
        assert.equal(activeTicket([]), undefined);
    });

    test("a key that is not a safe folder name is no ticket", () => {
        assert.equal(activeTicket([entry("jig-memory-ticket", { key: "../x" })]), undefined);
        for (const bad of ["", ".hidden", "a/b", "a b", "x".repeat(65), 3, undefined, null]) {
            assert.equal(isTicketKey(bad), false, String(bad));
        }
        for (const good of ["PROJ-123", "proj_1", "A.b-c"]) assert.equal(isTicketKey(good), true, good);
    });
});

describe("where the ticket folders are", () => {
    test("the memory section's folder, with ~/ expanded", () => {
        assert.equal(ticketsFolder({ folder: "/srv/tickets" }, {}), "/srv/tickets");
        assert.equal(ticketsFolder({ folder: "~/work/tickets" }, {}), path.join(os.homedir(), "work", "tickets"));
    });

    test("else the XDG data folder when it is absolute, else the home folder's", () => {
        assert.equal(ticketsFolder(undefined, { XDG_DATA_HOME: "/data" }), path.join("/data", "jig", "tickets"));
        assert.equal(
            ticketsFolder(undefined, { XDG_DATA_HOME: "relative" }),
            path.join(os.homedir(), ".local", "share", "jig", "tickets"),
        );
        assert.equal(ticketsFolder({}, {}), path.join(os.homedir(), ".local", "share", "jig", "tickets"));
    });

    test("the files of a ticket", () => {
        const paths = ticketPaths("/t", "PROJ-1");
        assert.deepEqual(paths, {
            dir: "/t/PROJ-1",
            notes: "/t/PROJ-1/notes.md",
            plan: "/t/PROJ-1/plan.md",
            ticket: "/t/PROJ-1/ticket.json",
        });
    });
});

describe("the bound repositories", () => {
    function repo(name: string): string {
        const dir = path.join(root, name);
        mkdirSync(path.join(dir, ".git"), { recursive: true });
        return dir;
    }
    const paths = () => ticketPaths(path.join(root, "tickets"), "PROJ-1");

    test("none when the file is missing", () => {
        assert.deepEqual(readBound(paths(), root), { roots: [], problems: [] });
    });

    test("absolute paths, and paths from Pi's folder, as real paths", () => {
        const orders = repo("orders-api");
        repo("billing");
        mkdirSync(paths().dir, { recursive: true });
        writeFileSync(paths().ticket, JSON.stringify({ repositories: [orders, "billing", orders] }));
        assert.deepEqual(readBound(paths(), root), { roots: [orders, path.join(root, "billing")], problems: [] });
    });

    test("a path that is not a git work tree is left out and reported", () => {
        mkdirSync(paths().dir, { recursive: true });
        mkdirSync(path.join(root, "plain"));
        writeFileSync(paths().ticket, JSON.stringify({ repositories: ["plain", "gone"] }));
        const bound = readBound(paths(), root);
        assert.deepEqual(bound.roots, []);
        assert.equal(bound.problems.length, 2);
        assert.match(bound.problems[0] ?? "", /plain is bound to PROJ-1 and is not a git work tree/);
    });

    test("a file that is not valid, or has the wrong shape, binds nothing and says so", () => {
        mkdirSync(paths().dir, { recursive: true });
        writeFileSync(paths().ticket, "{ nope");
        assert.match(readBound(paths(), root).problems[0] ?? "", /is not valid JSON/);
        writeFileSync(paths().ticket, JSON.stringify({ repositories: [3] }));
        assert.match(readBound(paths(), root).problems[0] ?? "", /needs "repositories": a list of repository paths/);
    });

    test("binding adds a path once, keeps the rest of the file, and makes the folder", () => {
        const orders = repo("orders-api");
        assert.equal(addBound(paths(), orders), true);
        assert.equal(addBound(paths(), orders), false);
        writeFileSync(paths().ticket, JSON.stringify({ repositories: [orders], note: "keep" }));
        assert.equal(addBound(paths(), repo("billing")), true);
        const saved = JSON.parse(readFileSync(paths().ticket, "utf8")) as { repositories: string[]; note: string };
        assert.deepEqual(saved.repositories, [orders, path.join(root, "billing")]);
        assert.equal(saved.note, "keep");
        assert.deepEqual(readBound(paths(), root).roots, [orders, path.join(root, "billing")]);
    });
});
