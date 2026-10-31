// The index check: before a read runs where the environment requires one (production by default), the planner is asked how it
// would run, and a plan that scans the collection is refused with the fields an index leads with. The database is a fake that
// records requests, so a test sees which ones were sent, and what the fake answers is what a real planner could say (the shapes
// below were read from a MongoDB 8.0 server).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { driverError, INDEX_PLAN, SCAN_PLAN } from "./support/fake-backend.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { defaultSection } from "./support/section.ts";

let h: Harness;
beforeEach(() => void (h = setupHarness()));
afterEach(async () => h.close());

const orders = { database: "orders", collection: "orders" };
const find = (environment: string, extra: Record<string, unknown> = {}) => ({
    action: "find",
    environment,
    ...orders,
    ...extra,
});
const asked = () => h.backend.calls.map((call) => call.method);

/** The section with a change to the production connection and the allow list. */
function section(connection: Record<string, unknown> = {}, allow?: Record<string, unknown>): Record<string, unknown> {
    const base = defaultSection() as { connections: Record<string, Record<string, unknown>>; access: any };
    Object.assign(base.connections.production as object, connection);
    if (allow !== undefined) base.access.production = { allow };
    return base;
}

const indexes = (...keys: Array<Record<string, number>>) => keys.map((key, i) => ({ name: `i${i}`, key }));

