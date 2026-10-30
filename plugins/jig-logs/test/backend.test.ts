// The seam between the shared search and the backends: what every backend promises, the rules its file keeps, and proof
// that the shared search works with a backend it has never seen.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backendOf, backends } from "../src/backends/index.ts";
import type { LogBackend } from "../src/backends/index.ts";
import { elasticsearch } from "../src/backends/elasticsearch.ts";
import type { Backend } from "../src/config.ts";
import { transient } from "../src/failure.ts";
import { MAX_SIZE } from "../src/params.ts";
import type { LogQuery } from "../src/query.ts";
import { runSearch } from "../src/search.ts";
import { HOUR_MS, MAX_RANGE_MS, planBuckets } from "../src/time.ts";
import { hit, rangeOf, searchReply } from "./support/fake-search.ts";
import type { Json } from "./support/fake-search.ts";

const FROM = Date.UTC(2026, 9, 13, 10, 0, 0);
const range = { from: FROM, to: FROM + 2 * HOUR_MS };
const connection: Backend = { kind: "direct", url: "https://logs.example.com", auth: { kind: "bearer", token: "env:T" } };

/** What each backend's `environment` makes from the least a jig.json can say. */
const MINIMAL: Record<string, Record<string, unknown>> = {
    elasticsearch: { index: "app-logs-*" },
};

function queryFor(backend: LogBackend, over: Partial<LogQuery> = {}): LogQuery {
    return {
        environment: "staging",
        target: backend.environment("staging", MINIMAL[backend.type] ?? {}),
        kind: "phrase",
        text: "needle-xyz",
        size: 50,
        order: "asc",
        range,
        ...over,
    };
}

const registered = Object.values(backends);

// ---- what every backend promises ------------------------------------------------------------------------------

test("each backend is listed under its own type, and the environments it makes lead back to it", () => {
    assert.ok(registered.length >= 1);
    for (const [type, backend] of Object.entries(backends)) {
        assert.equal(backend.type, type);
        assert.ok(MINIMAL[type], `${type}: the least an environment can say is listed in this test`);
        assert.equal(backendOf(queryFor(backend).target), backend, type);
    }
});

test("the limits are real numbers, and never below what the tool asks of a backend", () => {
    for (const backend of registered) {
        const { maxHits, maxWindowMs } = backend.limits;
        assert.ok(Number.isInteger(maxHits) && maxHits >= MAX_SIZE, `${backend.type}: it must serve a full size`);
        assert.ok(maxWindowMs > 0, `${backend.type}: a window of no length`);
    }
});

test("what a backend says to the model is one plain line, and names no secret", () => {
    for (const backend of registered) {
        for (const [name, text] of Object.entries(backend.words)) {
            assert.ok(text.length > 3 && !/[\n\r]/.test(text), `${backend.type}.${name}`);
        }
        assert.ok(backend.config.needs.length > 0 && backend.config.exampleUrl.startsWith("https://"));
    }
});

test("the check for data never carries the phrase, the query or a filter", () => {
    for (const backend of registered) {
        const kinds = ["phrase", "query"] as const;
        for (const kind of kinds) {
            const request = backend.probe(queryFor(backend, { kind, text: "| needle-xyz" }), range);
            assert.ok(!JSON.stringify(request).includes("needle-xyz"), `${backend.type}, ${kind}`);
        }
    }
});

test("a request travels as a GET or a POST to a path that starts with a slash, and only the sender adds the address", () => {
    for (const backend of registered) {
        const query = queryFor(backend);
        const wire = backend.wire(query.target, connection)(backend.search(query, range, 5));
        assert.ok(wire.method === "GET" || wire.method === "POST", backend.type);
        assert.match(wire.path, /^\/[^/]/, backend.type);
        assert.ok(!wire.path.includes("://") && !JSON.stringify(wire).includes("example.com"), backend.type);
        // A request with a body says what it is; one without is a plain read.
        assert.equal(wire.method === "POST", wire.body !== undefined, backend.type);
    }
});

test("a reply that is not a result of the backend is not read", () => {
    for (const backend of registered) {
        const request = backend.search(queryFor(backend), range, 5);
        for (const reply of ["", "<html>gateway</html>", "[]", "null", '{"unrelated":true}']) {
            assert.equal(backend.parse(reply, request), undefined, `${backend.type}: ${reply}`);
        }
    }
});

test("what a backend makes of an error never repeats the reply", () => {
    for (const backend of registered) {
        for (const status of [400, 404, 408, 413, 429, 500, 502, 504]) {
            const failure = backend.classify(status, "SECRET-QUERY-TEXT");
            assert.ok(failure === undefined || !JSON.stringify(failure).includes("SECRET"), `${backend.type} ${status}`);
        }
    }
});

