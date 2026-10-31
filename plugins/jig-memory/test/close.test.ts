import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type CardFront, checkCard, draftCard, PLACEHOLDER, renderCard, SECTION_LIMIT } from "../src/card.ts";
import {
    CARD_FIX,
    CARD_REQUEST,
    correctionText,
    draftClose,
    NothingToClose,
    requestText,
    verifyCard,
} from "../src/close.ts";
import { ticketPaths } from "../src/store.ts";
import { ensureTicket } from "../src/store.ts";
import { changed, loadPlugin, PATTERN, tempFolder, useJig } from "./support.ts";

const read = (file: string) => readFileSync(file, "utf8");
const NOW = new Date("2026-10-31T10:15:00.000Z");
const SECTIONS = {
    Problem: "Cancelling an order with no customer returned 500.",
    Cause: "OrderMapper.toDto read the customer's name without a null check.",
    Fix: "The mapper returns an empty name when the customer is missing.",
};

function ticketWithNotes(folder: string, key = "PROJ-1"): ReturnType<typeof ticketPaths> {
    ensureTicket(folder, key);
    const paths = ticketPaths(folder, key);
    writeFileSync(paths.notes, `# ${key}\n\n## Now\nStatus: found it in OrderMapper\n`);
    return paths;
}

test("drafting a close writes the card with the front matter filled and placeholders in the sections", (t) => {
    const folder = tempFolder(t);
    const paths = ticketWithNotes(folder);
    const closing = draftClose(folder, "PROJ-1", undefined, NOW);
    assert.equal(read(paths.card), draftCard(closing.front));
    assert.deepEqual(closing.front.identifiers, ["OrderMapper"]);
    assert.equal(closing.corrected, false);
});

test("a ticket that is still the template has nothing to close", (t) => {
    const folder = tempFolder(t);
    ensureTicket(folder, "PROJ-1");
    assert.throws(() => draftClose(folder, "PROJ-1", undefined, NOW), NothingToClose);
    assert.equal(existsSync(ticketPaths(folder, "PROJ-1").card), false);
});

test("closing again replaces the card with a new draft", (t) => {
    const folder = tempFolder(t);
    const paths = ticketWithNotes(folder);
    const first = draftClose(folder, "PROJ-1", undefined, NOW);
    writeFileSync(paths.card, renderCard(first.front, SECTIONS));
    writeFileSync(paths.notes, "# PROJ-1\n\nNow it is PaymentWorker too.\n");
    const second = draftClose(folder, "PROJ-1", undefined, new Date("2026-11-02T08:00:00.000Z"));
    assert.deepEqual(second.front.identifiers, ["PaymentWorker"]);
    assert.match(read(paths.card), /closedAt: "2026-11-02T08:00:00\.000Z"/);
    assert.match(read(paths.card), new RegExp(`## Problem\\n${PLACEHOLDER.replace(/[()]/g, "\\$&")}`));
});

test("the request names the card, the notes and the limits; the correction lists what to change", (t) => {
    const folder = tempFolder(t);
    const paths = ticketPaths(folder, "PROJ-1");
    const request = requestText(folder, "PROJ-1");
    assert.match(request, /^\[ticket PROJ-1\] Closing the ticket\./);
    for (const text of [paths.card, paths.notes, "## Problem", "## Cause", "## Fix", `${SECTION_LIMIT} characters`]) {
        assert.ok(request.includes(text), text);
    }
    assert.equal(
        correctionText(folder, "PROJ-1", ["a.", "b."])
            .split("\n")
            .filter((line) => line.startsWith("- ")).length,
        2,
    );
});

test("verifying: a filled card passes, an unfilled one lists its problems, a missing one says so", (t) => {
    const folder = tempFolder(t);
    const paths = ticketWithNotes(folder);
    const closing = draftClose(folder, "PROJ-1", undefined, NOW);
    assert.equal(verifyCard(folder, closing).ok, false);
    assert.equal(verifyCard(folder, closing).problems.length, 3);
    writeFileSync(paths.card, renderCard(closing.front, SECTIONS));
    assert.deepEqual(verifyCard(folder, closing), { ok: true, problems: [] });
    writeFileSync(paths.card, "");
    assert.match(verifyCard(folder, closing).problems[0] ?? "", /missing/);
});

