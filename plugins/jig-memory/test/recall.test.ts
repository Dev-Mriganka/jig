import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCard } from "../src/card.ts";
import { type CardIndex, entryOf } from "../src/cards.ts";
import { ticketRegex } from "../src/config.ts";
import {
    buildQuery,
    COUNTED,
    formatMatches,
    type Match,
    notesText,
    POINTS,
    reason,
    recall,
    recallMessage,
} from "../src/recall.ts";
import { PATTERN } from "./support.ts";

interface Spec {
    problem?: string;
    cause?: string;
    fix?: string;
    keys?: string[];
    identifiers?: string[];
    errors?: string[];
    repositories?: string[];
}

/** An index of valid cards, made the way the plugin makes it. */
function index(specs: Record<string, Spec>): CardIndex {
    const cards: CardIndex = {};
    for (const [ticket, spec] of Object.entries(specs)) {
        const text = renderCard(
            {
                ticket,
                closedAt: "2026-10-01T09:00:00.000Z",
                repositories: spec.repositories ?? [],
                keys: spec.keys ?? [],
                identifiers: spec.identifiers ?? [],
                errors: spec.errors ?? [],
            },
            {
                Problem: spec.problem ?? "Something went wrong.",
                Cause: spec.cause ?? "A cause.",
                Fix: spec.fix ?? "A fix.",
            },
        );
        cards[ticket] = entryOf(ticket, text, { mtimeMs: 1, size: text.length });
    }
    return cards;
}

const OPTIONS = { max: 3, minScore: 2.5 };
const query = (text: string, extra: { ticket?: string; evidence?: string } = {}) =>
    buildQuery({ ...extra, text, pattern: ticketRegex({ ticketPattern: PATTERN }) });
const tickets = (matches: readonly Match[]) => matches.map((match) => match.ticket);

// Ten filler cards make a name that one card holds rare, as it is in a folder with some history.
const filler = Object.fromEntries(
    Array.from({ length: 10 }, (_, n) => [
        `FILL-${n}`,
        {
            problem: `Unrelated work number ${n}: the scheduled cleanup left stale temporary files in the shared folder.`,
            cause: `The cleanup job number ${n} skipped folders that a worker still held open.`,
            fix: `Close the folders before the cleanup runs and add a test for job ${n}.`,
            identifiers: [`Filler${n}Thing`],
        },
    ]),
);

test("an identifier that only one card holds passes alone, and the reason names it", () => {
    const cards = index({ ...filler, "PROJ-1": { identifiers: ["OrderService", "NullPointerException"] } });
    const matches = recall(cards, query("the NullPointerException comes from OrderService again"), OPTIONS);
    assert.deepEqual(tickets(matches), ["PROJ-1"]);
    assert.equal(reason(matches[0] as Match).startsWith("shares OrderService, NullPointerException"), true);
});

test("a name that every card holds does not pass alone", () => {
    const cards = index({
        "PROJ-1": { identifiers: ["SharedClient"] },
        "PROJ-2": { identifiers: ["SharedClient"] },
        "PROJ-3": { identifiers: ["SharedClient"] },
        "PROJ-4": { identifiers: ["SharedClient"] },
    });
    assert.deepEqual(recall(cards, query("SharedClient is slow"), OPTIONS), []);
});

test("a ticket key passes alone, whichever way it is shared", () => {
    const cards = index({
        ...filler,
        "PROJ-1": {},
        "PROJ-2": { keys: ["PROJ-50"] },
        "PROJ-3": { keys: ["PROJ-60"] },
    });
    assert.deepEqual(
        tickets(recall(cards, query("a follow-up of PROJ-1"), OPTIONS)),
        ["PROJ-1"],
        "the card's own ticket is named",
    );
    assert.deepEqual(
        tickets(recall(cards, query("see PROJ-50 first"), OPTIONS)),
        ["PROJ-2"],
        "the card names a key the query names",
    );
    assert.deepEqual(
        tickets(recall(cards, query("new work", { ticket: "PROJ-60" }), OPTIONS)),
        ["PROJ-3"],
        "the card names this ticket",
    );
});

test("an error line passes alone, compared without its numbers, ids and times", () => {
    const cards = index({
        ...filler,
        "PROJ-1": { errors: ["ERROR order 4411 failed: connection reset by peer"] },
    });
    const matches = recall(cards, query("[10:00:01] ERROR order 9 failed: connection reset by peer"), OPTIONS);
    assert.deepEqual(tickets(matches), ["PROJ-1"]);
    assert.match(reason(matches[0] as Match), /same error "ERROR order 9 failed: connection reset by peer"/);
});

test("one rare word is not enough, five are", () => {
    const cards = index({
        ...filler,
        "PROJ-1": {
            problem: "Reports export stalls behind the nightly warehouse sync.",
            cause: "A lock.",
            fix: "Release it.",
        },
    });
    assert.deepEqual(recall(cards, query("the warehouse is down"), OPTIONS), []);
    const matches = recall(cards, query("reports export stalls behind the nightly warehouse sync"), OPTIONS);
    assert.deepEqual(tickets(matches), ["PROJ-1"]);
    assert.match(reason(matches[0] as Match), /^words: /);
});

test("the words a reason shows are the query's own, at most three", () => {
    const cards = index({
        ...filler,
        "PROJ-1": { problem: "Reports export stalls behind the nightly warehouse sync schedule." },
    });
    const [match] = recall(
        cards,
        query("Reports exports stalled behind the nightly warehouse syncing schedules"),
        OPTIONS,
    );
    assert.equal(match?.words.length, 3);
    for (const word of match?.words ?? [])
        assert.match(word, /^(reports|exports|stalled|behind|nightly|warehouse|syncing|schedules)$/);
});