describe("a read in production", () => {
    test("is refused when the plan scans the collection, and the refusal names the fields an index leads with", async () => {
        h.backend.answers.explain = SCAN_PLAN;
        h.backend.answers.indexes = indexes({ _id: 1 }, { status: 1, createdAt: -1 }, { createdAt: 1 }, { items: 1 });
        const result = await h.call(find("production", { filter: { status: "x" } }));
        assert.equal(
            result.error?.message,
            "mongo find production orders.orders: refused, the plan scans the whole collection (COLLSCAN), and reads in production must use an index. " +
                "Filter on a field an index leads with: _id, status, createdAt, items.",
        );
        assert.deepEqual(asked(), ["explain", "indexes"], "nothing was read");
    });

    test("is asked about as the planner only, with the query the read would run", async () => {
        ok(await h.call(find("production", { filter: { status: "open" }, limit: 5, sort: { createdAt: -1 } })));
        assert.deepEqual(asked(), ["explain", "find"]);
        const explain = h.backend.calls[0]!;
        const read = h.backend.calls[1]!;
        assert.deepEqual(explain.query, {
            db: "orders",
            coll: "orders",
            verbosity: "queryPlanner",
            filter: { status: "open" },
            limit: 5,
            projection: { _id: 1, status: 1, items: 1, createdAt: 1 },
            sort: { createdAt: -1 },
        });
        const { verbosity: _, ...sent } = explain.query as Record<string, unknown>;
        assert.deepEqual(sent, read.query, "the explained query and the sent one are the same");
        assert.equal(explain.req.maxTimeMS, read.req.maxTimeMS);
    });

    test("runs when an index serves the plan, and says nothing of the check", async () => {
        h.backend.answers.explain = INDEX_PLAN;
        h.backend.answers.find = [{ _id: 1, status: "open" }];
        assert.equal(
            ok(await h.call(find("production", { filter: { status: "open" } }))),
            'mongo find production orders.orders: 1 document\n{"_id":1,"status":"open"}',
        );
    });

    test("a find with no filter is a scan, and is told to use sample to see what documents look like", async () => {
        h.backend.answers.explain = SCAN_PLAN;
        const message = (await h.call(find("production"))).error?.message ?? "";
        assert.match(message, /refused, the plan scans the whole collection/);
        assert.match(message, /To see what the documents look like, use sample\.$/);
        const sample = await h.call({ action: "sample", environment: "production", ...orders });
        assert.equal(sample.error, undefined, "a sample with no filter reads a bounded number of documents");
    });

    test("a sort that an index serves is not a scan, even with no filter", async () => {
        h.backend.answers.explain = {
            queryPlanner: {
                winningPlan: { stage: "LIMIT", inputStage: { stage: "FETCH", inputStage: { stage: "IXSCAN" } } },
            },
        };
        ok(await h.call(find("production", { sort: { createdAt: -1 }, limit: 3 })));
    });

    test("a count with no filter on a collection that is not reference data is refused, without asking the planner", async () => {
        h.backend.answers.indexes = indexes({ _id: 1 }, { status: 1 });
        const result = await h.call({ action: "count", environment: "production", ...orders });
        assert.equal(
            result.error?.message,
            "mongo count production orders.orders: refused, with no filter it reads every document, and reads in production must use an index. " +
                "Filter on a field an index leads with: _id, status. For the size of the collection, use stats.",
        );
        assert.deepEqual(asked(), ["indexes"]);
    });

    test("a count with a filter is asked about as the pipeline that counts, and runs when an index serves it", async () => {
        h.backend.answers.explain = {
            queryPlanner: {
                winningPlan: {
                    queryPlan: { stage: "GROUP", inputStage: { stage: "COUNT_SCAN", indexName: "status_1" } },
                    slotBasedPlan: { stages: "..." },
                },
            },
        };
        assert.match(
            ok(await h.call({ action: "count", environment: "production", ...orders, filter: { status: "open" } })),
            /3 documents match/,
        );
        assert.deepEqual((h.backend.of("explain")[0]!.query as any).pipeline, [
            { $match: { status: "open" } },
            { $group: { _id: 1, n: { $sum: 1 } } },
        ]);
        h.backend.answers.explain = {
            queryPlanner: {
                winningPlan: { queryPlan: { stage: "GROUP", inputStage: { stage: "COLLSCAN", filter: {} } } },
            },
        };
        assert.match(
            (await h.call({ action: "count", environment: "production", ...orders, filter: { createdAt: 1 } })).error
                ?.message ?? "",
            /refused, the plan scans the whole collection \(COLLSCAN\)/,
        );
    });

    test("distinct, sample and schema with a filter, and an aggregation, are checked; an unfiltered sample is not", async () => {
        h.backend.answers.explain = SCAN_PLAN;
        for (const [action, extra] of [
            ["distinct", { field: "status" }],
            ["sample", { filter: { status: "x" } }],
            ["schema", { filter: { status: "x" } }],
            ["aggregate", { pipeline: [{ $group: { _id: "$status" } }] }],
        ] as const) {
            const result = await h.call({ action, environment: "production", ...orders, ...extra });
            assert.match(result.error?.message ?? "", /refused, the plan scans the whole collection/, action);
        }
        assert.deepEqual(h.backend.of("aggregate"), [], "no read was sent");
        ok(await h.call({ action: "schema", environment: "production", ...orders }));
        ok(await h.call({ action: "sample", environment: "production", ...orders }));
    });

    test("an aggregation is explained as the pipeline that would run, with the allow list's projection and the limit", async () => {
        ok(
            await h.call({
                action: "aggregate",
                environment: "production",
                ...orders,
                pipeline: [{ $match: { status: "open" } }, { $group: { _id: "$status" } }],
                limit: 7,
            }),
        );
        const explain = h.backend.calls[0]!;
        const read = h.backend.calls[1]!;
        assert.equal(explain.method, "explain");
        assert.deepEqual((explain.query as any).pipeline, (read.query as any).pipeline);
        assert.deepEqual((read.query as any).pipeline.at(-1), { $limit: 7 });
    });

    test("explain at executionStats runs the query, so it is checked; at queryPlanner it runs nothing, and is not", async () => {
        h.backend.answers.explain = SCAN_PLAN;
        const stats = await h.call({
            action: "explain",
            environment: "production",
            ...orders,
            filter: { createdAt: 1 },
        });
        assert.match(stats.error?.message ?? "", /refused, the plan scans the whole collection/);
        assert.match(stats.error?.message ?? "", /explain with verbosity queryPlanner shows the plan without running/);
        assert.deepEqual(
            h.backend.of("explain").map((call) => (call.query as any).verbosity),
            ["queryPlanner"],
            "the query was never explained at executionStats",
        );
        h.backend.calls.length = 0;
        const planner = await h.call({
            action: "explain",
            environment: "production",
            ...orders,
            filter: { createdAt: 1 },
            verbosity: "queryPlanner",
        });
        assert.match(ok(planner), /plan: LIMIT > COLLSCAN/);
        assert.equal(h.backend.of("explain").length, 1);
    });
});

