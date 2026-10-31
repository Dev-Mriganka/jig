import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type CardFront, draftCard, renderCard } from "../src/card.ts";
import { INDEX_VERSION, entryOf, indexFile, loadCards } from "../src/cards.ts";
import { ticketPaths } from "../src/store.ts";
import { tempFolder } from "./support.ts";

const front = (ticket: string, extra: Partial<CardFront> = {}): CardFront => ({
    ticket,
    closedAt: "2026-10-31T10:15:00.000Z",
    repositories: ["orders-api"],
    keys: [],
    identifiers: ["OrderService"],
    errors: ["ERROR order 41 failed: NullPointerException"],
    ...extra,
});
const SECTIONS = {
    Problem: "Cancelling an order with no customer returned 500.",
    Cause: "The mapper read the customer's name without a null check.",
    Fix: "The mapper returns an empty name when the customer is missing.",
};

/** Writes a valid card for `ticket` into the folder, and returns its path. */
function writeCard(folder: string, ticket: string, extra: Partial<CardFront> = {}, sections = SECTIONS): string {
    const file = ticketPaths(folder, ticket).card;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, renderCard(front(ticket, extra), sections));
    return file;
}

const stamp = { mtimeMs: 1, size: 2 };

test("a valid card becomes an entry with its keys, identifiers, compared error lines, Cause, Fix and term counts", () => {
    const text = renderCard(front("PROJ-1", { keys: ["PROJ-9"] }), SECTIONS);
    const entry = entryOf("PROJ-1", text, stamp);
    assert.equal(entry.valid, true);
    assert.deepEqual(entry.keys, ["PROJ-9"]);
    assert.deepEqual(entry.identifiers, ["OrderService"]);
    assert.deepEqual(entry.errors, ["error order <n> failed: nullpointerexception"]);
    assert.equal(entry.cause, SECTIONS.Cause);
    assert.equal(entry.fix, SECTIONS.Fix);
    assert.equal(entry.terms.null, 1);
    assert.equal(entry.terms.order, 2, "the problem and the repository name orders-api");
    assert.equal(entry.terms.customer, 3, "the problem, the cause and the fix");
    assert.equal(
        entry.length,
        Object.values(entry.terms).reduce((sum, count) => sum + count, 0),
    );
});

test("a card that fails the check, or belongs to another ticket, is an entry with no content", () => {
    for (const text of [draftCard(front("PROJ-1")), renderCard(front("PROJ-2"), SECTIONS), "", "not a card"]) {
        const entry = entryOf("PROJ-1", text, stamp);
        assert.equal(entry.valid, false);
        assert.deepEqual([entry.keys, entry.identifiers, entry.errors, entry.length], [[], [], [], 0]);
    }
});

test("the index lists the valid cards of the folder and is written to .cards.json at 0600", (t) => {
    const folder = tempFolder(t);
    writeCard(folder, "PROJ-1");
    writeCard(folder, "PROJ-2", { identifiers: ["PaymentWorker"] });
    mkdirSync(ticketPaths(folder, "PROJ-3").dir, { recursive: true });
    writeFileSync(ticketPaths(folder, "PROJ-3").card, draftCard(front("PROJ-3")));
    mkdirSync(path.join(folder, "PROJ-4"));
    const cards = loadCards(folder);
    assert.deepEqual(Object.keys(cards).sort(), ["PROJ-1", "PROJ-2", "PROJ-3"]);
    assert.equal(cards["PROJ-3"]?.valid, false);
    assert.deepEqual(cards["PROJ-2"]?.identifiers, ["PaymentWorker"]);
    const onDisk = JSON.parse(readFileSync(indexFile(folder), "utf8")) as { version: number; cards: object };
    assert.equal(onDisk.version, INDEX_VERSION);
    assert.deepEqual(Object.keys(onDisk.cards).sort(), ["PROJ-1", "PROJ-2", "PROJ-3"]);
    assert.equal(statSync(indexFile(folder)).mode & 0o777, 0o600);
});

