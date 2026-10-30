// What the user types after /lens, parsed: every right spelling, and the wrong ones with the usage line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { completions, MAX_DAYS, parseCommand, USAGE, WORDS } from "../src/command.ts";

test("nothing after /lens is the summary, with any amount of white space", () => {
    for (const args of ["", " ", "   \t "])
        assert.deepEqual(parseCommand(args), { kind: "summary" }, JSON.stringify(args));
});

test("the two viewers", () => {
    assert.deepEqual(parseCommand("grafana"), { kind: "viewer", viewer: "grafana" });
    assert.deepEqual(parseCommand("datasette"), { kind: "viewer", viewer: "datasette" });
    assert.deepEqual(parseCommand("  grafana  "), { kind: "viewer", viewer: "grafana" });
});

test("rebuild and status", () => {
    assert.deepEqual(parseCommand("rebuild"), { kind: "rebuild" });
    assert.deepEqual(parseCommand("status"), { kind: "status" });
});

test("a ticket takes one key, exactly as typed", () => {
    assert.deepEqual(parseCommand("ticket PROJ-123"), { kind: "ticket", ticket: "PROJ-123" });
    assert.deepEqual(parseCommand("ticket   t-1 "), { kind: "ticket", ticket: "t-1" });
});

test("a session takes an id, or none for the session the user is in", () => {
    assert.deepEqual(parseCommand("session"), { kind: "session" });
    assert.deepEqual(parseCommand("session 0198-abc"), { kind: "session", session: "0198-abc" });
});

test("days takes a whole number from 1 to 90", () => {
    assert.deepEqual(parseCommand("days 1"), { kind: "days", days: 1 });
    assert.deepEqual(parseCommand("days 7"), { kind: "days", days: 7 });
    assert.deepEqual(parseCommand("days 90"), { kind: "days", days: 90 });
    assert.deepEqual(parseCommand("days 007"), { kind: "days", days: 7 });
    assert.equal(MAX_DAYS, 90, "the index keeps 90 days");
});

test("a word that is not a command gives the usage and nothing else", () => {
    for (const args of ["restart", "Status", "GRAFANA", "tickets", "7", "ticket1", "-h", "--help", "help"]) {
        assert.deepEqual(parseCommand(args), { kind: "usage" }, args);
    }
});

test("arguments where there are none to give are refused, and the command says so", () => {
    for (const word of ["grafana", "datasette", "rebuild", "status"]) {
        assert.deepEqual(
            parseCommand(`${word} now`),
            { kind: "usage", problem: `/lens ${word} takes no arguments.` },
            word,
        );
    }
});

test("a ticket without a key, or with two, is refused", () => {
    assert.deepEqual(parseCommand("ticket"), { kind: "usage", problem: "/lens ticket needs a ticket key." });
    assert.deepEqual(parseCommand("ticket A-1 B-2"), { kind: "usage", problem: "/lens ticket takes one ticket key." });
});

test("usage opens the usage view, and takes no arguments", () => {
    assert.deepEqual(parseCommand("usage"), { kind: "usage-view" });
    assert.deepEqual(parseCommand("  usage  "), { kind: "usage-view" });
    for (const args of ["usage week", "usage 7", "usage today"]) {
        assert.deepEqual(parseCommand(args), { kind: "usage", problem: "/lens usage takes no arguments." }, args);
    }
});

test("a session with two ids is refused", () => {
    assert.deepEqual(parseCommand("session a b"), { kind: "usage", problem: "/lens session takes one session id." });
});

test("days outside 1 to 90, or not a whole number, is refused with the range", () => {
    const problem = "/lens days takes a whole number from 1 to 90.";
    for (const args of [
        "days",
        "days 0",
        "days 91",
        "days 365",
        "days -3",
        "days 1.5",
        "days x",
        "days 7d",
        "days 1e1",
        "days +5",
        "days 7 8",
    ]) {
        assert.deepEqual(parseCommand(args), { kind: "usage", problem }, args);
    }
});

test("the usage names every command on one line", () => {
    assert.equal(
        USAGE,
        "Usage: /lens [ticket KEY | session [id] | days N | usage | grafana | datasette | rebuild | status]",
    );
    for (const [word] of WORDS) assert.ok(USAGE.includes(word), word);
    assert.ok(!USAGE.includes("\n"));
});

test("the completions are the first words, each with what it does", () => {
    assert.deepEqual(
        (completions("") ?? []).map((item) => item.value),
        ["ticket", "session", "days", "usage", "grafana", "datasette", "rebuild", "status"],
    );
    assert.deepEqual(completions("gr"), [
        { value: "grafana", label: "grafana", description: "open the Grafana dashboards" },
    ]);
    assert.equal(completions("zzz"), null);
    for (const item of completions("") ?? []) assert.ok(item.description.length > 0, item.value);
});