test("front matter the agent damaged is written back from the draft when the sections are fine", (t) => {
    const folder = tempFolder(t);
    const paths = ticketWithNotes(folder);
    const closing = draftClose(folder, "PROJ-1", undefined, NOW);
    writeFileSync(paths.card, `## Problem\na\n\n## Cause\nb\n\n## Fix\nc\n`);
    assert.equal(verifyCard(folder, closing).ok, true);
    const checked = checkCard(read(paths.card));
    assert.deepEqual(checked.front, closing.front);
    assert.deepEqual(checked.sections, { Problem: "a", Cause: "b", Fix: "c" });
});

test("front matter the agent changed but kept readable is left as it is", (t) => {
    const folder = tempFolder(t);
    const paths = ticketWithNotes(folder);
    const closing = draftClose(folder, "PROJ-1", undefined, NOW);
    const front: CardFront = { ...closing.front, identifiers: ["ByHand"] };
    writeFileSync(paths.card, renderCard(front, SECTIONS));
    assert.equal(verifyCard(folder, closing).ok, true);
    assert.deepEqual(checkCard(read(paths.card)).front?.identifiers, ["ByHand"]);
});

// -- Through the session ---------------------------------------------------------------------------------------------

function start(t: Parameters<typeof tempFolder>[0]) {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    return { folder, jig, pi };
}