test("the score adds shared names and words, best first, and tied cards come in key order", () => {
    const cards = index({
        ...filler,
        "PROJ-2": { identifiers: ["PaymentWorker"] },
        "PROJ-1": { identifiers: ["PaymentWorker", "RetryPolicy"] },
        "PROJ-3": { identifiers: ["PaymentWorker"] },
    });
    const matches = recall(cards, query("PaymentWorker ignores RetryPolicy"), { max: 10, minScore: 0.1 });
    assert.deepEqual(tickets(matches).slice(0, 3), ["PROJ-1", "PROJ-2", "PROJ-3"]);
    assert.ok((matches[0]?.score ?? 0) > (matches[1]?.score ?? 0));
    assert.equal(matches[1]?.score, matches[2]?.score);
});

test("no more than max cards come back, and a card under minScore stays out", () => {
    const cards = index({
        ...filler,
        "PROJ-1": { keys: ["PROJ-9"] },
        "PROJ-2": { keys: ["PROJ-9"] },
        "PROJ-3": { keys: ["PROJ-9"] },
        "PROJ-4": { keys: ["PROJ-9"] },
    });
    assert.equal(recall(cards, query("PROJ-9"), { max: 2, minScore: 2.5 }).length, 2);
    assert.equal(recall(cards, query("PROJ-9"), { max: 10, minScore: 7 }).length, 0, "one key is 6 points");
});

test("the points of each kind are capped, so a long list of shared names cannot outweigh a key", () => {
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"].map(
        (word) => `Shared${word}Name`,
    );
    const cards = index({ ...filler, "PROJ-1": { identifiers: names, keys: [] }, "PROJ-2": { keys: ["PROJ-9"] } });
    const [first] = recall(cards, query(`${names.join(" ")} PROJ-9`), OPTIONS);
    assert.equal(first?.ticket, "PROJ-1");
    assert.ok((first?.score ?? 0) <= COUNTED.identifiers * POINTS.identifier + 5 + 1e-9);
});

test("the ticket's own card, an invalid card and an empty index are never returned", () => {
    const cards = index({ "PROJ-1": { identifiers: ["OrderService"] }, "PROJ-2": { identifiers: ["OrderService"] } });
    const [valid] = Object.values(cards);
    assert.deepEqual(tickets(recall(cards, query("OrderService", { ticket: "PROJ-1" }), { max: 5, minScore: 0.1 })), [
        "PROJ-2",
    ]);
    if (valid !== undefined) cards["PROJ-2"] = { ...valid, valid: false };
    assert.deepEqual(
        recall(cards, query("OrderService"), { max: 5, minScore: 0.1 }).map((match) => match.ticket),
        ["PROJ-1"],
    );
    assert.deepEqual(recall({}, query("OrderService"), OPTIONS), []);
});

test("a query with nothing in it matches nothing", () => {
    assert.deepEqual(recall(index({ "PROJ-1": { identifiers: ["OrderService"] } }), query(""), OPTIONS), []);
});

test("the query reads keys, identifiers, error lines and words; a key is not a word", () => {
    const q = query("PROJ-130: handlePayment fails\nERROR 502 on /orders/12 for NullPointerException", {
        ticket: "PROJ-130",
    });
    assert.deepEqual(q.keys, ["PROJ-130"]);
    assert.deepEqual(q.identifiers, ["NullPointerException", "handlePayment", "502 /orders/{id}"]);
    assert.deepEqual(q.errors, ["ERROR 502 on /orders/12 for NullPointerException"]);
    assert.equal(q.roots.has("proj"), false);
    assert.equal(q.roots.get("payment"), "payment");
});

test("the headings and labels every ticket's notes share are not words", () => {
    const notes =
        "# PROJ-1\n\n## Now\nStatus: found the lock\nNext:\nOpen questions:\n(older lines moved to history/x.md)\n\n## Decisions\n";
    assert.equal(notesText(notes).replace(/\s+/g, " ").trim(), "found the lock");
});

test("the message gives the ticket, why it matched, and its Cause and Fix", () => {
    const match: Match = {
        ticket: "PROJ-88",
        score: 4,
        names: ["OrderService", "NullPointerException"],
        error: undefined,
        words: [],
        cause: "The mapper read a null.",
        fix: "Check for null.",
    };
    assert.equal(
        recallMessage("PROJ-130", "/data/tickets", [match]),
        "[recall PROJ-130] 1 earlier ticket may relate. Cards: /data/tickets/<KEY>/card.md. They are hints: check them against this ticket before relying on them.\n\n" +
            "PROJ-88: shares OrderService, NullPointerException\n  Cause: The mapper read a null.\n  Fix: Check for null.",
    );
    assert.match(
        recallMessage("PROJ-130", "/data/tickets", [match, { ...match, ticket: "PROJ-9" }]),
        /^\[recall PROJ-130\] 2 earlier tickets may relate\./,
    );
    assert.match(formatMatches([match, match]), /\n\nPROJ-88: shares/);
});

test("a reason with an error line cuts it, and a reason with all three kinds joins them", () => {
    const match: Match = {
        ticket: "PROJ-1",
        score: 9,
        names: ["PROJ-9", "OrderService"],
        error: `ERROR ${"x".repeat(100)}`,
        words: ["retry", "queue"],
        cause: "",
        fix: "",
    };
    assert.equal(
        reason(match),
        `shares PROJ-9, OrderService; same error "ERROR ${"x".repeat(54)}..."; words: retry, queue`,
    );
});