describe("what the planner can say", () => {
    const refusedBy = async (plan: unknown): Promise<boolean> => {
        h.backend.answers.explain = plan;
        const result = await h.call({
            action: "aggregate",
            environment: "production",
            ...orders,
            pipeline: [{ $match: { status: "open" } }],
        });
        return /refused, the (plan scans|plan joins)/.test(result.error?.message ?? "");
    };

    test("a scan is found wherever the server puts a plan: the cursor stage, a union, a slot-based plan, a shard", async () => {
        const cursor = (winningPlan: unknown) => ({ $cursor: { queryPlanner: { winningPlan, rejectedPlans: [] } } });
        const ix = { stage: "FETCH", inputStage: { stage: "IXSCAN" } };
        assert.equal(await refusedBy({ stages: [cursor({ stage: "COLLSCAN" })] }), true);
        assert.equal(await refusedBy({ stages: [cursor(ix)] }), false);
        assert.equal(
            await refusedBy({
                stages: [cursor(ix), { $unionWith: { coll: "customers", pipeline: [cursor({ stage: "COLLSCAN" })] } }],
            }),
            true,
            "a union's own plan",
        );
        assert.equal(
            await refusedBy({
                queryPlanner: { winningPlan: { queryPlan: { stage: "GROUP", inputStage: { stage: "COLLSCAN" } } } },
            }),
            true,
        );
        assert.equal(
            await refusedBy({
                queryPlanner: {
                    winningPlan: {
                        stage: "SHARD_MERGE",
                        shards: [{ winningPlan: ix }, { winningPlan: { stage: "COLLSCAN" } }],
                    },
                },
            }),
            true,
            "one shard that scans",
        );
        assert.equal(
            await refusedBy({
                queryPlanner: {
                    winningPlan: { stage: "EQ_LOOKUP", strategy: "HashJoin", inputStage: { stage: "IXSCAN" } },
                },
            }),
            true,
            "a join that reads the joined collection whole",
        );
        assert.equal(
            await refusedBy({
                queryPlanner: {
                    winningPlan: { stage: "EQ_LOOKUP", strategy: "IndexedLoopJoin", inputStage: { stage: "IXSCAN" } },
                },
            }),
            false,
        );
    });

    test("a join that reads the joined collection whole names that collection and the field, and its indexes", async () => {
        h.configure(
            section(
                {},
                { "orders.orders": ["_id", "status", "customerId"], "orders.customers": ["_id", "name", "segment"] },
            ),
        );
        h.backend.answers.explain = {
            queryPlanner: {
                winningPlan: {
                    queryPlan: {
                        stage: "EQ_LOOKUP",
                        foreignCollection: "orders.customers",
                        localField: "customerId",
                        foreignField: "name",
                        strategy: "HashJoin",
                        inputStage: { stage: "FETCH", inputStage: { stage: "IXSCAN" } },
                    },
                },
            },
        };
        h.backend.answers.indexes = (query: any) =>
            query.coll === "customers" ? indexes({ _id: 1 }, { segment: 1 }) : indexes({ _id: 1 });
        const result = await h.call({
            action: "aggregate",
            environment: "production",
            ...orders,
            pipeline: [
                { $match: { status: "open" } },
                { $lookup: { from: "customers", localField: "customerId", foreignField: "name", as: "c" } },
            ],
        });
        assert.equal(
            result.error?.message,
            "mongo aggregate production orders.orders: refused, the plan joins by reading all of customers (the $lookup uses a HashJoin), " +
                "since no index of it leads with name, and reads in production must use an index. Filter on a field an index leads with: _id, segment.",
        );
    });

    test("a plan the planner rejected is not what runs, and a query that echoes the word is not a scan", async () => {
        const echoed = {
            queryPlanner: {
                parsedQuery: { stage: { $eq: "COLLSCAN" } },
                winningPlan: {
                    stage: "FETCH",
                    filter: { stage: { $eq: "COLLSCAN" } },
                    inputStage: { stage: "IXSCAN" },
                },
                rejectedPlans: [{ stage: "COLLSCAN" }],
            },
        };
        assert.equal(await refusedBy(echoed), false);
    });

    test("an answer with no plan in it that can be read is a refusal, not a pass", async () => {
        h.backend.answers.explain = { ok: 1 };
        const result = await h.call(find("production", { filter: { status: "open" } }));
        assert.equal(
            result.error?.message,
            "mongo find production orders.orders: refused, the index check could not be made (the planner's answer holds no plan that can be read), and a read here is not sent without it. Nothing was read.",
        );
        assert.deepEqual(asked(), ["explain"]);
    });
});

