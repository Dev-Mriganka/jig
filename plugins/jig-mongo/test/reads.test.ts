// Each read action: the request it makes of the database, and what the model is shown. The database is a fake that records
// requests, so a test sees exactly what would be sent; and what the fake answers is what a real server could say.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { createAccess, readAllow, readDeny } from "../src/access.ts";
import type { Access, AccessRules } from "../src/access.ts";
import { summarizeExplain } from "../src/explain.ts";
import { parseCall } from "../src/params.ts";
import { checkPipeline } from "../src/pipeline.ts";
import { MAX_TEXT } from "../src/render.ts";
import { nsOf, planAggregateRead, planRead } from "../src/reads.ts";
import type { Rendered } from "../src/reads.ts";
import { InputError } from "../src/values.ts";
import { fakeBackend } from "./support/fake-backend.ts";
import type { FakeBackend } from "./support/fake-backend.ts";

const OID = "65f1f1f1f1f1f1f1f1f1f1f1";

function deny(...patterns: string[]): Access {
    const errors: string[] = [];
    const rules = readDeny(patterns, "deny", errors);
    assert.deepEqual(errors, []);
    return createAccess({ mode: "deny", deny: rules as NonNullable<typeof rules>, javascript: false });
}

function allow(map: Record<string, string[]>): Access {
    const errors: string[] = [];
    const rules = readAllow(map, "allow", errors);
    assert.deepEqual(errors, []);
    return createAccess({ mode: "allow", allow: rules as NonNullable<typeof rules>, javascript: false } as AccessRules);
}

const staging = () => deny("billing.cards", "*.notes", "*.profile.ssn");
const production = () =>
    allow({ "orders.orders": ["_id", "status", "items", "createdAt"], "orders.customers": ["_id", "name"] });

let backend: FakeBackend;
beforeEach(() => void (backend = fakeBackend()));

const target = { environment: "staging", database: "orders", collection: "orders" };

/** Plans a read the way the tool does, and runs it against the fake. */
async function run(input: Record<string, unknown>, access: Access = staging()): Promise<Rendered> {
    const call = parseCall({ ...target, ...input });
    if (call.action === "aggregate") {
        const ns = nsOf(call);
        access.namespace(ns.db, ns.coll);
        return planAggregateRead(call, ns, checkPipeline(call.pipeline, ns, access), access).run(
            backend,
            new AbortController().signal,
        );
    }
    return planRead(call, access).run(backend, new AbortController().signal);
}

const lines = (rendered: Rendered): string[] => rendered.text.split("\n");
const docsOf = (rendered: Rendered): unknown[] =>
    lines(rendered)
        .slice(1)
        .map((line) => JSON.parse(line));

describe("databases and collections", () => {
    test("databases: the system databases and the denied ones are not listed, sorted", async () => {
        const rendered = await run(
            { action: "databases", database: undefined, collection: undefined },
            deny("billing.*"),
        );
        assert.equal(rendered.text, "mongo databases staging: 2 databases\norders\nshop");
        assert.equal(backend.calls[0]?.method, "databases");
        assert.deepEqual(backend.calls[0]?.req.maxTimeMS, 10_000);
    });

    test("databases with an allow list: only those with a listed collection", async () => {
        assert.equal(
            (await run({ action: "databases", database: undefined, collection: undefined }, production())).text,
            "mongo databases staging: 1 database\norders",
        );
    });

    test("collections: the denied and the system ones are left out, views are marked", async () => {
        backend.answers.collections = [
            { name: "orders", type: "collection" },
            { name: "cards", type: "collection" },
            { name: "system.views", type: "collection" },
            { name: "report", type: "view" },
            { name: "metrics", type: "timeseries" },
        ];
        const rendered = await run({ action: "collections", collection: undefined }, deny("orders.cards"));
        assert.equal(
            rendered.text,
            "mongo collections staging orders: 3 collections\nmetrics (timeseries)\norders\nreport (view)",
        );
        assert.deepEqual(backend.calls[0]?.query, "orders");
        const listed = await run({ action: "collections", collection: undefined }, production());
        assert.equal(listed.text, "mongo collections staging orders: 1 collection\norders");
    });

    test("collections of a denied or system database are refused before anything is asked", () => {
        assert.throws(
            () =>
                planRead(
                    parseCall({ action: "collections", environment: "staging", database: "billing" }),
                    deny("billing.*"),
                ),
            /billing is denied/,
        );
        assert.throws(
            () => planRead(parseCall({ action: "collections", environment: "staging", database: "admin" }), deny()),
            /always denied/,
        );
        assert.equal(backend.calls.length, 0);
    });
});

