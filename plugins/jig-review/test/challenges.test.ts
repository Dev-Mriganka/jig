import assert from "node:assert/strict";
import { test } from "node:test";
import { CHALLENGE_BYTES, CHALLENGE_TTL_MS, ChallengeBook } from "../src/passkey/challenges.ts";

test("a challenge is 32 random bytes, different every time, good for two minutes", () => {
    assert.equal(CHALLENGE_BYTES, 32);
    assert.equal(CHALLENGE_TTL_MS, 120_000);
    const book = new ChallengeBook<string>();
    const a = book.issue("approve", "one");
    const b = book.issue("approve", "two");
    assert.equal(a.value.length, 32);
    assert.notDeepEqual(a.value, b.value);
});

test("a challenge answers once: the second use finds nothing", () => {
    const book = new ChallengeBook<string>();
    const issued = book.issue("approve", "review-1");
    assert.equal(book.take("approve", issued.value)?.context, "review-1");
    assert.equal(book.take("approve", issued.value), undefined, "reused");
    assert.equal(book.size, 0);
});

test("a challenge that was never issued finds nothing", () => {
    const book = new ChallengeBook<string>();
    book.issue("approve", "x");
    assert.equal(book.take("approve", Buffer.alloc(32, 7)), undefined);
    assert.equal(book.size, 1, "a guess burns nothing that was issued");
});

test("a challenge expires after two minutes", () => {
    let now = 1_000_000;
    const book = new ChallengeBook<string>(() => now);
    const fresh = book.issue("approve", "x");
    now += CHALLENGE_TTL_MS - 1;
    assert.ok(book.take("approve", fresh.value), "still good just before");
    const late = book.issue("approve", "y");
    now += CHALLENGE_TTL_MS;
    assert.equal(book.take("approve", late.value), undefined, "expired at two minutes");
    assert.equal(book.size, 0, "and used up");
});

test("a challenge belongs to its purpose: a registration challenge cannot approve, and the attempt burns it", () => {
    const book = new ChallengeBook<undefined>();
    const registration = book.issue("register", undefined);
    assert.equal(book.take("approve", registration.value), undefined);
    assert.equal(book.take("register", registration.value), undefined, "burnt by the wrong-purpose attempt");
});

test("asking again and again cannot make the book grow without bound; the oldest goes first", () => {
    const book = new ChallengeBook<number>();
    const first = book.issue("approve", 0);
    for (let i = 1; i < 100; i++) book.issue("approve", i);
    assert.ok(book.size <= 16);
    assert.equal(book.take("approve", first.value), undefined, "the oldest was dropped");
});

test("clearing forgets everything", () => {
    const book = new ChallengeBook<number>();
    const issued = book.issue("approve", 0);
    book.clear();
    assert.equal(book.take("approve", issued.value), undefined);
});
