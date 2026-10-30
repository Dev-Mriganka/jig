import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import type { Target } from "../src/config.ts";
import { checkParams, logsParameters, resolveQuery, resolveView, USAGE } from "../src/params.ts";
import { NOW } from "./support/world.ts";

const TARGET: Target = {
    index: "app-*",
    timeField: "@timestamp",
    messageField: "message",
    filter: {},
    jigEnvironment: "staging",
};
const base = { phrase: "abc", environment: "staging" };
const ok = (params: Record<string, unknown>) => Check(logsParameters, params);

/** Fails unless the call is refused as invalid input, with one line. */
function refused(call: () => unknown, pattern: RegExp, label?: string): void {
    assert.throws(
        call,
        (error: Error) => error instanceof TypeError && pattern.test(error.message) && !error.message.includes("\n"),
        label,
    );
}

const query = (params: Record<string, unknown>) => resolveQuery(params, "staging", TARGET, NOW);

// ---- the schema the model sees -----------------------------------------------------------------------------------

test("the schema accepts every documented parameter", () => {
    assert.ok(ok(base));
    assert.ok(ok({ query: "error AND timeout", environment: "prod" }));
    assert.ok(ok({ ...base, window: "30m", size: 200, order: "desc" }));
    assert.ok(ok({ ...base, from: "2026-10-13T10:00:00Z", to: "2026-10-13T11:00:00Z" }));
    assert.ok(
        ok({ ...base, match: ["a", "b", "c", "d", "e"], exclude: ["x"], around: "needle", chars: 4000, offset: 40 }),
    );
    assert.ok(ok({ query: "x".repeat(2000), environment: "prod" }));
});

// The schema cannot say "one of phrase and query", so that is checked in checkParams (below).
test("the schema refuses what is out of range, and any parameter it does not list", () => {
    const bad: Array<Record<string, unknown>> = [
        { phrase: "abc" },
        { ...base, environment: "" },
        { phrase: "", environment: "staging" },
        { phrase: "x".repeat(513), environment: "staging" },
        { query: "x".repeat(2001), environment: "staging" },
        { ...base, size: 0 },
        { ...base, size: 201 },
        { ...base, size: 1.5 },
        { ...base, window: "2 hours" },
        { ...base, window: "0h" },
        { ...base, order: "newest" },
        { ...base, chars: 39 },
        { ...base, chars: 4001 },
        { ...base, chars: 1.5 },
        { ...base, around: "" },
        { ...base, around: "x".repeat(201) },
        { ...base, match: [] },
        { ...base, match: ["a", "b", "c", "d", "e", "f"] },
        { ...base, match: [""] },
        { ...base, match: ["x".repeat(201)] },
        { ...base, match: "a" },
        { ...base, exclude: [] },
        { ...base, offset: -1 },
        { ...base, offset: 1.5 },
        { ...base, limit: 5 },
        { ...base, index: "other-*" },
    ];
    for (const params of bad) assert.ok(!ok(params), JSON.stringify(params));
});

// ---- the shape of a call: the usage line -------------------------------------------------------------------------

test("the usage line names every parameter of the schema, and marks the optional ones", () => {
    const names = Object.keys((logsParameters as unknown as { properties: object }).properties).filter(
        (name) => !["phrase", "query", "environment"].includes(name),
    );
    assert.equal(
        USAGE,
        `Usage: logs {phrase or query, environment, ${names.map((name) => `${name}?`).join(", ")}}`,
        "same names, same order as the schema",
    );
    assert.ok(
        USAGE.startsWith(
            "Usage: logs {phrase or query, environment, window?, from?, to?, size?, order?, match?, exclude?, around?",
        ),
    );
});

test("a parameter the tool lacks is refused with the usage line", () => {
    assert.throws(() => checkParams({ ...base, limit: 10 }), new TypeError(`logs does not use limit. ${USAGE}`));
    assert.throws(() => checkParams({ ...base, index: "x" }), new TypeError(`logs does not use index. ${USAGE}`));
    // A value of undefined counts as absent, as when a caller spreads an options object.
    assert.doesNotThrow(() => checkParams({ ...base, limit: undefined }));
});

test("exactly one of phrase and query is needed", () => {
    assert.throws(() => checkParams({ environment: "staging" }), new TypeError(`logs needs phrase or query. ${USAGE}`));
    assert.throws(
        () => checkParams({ ...base, query: "a" }),
        new TypeError(`logs takes phrase or query, not both. ${USAGE}`),
    );
    assert.doesNotThrow(() => checkParams({ query: "a", environment: "staging" }));
    assert.doesNotThrow(() => checkParams(base));
});

test("an unknown name in a message is shown safely", () => {
    refused(() => checkParams({ ...base, "bad\nname": 1 }), /^logs does not use bad\?name\. Usage: /);
});

// ---- the values ----------------------------------------------------------------------------------------------

test("a call gets its defaults: the last 2 hours, 50 hits, oldest first", () => {
    assert.deepEqual(query(base), {
        environment: "staging",
        target: TARGET,
        kind: "phrase",
        text: "abc",
        size: 50,
        order: "asc",
        range: { from: NOW - 7_200_000, to: NOW },
    });
    assert.equal(query({ query: "a OR b", environment: "staging" }).kind, "query");
    assert.equal(query({ ...base, order: "desc" }).order, "desc");
    assert.equal(query({ ...base, size: 200 }).size, 200);
});