describe("stats", () => {
    test("a collection: the numbers that matter, from the storage statistics", async () => {
        const rendered = await run({ action: "stats" });
        assert.equal(lines(rendered)[0], "mongo stats staging orders.orders");
        assert.deepEqual(JSON.parse(lines(rendered)[1] as string), {
            count: 1200,
            size: 372000,
            avgObjSize: 310,
            storageSize: 200000,
            nindexes: 2,
            totalIndexSize: 60000,
        });
        assert.deepEqual(backend.calls[0]?.query, { db: "orders", coll: "orders" });
    });

    test("a database: its own statistics", async () => {
        const rendered = await run({ action: "stats", collection: undefined });
        assert.equal(lines(rendered)[0], "mongo stats staging orders");
        assert.deepEqual(JSON.parse(lines(rendered)[1] as string), {
            collections: 3,
            objects: 1200,
            avgObjSize: 310,
            dataSize: 372000,
            storageSize: 200000,
            indexes: 6,
            indexSize: 90000,
        });
        assert.equal(backend.calls[0]?.method, "dbStats");
    });

    test("a denied collection is refused, and a collection outside the allow list too", () => {
        assert.throws(
            () =>
                planRead(
                    parseCall({ ...target, action: "stats", collection: "cards", database: "billing" }),
                    staging(),
                ),
            /billing\.cards is denied/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "stats", collection: "payments" }), production()),
            /not in the allow list/,
        );
    });
});

describe("indexes", () => {
    test("each index with its keys and options; the condition of a partial index is not shown", async () => {
        backend.answers.indexes = [
            { name: "_id_", key: { _id: 1 } },
            { name: "status_1", key: { status: 1 }, unique: true, sparse: true, v: 2 },
            { name: "ttl", key: { createdAt: 1 }, expireAfterSeconds: 3600 },
            { name: "open", key: { status: 1, createdAt: -1 }, partialFilterExpression: { notes: { $exists: true } } },
        ];
        const rendered = await run({ action: "indexes" });
        assert.equal(lines(rendered)[0], "mongo indexes staging orders.orders: 4 indexes");
        assert.deepEqual(docsOf(rendered), [
            { name: "_id_", key: { _id: 1 } },
            { name: "status_1", key: { status: 1 }, unique: true, sparse: true },
            { name: "ttl", key: { createdAt: 1 }, expireAfterSeconds: 3600 },
            { name: "open", key: { status: 1, createdAt: -1 }, partial: true },
        ]);
    });

    test("an index on a field that may not be seen is not shown, and the count says so", async () => {
        backend.answers.indexes = [
            { name: "_id_", key: { _id: 1 } },
            { name: "notes_1", key: { notes: 1 } },
            { name: "pw", key: { userPassword: 1 } },
        ];
        const rendered = await run({ action: "indexes" });
        assert.equal(
            lines(rendered)[0],
            "mongo indexes staging orders.orders: 1 index; 2 indexes on fields that may not be seen not shown",
        );
        const listed = await run({ action: "indexes" }, production());
        assert.match(lines(listed)[0] as string, /: 1 index; 2 indexes on fields/);
    });

    test("index-stats: how often each index is used", async () => {
        const rendered = await run({ action: "index-stats" });
        assert.equal(backend.calls[0]?.method, "indexStats");
        assert.deepEqual(docsOf(rendered), [
            { name: "status_1", key: { status: 1 }, accesses: { ops: 12, since: "2026-01-01T00:00:00Z" } },
        ]);
    });
});

