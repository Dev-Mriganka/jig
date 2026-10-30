// Against a real MongoDB, only when JIG_TEST_MONGO_URI is set: every action once, through the driver. Use a server you may write test
// data to; each run makes a database of its own and drops it at the end. A URI with a user and password also runs the tool itself
// (the section's `uri` never holds them, so they are split off), and one without runs the driver seam alone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";
import type { Backend } from "../src/backend.ts";
import { toExtended, typeName } from "../src/bson.ts";
import { connectDriver } from "../src/driver.ts";
import { summarizeExplain } from "../src/explain.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const given = process.env.JIG_TEST_MONGO_URI;
const skip =
    given === undefined || given === "" ? "set JIG_TEST_MONGO_URI to a MongoDB you may write test data to" : false;

/** The address without its user and password, and the user and password. */
function split(uri: string): { uri: string; user: string; password: string } {
    const match = /^(mongodb:\/\/)(?:([^:@/]*)(?::([^@/]*))?@)?(.*)$/.exec(uri);
    if (match === null) throw new Error("JIG_TEST_MONGO_URI must be a mongodb:// address");
    return {
        uri: `${match[1]}${match[4]}`,
        user: decodeURIComponent(match[2] ?? ""),
        password: decodeURIComponent(match[3] ?? ""),
    };
}