describe("the fields named in a refusal", () => {
    beforeEach(() => {
        h.backend.answers.explain = SCAN_PLAN;
    });
    const refusal = async (filter: Record<string, unknown> = { status: "x" }) =>
        (await h.call(find("production", { filter }))).error?.message ?? "";

    test("are at most 5, each once, and the rest are counted", async () => {
        h.backend.answers.indexes = indexes(
            { _id: 1 },
            { status: 1, createdAt: -1 },
            { status: 1 },
            { createdAt: 1 },
            { items: 1 },
            { "items.sku": 1 },
            { shipping: 1 },
            { notes: 1 },
        );
        // The allow list is _id, status, items and createdAt: shipping and notes may not be seen, and are not named or counted.
        assert.match(await refusal(), /leads with: _id, status, createdAt, items, items\.sku\.$/);
        h.configure(
            section(
                {},
                { "orders.orders": ["_id", "status", "createdAt", "items", "shipping", "notes", "a", "b", "c"] },
            ),
        );
        h.backend.answers.indexes = indexes(
            { _id: 1 },
            { status: 1 },
            { createdAt: 1 },
            { items: 1 },
            { shipping: 1 },
            { notes: 1 },
            { a: 1 },
            { b: 1 },
        );
        assert.match(
            await refusal(),
            /leads with: _id, status, createdAt, items, shipping \(\+3 more; `mongo indexes` lists all\)\.$/,
        );
    });

    test("leave out an index no field of which may be seen, and text and wildcard indexes", async () => {
        h.backend.answers.indexes = [
            { name: "a", key: { internalNotes: 1 } },
            { name: "b", key: { _fts: "text", _ftsx: 1 } },
            { name: "c", key: { "$**": 1 } },
            { name: "d", key: { status: "hashed" } },
        ];
        assert.match(await refusal(), /leads with: status\.$/);
    });

    test("say so when no index leads with a field that may be seen, or when the index list cannot be read", async () => {
        h.backend.answers.indexes = [{ name: "a", key: { internalNotes: 1 } }];
        assert.match(await refusal(), /No index leads with a field you may see; `mongo indexes` lists the indexes\.$/);
        h.backend.answers.indexes = () => {
            throw driverError("MongoServerError", "x", { code: 13 });
        };
        const message = await refusal();
        assert.match(message, /^mongo find production orders\.orders: refused, the plan scans/);
        assert.match(message, /`mongo indexes` lists the indexes\.$/);
    });
});

describe("a $lookup", () => {
    const lookup = (foreignField: string, extra: Record<string, unknown> = {}) => ({
        action: "aggregate",
        environment: "production",
        ...orders,
        pipeline: [
            { $match: { status: "open" } },
            { $lookup: { from: "customers", localField: "customerId", foreignField, as: "customer", ...extra } },
        ],
    });
    beforeEach(() => {
        h.configure(
            section(
                {},
                {
                    "orders.orders": ["_id", "status", "customerId"],
                    "orders.customers": ["_id", "name", "segment"],
                },
            ),
        );
    });

    test("that matches on a field no index of the joined collection leads with is refused: the planner does not say", async () => {
        h.backend.answers.indexes = (query: any) =>
            query.coll === "customers" ? indexes({ _id: 1 }, { segment: 1 }) : indexes({ _id: 1 });
        const message = (await h.call(lookup("name"))).error?.message ?? "";
        assert.equal(
            message,
            "mongo aggregate production orders.orders: refused, the $lookup into customers matches on name, which no index of it leads with, " +
                "so it would scan customers for each document, and reads in production must use an index. " +
                "Filter on a field an index leads with: _id, segment.",
        );
        assert.deepEqual(h.backend.of("aggregate"), []);
    });

    test("runs when an index of the joined collection leads with the field, or the field is _id", async () => {
        h.backend.answers.indexes = (query: any) =>
            query.coll === "customers" ? indexes({ _id: 1 }, { name: 1, segment: 1 }) : indexes({ _id: 1 });
        ok(await h.call(lookup("name")));
        h.backend.calls.length = 0;
        ok(await h.call(lookup("_id")));
        assert.deepEqual(asked(), ["explain", "aggregate"], "an _id join needs no look at the indexes");
    });

    test("is not checked when the joined collection is marked as reference data", async () => {
        h.configure(
            section(
                {},
                {
                    "orders.orders": ["_id", "status", "customerId"],
                    "orders.customers": { fields: ["_id", "name"], reference: true },
                },
            ),
        );
        h.backend.answers.indexes = indexes({ _id: 1 });
        ok(await h.call(lookup("name")));
    });
});