describe("explain", () => {
    test("a find: the filter, the limit and the sort go to the server, at the verbosity asked", async () => {
        backend.answers.explain = {
            queryPlanner: {
                winningPlan: { stage: "FETCH", inputStage: { stage: "IXSCAN", indexName: "status_1_createdAt_-1" } },
                rejectedPlans: [{}],
            },
            executionStats: { nReturned: 5, totalKeysExamined: 5, totalDocsExamined: 5, executionTimeMillis: 3 },
        };
        const rendered = await run({
            action: "explain",
            filter: { status: "open" },
            sort: { createdAt: -1 },
            limit: 5,
            projection: { status: 1 },
        });
        assert.deepEqual(backend.calls[0]?.query, {
            db: "orders",
            coll: "orders",
            verbosity: "executionStats",
            filter: { status: "open" },
            limit: 5,
            projection: { status: 1 },
            sort: { createdAt: -1 },
        });
        assert.equal(
            rendered.text,
            [
                "mongo explain staging orders.orders (executionStats)",
                "plan: FETCH > IXSCAN(status_1_createdAt_-1)",
                "rejected plans: 1",
                "executed: returned 5 documents, 5 index keys examined, 5 documents examined, 3 ms",
            ].join("\n"),
        );
        await run({ action: "explain", verbosity: "queryPlanner" });
        assert.equal((backend.calls[1]!.query as any).verbosity, "queryPlanner");
    });

    test("a pipeline is explained as the pipeline that would run, and one that writes is refused", async () => {
        await run(
            { action: "explain", pipeline: [{ $match: { status: "open" } }, { $group: { _id: "$status" } }] },
            production(),
        );
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $match: { status: "open" } },
            { $project: { _id: 1, status: 1, items: 1, createdAt: 1 } },
            { $group: { _id: "$status" } },
        ]);
        assert.throws(
            () => planRead(parseCall({ ...target, action: "explain", pipeline: [{ $out: "x" }] }), staging()),
            /explain a pipeline without its \$out stage/,
        );
    });

    test("with an allow list the explained find has the forced projection, and the filter is checked like a find's", async () => {
        await run({ action: "explain", filter: { status: "open" } }, production());
        assert.deepEqual((backend.calls[0]!.query as any).projection, { _id: 1, status: 1, items: 1, createdAt: 1 });
        assert.throws(
            () => planRead(parseCall({ ...target, action: "explain", filter: { password: 1 } }), staging()),
            /credential/,
        );
    });

    test("a plan that scans the collection says so, with the way out", () => {
        const lines = summarizeExplain({
            queryPlanner: { winningPlan: { stage: "COLLSCAN", filter: {} } },
            executionStats: { nReturned: 2, totalDocsExamined: 1200, executionTimeMillis: 14 },
        });
        assert.equal(lines[0], "plan: COLLSCAN");
        assert.match(lines[1] as string, /^warning: COLLSCAN reads the whole collection/);
        assert.equal(lines[2], "executed: returned 2 documents, 1200 documents examined, 14 ms");
    });

    test("plans of other shapes: several inputs, an aggregation, the slot-based engine, a plan with no index", () => {
        assert.equal(
            summarizeExplain({
                queryPlanner: {
                    winningPlan: {
                        stage: "FETCH",
                        inputStage: {
                            stage: "OR",
                            inputStages: [
                                { stage: "IXSCAN", indexName: "a_1" },
                                { stage: "IXSCAN", indexName: "b_1" },
                            ],
                        },
                    },
                },
            })[0],
            "plan: FETCH > OR[IXSCAN(a_1), IXSCAN(b_1)]",
        );
        assert.equal(
            summarizeExplain({
                stages: [
                    {
                        $cursor: {
                            queryPlanner: { winningPlan: { stage: "IXSCAN", indexName: "s_1" } },
                            executionStats: { nReturned: 1 },
                        },
                    },
                ],
            })[0],
            "plan: IXSCAN(s_1)",
        );
        assert.equal(
            summarizeExplain({
                queryPlanner: { winningPlan: { queryPlan: { stage: "IXSCAN", indexName: "q_1" }, slotBasedPlan: {} } },
            })[0],
            "plan: IXSCAN(q_1)",
        );
        assert.match(
            summarizeExplain({
                queryPlanner: { winningPlan: { stage: "SORT", inputStage: { stage: "EOF" } } },
            })[1] as string,
            /^note: no index scan/,
        );
        assert.equal(summarizeExplain({})[0], "plan: ?");
    });
});