describe("against a real MongoDB", { skip }, () => {
    const server = split(given ?? "mongodb://127.0.0.1:27017");
    const db = `jig_mongo_it_${randomBytes(4).toString("hex")}`;
    const ns = { db, coll: "orders" };
    const req = { maxTimeMS: 10_000 };
    let backend: Backend;
    let raw: MongoClient;

    before(async () => {
        backend = await connectDriver({
            environment: "staging",
            uri: server.uri,
            user: server.user,
            password: server.password,
            production: false,
        });
        raw = new MongoClient(given as string);
        await raw.connect();
    });
    after(async () => {
        await raw?.db(db).dropDatabase();
        await raw?.close();
        await backend?.close();
    });

    test("insert, count, find, distinct, aggregate, sample: typed values go in and come back as Extended JSON", async () => {
        const inserted = await backend.insert(
            {
                ...ns,
                documents: [
                    {
                        _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" },
                        status: "open",
                        qty: 5,
                        big: 3_000_000_000,
                        price: { $numberDecimal: "1.5" },
                        createdAt: { $date: "2026-01-02T03:04:05Z" },
                        notes: "n",
                        items: [{ sku: "a", qty: 1 }],
                    },
                    { status: "open", qty: 7, createdAt: { $date: "2026-01-03T00:00:00Z" } },
                    { status: "closed", qty: 1.5, createdAt: { $date: "2026-01-04T00:00:00Z" } },
                ],
            },
            req,
        );
        assert.equal(inserted.inserted, 3);
        assert.equal(await backend.count({ ...ns, filter: { status: "open" } }, req), 2);
        assert.equal(await backend.count({ ...ns, filter: { status: "open" }, limit: 1 }, req), 1);
        const found = await backend.find(
            {
                ...ns,
                filter: { _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" } },
                projection: { status: 1, big: 1, price: 1, createdAt: 1 },
                limit: 5,
            },
            req,
        );
        assert.deepEqual(toExtended(found), [
            {
                _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" },
                status: "open",
                big: 3_000_000_000,
                price: { $numberDecimal: "1.5" },
                createdAt: { $date: "2026-01-02T03:04:05.000Z" },
            },
        ]);
        const sorted = await backend.find(
            {
                ...ns,
                filter: { createdAt: { $gt: { $date: "2026-01-02T12:00:00Z" } } },
                sort: { createdAt: -1 },
                limit: 5,
            },
            req,
        );
        assert.deepEqual(
            (sorted as Array<{ status: string }>).map((doc) => doc.status),
            ["closed", "open"],
        );
        const values = await backend.aggregate(
            {
                ...ns,
                pipeline: [
                    { $match: {} },
                    { $unwind: "$status" },
                    { $group: { _id: "$status" } },
                    { $sort: { _id: 1 } },
                    { $limit: 5 },
                ],
            },
            req,
        );
        assert.deepEqual(values, [{ _id: "closed" }, { _id: "open" }]);
        const grouped = await backend.aggregate(
            { ...ns, pipeline: [{ $group: { _id: "$status", total: { $sum: "$qty" } } }, { $sort: { _id: 1 } }] },
            req,
        );
        assert.deepEqual(grouped, [
            { _id: "closed", total: 1.5 },
            { _id: "open", total: 12 },
        ]);
        assert.equal((await backend.aggregate({ ...ns, pipeline: [{ $sample: { size: 2 } }] }, req)).length, 2);
    });

    test("typed sampling tells an int from a double, a long, a decimal and a date", async () => {
        const docs = await backend.aggregate(
            { ...ns, pipeline: [{ $match: { qty: { $in: [5, 1.5] } } }], typed: true },
            req,
        );
        const types = new Set((docs as Array<Record<string, unknown>>).map((doc) => typeName(doc.qty)));
        assert.deepEqual([...types].sort(), ["double", "int"]);
        const first = (docs as Array<Record<string, unknown>>).find((doc) => doc.big !== undefined) as Record<
            string,
            unknown
        >;
        assert.deepEqual(
            [typeName(first._id), typeName(first.big), typeName(first.price), typeName(first.createdAt)],
            ["objectId", "long", "decimal", "date"],
        );
    });

    test("indexes: create, list, statistics, explain with an index, drop", async () => {
        assert.equal(
            await backend.createIndex(
                { ...ns, keys: { status: 1, createdAt: -1 }, options: { name: "by_status" } },
                req,
            ),
            "by_status",
        );
        const indexes = await backend.indexes(ns, req);
        assert.deepEqual(indexes.map((index) => index.name).sort(), ["_id_", "by_status"]);
        assert.ok((await backend.indexStats(ns, req)).some((index) => index.name === "by_status"));
        const explained = await backend.explain(
            { ...ns, verbosity: "executionStats", filter: { status: "open" }, limit: 5 },
            req,
        );
        const lines = summarizeExplain(toExtended(explained) as Record<string, unknown>);
        assert.match(lines[0] as string, /IXSCAN\(by_status\)/);
        assert.match(lines.at(-1) as string, /^executed: returned 2 documents/);
        const scanned = await backend.explain({ ...ns, verbosity: "queryPlanner", filter: { qty: 5 } }, req);
        assert.match(summarizeExplain(toExtended(scanned) as Record<string, unknown>).join("\n"), /COLLSCAN/);
        await backend.dropIndex({ ...ns, name: "by_status" }, req);
        assert.deepEqual(
            (await backend.indexes(ns, req)).map((index) => index.name),
            ["_id_"],
        );
    });

    test("update, replace, delete and bulk report what the server counted", async () => {
        assert.deepEqual(
            await backend.update(
                { ...ns, filter: { status: "open" }, update: { $set: { status: "shipped" } }, many: true },
                req,
            ),
            { matched: 2, modified: 2 },
        );
        assert.deepEqual(
            await backend.update(
                { ...ns, filter: { status: "shipped" }, update: [{ $set: { tag: "p" } }], many: false },
                req,
            ),
            { matched: 1, modified: 1 },
        );
        assert.deepEqual(
            await backend.replace({ ...ns, filter: { status: "closed" }, replacement: { status: "void" } }, req),
            { matched: 1, modified: 1 },
        );
        assert.deepEqual(await backend.remove({ ...ns, filter: { status: "void" }, many: false }, req), { deleted: 1 });
        const bulk = await backend.bulk(
            {
                ...ns,
                operations: [
                    { insertOne: { document: { status: "b1" } } },
                    { updateMany: { filter: { status: "shipped" }, update: { $set: { x: 1 } } } },
                    { deleteOne: { filter: { status: "b1" } } },
                ],
            },
            req,
        );
        assert.deepEqual(bulk, { inserted: 1, matched: 2, modified: 2, deleted: 1 });
        assert.equal(await backend.count({ ...ns, filter: { status: "shipped" } }, req), 2);
    });

    test("$out writes a collection, which is counted; a view and the listings and statistics", async () => {
        await backend.aggregate({ ...ns, pipeline: [{ $match: { status: "shipped" } }, { $out: "archive" }] }, req);
        assert.equal(await backend.count({ db, coll: "archive", filter: {} }, req), 2);
        assert.deepEqual((await backend.collections(db, req)).map((entry) => entry.name).sort(), ["archive", "orders"]);
        assert.ok((await backend.databases(req)).includes(db));
        const stats = await backend.collStats(ns, req);
        assert.equal((stats.storageStats as { count: number }).count, 2);
        assert.ok(((await backend.dbStats(db, req)).collections as number) >= 2);
    });

    const tool =
        server.user === "" ? { skip: "give a user and password in JIG_TEST_MONGO_URI to run the tool itself" } : {};
    describe("the tool itself", tool, () => {
        let h: Harness;
        const target = { environment: "staging", database: db, collection: "tool" };
        before(() => {
            h = setupHarness({ connect: connectDriver });
            h.jig.secrets.set("pass:it/db", server.password);
            h.configure({
                connections: { staging: { uri: server.uri, user: server.user, password: "pass:it/db" } },
                access: { staging: { deny: ["*.notes"] } },
            });
        });
        after(async () => h?.close());

        test("a write asks with a count, runs once, and a count that moved is refused", async () => {
            // A document with a denied field cannot be written through the tool, so this one is written beside it.
            assert.match(
                (await h.call({ action: "insert", ...target, documents: [{ status: "stuck", notes: "n" }] })).blocked ??
                    "",
                /"notes" is denied by the access list/,
            );
            await raw.db(db).collection("tool").insertOne({ status: "stuck", notes: "n" });
            assert.match(
                ok(await h.call({ action: "insert", ...target, documents: [{ status: "stuck" }] })),
                /inserted 1 document/,
            );
            const update = {
                action: "update",
                ...target,
                filter: { status: "stuck" },
                update: { $set: { status: "shipped" } },
                which: "many",
            };
            const moved = await h.call(update, {
                between: async () => void (await raw.db(db).collection("tool").insertOne({ status: "stuck" })),
            });
            assert.match(
                moved.error?.message ?? "",
                /changed since the preview \(it was 2 documents match; now 3 documents match\)/,
            );
            assert.equal(await raw.db(db).collection("tool").countDocuments({ status: "shipped" }), 0);
            const done = await h.call(update);
            assert.match(ok(done), /matched 3 documents, modified 3/);
            assert.match(done.preview?.summary ?? "", /3 documents match/);
        });

        test("a read strips what is denied, and the system databases are not listed", async () => {
            const found = ok(await h.call({ action: "find", ...target, filter: { status: "shipped" }, limit: 5 }));
            assert.ok(!found.includes("notes"), found);
            assert.match(found, /3 documents/);
            const databases = ok(await h.call({ action: "databases", environment: "staging" }));
            for (const hidden of ["admin", "local", "config"])
                assert.ok(!databases.split("\n").includes(hidden), hidden);
            assert.ok(databases.split("\n").includes(db));
            assert.match(ok(await h.call({ action: "schema", ...target })), /status: string \(in 3 of 3\)/);
            assert.match(
                ok(await h.call({ action: "explain", ...target, filter: { status: "shipped" } })),
                /plan: LIMIT > COLLSCAN\n.*warning: COLLSCAN/s,
            );
            assert.match((await h.call({ action: "find", ...target, filter: { notes: "n" } })).blocked ?? "", /denied/);
        });

        test("production reads only what the allow list names, whatever the query, through a real server", async () => {
            const shop = raw.db(db);
            await shop.collection("lines").insertMany([
                {
                    _id: 1 as never,
                    status: "open",
                    qty: 3,
                    internal: "hidden",
                    items: [{ sku: "a", cost: 9 }],
                    customerId: 7,
                },
                {
                    _id: 2 as never,
                    status: "open",
                    qty: 4,
                    internal: "hidden",
                    items: [{ sku: "b", cost: 8 }],
                    customerId: 7,
                },
                { _id: 3 as never, status: "closed", qty: 5, internal: "hidden", items: [], customerId: 8 },
            ]);
            await shop.collection("people").insertMany([
                { _id: 7 as never, name: "Ada", dob: "1815" },
                { _id: 8 as never, name: "Bob", dob: "1816" },
            ]);
            const section = {
                connections: {
                    staging: { uri: server.uri, user: server.user, password: "pass:it/db" },
                    production: { uri: server.uri, user: server.user, password: "pass:it/db" },
                },
                access: {
                    staging: { deny: ["*.notes"] },
                    production: {
                        allow: {
                            [`${db}.lines`]: ["_id", "status", "items.sku", "customerId"],
                            [`${db}.people`]: ["_id", "name"],
                        },
                    },
                },
            };
            h.configure(section);
            const lines = { environment: "production", database: db, collection: "lines" };
            const found = ok(await h.call({ action: "find", ...lines, filter: { status: "open" }, sort: { _id: 1 } }));
            assert.match(found, /2 documents/);
            for (const hidden of ["qty", "internal", "cost", "hidden"])
                assert.ok(!found.includes(hidden), `${hidden} in ${found}`);
            assert.match(found, /"items":\[\{"sku":"a"\}\]/);
            assert.match(
                (await h.call({ action: "find", ...lines, filter: { qty: 3 } })).blocked ?? "",
                /"qty" is not allowed/,
            );
            const grouped = ok(
                await h.call({
                    action: "aggregate",
                    ...lines,
                    pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
                }),
            );
            assert.match(grouped, /\{"_id":"closed","n":1\}\n\{"_id":"open","n":2\}/);
            const simple = ok(
                await h.call({
                    action: "aggregate",
                    ...lines,
                    pipeline: [
                        { $match: { _id: 1 } },
                        { $lookup: { from: "people", localField: "customerId", foreignField: "_id", as: "person" } },
                    ],
                }),
            );
            assert.match(simple, /"person":\[\{"_id":7,"name":"Ada"\}\]/);
            assert.ok(!simple.includes("1815"), "the looked-up collection is cut to its allowed fields");
            const piped = ok(
                await h.call({
                    action: "aggregate",
                    ...lines,
                    pipeline: [
                        { $match: { _id: 2 } },
                        {
                            $lookup: {
                                from: "people",
                                let: { c: "$customerId" },
                                pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$c"] } } }],
                                as: "person",
                            },
                        },
                    ],
                }),
            );
            assert.match(piped, /"person":\[\{"_id":7,"name":"Ada"\}\]/);
            assert.ok(!piped.includes("1815"));
            assert.match(
                ok(await h.call({ action: "distinct", ...lines, field: "status" })),
                /2 values\n"closed"\n"open"/,
            );
            assert.match(ok(await h.call({ action: "schema", ...lines })), /status: string \(in 3 of 3\)/);
            assert.ok(!ok(await h.call({ action: "schema", ...lines })).includes("internal"));
            assert.ok(!ok(await h.call({ action: "sample", ...lines })).includes("hidden"));
            assert.match(
                ok(await h.call({ action: "count", ...lines, filter: { status: "open" } })),
                /2 documents match/,
            );
            assert.match(
                (await h.call({ action: "aggregate", ...lines, pipeline: [{ $project: { x: "$internal" } }] }))
                    .blocked ?? "",
                /"internal" is not allowed/,
            );
            assert.match(
                (await h.call({ action: "aggregate", ...lines, pipeline: [{ $addFields: { all: "$$ROOT" } }] }))
                    .blocked ?? "",
                /whole document/,
            );
            assert.match(
                (await h.call({ action: "delete", ...lines, filter: { status: "open" }, which: "many" })).blocked ?? "",
                /production is production, which is read-only/,
            );
            const databases = ok(await h.call({ action: "databases", environment: "production" }));
            assert.deepEqual(databases.split("\n").slice(1), [db]);
        });

        test("an index change and a pipeline that writes: previewed, run, and checked", async () => {
            assert.match(
                ok(await h.call({ action: "create-index", ...target, keys: { status: 1 } })),
                /created the index status_1/,
            );
            assert.match(
                ok(await h.call({ action: "explain", ...target, filter: { status: "shipped" } })),
                /IXSCAN\(status_1\)/,
            );
            assert.match(
                ok(
                    await h.call({
                        action: "aggregate",
                        ...target,
                        pipeline: [{ $match: { status: "shipped" } }, { $out: "tool_copy" }],
                    }),
                ),
                /\$out wrote 3 documents to .*tool_copy/,
            );
            assert.match(
                ok(await h.call({ action: "drop-index", ...target, name: "status_1" })),
                /dropped the index status_1/,
            );
            assert.match(
                ok(await h.call({ action: "delete", ...target, filter: { status: "shipped" }, which: "many" })),
                /deleted 3 documents/,
            );
        });
    });
});