describe("a collection marked as reference data", () => {
    beforeEach(() => {
        h.configure(
            section(
                {},
                {
                    "orders.orders": ["_id", "status", "items", "createdAt"],
                    "orders.countries": { fields: ["_id", "name"], reference: true },
                    "orders.regions": { fields: ["_id", "name"] },
                },
            ),
        );
        h.backend.answers.explain = SCAN_PLAN;
    });
    const countries = { database: "orders", collection: "countries", environment: "production" };

    test("may be read whole: a count with no filter, a find, an aggregation, with no look at the planner", async () => {
        ok(await h.call({ action: "count", ...countries }));
        ok(await h.call({ action: "find", ...countries }));
        ok(await h.call({ action: "aggregate", ...countries, pipeline: [{ $group: { _id: "$name" } }] }));
        ok(await h.call({ action: "distinct", ...countries, field: "name" }));
        assert.deepEqual(h.backend.of("explain"), []);
    });

    test("is the only collection that may: the others of the list, and the rest of production, are still checked", async () => {
        const regions = { ...countries, collection: "regions" };
        assert.match((await h.call({ action: "count", ...regions })).error?.message ?? "", /with no filter/);
        assert.match((await h.call({ action: "find", ...regions })).error?.message ?? "", /refused/);
        assert.match(
            (await h.call({ action: "find", ...orders, environment: "production" })).error?.message ?? "",
            /refused/,
        );
    });

    test("the object form is checked: a field list that is empty or missing, an unknown key, a reference that is not true or false", () => {
        const refused = (entry: unknown) =>
            h.jig.sections.get("mongo")?.(section({}, { "orders.orders": entry })) ?? [];
        assert.match(refused({ reference: true }).join(), /must list 1 to 500 field paths/);
        assert.match(refused({ fields: [], reference: true }).join(), /must list 1 to 500 field paths/);
        assert.match(refused({ fields: ["_id"], refrence: true }).join(), /refrence: unknown field/);
        assert.match(refused({ fields: ["_id"], reference: "yes" }).join(), /reference: must be true or false/);
        assert.deepEqual(refused({ fields: ["_id"], reference: false }), []);
        assert.deepEqual(refused({ fields: ["_id"] }), []);
    });
});

describe("the setting requireIndex", () => {
    test("false turns the check off for one production connection: a scan runs, and the planner is never asked", async () => {
        h.configure(section({ requireIndex: false }));
        h.backend.answers.explain = SCAN_PLAN;
        ok(await h.call(find("production", { filter: { status: "x" } })));
        ok(await h.call({ action: "count", environment: "production", ...orders }));
        assert.deepEqual(h.backend.of("explain"), []);
    });

    test("true is the default for production, and is the same when written", async () => {
        h.configure(section({ requireIndex: true }));
        h.backend.answers.explain = SCAN_PLAN;
        assert.match((await h.call(find("production", { filter: { status: "x" } }))).error?.message ?? "", /refused/);
    });

    test("true turns the check on for a test environment, which is not checked otherwise", async () => {
        h.backend.answers.explain = SCAN_PLAN;
        ok(await h.call(find("staging", { filter: { status: "x" } })));
        assert.deepEqual(h.backend.of("explain"), [], "a test environment is not checked by default");

        const test = defaultSection() as { connections: Record<string, Record<string, unknown>> };
        Object.assign(test.connections.staging as object, { requireIndex: true });
        h.configure(test);
        const result = await h.call(find("staging", { filter: { status: "x" } }));
        assert.match(result.error?.message ?? "", /^mongo find staging orders\.orders: refused, the plan scans/);
        assert.match(result.error?.message ?? "", /reads in staging must use an index/);
    });

    test("is per connection where an environment has several", async () => {
        h.configure({
            connections: {
                production: {
                    orders: { uri: "mongodb://orders.example.com:27017", user: "u", password: "pass:mongo/production" },
                    billing: {
                        uri: "mongodb://billing.example.com:27017",
                        user: "u",
                        password: "pass:mongo/production",
                        requireIndex: false,
                    },
                },
            },
            access: {
                production: {
                    orders: { allow: { "orders.orders": ["_id", "status"] } },
                    billing: { allow: { "orders.orders": ["_id", "status"] } },
                },
            },
        });
        h.backend.answers.explain = SCAN_PLAN;
        const call = (cluster: string) => h.call(find("production", { cluster, filter: { status: "x" } }));
        assert.match((await call("orders")).error?.message ?? "", /production\/orders orders\.orders: refused/);
        ok(await call("billing"));
    });

    test("must be true or false", () => {
        const check = h.jig.sections.get("mongo");
        for (const value of ["no", 0, null, "false"]) {
            const raw = section({ requireIndex: value });
            assert.match((check?.(raw) ?? []).join(), /connections\.production\.requireIndex: must be true or false/);
        }
        assert.deepEqual(check?.(section({ requireIndex: false })), []);
    });
});