test("an unchanged card is not read again, a changed one is, and a removed one is dropped", (t) => {
    const folder = tempFolder(t);
    const one = writeCard(folder, "PROJ-1");
    writeCard(folder, "PROJ-2");
    loadCards(folder);
    // Marking the stored entries shows which ones the next load reads again: a re-read replaces the mark.
    const marked = JSON.parse(readFileSync(indexFile(folder), "utf8")) as { cards: Record<string, { cause: string }> };
    for (const entry of Object.values(marked.cards)) entry.cause = "MARK";
    writeFileSync(indexFile(folder), JSON.stringify(marked));

    writeFileSync(one, renderCard(front("PROJ-1"), { ...SECTIONS, Cause: "A different cause altogether." }));
    const cards = loadCards(folder);
    assert.equal(cards["PROJ-2"]?.cause, "MARK", "untouched, so the entry came from the index");
    assert.equal(cards["PROJ-1"]?.cause, "A different cause altogether.");

    writeFileSync(ticketPaths(folder, "PROJ-2").card, "");
    writeFileSync(ticketPaths(folder, "PROJ-2").card, "x");
    assert.equal(loadCards(folder)["PROJ-2"]?.valid, false, "its size changed");
    writeFileSync(path.join(folder, "PROJ-2", "card.md"), renderCard(front("PROJ-2"), SECTIONS));
    utimesSync(path.join(folder, "PROJ-2", "card.md"), new Date(), new Date(Date.now() + 5000));
    assert.equal(loadCards(folder)["PROJ-2"]?.valid, true, "its time changed");
});

test("a card whose size stays the same but whose time moves is read again", (t) => {
    const folder = tempFolder(t);
    const file = writeCard(folder, "PROJ-1");
    loadCards(folder);
    const text = readFileSync(file, "utf8").replace("customer's name", "customer's NAME");
    writeFileSync(file, text);
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.match(loadCards(folder)["PROJ-1"]?.cause ?? "", /NAME/);
});

test("a deleted card leaves the index, and the file is written again without it", (t) => {
    const folder = tempFolder(t);
    writeCard(folder, "PROJ-1");
    writeCard(folder, "PROJ-2");
    loadCards(folder);
    rmSync(ticketPaths(folder, "PROJ-2").dir, { recursive: true });
    assert.deepEqual(Object.keys(loadCards(folder)), ["PROJ-1"]);
    const onDisk = JSON.parse(readFileSync(indexFile(folder), "utf8")) as { cards: object };
    assert.deepEqual(Object.keys(onDisk.cards), ["PROJ-1"]);
});

test("a missing, damaged or foreign index is rebuilt from the cards", (t) => {
    const folder = tempFolder(t);
    writeCard(folder, "PROJ-1");
    for (const content of [
        "",
        "{not json",
        '{"version":99,"cards":{}}',
        '{"version":1,"cards":{"PROJ-1":{"mtimeMs":"x"}}}',
    ]) {
        writeFileSync(indexFile(folder), content);
        const cards = loadCards(folder);
        assert.equal(cards["PROJ-1"]?.valid, true, content);
        const again = JSON.parse(readFileSync(indexFile(folder), "utf8")) as { version: number };
        assert.equal(again.version, INDEX_VERSION, content);
    }
});

test("a folder that does not exist, or cannot take the index file, has no cards or still gives the cards", (t) => {
    const folder = tempFolder(t);
    assert.deepEqual(loadCards(path.join(folder, "nowhere")), {});
    writeCard(folder, "PROJ-1");
    mkdirSync(indexFile(folder));
    assert.equal(loadCards(folder)["PROJ-1"]?.valid, true, "the index could not be written, the card was still read");
});

test("1,000 cards are indexed once and then loaded from the index, both fast", (t) => {
    const folder = tempFolder(t);
    for (let n = 1; n <= 1000; n++) {
        writeCard(
            folder,
            `GEN-${n}`,
            { identifiers: [`Thing${n}Service`, "SharedClient"], errors: [`ERROR generated failure number ${n}`] },
            {
                Problem: `Generated problem ${n}: the batch ${n % 17} stalls when the queue holds ${n % 91} items for worker${n % 13}.`,
                Cause: `The retry loop of Thing${n}Service waits on a lock that the cleanup job ${n % 29} keeps.`,
                Fix: `Release the lock before the cleanup job ${n % 29} starts and add a test for batch ${n % 17}.`,
            },
        );
    }
    let started = performance.now();
    const built = loadCards(folder);
    const cold = performance.now() - started;
    assert.equal(Object.keys(built).length, 1000);
    started = performance.now();
    const loaded = loadCards(folder);
    const warm = performance.now() - started;
    assert.equal(Object.keys(loaded).length, 1000);
    t.diagnostic(
        `1,000 cards: built in ${cold.toFixed(0)} ms, loaded in ${warm.toFixed(0)} ms, index ${(statSync(indexFile(folder)).size / 1024).toFixed(0)} KB`,
    );
    assert.ok(cold < 10_000, `building took ${cold} ms`);
    assert.ok(warm < 1_000, `loading took ${warm} ms`);
});