describe("count, find, distinct and sample", () => {
    test("count: the filter goes to the server, and the number is exact", async () => {
        backend.answers.count = 42;
        const rendered = await run({ action: "count", filter: { status: "open" } });
        assert.equal(rendered.text, "mongo count staging orders.orders: 42 documents match (exact)");
        assert.deepEqual(backend.calls[0]?.query, { db: "orders", coll: "orders", filter: { status: "open" } });
        assert.deepEqual(rendered.facts, { matched: 42 });
        backend.answers.count = 1;
        assert.equal(
            (await run({ action: "count" })).text,
            "mongo count staging orders.orders: 1 document match (exact)",
        );
        assert.deepEqual(backend.calls[1]?.query, { db: "orders", coll: "orders", filter: {} });
    });

    test("find: the request has the filter, the sort and the default limit of 20; documents are one line of Extended JSON each", async () => {
        backend.answers.find = [
            { _id: new ObjectId(OID), status: "open", createdAt: new Date("2026-01-02T03:04:05Z") },
        ];
        const rendered = await run({ action: "find", filter: { status: "open" }, sort: { createdAt: -1 } });
        assert.deepEqual(backend.calls[0]?.query, {
            db: "orders",
            coll: "orders",
            filter: { status: "open" },
            limit: 20,
            sort: { createdAt: -1 },
        });
        assert.equal(
            rendered.text,
            `mongo find staging orders.orders: 1 document\n{"_id":{"$oid":"${OID}"},"status":"open","createdAt":{"$date":"2026-01-02T03:04:05.000Z"}}`,
        );
        assert.deepEqual(rendered.facts, { returned: 1 });
        assert.deepEqual(rendered.details, { count: 1, partial: false });
    });

    test("find: a result that reaches the limit is marked possibly partial, and one below it is not", async () => {
        backend.answers.find = [{ a: 1 }, { a: 2 }];
        const reached = await run({ action: "find", limit: 2 });
        assert.match(
            lines(reached)[0] as string,
            /: 2 documents, possibly partial \(limit 2 reached; narrow the filter or raise limit\)$/,
        );
        assert.equal(reached.details.partial, true);
        const below = await run({ action: "find", limit: 3 });
        assert.equal(lines(below)[0], "mongo find staging orders.orders: 2 documents");
    });

    test("find: denied fields are taken out of every document, at any depth, though the server sent them", async () => {
        backend.answers.find = [
            {
                _id: 1,
                status: "open",
                notes: "private",
                password: "p",
                customer: { name: "Ada", profile: { ssn: "123", city: "X" }, apiKey: "k" },
                items: [{ sku: "a", notes: "n", nested: [{ token: "t", ok: 1 }] }],
            },
        ];
        const [doc] = docsOf(await run({ action: "find" }));
        assert.deepEqual(doc, {
            _id: 1,
            status: "open",
            customer: { name: "Ada", profile: { city: "X" } },
            items: [{ sku: "a", nested: [{ ok: 1 }] }],
        });
    });

    test("find: the projection and the sort are checked, and a projection that computes is for aggregate", () => {
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", projection: { password: 1 } }), staging()),
            /credential/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", projection: { x: "$status" } }), staging()),
            /must be 1 or 0; computed fields need aggregate/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", sort: { notes: 1 } }), staging()),
            /denied/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", sort: { a: 2 } }), staging()),
            /must be 1 or -1/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", sort: {} }), staging()),
            /sort takes 1 to 8 fields/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", filter: { notes: "x" } }), staging()),
            /denied/,
        );
    });

    test("find with an allow list: a forced inclusion projection of the allowed fields, and the result is cut to them again", async () => {
        backend.answers.find = [
            { _id: 1, status: "open", items: [{ sku: "a", token: "t" }], createdAt: 5, internalNotes: "x" },
        ];
        const [doc] = docsOf(await run({ action: "find", filter: { status: "open" } }, production()));
        assert.deepEqual((backend.calls[0]!.query as any).projection, { _id: 1, status: 1, items: 1, createdAt: 1 });
        assert.deepEqual(
            doc,
            { _id: 1, status: "open", items: [{ sku: "a" }], createdAt: 5 },
            "the server's extra field and the credential-like one are gone",
        );
        await run({ action: "find", projection: { status: 1 } }, production());
        assert.deepEqual((backend.calls[1]!.query as any).projection, { status: 1 });
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", projection: { internalNotes: 1 } }), production()),
            /"internalNotes" is not allowed in orders\.orders/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", filter: { internalNotes: 1 } }), production()),
            /not allowed/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "find", projection: { status: 0 } }), production()),
            /name the fields you want/,
        );
    });

    test("distinct: unwound, grouped, sorted and limited; values are cut like documents", async () => {
        backend.answers.aggregate = [{ _id: "a" }, { _id: "b" }];
        const rendered = await run({
            action: "distinct",
            field: "status",
            filter: { createdAt: { $gt: { $date: "2026-01-01T00:00:00Z" } } },
            limit: 2,
        });
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $match: { createdAt: { $gt: { $date: "2026-01-01T00:00:00Z" } } } },
            { $unwind: "$status" },
            { $group: { _id: "$status" } },
            { $sort: { _id: 1 } },
            { $limit: 2 },
        ]);
        assert.match(
            rendered.text,
            /^mongo distinct staging orders\.orders\.status: 2 values, possibly partial \(limit 2 reached/,
        );
        assert.deepEqual(docsOf(rendered), ["a", "b"]);
        backend.answers.aggregate = [{ _id: { region: "n", token: "t", notes: "x" } }];
        assert.deepEqual(docsOf(await run({ action: "distinct", field: "address" })), [{ region: "n" }]);
    });

    test("distinct: a denied field, a field not allowed, and a field that is only partly allowed are refused", () => {
        assert.throws(
            () => planRead(parseCall({ ...target, action: "distinct", field: "password" }), staging()),
            /credential/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "distinct", field: "internalNotes" }), production()),
            /not allowed/,
        );
        assert.throws(
            () =>
                planRead(
                    parseCall({ ...target, action: "distinct", field: "items" }),
                    allow({ "orders.orders": ["items.sku"] }),
                ),
            /only partly allowed/,
        );
        assert.throws(
            () => planRead(parseCall({ ...target, action: "distinct", field: "profile" }), staging()),
            /holds a denied field/,
        );
    });

    test("sample: the filter, a random sample of the size asked, then the projection", async () => {
        backend.answers.aggregate = [{ _id: 1, status: "x", notes: "n" }];
        const rendered = await run({ action: "sample", filter: { status: "x" }, limit: 5, projection: { status: 1 } });
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $match: { status: "x" } },
            { $sample: { size: 5 } },
            { $project: { status: 1 } },
        ]);
        assert.equal(lines(rendered)[0], "mongo sample staging orders.orders: 1 document sampled");
        assert.deepEqual(docsOf(rendered), [{ _id: 1, status: "x" }]);
        await run({ action: "sample" });
        assert.deepEqual((backend.calls[1]!.query as any).pipeline, [{ $sample: { size: 20 } }]);
        await run({ action: "sample" }, production());
        assert.deepEqual((backend.calls[2]!.query as any).pipeline, [
            { $sample: { size: 20 } },
            { $project: { _id: 1, status: 1, items: 1, createdAt: 1 } },
        ]);
    });
});