describe("/jig", () => {
    const lines = () => h.jig.status.get("jig-mongo")?.() ?? ["not registered"];

    test("says nothing while the check is on, and names the production connections where the user turned it off", () => {
        assert.deepEqual(lines(), []);
        h.configure(section({ requireIndex: false }));
        assert.deepEqual(lines(), [
            "jig-mongo: the index check is OFF for production (requireIndex: false in your jig.json): reads there may scan whole collections",
        ]);
    });

    test("names a connection of an environment that has several, and ignores a test environment, where it is off anyway", () => {
        h.configure({
            connections: {
                production: {
                    orders: { uri: "mongodb://orders.example.com:27017", user: "u", password: "pass:mongo/production" },
                    billing: {
                        uri: "mongodb://billing.example.com:27017",
                        user: "u",
                        password: "pass:mongo/production",
                        requireIndex: false,
                    },
                },
                staging: {
                    uri: "mongodb://db.staging.example.com:27017",
                    user: "u",
                    password: "pass:mongo/staging",
                    requireIndex: false,
                },
            },
            access: {
                production: {
                    orders: { allow: { "orders.orders": ["_id"] } },
                    billing: { allow: { "orders.orders": ["_id"] } },
                },
            },
        });
        assert.deepEqual(lines(), [
            "jig-mongo: the index check is OFF for production/billing (requireIndex: false in your jig.json): reads there may scan whole collections",
        ]);
    });

    test("says nothing when the section is not valid", () => {
        h.jig.setSection("mongo", { connections: { production: { requireIndex: false } } });
        assert.deepEqual(lines(), []);
    });
});

describe("a check that cannot be made", () => {
    const refusal = async () => (await h.call(find("production", { filter: { status: "open" } }))).error?.message ?? "";

    test("is a refusal when the user may not explain: the read is not sent", async () => {
        h.backend.answers.explain = () => {
            throw driverError("MongoServerError", "not authorized on orders to execute command", { code: 13 });
        };
        assert.equal(
            await refusal(),
            "mongo find production orders.orders: refused, the index check could not be made (the database user cannot do this in production (Unauthorized): it needs another role), and a read here is not sent without it. Nothing was read.",
        );
        assert.deepEqual(asked(), ["explain"]);
        assert.deepEqual(h.backend.of("find"), []);
    });

    test("is a refusal for any other failure of the planner too, with no server text in production", async () => {
        h.backend.answers.explain = () => {
            throw driverError("MongoServerError", "customer 4111 not found", { code: 8000, codeName: "AtlasError" });
        };
        const message = await refusal();
        assert.match(
            message,
            /refused, the index check could not be made \(the database rejected the request \(AtlasError\)\)/,
        );
        assert.ok(!message.includes("4111"));
        h.backend.answers.explain = () => {
            throw driverError("MongoNetworkError");
        };
        assert.match(
            await refusal(),
            /refused, the index check could not be made \(the connection to the database dropped\)/,
        );
    });

    test("is not worded as a refusal when the call ran out of time or was cancelled", async () => {
        const control = new AbortController();
        h.backend.answers.explain = () => {
            control.abort();
            throw driverError("AbortError", "aborted");
        };
        const result = await h.call(find("production", { filter: { status: "open" } }), { signal: control.signal });
        assert.equal(
            result.error?.message,
            "mongo find production orders.orders: the call hit its time limit or was cancelled",
        );
    });
});
