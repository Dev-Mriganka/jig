import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketRegex } from "../src/config.ts";
import {
    countIdentifiers,
    ERROR_LENGTH,
    extractErrors,
    extractIdentifiers,
    extractKeys,
    isErrorLine,
    MAX_ERRORS,
    MAX_IDENTIFIERS,
    MAX_KEYS,
    normalizeError,
} from "../src/extract.ts";
import { PATTERN } from "./support.ts";

const names = (text: string) => [...countIdentifiers(text).keys()];

test("ticket keys are found in order, once each, without the ticket's own", () => {
    const pattern = ticketRegex({ ticketPattern: PATTERN });
    assert.deepEqual(extractKeys(["see PROJ-2 and PROJ-9", "again PROJ-2, PROJ-1, then PROJ-9"], pattern, "PROJ-1"), [
        "PROJ-2",
        "PROJ-9",
    ]);
});

test("a key glued to a letter or digit is not a key", () => {
    const pattern = ticketRegex({ ticketPattern: PATTERN });
    assert.deepEqual(extractKeys(["xPROJ-2 PROJ-3x PROJ-4"], pattern, undefined), ["PROJ-4"]);
});

test("without a pattern anything shaped like ABC-123 is a key, except words such as UTF-8 and SHA-256", () => {
    assert.deepEqual(
        extractKeys(["PROJ-12 in UTF-8, hashed with SHA-256, per RFC-7231 and ACME-3"], undefined, undefined),
        ["PROJ-12", "ACME-3"],
    );
});

test("a pattern given without the g flag still works", () => {
    assert.deepEqual(extractKeys(["PROJ-5 PROJ-6"], /PROJ-\d+/, undefined), ["PROJ-5", "PROJ-6"]);
});

test("a card keeps at most 20 keys", () => {
    const text = Array.from({ length: 40 }, (_, n) => `PROJ-${n + 1}`).join(" ");
    assert.equal(extractKeys([text], undefined, undefined).length, MAX_KEYS);
});

test("class and exception names are identifiers, however deep their package", () => {
    assert.deepEqual(names("java.lang.NullPointerException at OrderService.process, then OrderMapper"), [
        "NullPointerException",
        "OrderService",
        "OrderMapper",
    ]);
});

test("function names: camelCase, and snake_case where it is called", () => {
    assert.deepEqual(names("handlePayment calls getOrderById; process_payment(order) and plain_words are not alike"), [
        "handlePayment",
        "getOrderById",
        "process_payment",
    ]);
});

test("a single word, an acronym, a product name and a random string are not identifiers", () => {
    assert.deepEqual(names("Order HTTP GitHub JavaScript iPhone macOS eyJhbGciOiJIUzI1NiJ9 aB3dE5Fg7H9"), []);
});

test("a status with its path is one identifier, with ids and UUIDs written {id} and no query string", () => {
    assert.deepEqual(names("POST /orders/12345/cancel returned 500"), ["500 /orders/{id}/cancel"]);
    assert.deepEqual(names("GET /customers/3f2504e0-4f89-11d3-9a0c-0305e82c3301/orders?page=2 -> 404"), [
        "404 /customers/{id}/orders",
    ]);
    assert.deepEqual(names("502 on /health"), ["502 /health"]);
});

test("a status far from the path, a path with no status and a plain file path are not identifiers", () => {
    assert.deepEqual(names(`404 ${"x".repeat(60)} /orders`), []);
    assert.deepEqual(names("the page /orders lists open orders"), []);
    assert.deepEqual(names("port 5432 on https://db.example.com/orders"), []);
});

test("config keys: dotted keys given a value, and UPPER_SNAKE names", () => {
    assert.deepEqual(names("spring.datasource.url=jdbc and server.port: 8080, set ORDERS_DB_URL or MAX_RETRY_COUNT"), [
        "ORDERS_DB_URL",
        "MAX_RETRY_COUNT",
        "spring.datasource.url",
        "server.port",
    ]);
});

test("a package, a host name and a file name are not config keys", () => {
    assert.deepEqual(names("com.example.orders api.staging.example.com config.yaml: bad e.g: this"), []);
});

test("identifiers from the notes come first, then those only the evidence has, up to the limit", () => {
    assert.deepEqual(extractIdentifiers("OrderService OrderService OrderMapper", "PaymentWorker OrderMapper"), [
        "OrderService",
        "OrderMapper",
        "PaymentWorker",
    ]);
    const many = Array.from({ length: 80 }, (_, n) => `Thing${String.fromCharCode(65 + (n % 26))}Name${n}`).join(" ");
    assert.equal(extractIdentifiers(many, "").length <= MAX_IDENTIFIERS, true);
});

test("an error line has an error name, Caused by, an upper-case level, or one of a few phrases; a stack frame is not", () => {
    for (const line of [
        "java.lang.NullPointerException: customer is null",
        "TypeError: x is not a function",
        "Caused by: java.net.SocketTimeoutException",
        "2026-10-30 10:00:01 ERROR order 42 rejected",
        "FATAL: password authentication failed",
        "the build failed after 3 minutes",
        "request timed out",
        "Connection refused by host",
        "Permission denied (publickey)",
    ]) {
        assert.equal(isErrorLine(line), true, line);
    }
    for (const line of [
        "",
        "   at com.example.OrderService.process(OrderService.java:42)",
        "INFO order 42 saved",
        "error handling is described below",
    ]) {
        assert.equal(isErrorLine(line), false, line);
    }
});

test("error lines lose their timestamp, are cut to 160 characters, and the most frequent come first", () => {
    const text = [
        "2026-10-30T10:00:01.123Z ERROR order 41 failed: NullPointerException",
        "[10:00:02] WARN retrying",
        "2026-10-30T10:00:03.456Z ERROR order 42 failed: NullPointerException",
        "2026-10-30T10:00:04.000Z ERROR disk is full",
        `ERROR ${"x".repeat(300)}`,
    ].join("\n");
    const lines = extractErrors(text);
    assert.equal(lines[0], "ERROR order 41 failed: NullPointerException", "the first of the two that are one line");
    assert.equal(lines[1], "ERROR disk is full");
    assert.equal(lines[2]?.length, ERROR_LENGTH);
    assert.equal(lines.length, 3);
});

test("a card keeps at most ten error lines", () => {
    const text = Array.from({ length: 30 }, (_, n) => `ERROR failure kind ${String.fromCharCode(97 + n)}`).join("\n");
    assert.equal(extractErrors(text).length, MAX_ERRORS);
});

test("two error lines that differ only in numbers, ids, times and thread names are one line", () => {
    const a =
        "2026-10-30 10:00:01,123 [http-nio-8080-exec-3] ERROR Order 4411 failed for 3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const b =
        "2026-10-31 11:12:13,456 [http-nio-8080-exec-9] ERROR Order 9 failed for 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    assert.equal(normalizeError(a), normalizeError(b));
    assert.equal(normalizeError(a), "error order <n> failed for <id>");
    assert.notEqual(normalizeError(a), normalizeError("ERROR Payment 4411 declined"));
});
