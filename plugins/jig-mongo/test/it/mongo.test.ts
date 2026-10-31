// jig-mongo against a real MongoDB replica set with authentication on, reached directly (a member's published port, with
// `directConnection`). Every action runs through the tool and the driver, and what a write did is read back with a client of the
// test's own, so a result is never taken on the tool's word. Access lists, the production allow list, `$lookup` cut to allowed
// fields and the errors a real server gives are proved here; the routes (ssh and SOCKS) have their own files.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Decimal128, Long, ObjectId } from "mongodb";
import type { MongoClient } from "mongodb";
import { createMasker } from "../../../jig-core/src/mask/index.ts";
import { describeIt, must } from "../../../../test/support/it.ts";
import { ok } from "../support/harness.ts";
import { accounts, connection, rawClient, realHarness } from "../support/real.ts";
import type { Harness } from "../support/harness.ts";

describeIt(
    "jig-mongo against a MongoDB replica set, reached directly",
    {
        service: "mongodb",
        variables: [
            "JIG_IT_MONGO_DIRECT_URI",
            "JIG_IT_MONGO_USER",
            "JIG_IT_MONGO_READONLY_USER",
            "JIG_IT_MONGO_PASSWORD",
        ],
        hint: "a MongoDB 7 or 8 replica set with authentication on, and a user that writes and one that reads",
    },
    () => {
        const db = `jigit_${randomBytes(4).toString("hex")}`;
        const uri = () => must("JIG_IT_MONGO_DIRECT_URI");
        const who = () => accounts();
        let raw: MongoClient;

        const FIRST = new ObjectId("65f1f1f1f1f1f1f1f1f1f1f1");
        const SECOND = new ObjectId("65f1f1f1f1f1f1f1f1f1f1f2");

        /** The `mongo` section: a test environment with a deny list, and production with an allow list. */
        const section = (staging: Record<string, unknown> = connection(uri(), who().user)) => ({
            connections: {
                staging,
                production: connection(uri(), who().readonlyUser),
                // Production with the index check switched off, which only the person who writes jig.json can do.
                "production-scan": connection(uri(), who().readonlyUser, { requireIndex: false }),
                // A user that may only read, in a test environment, to see what the server says to a write.
                reader: connection(uri(), who().readonlyUser),
            },
            access: {
                staging: { deny: [`${db}.secrets`, "*.internalNote"] },
                reader: { deny: [] },
                production: {
                    allow: {
                        [`${db}.orders`]: ["_id", "status", "total", "customer", "contactEmail", "createdAt"],
                        // A small collection that is read whole, so the index check leaves it alone.
                        [`${db}.customers`]: { fields: ["_id", "name"], reference: true },
                    },
                },
                "production-scan": {
                    allow: { [`${db}.orders`]: ["_id", "status", "total", "customer", "contactEmail", "createdAt"] },
                },
            },
        });

        const harness = (t: import("node:test").TestContext): Harness => {
            const h = realHarness(t, section());
            // `reader` is a test environment for jig-core, as `staging` is.
            h.jig.kinds.set("reader", "test");
            h.jig.kinds.set("production-scan", "production");
            return h;
        };
        const on = (collection: string, environment = "staging") => ({ environment, database: db, collection });

        before(async () => {
            raw = await rawClient(uri());
            const info = await raw.db("admin").command({ buildInfo: 1 });
            console.log(`MongoDB ${info.version}`);
            const orders = raw.db(db).collection("orders");
            await orders.insertMany([
                {
                    _id: FIRST,
                    status: "open",
                    total: Decimal128.fromString("19.99"),
                    qty: Long.fromString("9007199254740993"),
                    createdAt: new Date("2026-01-02T03:04:05Z"),
                    customer: "c1",
                    contactEmail: "jane@example.com",
                    internalNote: "keep out",
                    secretToken: "zz-not-for-the-model",
                    items: [{ sku: "a", qty: 1 }],
                },
                {
                    _id: SECOND,
                    status: "open",
                    total: Decimal128.fromString("5.00"),
                    qty: 1,
                    createdAt: new Date("2026-01-03T00:00:00Z"),
                    customer: "c2",
                    contactEmail: "bob@example.com",
                    internalNote: "n2",
                },
                {
                    status: "closed",
                    total: Decimal128.fromString("7.50"),
                    qty: 2.5,
                    createdAt: new Date("2026-01-04T00:00:00Z"),
                    customer: "c1",
                    contactEmail: "jane@example.com",
                },
            ]);
            // The indexes the production reads below are served by: production refuses a read that scans the collection.
            await orders.createIndexes([{ key: { status: 1 } }, { key: { customer: 1 } }, { key: { createdAt: 1 } }]);
            await raw
                .db(db)
                .collection("customers")
                .insertMany([
                    { _id: "c1" as never, name: "Ada Lovelace", email: "ada@example.com", plan: "gold" },
                    { _id: "c2" as never, name: "Bob Barker", email: "bob@example.com", plan: "free" },
                ]);
            await raw
                .db(db)
                .collection("secrets")
                .insertOne({ _id: 1 as never, value: "hidden" });
            await raw
                .db(db)
                .createCollection("open_orders", { viewOn: "orders", pipeline: [{ $match: { status: "open" } }] });
            await raw.db(db).createCollection("metrics", { timeseries: { timeField: "ts" } });
        });

        after(async () => {
            await raw?.db(db).dropDatabase();
            await raw?.close();
        });

        test("databases and collections show what exists, minus what is always denied and what the list denies", async (t) => {
            const h = harness(t);
            const databases = ok(await h.call({ action: "databases", environment: "staging" }));
            assert.match(databases, new RegExp(`^mongo databases staging: \\d+ databases?\\n(?:.*\\n)*?${db}`));
            for (const hidden of ["admin", "local", "config"])
                assert.doesNotMatch(databases, new RegExp(`^${hidden}$`, "m"));
            const collections = ok(await h.call({ action: "collections", environment: "staging", database: db }));
            assert.equal(
                collections,
                `mongo collections staging ${db}: 4 collections\ncustomers\nmetrics (timeseries)\nopen_orders (view)\norders`,
            );
            const admin = await h.call({ action: "collections", environment: "staging", database: "admin" });
            assert.equal(admin.blocked, "admin: the databases admin, local and config are always denied");
        });

        test("find returns typed values as Extended JSON, strips denied fields, and a result at its limit says so", async (t) => {
            const h = harness(t);
            const found = ok(
                await h.call({ action: "find", ...on("orders"), filter: { _id: { $oid: FIRST.toHexString() } } }),
            );
            const [header, line] = found.split("\n");
            assert.equal(header, `mongo find staging ${db}.orders: 1 document`);
            assert.deepEqual(JSON.parse(line ?? ""), {
                _id: { $oid: FIRST.toHexString() },
                status: "open",
                total: { $numberDecimal: "19.99" },
                qty: { $numberLong: "9007199254740993" },
                createdAt: { $date: "2026-01-02T03:04:05.000Z" },
                customer: "c1",
                contactEmail: "jane@example.com",
                items: [{ sku: "a", qty: 1 }],
            });
            assert.doesNotMatch(found, /internalNote|secretToken|zz-not-for-the-model/);

            const sorted = ok(
                await h.call({
                    action: "find",
                    ...on("orders"),
                    filter: { createdAt: { $gt: { $date: "2026-01-02T12:00:00Z" } } },
                    sort: { createdAt: -1 },
                    projection: { status: 1 },
                    limit: 1,
                }),
            );
            assert.match(sorted, /possibly partial \(limit 1 reached; narrow the filter or raise limit\)/);
            assert.match(sorted.split("\n")[1] ?? "", /^\{"_id":\{"\$oid":"[0-9a-f]{24}"\},"status":"closed"\}$/);
        });

        test("count, distinct, sample, aggregate and schema read the real collection", async (t) => {
            const h = harness(t);
            assert.equal(
                ok(await h.call({ action: "count", ...on("orders"), filter: { status: "open" } })),
                `mongo count staging ${db}.orders: 2 documents match (exact)`,
            );
            const distinct = ok(await h.call({ action: "distinct", ...on("orders"), field: "status" }));
            assert.deepEqual(distinct.split("\n").slice(1).sort(), ['"closed"', '"open"']);
            const sample = ok(await h.call({ action: "sample", ...on("orders"), limit: 2 }));
            assert.equal(sample.split("\n").length, 3);
            const grouped = ok(
                await h.call({
                    action: "aggregate",
                    ...on("orders"),
                    pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
                }),
            );
            assert.deepEqual(
                grouped
                    .split("\n")
                    .slice(1)
                    .map((row) => JSON.parse(row)),
                [
                    { _id: "closed", n: 1 },
                    { _id: "open", n: 2 },
                ],
            );
            const schema = ok(await h.call({ action: "schema", ...on("orders") }));
            assert.match(schema, /^createdAt: date \(in 3 of 3\)$/m);
            assert.match(schema, /^total: decimal \(in 3 of 3\)$/m);
            assert.match(schema, /^qty: (int|long|double)[^\n]* \(in 3 of 3\)$/m);
            assert.doesNotMatch(schema, /internalNote|secretToken/);
        });

        test("indexes, explain, stats and index-stats: the plan uses the index that was made", async (t) => {
            const h = harness(t);
            // A collection of its own, so that the indexes the production tests rely on stay as they are.
            await raw
                .db(db)
                .collection("explained")
                .insertMany([
                    {
                        status: "open",
                        total: Decimal128.fromString("19.99"),
                        createdAt: new Date("2026-01-02T03:04:05Z"),
                    },
                    {
                        status: "open",
                        total: Decimal128.fromString("5.00"),
                        createdAt: new Date("2026-01-03T00:00:00Z"),
                    },
                    {
                        status: "closed",
                        total: Decimal128.fromString("7.50"),
                        createdAt: new Date("2026-01-04T00:00:00Z"),
                    },
                ]);
            const created = await h.call({
                action: "create-index",
                ...on("explained"),
                keys: { status: 1, createdAt: -1 },
            });
            assert.equal(
                ok(created),
                `mongo create-index staging ${db}.explained: created the index status_1_createdAt_-1`,
            );
            assert.match(created.preview?.body ?? "", /Existing indexes: _id_\./);
            const indexes = ok(await h.call({ action: "indexes", ...on("explained") }));
            assert.match(indexes, /"name":"status_1_createdAt_-1","key":\{"status":1,"createdAt":-1\}/);
            const explain = ok(await h.call({ action: "explain", ...on("explained"), filter: { status: "open" } }));
            assert.match(explain, /^plan: .*IXSCAN\(status_1_createdAt_-1\)$/m);
            assert.match(explain, /^executed: returned 2 documents, 2 index keys examined, 2 documents examined,/m);
            const collscan = ok(
                await h.call({
                    action: "explain",
                    ...on("explained"),
                    filter: { total: { $gt: { $numberDecimal: "1" } } },
                }),
            );
            assert.match(collscan, /COLLSCAN/);
            const stats = ok(await h.call({ action: "stats", ...on("explained") }));
            assert.match(stats, /"count":3,.*"nindexes":2,/);
            const used = ok(await h.call({ action: "index-stats", ...on("explained") }));
            assert.match(used, /status_1_createdAt_-1/);
            // The user that may only read lacks the privilege of $indexStats, and the tool says whose it is to fix.
            const denied = await h.call({ action: "index-stats", ...on("explained", "reader") });
            assert.equal(
                denied.error?.message,
                `mongo index-stats reader ${db}.explained: the database user cannot do this in reader (Unauthorized): it needs another role`,
            );
            const dropped = await h.call({ action: "drop-index", ...on("explained"), name: "status_1_createdAt_-1" });
            assert.match(ok(dropped), /dropped the index status_1_createdAt_-1/);
            assert.equal((await raw.db(db).collection("explained").indexes()).length, 1);
        });

        test("a write shows its preview with the count and a fingerprint, runs once, and the server holds the change", async (t) => {
            const h = harness(t);
            const work = raw.db(db).collection("work");
            await work.insertMany([
                { n: 1, state: "stuck" },
                { n: 2, state: "stuck" },
                { n: 3, state: "fine" },
            ]);
            const update = {
                action: "update",
                ...on("work"),
                filter: { state: "stuck" },
                update: { $set: { state: "shipped" } },
                which: "many",
            };
            const result = await h.call(update);
            assert.equal(ok(result), `mongo update staging ${db}.work: matched 2 documents, modified 2`);
            assert.equal(result.preview?.summary, `update many in ${db}.work (staging): 2 documents match`);
            assert.match(result.preview?.fingerprint ?? "", /^[0-9a-f]{64}$/);
            assert.match(result.preview?.body ?? "", /Matches now: 2 documents \(counted just before this preview\)\./);
            assert.equal(await work.countDocuments({ state: "shipped" }), 2);
            assert.equal(await work.countDocuments({ state: "fine" }), 1);

            // One written once: the retry the driver would make is off, so the server saw one update.
            assert.deepEqual(h.jig.facts.get(result.id)?.[0], { matched: 2, modified: 2 });

            const removed = await h.call({
                action: "delete",
                ...on("work"),
                filter: { state: "shipped" },
                which: "many",
            });
            assert.equal(ok(removed), `mongo delete staging ${db}.work: deleted 2 documents`);
            assert.equal(await work.countDocuments({}), 1);
            const replaced = await h.call({
                action: "replace",
                ...on("work"),
                filter: { n: 3 },
                replacement: { n: 3, state: "replaced" },
            });
            assert.match(ok(replaced), /matched 1 document, modified 1/);
            assert.deepEqual(await work.findOne({ n: 3 }, { projection: { _id: 0 } }), { n: 3, state: "replaced" });
            const bulk = await h.call({
                action: "bulk",
                ...on("work"),
                operations: [
                    { insertOne: { document: { n: 4 } } },
                    { updateOne: { filter: { n: 3 }, update: { $set: { state: "bulk" } } } },
                ],
            });
            assert.match(ok(bulk), /inserted 1/);
            assert.equal(await work.countDocuments({ n: 4 }), 1);
            assert.equal(await work.countDocuments({ state: "bulk" }), 1);
        });

        test("a write whose count changed while the person read the preview is refused, and nothing is changed", async (t) => {
            const h = harness(t);
            const work = raw.db(db).collection("changing");
            await work.insertMany([{ k: "x" }, { k: "x" }]);
            const result = await h.call(
                {
                    action: "update",
                    ...on("changing"),
                    filter: { k: "x" },
                    update: { $set: { k: "y" } },
                    which: "many",
                },
                { between: async () => void (await work.insertOne({ k: "x" })) },
            );
            assert.equal(
                result.error?.message,
                `mongo update staging ${db}.changing: changed since the preview (it was 2 documents match; now 3 documents match). Nothing was changed; run it again to see the new preview.`,
            );
            assert.equal(await work.countDocuments({ k: "y" }), 0);
        });

        test("the guards: an empty filter, a filter that matches nothing, and more documents than the cap are refused before anything is sent", async (t) => {
            const h = harness(t);
            const work = raw.db(db).collection("guards");
            await work.insertMany(Array.from({ length: 5 }, (_, n) => ({ n })));
            const empty = await h.call({
                action: "update",
                ...on("guards"),
                filter: {},
                update: { $set: { a: 1 } },
                which: "many",
            });
            assert.match(
                empty.blocked ?? empty.error?.message ?? "",
                /the filter is empty, so it would change every document/,
            );
            const none = await h.call({ action: "delete", ...on("guards"), filter: { n: 99 }, which: "many" });
            assert.match(
                none.blocked ?? none.error?.message ?? "",
                /no document matches the filter, so nothing would change/,
            );
            const capped = await h.call({
                action: "delete",
                ...on("guards"),
                filter: { n: { $gte: 0 } },
                which: "many",
                limit: 3,
            });
            assert.match(capped.blocked ?? capped.error?.message ?? "", /3/);
            assert.equal(await work.countDocuments({}), 5);
        });

        test("a duplicate key is the server's rejection: nothing changed for one document, and part may have for several", async (t) => {
            const h = harness(t);
            const work = raw.db(db).collection("dups");
            await work.insertOne({ _id: "a" as never });
            const one = await h.call({ action: "insert", ...on("dups"), documents: [{ _id: "a" }] });
            assert.match(
                one.error?.message ?? "",
                new RegExp(
                    `^mongo insert staging ${db}\\.dups: the database rejected the request \\(code 11000, a duplicate key\\): .*E11000 duplicate key.*Nothing was changed\\.$`,
                ),
            );
            const several = await h.call({
                action: "insert",
                ...on("dups"),
                documents: [{ _id: "b" }, { _id: "a" }, { _id: "c" }],
            });
            const message = several.error?.message ?? "";
            assert.match(message, /a duplicate key\)/);
            assert.match(message, /Part of it may have been carried out\. It was not sent again\./);
            assert.doesNotMatch(message, /no answer|driver failed/);
            // The check reads by _id, so the document that was already there ("a") counts with the one that went in ("b").
            assert.match(message, /Read once to check: 2 of the 3 inserted documents are present/);
            assert.deepEqual(
                (await work.find({}).sort({ _id: 1 }).toArray()).map((doc) => doc._id),
                ["a", "b"],
            );
        });

        test("the access list of a test environment: a denied collection, a denied field in a filter, and a credential-like field are refused", async (t) => {
            const h = harness(t);
            const denied = await h.call({ action: "find", ...on("secrets") });
            assert.equal(denied.blocked, `${db}.secrets is denied by the access list`);
            const field = await h.call({ action: "find", ...on("orders"), filter: { internalNote: "keep out" } });
            assert.equal(field.blocked, '"internalNote" is denied by the access list');
            const rename = await h.call({
                action: "aggregate",
                ...on("orders"),
                pipeline: [{ $project: { x: "$secretToken" } }],
            });
            assert.match(rename.blocked ?? "", /^"secretToken" looks like a credential/);
            const lookup = await h.call({
                action: "aggregate",
                ...on("orders"),
                pipeline: [{ $lookup: { from: "secrets", localField: "customer", foreignField: "_id", as: "x" } }],
            });
            assert.equal(lookup.blocked, `${db}.secrets is denied by the access list`);
            const written = await h.call({ action: "insert", ...on("secrets"), documents: [{ a: 1 }] });
            assert.equal(written.blocked, `${db}.secrets is denied by the access list`);
            assert.equal(await raw.db(db).collection("secrets").countDocuments({}), 1);
        });

        test("production reads only what the allow list names, refuses everything else, and cannot be written to", async (t) => {
            const h = harness(t);
            // `status` leads an index, so production allows the read.
            const found = ok(
                await h.call({
                    action: "find",
                    ...on("orders", "production"),
                    filter: { status: { $in: ["open", "closed"] } },
                }),
            );
            const rows = found
                .split("\n")
                .slice(1)
                .map((line) => JSON.parse(line));
            assert.equal(rows.length, 3);
            for (const row of rows) {
                assert.ok(
                    Object.keys(row).every((key) =>
                        ["_id", "status", "total", "customer", "contactEmail", "createdAt"].includes(key),
                    ),
                    JSON.stringify(row),
                );
            }
            assert.doesNotMatch(found, /internalNote|secretToken|items|qty/);
            const notListed = await h.call({ action: "find", ...on("secrets", "production") });
            assert.equal(
                notListed.blocked,
                `${db}.secrets is not in the allow list; allowed: ${db}.orders, ${db}.customers`,
            );
            const field = await h.call({ action: "find", ...on("orders", "production"), filter: { qty: 1 } });
            assert.match(field.blocked ?? "", /^"qty" is not allowed in /);
            for (const input of [
                { action: "insert", ...on("orders", "production"), documents: [{ a: 1 }] },
                {
                    action: "update",
                    ...on("orders", "production"),
                    filter: { status: "open" },
                    update: { $set: { a: 1 } },
                    which: "many",
                },
                { action: "create-index", ...on("orders", "production"), keys: { a: 1 } },
            ]) {
                const write = await h.call(input);
                assert.match(
                    write.blocked ?? "",
                    /production is production, which is read-only: .* is not allowed there/,
                );
            }
            assert.equal(await raw.db(db).collection("orders").countDocuments({ a: 1 }), 0);
        });

        test("production refuses a read the server would answer by scanning the collection, and allows one an index serves", async (t) => {
            const h = harness(t);
            const orders = on("orders", "production");
            // The plan is the real server's. Reads that an index serves are allowed.
            assert.match(ok(await h.call({ action: "find", ...orders, filter: { status: "closed" } })), /1 document/);
            assert.match(
                ok(await h.call({ action: "count", ...orders, filter: { customer: "c1" } })),
                /2 documents match/,
            );
            assert.match(
                ok(await h.call({ action: "find", ...orders, filter: { _id: { $oid: FIRST.toHexString() } } })),
                /1 document/,
            );
            assert.match(
                ok(await h.call({ action: "find", ...orders, sort: { createdAt: -1 }, limit: 2 })),
                /2 documents/,
                "a sort an index serves, with a limit, reads no more than the limit",
            );
            assert.match(
                ok(
                    await h.call({
                        action: "aggregate",
                        ...orders,
                        pipeline: [{ $match: { status: "open" } }, { $group: { _id: "$customer", n: { $sum: 1 } } }],
                    }),
                ),
                /"n":1/,
            );
            assert.match(
                ok(await h.call({ action: "distinct", ...orders, field: "status", filter: { status: "open" } })),
                /open/,
            );

            // A field no index leads with is a COLLSCAN in the winning plan, and the refusal names the fields that do lead one.
            const scan = await h.call({ action: "find", ...orders, filter: { contactEmail: "jane@example.com" } });
            assert.equal(
                scan.error?.message,
                `mongo find production ${db}.orders: refused, the plan scans the whole collection (COLLSCAN), and reads in production must use an index. ` +
                    "Filter on a field an index leads with: _id, status, customer, createdAt.",
            );
            assert.equal(scan.text, "");
            // The rest of the reads that would scan: no filter, a count with none, an aggregation that opens with an unindexed group.
            assert.match(
                (await h.call({ action: "find", ...orders })).error?.message ?? "",
                /refused, the plan scans the whole collection \(COLLSCAN\).* To see what the documents look like, use sample\.$/,
            );
            assert.match(
                (await h.call({ action: "count", ...orders })).error?.message ?? "",
                /refused, with no filter it reads every document.* For the size of the collection, use stats\.$/,
            );
            assert.match(
                (await h.call({ action: "count", ...orders, filter: { contactEmail: "jane@example.com" } })).error
                    ?.message ?? "",
                /refused, the plan scans the whole collection/,
            );
            assert.match(
                (await h.call({ action: "aggregate", ...orders, pipeline: [{ $group: { _id: "$contactEmail" } }] }))
                    .error?.message ?? "",
                /refused, the plan scans the whole collection/,
            );
            assert.match(
                (await h.call({ action: "distinct", ...orders, field: "contactEmail" })).error?.message ?? "",
                /refused, the plan scans the whole collection/,
            );
            // Only the connection's owner can turn the check off, and the same read then runs.
            const off = on("orders", "production-scan");
            assert.match(
                ok(await h.call({ action: "find", ...off, filter: { contactEmail: "jane@example.com" } })),
                /2 documents/,
            );
            // A test environment is not checked unless it asks to be.
            assert.match(
                ok(await h.call({ action: "find", ...on("orders"), filter: { contactEmail: "jane@example.com" } })),
                /2 documents/,
            );
            // Reference data is read whole: no filter, no index.
            assert.match(ok(await h.call({ action: "find", ...on("customers", "production") })), /Ada Lovelace/);
            assert.match(ok(await h.call({ action: "count", ...on("customers", "production") })), /2 documents/);
        });

        test("a $lookup in production is cut to the fields the allow list names, on the server", async (t) => {
            const h = harness(t);
            const joined = ok(
                await h.call({
                    action: "aggregate",
                    ...on("orders", "production"),
                    pipeline: [
                        { $match: { customer: "c1" } },
                        { $lookup: { from: "customers", localField: "customer", foreignField: "_id", as: "who" } },
                        { $sort: { _id: 1 } },
                    ],
                }),
            );
            const rows = joined
                .split("\n")
                .slice(1)
                .map((line) => JSON.parse(line));
            assert.equal(rows.length, 2);
            for (const row of rows) {
                assert.deepEqual(
                    row.who,
                    [{ _id: "c1", name: "Ada Lovelace" }],
                    "the joined customer has no email and no plan",
                );
                assert.equal(row.internalNote, undefined);
            }
            // The names that would reach the denied part by another road are refused before they run.
            for (const stage of [
                { $project: { x: { $getField: "internalNote" } } },
                { $unionWith: "secrets" },
                {
                    $lookup: {
                        from: "customers",
                        localField: "customer",
                        foreignField: "_id",
                        pipeline: [{ $project: { email: 1 } }],
                        as: "x",
                    },
                },
            ]) {
                const refused = await h.call({ action: "aggregate", ...on("orders", "production"), pipeline: [stage] });
                assert.ok(refused.blocked !== undefined, JSON.stringify(stage));
            }
        });

        test("what production returns is masked by jig-core's own masker, and identifiers stay", async (t) => {
            const h = harness(t);
            const classified = h.declaration.classify({ action: "find", ...on("orders", "production") });
            assert.deepEqual(classified, { action: "find", environment: "production", effect: "read" });
            assert.equal(h.jig.kinds.get("production"), "production");
            const masker = createMasker(randomBytes(32));
            const orders = masker.text(
                ok(await h.call({ action: "find", ...on("orders", "production"), filter: { customer: "c1" } })),
            );
            assert.doesNotMatch(orders, /jane@example\.com/);
            assert.match(orders, /"contactEmail":"email#[0-9a-f]{6}"/);
            assert.match(orders, /"_id":\{"\$oid":"65f1f1f1f1f1f1f1f1f1f1f1"\}/);
            const customers = masker.text(ok(await h.call({ action: "find", ...on("customers", "production") })));
            assert.doesNotMatch(customers, /Ada Lovelace/);
            assert.match(customers, /"_id":"c1"/);
        });

        test("the database's own words: a user that may not write, a wrong password, and an address nobody answers", async (t) => {
            const h = harness(t);
            // In a test environment the server's words are shown, cut to a line.
            const forbidden = await h.call({ action: "insert", ...on("orders", "reader"), documents: [{ a: 1 }] });
            assert.match(
                forbidden.error?.message ?? "",
                /^mongo insert reader .*: the database user cannot do this in reader \(Unauthorized\): it needs another role\. Nothing was changed\.$/,
            );

            h.configure(section({ uri: uri(), user: who().user, password: "env:WRONG" }));
            h.jig.secrets.set("env:WRONG", `${accounts().password}-wrong`);
            const refused = await h.call({ action: "count", ...on("orders") });
            assert.equal(
                refused.error?.message,
                `mongo count staging ${db}.orders: the database refused the sign-in for staging: check the user and the password reference`,
            );
            assert.ok(!(refused.error?.message ?? "").includes(accounts().password));

            h.configure(section(connection("mongodb://127.0.0.1:1/?directConnection=true", who().user)));
            const unreachable = await h.call({ action: "count", ...on("orders") });
            assert.equal(
                unreachable.error?.message,
                `mongo count staging ${db}.orders: cannot reach the staging database: check the network, the VPN and the route, then try again`,
            );
        });

        test("the connection is kept for the next call, and closed when the session ends", async (t) => {
            const h = harness(t);
            ok(await h.call({ action: "count", ...on("orders") }));
            const before = h.jig.resolved.length;
            ok(await h.call({ action: "count", ...on("orders") }));
            assert.equal(h.jig.resolved.length, before, "no secret is read again for a connection that is open");
            await h.close();
        });
    },
);
