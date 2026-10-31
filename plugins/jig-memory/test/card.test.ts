import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type CardFront,
    checkCard,
    draftCard,
    isValid,
    PLACEHOLDER,
    parseFront,
    renderCard,
    SECTION_LIMIT,
} from "../src/card.ts";

const FRONT: CardFront = {
    ticket: "PROJ-123",
    closedAt: "2026-10-31T10:15:00.000Z",
    repositories: ["orders-api"],
    keys: ["PROJ-98"],
    identifiers: ["OrderService", "500 /orders/{id}/cancel"],
    errors: ['NullPointerException: customer is "null"'],
};

const SECTIONS = {
    Problem: "Cancelling an order with no customer returned 500.",
    Cause: "OrderMapper.toDto read the customer's name without a null check.",
    Fix: "The mapper returns an empty name when the customer is missing.",
};

test("a card is front matter and three sections, and it reads back as it was written", () => {
    const text = renderCard(FRONT, SECTIONS);
    assert.match(
        text,
        /^---\nticket: "PROJ-123"\nclosedAt: "2026-10-31T10:15:00\.000Z"\nrepositories:\n {2}- "orders-api"\n/,
    );
    assert.match(text, /\n## Problem\nCancelling an order[^\n]*\n\n## Cause\n/);
    const checked = checkCard(text);
    assert.deepEqual(checked.problems, []);
    assert.deepEqual(checked.front, FRONT);
    assert.deepEqual(checked.sections, SECTIONS);
    assert.equal(isValid(checked, "PROJ-123"), true);
});

test("empty lists are written as [] and read back as empty", () => {
    const text = renderCard({ ...FRONT, repositories: [], keys: [], identifiers: [], errors: [] }, SECTIONS);
    assert.match(text, /^repositories: \[\]$/m);
    assert.deepEqual(parseFront(text)?.front.keys, []);
});

test("a draft has the front matter filled and each section marked as not filled yet", () => {
    const checked = checkCard(draftCard(FRONT));
    assert.deepEqual(checked.front, FRONT);
    assert.deepEqual(checked.problems, [
        `The section Problem still says ${PLACEHOLDER}: replace it.`,
        `The section Cause still says ${PLACEHOLDER}: replace it.`,
        `The section Fix still says ${PLACEHOLDER}: replace it.`,
    ]);
});

test("a section that is missing, empty or over the limit is named, with what to change", () => {
    const text = [
        `---\nticket: "PROJ-123"\nclosedAt: "2026-10-31T10:15:00.000Z"\n---\n`,
        "## Problem\n\n",
        `## Cause\n${"x".repeat(SECTION_LIMIT + 1)}\n`,
    ].join("\n");
    const { problems } = checkCard(text);
    assert.deepEqual(problems, [
        "The section Problem is empty: write it from the notes.",
        `The section Cause has ${SECTION_LIMIT + 1} characters, and the limit is ${SECTION_LIMIT}: shorten it.`,
        'The section Fix is missing: add "## Fix" and its text.',
    ]);
});

test("exactly 400 characters is allowed, counted in characters and not in bytes", () => {
    const sections = { ...SECTIONS, Cause: "é".repeat(SECTION_LIMIT) };
    assert.deepEqual(checkCard(renderCard(FRONT, sections)).problems, []);
});

test("another section, a repeated section and text before the first section are named", () => {
    const text = `${renderCard(FRONT, SECTIONS)}\n## Notes\nmore\n\n## Fix\nagain\n`;
    assert.deepEqual(checkCard(text).problems, [
        'The section "Notes" is not one of Problem, Cause, Fix: remove it or rename it.',
        "The section Fix appears twice: keep one.",
    ]);
    const lead = renderCard(FRONT, SECTIONS).replace("\n## Problem", "\nSome intro.\n\n## Problem");
    assert.deepEqual(checkCard(lead).problems, [
        "There is text before the first section: the body is only the three sections.",
    ]);
});

test("front matter that is missing or lacks a ticket is not usable, and the card is not valid", () => {
    const body = "## Problem\na\n\n## Cause\nb\n\n## Fix\nc\n";
    const none = checkCard(body);
    assert.equal(none.front, undefined);
    assert.deepEqual(none.problems, [], "the sections are fine");
    assert.equal(isValid(none, "PROJ-123"), false);
    assert.equal(parseFront(`---\nclosedAt: "x"\n---\n${body}`), undefined);
    assert.equal(parseFront(`---\nticket: "PROJ-123"\n${body}`), undefined, "never closed");
});

test("a card for another ticket than its folder's is not valid", () => {
    assert.equal(isValid(checkCard(renderCard(FRONT, SECTIONS)), "PROJ-999"), false);
});

test("plain YAML values and Windows line ends are read too", () => {
    const text = `---\r\nticket: PROJ-7\r\nclosedAt: 2026-10-31\r\nkeys: ["PROJ-1", 3, ""]\r\n---\r\n## Problem\r\na\r\n## Cause\r\nb\r\n## Fix\r\nc\r\n`;
    const checked = checkCard(text);
    assert.equal(checked.front?.ticket, "PROJ-7");
    assert.equal(checked.front?.closedAt, "2026-10-31");
    assert.deepEqual(checked.front?.keys, ["PROJ-1"], "what is not text is dropped");
    assert.deepEqual(checked.problems, []);
});

test("a list is cut to the length a card keeps, so a hand-made card cannot fill the index", () => {
    const errors = Array.from({ length: 30 }, (_, n) => `  - "${"e".repeat(300)}${n}"`).join("\n");
    const front = parseFront(`---\nticket: "PROJ-1"\nclosedAt: "t"\nerrors:\n${errors}\n---\n`)?.front;
    assert.equal(front?.errors.length, 10);
    assert.equal(front?.errors[0]?.length, 160);
});