test("/ticket close drafts the card, sends one follow-up message that starts an idle agent, and says so", async (t) => {
    const { folder, pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "10:00:00 ERROR NullPointerException in OrderMapper", { action: "query" });
    const before = pi.sent.length;
    await pi.command("close");
    const paths = ticketPaths(folder, "PROJ-1");
    assert.equal(pi.sent.length, before + 1);
    const sent = pi.sent.at(-1);
    assert.equal(sent?.message.customType, CARD_REQUEST);
    assert.deepEqual(sent?.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.deepEqual(sent?.message.details, { key: "PROJ-1" });
    assert.match(read(paths.card), /errors:\n {2}- "ERROR NullPointerException in OrderMapper"/);
    assert.equal(pi.notices.at(-1)?.text, `Card for PROJ-1 drafted in ${paths.card}; the agent is asked to fill it.`);
});

test("when the agent has settled and the card is filled, it stays, and the active ticket is closed", async (t) => {
    const { folder, jig, pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "ERROR boom in OrderMapper", { action: "query" });
    await pi.command("close");
    const paths = ticketPaths(folder, "PROJ-1");
    writeFileSync(paths.card, renderCard(checkCard(read(paths.card)).front as CardFront, SECTIONS));
    pi.settle();
    assert.equal(pi.notices.at(-1)?.text, `Ticket PROJ-1 closed. Card: ${paths.card}`);
    assert.deepEqual(jig.tickets, ["PROJ-1", undefined]);
    const index = JSON.parse(readFileSync(path.join(folder, ".cards.json"), "utf8")) as {
        cards: Record<string, { valid: boolean; cause: string }>;
    };
    assert.deepEqual(Object.keys(index.cards), ["PROJ-1"], "the card is in the index at once");
    assert.equal(index.cards["PROJ-1"]?.cause, SECTIONS.Cause);
    assert.equal(pi.sent.length, 2, "notes and the request, and nothing else");
    assert.deepEqual(
        pi.log.filter((entry) => entry.type === "custom").map((entry) => entry.data),
        [{ key: "PROJ-1" }, { key: null }],
    );
    pi.settle();
    assert.equal(pi.sent.length, 2, "a later settle checks nothing");
});

test("a card left unfilled gets one correction message, then a warning and no more messages", async (t) => {
    const { folder, jig, pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "ERROR boom", { action: "query" });
    await pi.command("close");
    pi.settle();
    const fix = pi.sent.at(-1);
    assert.equal(fix?.message.customType, CARD_FIX);
    assert.deepEqual(fix?.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.match(fix?.message.content ?? "", /The section Problem still says \(not filled yet\)/);
    assert.match(pi.notices.at(-1)?.text ?? "", /^The card for PROJ-1 needs changes; the agent is asked once more\./);
    const sent = pi.sent.length;
    pi.settle();
    assert.equal(pi.sent.length, sent, "no second correction");
    assert.equal(pi.notices.at(-1)?.level, "warning");
    assert.match(
        pi.notices.at(-1)?.text ?? "",
        /^The card for PROJ-1 is not complete: .*Fix .*card\.md by hand, or run \/ticket close PROJ-1 again\.$/,
    );
    assert.deepEqual(jig.tickets, ["PROJ-1"], "the ticket stays active");
    assert.ok(existsSync(ticketPaths(folder, "PROJ-1").card), "the card stays on disk");
});

test("a card that is too long is named, corrected, and passes once it is shortened", async (t) => {
    const { folder, pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "ERROR boom", { action: "query" });
    await pi.command("close");
    const paths = ticketPaths(folder, "PROJ-1");
    const front = checkCard(read(paths.card)).front as CardFront;
    writeFileSync(paths.card, renderCard(front, { ...SECTIONS, Cause: "c".repeat(SECTION_LIMIT + 50) }));
    pi.settle();
    assert.match(
        pi.sent.at(-1)?.message.content ?? "",
        /The section Cause has 450 characters, and the limit is 400: shorten it\./,
    );
    writeFileSync(paths.card, renderCard(front, SECTIONS));
    pi.settle();
    assert.match(pi.notices.at(-1)?.text ?? "", /^Ticket PROJ-1 closed\./);
});

test("a run that was aborted gets a warning and no correction", async (t) => {
    const { pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "ERROR boom", { action: "query" });
    await pi.command("close");
    const sent = pi.sent.length;
    pi.settle(true);
    assert.equal(pi.sent.length, sent);
    assert.equal(pi.notices.at(-1)?.level, "warning");
});

test("closing a ticket that is not the active one leaves the active ticket alone", async (t) => {
    const { folder, jig, pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "ERROR first problem", { action: "query" });
    await pi.command("off");
    pi.input("now PROJ-2");
    await pi.command("close PROJ-1");
    const paths = ticketPaths(folder, "PROJ-1");
    writeFileSync(paths.card, renderCard(checkCard(read(paths.card)).front as CardFront, SECTIONS));
    pi.settle();
    assert.equal(pi.notices.at(-1)?.text, `Card for PROJ-1 written: ${paths.card}`);
    assert.deepEqual(jig.tickets, ["PROJ-1", undefined, "PROJ-2"], "PROJ-2 is still active");
});

test("a close with nothing to say, no folder, no ticket or a bad key is refused in words", async (t) => {
    const { folder, pi } = start(t);
    await pi.command("close");
    assert.equal(pi.notices.at(-1)?.text, "No active ticket. Run /ticket close KEY.");
    await pi.command("close PROJ-9");
    assert.equal(pi.notices.at(-1)?.text, `No folder for PROJ-9 in ${folder}: run /ticket PROJ-9 first.`);
    await pi.command("close ../x");
    assert.equal(pi.notices.at(-1)?.text, "Use /ticket close, or /ticket close KEY.");
    await pi.command("close PROJ-1 PROJ-2");
    assert.equal(pi.notices.at(-1)?.text, "Use /ticket close, or /ticket close KEY.");
    pi.input("look at PROJ-1");
    const sent = pi.sent.length;
    await pi.command("close");
    assert.equal(
        pi.notices.at(-1)?.text,
        "PROJ-1 has no notes or saved evidence yet, so there is nothing to put on a card.",
    );
    assert.equal(pi.notices.at(-1)?.level, "warning");
    assert.equal(pi.sent.length, sent);
    assert.equal(existsSync(ticketPaths(folder, "PROJ-1").card), false);
});

test("a reopened ticket closes again with a fresh draft", async (t) => {
    const { folder, jig, pi } = start(t);
    pi.input("look at PROJ-1");
    pi.result("logs", "ERROR first failure", { action: "query" });
    await pi.command("close");
    const paths = ticketPaths(folder, "PROJ-1");
    writeFileSync(paths.card, renderCard(checkCard(read(paths.card)).front as CardFront, SECTIONS));
    pi.settle();
    await pi.command("PROJ-1");
    pi.result("logs", "ERROR second failure", { action: "query" });
    await pi.command("close");
    assert.match(read(paths.card), /## Problem\n\(not filled yet\)/);
    assert.match(read(paths.card), /second failure/);
    assert.deepEqual(jig.tickets, ["PROJ-1", undefined, "PROJ-1"]);
});

test("a tool result without a change, and a settle with no close pending, do nothing", (t) => {
    const { pi } = start(t);
    pi.input("look at PROJ-1");
    assert.equal(changed(pi.result("logs", "ok", { action: "query" })), undefined);
    pi.settle();
    assert.equal(pi.sent.length, 1);
});
