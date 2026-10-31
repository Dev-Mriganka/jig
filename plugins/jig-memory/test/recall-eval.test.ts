// The recall test: invented cards and queries, and how well recall finds the right cards. It measures two things with the
// default settings (3 cards at most, minScore 2): recall at 3, the share of the cards a query should find that come back, and
// precision, the share of the cards that come back that a query should find. The floors guard against a change to the scoring
// that makes it worse. They come from the first honest run (docs/recall.md), and they say nothing about real tickets.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadCards } from "../src/cards.ts";
import { RECALL_DEFAULTS, ticketRegex } from "../src/config.ts";
import { buildQuery, recall, reason } from "../src/recall.ts";
import { PATTERN, tempFolder } from "./support.ts";

const DIR = path.join(import.meta.dirname, "recall-eval");

/** Recall at 3 and precision may not fall below these. */
const RECALL_FLOOR = 0.85;
const PRECISION_FLOOR = 0.88;

interface EvalQuery {
    id: string;
    ticket: string;
    kind: string;
    text: string;
    expect: string[];
}

const queries = JSON.parse(readFileSync(path.join(DIR, "queries.json"), "utf8")) as EvalQuery[];
const cardFiles = readdirSync(path.join(DIR, "cards")).filter((name) => name.endsWith(".md"));

/** The cards copied where the plugin keeps them: <folder>/<KEY>/card.md. */
function folderWithCards(t: Parameters<typeof tempFolder>[0]): string {
    const folder = tempFolder(t);
    for (const name of cardFiles) {
        const key = name.slice(0, -".md".length);
        mkdirSync(path.join(folder, key));
        cpSync(path.join(DIR, "cards", name), path.join(folder, key, "card.md"));
    }
    return folder;
}

test("the recall test has 20 to 30 cards, all valid, and at least 10 queries that name cards that exist", (t) => {
    const cards = loadCards(folderWithCards(t));
    assert.ok(cardFiles.length >= 20 && cardFiles.length <= 30, `${cardFiles.length} cards`);
    for (const [key, card] of Object.entries(cards)) assert.equal(card.valid, true, `${key} is not a valid card`);
    assert.equal(Object.keys(cards).length, cardFiles.length);
    assert.ok(queries.length >= 10, `${queries.length} queries`);
    for (const query of queries) {
        for (const key of query.expect) assert.ok(key in cards, `${query.id} expects ${key}, which is not a card`);
        assert.equal(cards[query.ticket], undefined, `${query.id} is a ticket that already has a card`);
    }
    assert.ok(
        queries.some((query) => query.expect.length === 0),
        "some queries have no card to find",
    );
});

test("recall at 3 and precision stay above their floors", (t) => {
    const cards = loadCards(folderWithCards(t));
    const pattern = ticketRegex({ ticketPattern: PATTERN });
    let expected = 0;
    let returned = 0;
    let hits = 0;
    let silentOnNone = 0;
    let none = 0;
    for (const query of queries) {
        const matches = recall(cards, buildQuery({ ticket: query.ticket, text: query.text, pattern }), {
            max: RECALL_DEFAULTS.max,
            minScore: RECALL_DEFAULTS.minScore,
        });
        const found = matches.filter((match) => query.expect.includes(match.ticket));
        expected += query.expect.length;
        returned += matches.length;
        hits += found.length;
        if (query.expect.length === 0) {
            none++;
            if (matches.length === 0) silentOnNone++;
        }
        const mark = found.length === query.expect.length && found.length === matches.length ? "ok  " : "MISS";
        t.diagnostic(
            `${mark} ${query.id} [${query.kind}] expects ${query.expect.join(" ") || "nothing"}; got ${
                matches.map((match) => `${match.ticket} ${match.score} (${reason(match)})`).join(" | ") || "nothing"
            }`,
        );
    }
    const recallAt3 = hits / expected;
    const precision = returned === 0 ? 1 : hits / returned;
    t.diagnostic(
        `recall at 3: ${hits} of ${expected} expected cards = ${recallAt3.toFixed(3)}; precision: ${hits} of ${returned} returned = ${precision.toFixed(3)}; silent on ${silentOnNone} of ${none} queries with no card`,
    );
    assert.ok(recallAt3 >= RECALL_FLOOR, `recall at 3 is ${recallAt3.toFixed(3)}, the floor is ${RECALL_FLOOR}`);
    assert.ok(precision >= PRECISION_FLOOR, `precision is ${precision.toFixed(3)}, the floor is ${PRECISION_FLOOR}`);
});