// ---- the rules of the folder -----------------------------------------------------------------------------------

const FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "backends");
const adapters = fs
    .readdirSync(FOLDER)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: fs.readFileSync(path.join(FOLDER, file), "utf8") }));
const IMPORT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;

test("an adapter reaches no part of jig-core, and no other adapter or the search", () => {
    assert.ok(adapters.length >= 3, "the interface, the registry and the adapters");
    for (const { file, text } of adapters) {
        for (const match of text.matchAll(IMPORT)) {
            const specifier = match[1] as string;
            assert.ok(!specifier.includes("jig-core"), `${file}: ${specifier}`);
            if (!specifier.startsWith(".")) {
                assert.ok(specifier.startsWith("node:"), `${file}: ${specifier} is not a built-in`);
                continue;
            }
            assert.ok(specifier.endsWith(".ts"), `${file}: ${specifier} must end in .ts`);
            // Only the registry looks at every adapter. An adapter and the interface see the shared files and each other's
            // helpers never: a second adapter must not depend on the first.
            if (file !== "index.ts" && specifier.startsWith("./")) {
                assert.ok(
                    ["./backend.ts", "./logql.ts"].includes(specifier),
                    `${file}: ${specifier} is another adapter`,
                );
            }
            assert.ok(
                !/^\.\.\/(?:search|tool|summary|params|request)\.ts$/.test(specifier),
                `${file}: ${specifier} belongs to the shared search`,
            );
        }
    }
});

test("type-erasable TypeScript only, in the folder too", () => {
    for (const { file, text } of adapters) {
        assert.ok(!/^\s*(?:export\s+)?(?:const\s+)?enum\s/m.test(text), `${file}: enum`);
        assert.ok(!/^\s*(?:export\s+)?(?:declare\s+)?namespace\s/m.test(text), `${file}: namespace`);
        assert.ok(!/^\s*import\s+\w+\s*=/m.test(text), `${file}: import =`);
        assert.ok(!/constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s/.test(text), `${file}: parameter`);
    }
});

// ---- the shared search works with a backend it has never seen ----------------------------------------------------

/**
 * A backend that answers like Elasticsearch but refuses a request over an hour, and has a word of its own for HTTP 418.
 * The shared search must follow both without a line of change.
 */
const hourly: LogBackend = {
    ...elasticsearch,
    limits: { maxHits: 10_000, maxWindowMs: HOUR_MS },
    classify: (status) => (status === 418 ? transient("upstream_unavailable") : undefined),
};

test("a backend's longest window cuts the buckets of a call, and the search keeps within it", async () => {
    assert.deepEqual(
        planBuckets({ from: FROM, to: FROM + 5 * HOUR_MS }, HOUR_MS).map((bucket) => bucket.to - bucket.from),
        Array(5).fill(HOUR_MS),
    );
    const spans = planBuckets({ from: FROM, to: FROM + MAX_RANGE_MS }, 7 * HOUR_MS).map((b) => b.to - b.from);
    assert.ok(spans.every((span) => span <= 7 * HOUR_MS) && spans.length > 7, "days are cut to 7 hours");

    const seen: number[] = [];
    const outcome = await runSearch(queryFor(hourly, { range: { from: FROM, to: FROM + 5 * HOUR_MS } }), {
        backend: hourly,
        send: async (body) => {
            const request = { headers: {}, body: body as Json, path: "", index: "", method: "POST" };
            seen.push(rangeOf(request).to - rangeOf(request).from);
            return { status: 200, body: JSON.stringify(searchReply({ hits: [hit(1)], total: 1 }).json) };
        },
    });
    assert.deepEqual(seen, Array(5).fill(HOUR_MS));
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.windows.length, 5);
});

test("a backend's own reading of an error decides whether the bucket is halved", async () => {
    let calls = 0;
    const outcome = await runSearch(queryFor(hourly, { range: { from: FROM, to: FROM + HOUR_MS } }), {
        backend: hourly,
        send: async () => {
            calls += 1;
            return calls === 1
                ? { status: 418, body: "" }
                : { status: 200, body: JSON.stringify(searchReply({ hits: [hit(calls)], total: 1 }).json) };
        },
    });
    assert.equal(calls, 3, "the whole hour, then its two halves");
    assert.equal(outcome.splits, 1);
    assert.equal(outcome.status, "complete");
    // The same status means something else to Elasticsearch: it is an ordinary rejected query.
    const rejected = await runSearch(queryFor(elasticsearch, { range: { from: FROM, to: FROM + HOUR_MS } }), {
        send: async () => ({ status: 418, body: "" }),
    });
    assert.equal(rejected.windows[0]?.reason, "query_rejected");
});
