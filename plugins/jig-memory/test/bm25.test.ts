import assert from "node:assert/strict";
import { test } from "node:test";
import { bm25, corpusOf, countTerms, type Doc, rarity, stem, tokenize, words } from "../src/bm25.ts";

test("endings that tickets vary are cut, so related forms meet", () => {
    const same = [
        ["timeout", "timeouts"],
        ["queue", "queued", "queues", "queueing"],
        ["map", "mapped", "mapping", "maps"],
        ["fail", "failed", "failing"],
        ["process", "processing", "processes"],
        ["retry", "retries", "retrying"],
        ["migrate", "migrated", "migrating"],
        ["timezone", "timezones"],
        ["cancel", "cancelled", "cancelling"],
        ["install", "installed", "installing"],
    ];
    for (const group of same) assert.equal(new Set(group.map(stem)).size, 1, group.join(", "));
});

test("words that must stay apart do", () => {
    assert.notEqual(stem("process"), stem("proc"));
    assert.equal(stem("status"), "status");
    assert.equal(stem("class"), "class");
    assert.equal(stem("analysis"), "analysis");
    assert.equal(stem("spring"), "spring");
    assert.equal(stem("string"), "string");
});

test("common words, short words and numbers are not searched; the rest is lower case roots", () => {
    assert.deepEqual(tokenize("The orders were failing, and it is 502 in the API"), ["order", "fail", "api"]);
});

test("a CamelCase name counts whole and in its parts, and keeps its spelling for display", () => {
    assert.deepEqual(
        words("OrderService retries").map((word) => [word.term, word.word]),
        [
            ["orderservic", "orderservice"],
            ["order", "order"],
            ["servic", "service"],
            ["retry", "retries"],
        ],
    );
});

test("an underscore, a dash or a dot separates words", () => {
    assert.deepEqual(tokenize("max_retry_count orders-api spring.datasource.url"), [
        "max",
        "retry",
        "count",
        "order",
        "api",
        "spring",
        "datasourc",
        "url",
    ]);
});

test("terms are counted, and a word like constructor is an ordinary word", () => {
    const counts = countTerms(["a", "b", "a", "constructor"]);
    assert.deepEqual({ ...counts }, { a: 2, b: 1, constructor: 1 });
});

test("rarity is 1 for what one card has, falls as more cards have it, and does not depend on how many cards there are", () => {
    assert.equal(rarity(1, 10), 1);
    assert.equal(rarity(1, 1000), 1);
    assert.ok(rarity(5, 10) < rarity(2, 10));
    assert.ok(rarity(10, 10) < 0.1);
    assert.ok(rarity(500, 1000) < 0.15);
    assert.ok(Math.abs(rarity(50, 1000) - 0.46) < 0.02);
    assert.equal(rarity(1, 0), 0);
    assert.equal(rarity(0, 5), 1, "never more than one card short of the rarest");
});

const doc = (text: string): Doc => {
    const terms = tokenize(text);
    return { length: terms.length, terms: countTerms(terms) };
};

test("a card scores for the rare words it shares, and not for words every card has", () => {
    const docs = [
        doc("export fails when the report has a null currency"),
        doc("export fails when the queue is full"),
        doc("export fails after the migration"),
    ];
    const corpus = corpusOf(docs);
    const query = tokenize("export fails with a null currency");
    const [first, second, third] = docs.map((d) => bm25(query, d, corpus));
    assert.ok((first?.score ?? 0) > (second?.score ?? 0));
    assert.ok((first?.score ?? 0) > (third?.score ?? 0));
    assert.ok((first?.shares.get("null") ?? 0) > (first?.shares.get("export") ?? 1), "null is rarer than export");
});

test("a word counted three times is worth more than once, but not three times as much", () => {
    const corpus = corpusOf([doc("timeout"), doc("other"), doc("another thing")]);
    const once = bm25(["timeout"], { length: 1, terms: { timeout: 1 } }, corpus).score;
    const thrice = bm25(["timeout"], { length: 1, terms: { timeout: 3 } }, corpus).score;
    assert.ok(thrice > once && thrice < 3 * once);
});

test("a long card scores lower than a short one for the same word", () => {
    const corpus = corpusOf([doc("a b c d"), doc("timeout")]);
    const short = bm25(["timeout"], { length: 4, terms: { timeout: 1 } }, corpus).score;
    const long = bm25(["timeout"], { length: 40, terms: { timeout: 1 } }, corpus).score;
    assert.ok(long < short);
});

test("a query of repeated words counts each once, and an empty corpus scores nothing", () => {
    const corpus = corpusOf([doc("timeout")]);
    assert.equal(
        bm25(["timeout", "timeout"], doc("timeout"), corpus).score,
        bm25(["timeout"], doc("timeout"), corpus).score,
    );
    assert.equal(corpusOf([]).size, 0);
    assert.equal(bm25(["x"], { length: 0, terms: {} }, corpusOf([])).score, 0);
});

test("a word named like a member of Object is not found in a card that lacks it", () => {
    const parsed: Doc = JSON.parse('{"length":3,"terms":{"timeout":1}}');
    const corpus = corpusOf([parsed]);
    assert.equal(bm25(["constructor", "tostring", "hasownproperty"], parsed, corpus).score, 0);
    assert.ok(bm25(["timeout"], parsed, corpus).score > 0);
});