describe("schema", () => {
    test("field names and types from a sample, counted per document, with arrays marked and values never shown", async () => {
        backend.answers.aggregate = [
            {
                _id: new ObjectId(OID),
                status: "open",
                total: new Int32(5),
                ratio: new Double(0.5),
                big: Long.fromNumber(9),
                price: Decimal128.fromString("1.5"),
                items: [{ sku: "a", qty: new Int32(1) }, { sku: "b" }],
                blob: new Binary(Buffer.from("x")),
                when: new Date(0),
                password: "p",
            },
            { _id: new ObjectId(OID), status: null, total: "n/a", items: [] },
        ];
        const rendered = await run({ action: "schema", limit: 50 });
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [{ $sample: { size: 50 } }]);
        assert.equal((backend.calls[0]!.query as any).typed, true);
        assert.equal(
            rendered.text,
            [
                "mongo schema staging orders.orders: 12 fields in a sample of 2 documents",
                "_id: objectId (in 2 of 2)",
                "big: long (in 1 of 2)",
                "blob: binData (in 1 of 2)",
                "items: array (in 2 of 2)",
                "items[]: object (in 1 of 2)",
                "items[].qty: int (in 1 of 2)",
                "items[].sku: string (in 1 of 2)",
                "price: decimal (in 1 of 2)",
                "ratio: double (in 1 of 2)",
                "status: string|null (in 2 of 2)",
                "total: int|string (in 2 of 2)",
                "when: date (in 1 of 2)",
            ].join("\n"),
        );
        assert.ok(!rendered.text.includes("password"), "a denied field is not in the schema");
        assert.ok(!rendered.text.includes("open"), "no value is shown");
    });

    test("with an allow list the sample is projected to the allowed fields, and only those are described", async () => {
        backend.answers.aggregate = [{ _id: 1, status: "open", items: [{ sku: "a", token: "t" }], internal: "x" }];
        const rendered = await run({ action: "schema" }, production());
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $sample: { size: 20 } },
            { $project: { _id: 1, status: 1, items: 1, createdAt: 1 } },
        ]);
        assert.deepEqual(lines(rendered).slice(1), [
            "_id: int (in 1 of 1)",
            "items: array (in 1 of 1)",
            "items[]: object (in 1 of 1)",
            "items[].sku: string (in 1 of 1)",
            "status: string (in 1 of 1)",
        ]);
    });

    test("a filter narrows the sample, and it is checked", async () => {
        await run({ action: "schema", filter: { status: "open" }, limit: 5 });
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $match: { status: "open" } },
            { $sample: { size: 5 } },
        ]);
        assert.throws(
            () => planRead(parseCall({ ...target, action: "schema", filter: { token: 1 } }), staging()),
            /credential/,
        );
    });
});