test("a window ends now; from and to are exact", () => {
    assert.deepEqual(query({ ...base, window: "30m" }).range, { from: NOW - 1_800_000, to: NOW });
    const exact = query({ ...base, from: "2026-10-13T10:00:00Z", to: "2026-10-13T10:30:00Z" });
    assert.deepEqual(exact.range, { from: NOW - 7_200_000, to: NOW - 5_400_000 });
});

test("a phrase or query must be printable text of the right length", () => {
    refused(() => query({ phrase: "x".repeat(513), environment: "staging" }), /^logs: phrase must be 1-512 printable/);
    refused(() => query({ phrase: "   ", environment: "staging" }), /^logs: phrase must be 1-512 printable/);
    refused(() => query({ phrase: "a\nb", environment: "staging" }), /^logs: phrase must be 1-512 printable/);
    refused(() => query({ phrase: "a\u0000b", environment: "staging" }), /^logs: phrase must be 1-512 printable/);
    refused(() => query({ phrase: 5, environment: "staging" }), /^logs: phrase must be 1-512 printable/);
    refused(() => query({ query: "x".repeat(2001), environment: "staging" }), /^logs: query must be 1-2000 printable/);
    assert.equal(query({ query: "x".repeat(2000), environment: "staging" }).text.length, 2000);
    assert.equal(query({ phrase: "x".repeat(512), environment: "staging" }).text.length, 512);
});

test("window, from and to are refused with the rule they break", () => {
    refused(() => query({ ...base, window: "9d" }), /^logs: window must look like 30m, 2h or 1d and be at most 7d/);
    refused(() => query({ ...base, window: 5 }), /^logs: window must be text/);
    refused(() => query({ ...base, from: "2026-10-13T10:00:00Z" }), /from and to must be given together/);
    refused(
        () => query({ ...base, window: "1h", from: "2026-10-13T10:00:00Z", to: "2026-10-13T11:00:00Z" }),
        /either window or from and to, not both/,
    );
    refused(() => query({ ...base, from: "2026-10-01T00:00:00Z", to: "2026-10-09T00:00:00Z" }), /at most 7 days/);
    refused(() => query({ ...base, from: "2026-10-13T10:00:00", to: "2026-10-13T11:00:00" }), /with a timezone/);
});

test("size and order are refused with their range", () => {
    refused(() => query({ ...base, size: 0 }), /^logs: size must be an integer from 1 to 200 \(got 0\)$/);
    refused(() => query({ ...base, size: 201 }), /^logs: size must be an integer from 1 to 200 \(got 201\)$/);
    refused(() => query({ ...base, size: 1.5 }), /^logs: size must be an integer from 1 to 200 \(got 1\.5\)$/);
    refused(() => query({ ...base, size: "50" }), /^logs: size must be an integer from 1 to 200 \(got "50"\)$/);
    refused(() => query({ ...base, order: "newest" }), /^logs: order must be asc or desc \(got "newest"\)$/);
});

test("the view: match, exclude, around, chars and offset", () => {
    assert.deepEqual(resolveView(base), { offset: 0 });
    assert.deepEqual(
        resolveView({ ...base, match: ["a b"], exclude: ["c"], around: "needle", chars: 1000, offset: 3 }),
        { match: ["a b"], exclude: ["c"], around: "needle", chars: 1000, offset: 3 },
    );
});

test("match and exclude take 1 to 5 printable texts", () => {
    refused(() => resolveView({ ...base, match: [] }), /^logs: match must list 1 to 5 texts$/);
    refused(
        () => resolveView({ ...base, exclude: ["a", "b", "c", "d", "e", "f"] }),
        /^logs: exclude must list 1 to 5 texts$/,
    );
    refused(() => resolveView({ ...base, match: "a" }), /^logs: match must list 1 to 5 texts$/);
    refused(() => resolveView({ ...base, match: ["a\nb"] }), /^logs: each match must be 1-200 printable characters/);
    refused(() => resolveView({ ...base, match: ["   "] }), /^logs: each match must be 1-200 printable characters/);
    refused(() => resolveView({ ...base, exclude: ["x".repeat(201)] }), /^logs: each exclude must be 1-200 printable/);
    refused(() => resolveView({ ...base, exclude: [3] }), /^logs: each exclude must be 1-200 printable/);
});

test("around is one printable text; chars and offset are integers in range", () => {
    refused(() => resolveView({ ...base, around: "a\tb" }), /^logs: around must be 1-200 printable characters/);
    refused(() => resolveView({ ...base, around: "  " }), /^logs: around must be 1-200 printable characters/);
    refused(() => resolveView({ ...base, chars: 10 }), /^logs: chars must be an integer from 40 to 4000 \(got 10\)$/);
    refused(
        () => resolveView({ ...base, chars: 4001 }),
        /^logs: chars must be an integer from 40 to 4000 \(got 4001\)$/,
    );
    refused(
        () => resolveView({ ...base, offset: -1 }),
        /^logs: offset must be an integer from 0 to 1000000 \(got -1\)$/,
    );
    refused(() => resolveView({ ...base, offset: 1.5 }), /^logs: offset must be an integer from 0 to /);
    assert.equal(resolveView({ ...base, chars: 40 }).chars, 40);
    assert.equal(resolveView({ ...base, chars: 4000 }).chars, 4000);
});

test("every refusal is one line that starts with the tool's name", () => {
    const calls: Array<() => unknown> = [
        () => query({ ...base, window: "9d" }),
        () => query({ ...base, size: 0 }),
        () => resolveView({ ...base, match: [] }),
        () => resolveView({ ...base, chars: 3 }),
    ];
    for (const call of calls) refused(call, /^logs: /);
});