describe("aggregate", () => {
    test("the stages run, with a limit as the last stage; a result that reaches it is marked possibly partial", async () => {
        backend.answers.aggregate = [
            { _id: "open", n: 2 },
            { _id: "closed", n: 1 },
        ];
        const rendered = await run({
            action: "aggregate",
            pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
            limit: 2,
        });
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $group: { _id: "$status", n: { $sum: 1 } } },
            { $limit: 2 },
        ]);
        assert.match(
            lines(rendered)[0] as string,
            /^mongo aggregate staging orders\.orders: 2 documents, possibly partial \(limit 2 reached/,
        );
        assert.deepEqual(docsOf(rendered), [
            { _id: "open", n: 2 },
            { _id: "closed", n: 1 },
        ]);
        const below = await run({ action: "aggregate", pipeline: [{ $limit: 100 }] });
        assert.equal(lines(below)[0], "mongo aggregate staging orders.orders: 2 documents");
        assert.deepEqual((backend.calls[1]!.query as any).pipeline.at(-1), { $limit: 20 });
    });

    test("the result is stripped of denied fields, whatever name the pipeline gave the document", async () => {
        backend.answers.aggregate = [
            { n: 1, rows: [{ notes: "x", password: "p", ok: 1 }], profile: { ssn: "1", city: "c" } },
        ];
        assert.deepEqual(docsOf(await run({ action: "aggregate", pipeline: [{ $match: {} }] })), [
            { n: 1, rows: [{ ok: 1 }], profile: { city: "c" } },
        ]);
    });

    test("with an allow list the pipeline has the projection in front, and the output keeps the names the pipeline made", async () => {
        backend.answers.aggregate = [{ _id: "open", total: 5, apiKey: "k" }];
        const rendered = await run(
            {
                action: "aggregate",
                pipeline: [{ $match: { status: "open" } }, { $group: { _id: "$status", total: { $sum: 1 } } }],
            },
            production(),
        );
        assert.deepEqual((backend.calls[0]!.query as any).pipeline, [
            { $match: { status: "open" } },
            { $project: { _id: 1, status: 1, items: 1, createdAt: 1 } },
            { $group: { _id: "$status", total: { $sum: 1 } } },
            { $limit: 20 },
        ]);
        assert.deepEqual(docsOf(rendered), [{ _id: "open", total: 5 }]);
    });

    test("a pipeline that names a denied field is refused before it is planned to run", async () => {
        await assert.rejects(run({ action: "aggregate", pipeline: [{ $project: { x: "$password" } }] }), InputError);
        assert.equal(backend.calls.length, 0);
    });
});

describe("what the model is shown", () => {
    test("a result too large for the budget is cut at a whole document, and the header says how many are shown", async () => {
        const big = (n: number) => ({ n, text: "x".repeat(10_000) });
        backend.answers.find = Array.from({ length: 10 }, (_, n) => big(n));
        const rendered = await run({ action: "find", limit: 10 });
        const shown = lines(rendered).length - 1;
        assert.ok(shown >= 3 && shown < 10, `${shown} documents shown`);
        assert.ok(rendered.text.length <= MAX_TEXT + 500);
        assert.match(
            lines(rendered)[0] as string,
            new RegExp(
                `: 10 documents, possibly partial \\(limit 10 reached.*; showing the first ${shown}; the output limit was reached`,
            ),
        );
        for (const line of lines(rendered).slice(1)) JSON.parse(line);
    });

    test("one document larger than the budget is still shown whole, never cut in the middle", async () => {
        backend.answers.find = [{ text: "y".repeat(MAX_TEXT + 100) }];
        const rendered = await run({ action: "find" });
        assert.equal(lines(rendered).length, 2);
        assert.equal((JSON.parse(lines(rendered)[1] as string) as { text: string }).text.length, MAX_TEXT + 100);
    });

    test("an empty result says so", async () => {
        assert.equal((await run({ action: "find" })).text, "mongo find staging orders.orders: 0 documents");
    });
});
