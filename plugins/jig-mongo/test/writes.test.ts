// A write: the preview with its count and fingerprint, "changed since the preview", the cap, the one send, and what is done when a
// reply is lost. The database is a fake that records each request, so a test sees what was sent and how many times.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { driverError } from "./support/fake-backend.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
beforeEach(() => void (h = setupHarness()));
afterEach(async () => h.close());

const target = { environment: "staging", database: "orders", collection: "orders" };
const update = {
    action: "update",
    ...target,
    filter: { status: "stuck" },
    update: { $set: { status: "shipped" } },
    which: "many",
};
const factsOf = (id: string) => Object.assign({}, ...(h.jig.facts.get(id) ?? []));

describe("a write to a test environment asks, with a preview that counts", () => {
    test("update many: the count is read just before, the preview shows the filter, the change and the count", async () => {
        h.backend.answers.count = 12;
        const result = await h.call(update);
        assert.equal(ok(result), "mongo update staging orders.orders: matched 1 document, modified 1");
        assert.deepEqual(h.backend.of("count")[0]?.query, {
            db: "orders",
            coll: "orders",
            filter: { status: "stuck" },
            limit: 1001,
        });
        assert.deepEqual(result.cls, { action: "update", environment: "staging", effect: "write" });
        const preview = result.preview;
        assert.equal(preview?.summary, "update many in orders.orders (staging): 12 documents match");
        assert.match(preview?.fingerprint ?? "", /^[0-9a-f]{64}$/);
        assert.equal(preview?.format, "text");
        assert.match(preview?.body ?? "", /Environment: staging\n\nCollection: orders\.orders/);
        assert.match(preview?.body ?? "", /Filter:\n\{\n {2}"status": "stuck"\n\}/);
        assert.match(preview?.body ?? "", /Update:\n\{\n {2}"\$set": \{\n {4}"status": "shipped"/);
        assert.match(
            preview?.body ?? "",
            /Matches now: 12 documents \(counted just before this preview\)\.\nThis update changes all 12 documents\.\nCap: at most 1000 documents\./,
        );
    });

    test("the write is sent once, as previewed, and its numbers go to the record", async () => {
        h.backend.answers.count = 12;
        h.backend.answers.update = { matched: 12, modified: 11 };
        const result = await h.call(update);
        assert.equal(ok(result), "mongo update staging orders.orders: matched 12 documents, modified 11");
        assert.deepEqual(
            h.backend.of("update").map((call) => call.query),
            [
                {
                    db: "orders",
                    coll: "orders",
                    filter: { status: "stuck" },
                    update: { $set: { status: "shipped" } },
                    many: true,
                },
            ],
        );
        assert.deepEqual(factsOf(result.id), { matched: 12, modified: 11 });
        assert.deepEqual(result.details, { action: "update", environment: "staging", matched: 12, modified: 11 });
    });

    test("the fingerprint covers the request and the count: the same state gives the same one, a different count or request another", async () => {
        const preview = async (input: Record<string, unknown>, count: number) => {
            h.backend.answers.count = count;
            return (await h.declaration.preview?.(input, new AbortController().signal))?.fingerprint;
        };
        const first = await preview(update, 12);
        assert.equal(await preview(update, 12), first);
        assert.notEqual(await preview(update, 13), first);
        assert.notEqual(await preview({ ...update, filter: { status: "other" } }, 12), first);
        assert.notEqual(await preview({ ...update, update: { $set: { status: "x" } } }, 12), first);
        assert.notEqual(await preview({ ...update, which: "one" }, 12), first);
        assert.notEqual(await preview({ ...update, environment: "staging", database: "shop" }, 12), first);
    });

    test("a read does not ask, and its preview is a line", async () => {
        const result = await h.call({ action: "find", ...target });
        assert.equal(result.preview, undefined);
        assert.equal(h.backend.of("count").length, 0);
        assert.deepEqual(await h.declaration.preview?.({ action: "find", ...target }, new AbortController().signal), {
            summary: "mongo find staging orders.orders",
        });
    });
});

describe("changed since the preview", () => {
    test("a count that changed while the person read the preview: nothing is sent, and the message says what changed", async () => {
        h.backend.answers.count = 12;
        const result = await h.call(update, { between: () => void (h.backend.answers.count = 13) });
        assert.match(
            result.error?.message ?? "",
            /^mongo update staging orders\.orders: changed since the preview \(it was 12 documents match; now 13 documents match\)\. Nothing was changed; run it again to see the new preview\.$/,
        );
        assert.equal(h.backend.of("update").length, 0);
        assert.equal(
            h.backend.calls.filter((call) => ["update", "insert", "remove", "bulk", "replace"].includes(call.method))
                .length,
            0,
        );
    });

    test("a count that is the same is not a change, and a different count with no preview on file is not compared", async () => {
        h.backend.answers.count = 12;
        ok(await h.call(update, { between: () => void (h.backend.answers.count = 12) }));
        h.backend.answers.count = 12;
        const unasked = await h.call(update, { ask: false, between: () => void (h.backend.answers.count = 40) });
        ok(unasked);
        assert.equal(h.backend.of("update").length, 2);
    });

    test("the other writes are compared the same way: insert, delete, bulk, index changes, $out", async () => {
        const cases: Array<[Record<string, unknown>, () => void]> = [
            [
                { action: "delete", ...target, filter: { a: 1 }, which: "many" },
                () => void (h.backend.answers.count = 8),
            ],
            [
                {
                    action: "bulk",
                    ...target,
                    operations: [{ updateMany: { filter: { a: 1 }, update: { $set: { b: 1 } } } }],
                },
                () => void (h.backend.answers.count = 8),
            ],
            [
                { action: "create-index", ...target, keys: { a: 1 } },
                () =>
                    void (h.backend.answers.indexes = [
                        { name: "_id_", key: { _id: 1 } },
                        { name: "x_1", key: { x: 1 } },
                    ]),
            ],
            [
                { action: "drop-index", ...target, name: "status_1" },
                () =>
                    void (h.backend.answers.indexes = [
                        { name: "_id_", key: { _id: 1 } },
                        { name: "status_1", key: { status: -1 } },
                    ]),
            ],
            [
                { action: "aggregate", ...target, pipeline: [{ $match: {} }, { $out: "archive" }] },
                () => void (h.backend.answers.aggregate = [{ n: 9 }]),
            ],
        ];
        for (const [input, change] of cases) {
            h.backend.reset();
            h.backend.answers.count = 3;
            h.backend.answers.aggregate = [{ n: 3 }];
            const result = await h.call(input, { between: change });
            assert.match(result.error?.message ?? "", /changed since the preview/, String(input.action));
        }
    });
});

describe("the cap, and what matches nothing", () => {
    test("many beyond 1000 documents blocks the call without asking: the filter matches more than the cap", async () => {
        h.backend.answers.count = 1001;
        const result = await h.call(update);
        assert.match(
            result.blocked ?? "",
            /mongo update staging orders\.orders: the filter matches more than 1000 documents\. Narrow the filter, or raise limit \(up to 2000\)/,
        );
        assert.equal(result.preview, undefined);
        assert.equal(h.backend.of("update").length, 0);
    });

    test("a limit raised on purpose lets it through, and the count stops one past it", async () => {
        h.backend.answers.count = 1500;
        const result = await h.call({ ...update, limit: 2000 });
        ok(result);
        assert.equal((h.backend.of("count")[0]!.query as any).limit, 2001);
        assert.match(result.preview?.summary ?? "", /1500 documents match/);
        assert.match(result.preview?.body ?? "", /Cap: at most 2000 documents\./);
        h.backend.answers.count = 2001;
        const over = await h.call({ ...update, limit: 2000 });
        assert.match(over.blocked ?? "", /more than 2000 documents\. Narrow the filter\s*$/);
    });

    test("a limit lower than the matches is a cap too: the write is refused", async () => {
        h.backend.answers.count = 50;
        const result = await h.call({ ...update, limit: 10 });
        assert.match(result.blocked ?? "", /more than 10 documents/);
    });

    test("one document changes at most one, whatever the count; the preview says so", async () => {
        h.backend.answers.count = 1001;
        const result = await h.call({ ...update, which: "one" });
        ok(result);
        assert.match(result.preview?.summary ?? "", /update one .*: more than 1000 documents match/);
        assert.match(result.preview?.body ?? "", /This update changes the first of more than 1000 documents\./);
        h.backend.answers.count = 1;
        assert.match(
            (await h.call({ ...update, which: "one" })).preview?.body ?? "",
            /This update changes 1 document\./,
        );
    });

    test("a filter that matches nothing blocks the call: there is nothing to approve", async () => {
        h.backend.answers.count = 0;
        const result = await h.call(update);
        assert.match(result.blocked ?? "", /no document matches the filter, so nothing would change/);
        assert.equal(h.backend.of("update").length, 0);
    });

    test("the cap and the empty match hold when no preview was asked for, as when a rule lets writes through without asking", async () => {
        h.backend.answers.count = 5000;
        const over = await h.call(update, { ask: false });
        assert.match(over.error?.message ?? "", /the filter matches more than 1000 documents/);
        h.backend.answers.count = 0;
        const none = await h.call(update, { ask: false });
        assert.match(none.error?.message ?? "", /no document matches/);
        assert.equal(h.backend.of("update").length, 0);
    });
});

describe("each write", () => {
    test("insert: the documents are previewed as given, an _id is made for those without one, and the fingerprint does not change by it", async () => {
        h.backend.answers.insert = (query: any) => ({ inserted: query.documents.length });
        const input = {
            action: "insert",
            ...target,
            documents: [{ status: "new" }, { _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" }, status: "old" }],
        };
        const result = await h.call(input);
        assert.equal(ok(result), "mongo insert staging orders.orders: inserted 2 documents");
        assert.equal(result.preview?.summary, "insert 2 documents into orders.orders in staging");
        assert.match(result.preview?.body ?? "", /Documents:\n\[\n {2}\{\n {4}"status": "new"/);
        const sent = (h.backend.of("insert")[0]!.query as any).documents;
        assert.match(sent[0]._id.$oid, /^[0-9a-f]{24}$/);
        assert.deepEqual(sent[1], input.documents[1]);
        assert.deepEqual(factsOf(result.id), { inserted: 2 });
        assert.equal(h.backend.of("count").length, 0, "an insert counts nothing");
    });

    test("insert: the preview lists the first documents and says how many more", async () => {
        const documents = Array.from({ length: 25 }, (_, n) => ({ n }));
        const result = await h.call({ action: "insert", ...target, documents });
        assert.match(result.preview?.body ?? "", /\.\.\. and 15 more documents/);
        assert.equal((h.backend.of("insert")[0]!.query as any).documents.length, 25);
    });

    test("replace: one document, matched by its filter", async () => {
        h.backend.answers.count = 1;
        const result = await h.call({
            action: "replace",
            ...target,
            filter: { _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" } },
            replacement: { status: "void" },
        });
        assert.equal(ok(result), "mongo replace staging orders.orders: matched 1 document, modified 1");
        assert.deepEqual(h.backend.of("replace")[0]?.query, {
            db: "orders",
            coll: "orders",
            filter: { _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" } },
            replacement: { status: "void" },
        });
        assert.match(result.preview?.body ?? "", /Replacement:/);
        assert.match(result.preview?.summary ?? "", /^replace one in orders\.orders \(staging\): 1 document match$/);
    });

    test("an update written as stages", async () => {
        h.backend.answers.count = 3;
        const result = await h.call({
            action: "update",
            ...target,
            filter: { status: "stuck" },
            pipeline: [{ $set: { total: { $add: ["$a", 1] } } }],
            which: "many",
        });
        ok(result);
        assert.deepEqual((h.backend.of("update")[0]!.query as any).update, [{ $set: { total: { $add: ["$a", 1] } } }]);
    });

    test("delete: one or many, with the number deleted in the record", async () => {
        h.backend.answers.count = 7;
        h.backend.answers.remove = { deleted: 7 };
        const many = await h.call({ action: "delete", ...target, filter: { status: "test" }, which: "many" });
        assert.equal(ok(many), "mongo delete staging orders.orders: deleted 7 documents");
        assert.deepEqual(h.backend.of("remove")[0]?.query, {
            db: "orders",
            coll: "orders",
            filter: { status: "test" },
            many: true,
        });
        assert.deepEqual(factsOf(many.id), { deleted: 7 });
        h.backend.answers.remove = { deleted: 1 };
        const one = await h.call({ action: "delete", ...target, filter: { status: "test" }, which: "one" });
        assert.equal(ok(one), "mongo delete staging orders.orders: deleted 1 document");
        assert.equal((h.backend.of("remove")[1]!.query as any).many, false);
    });

    test("bulk: each operation is counted, and the preview lists the counts; the inserts get ids", async () => {
        h.backend.answers.count = (query: any) => (query.filter.a === 1 ? 4 : 2);
        h.backend.answers.bulk = { inserted: 1, matched: 6, modified: 6, deleted: 0 };
        const operations = [
            { insertOne: { document: { a: 9 } } },
            { updateMany: { filter: { a: 1 }, update: { $set: { b: 1 } } } },
            { deleteOne: { filter: { a: 2 } } },
        ];
        const result = await h.call({ action: "bulk", ...target, operations });
        assert.equal(ok(result), "mongo bulk staging orders.orders: inserted 1, matched 6, modified 6, deleted 0");
        assert.match(
            result.preview?.summary ?? "",
            /^bulk write of 3 operations in orders\.orders \(staging\): up to 6 documents$/,
        );
        assert.match(
            result.preview?.body ?? "",
            /1\. insertOne\n2\. updateMany: 4 documents match\n3\. deleteOne: 2 documents match/,
        );
        const sent = (h.backend.of("bulk")[0]!.query as any).operations;
        assert.match(sent[0].insertOne.document._id.$oid, /^[0-9a-f]{24}$/);
        assert.deepEqual(sent.slice(1), operations.slice(1));
        assert.deepEqual(factsOf(result.id), { inserted: 1, matched: 6, modified: 6, deleted: 0 });
    });

    test("bulk: the operations together stay under the cap, and an operation that is not valid blocks the call", async () => {
        h.backend.answers.count = 600;
        const over = await h.call({
            action: "bulk",
            ...target,
            operations: [
                { updateMany: { filter: { a: 1 }, update: { $set: { b: 1 } } } },
                { deleteMany: { filter: { a: 2 } } },
            ],
        });
        assert.match(over.blocked ?? "", /the operations touch more than 1000 documents in all/);
        const invalid: Array<[unknown, RegExp]> = [
            [{ upsertOne: {} }, /must be one of/],
            [{ updateOne: { filter: { a: 1 }, update: { $set: { b: 1 } }, upsert: true } }, /does not take upsert/],
            [{ updateOne: { filter: { a: 1 } } }, /needs update/],
            [{ deleteOne: {} }, /deleteOne needs filter/],
            [{ deleteMany: { filter: {} } }, /the filter is empty/],
            [{ insertOne: { document: { password: "x" } } }, /credential/],
            [{ updateOne: { filter: { a: 1 }, update: { b: 1 } } }, /takes operators|use replace/],
            [{ updateOne: { filter: { a: 1 }, update: "x" } }, /operators or a list of stages/],
            [{ replaceOne: { filter: { a: 1 }, replacement: { $set: { a: 1 } } } }, /cannot hold operators/],
            [{ insertOne: {}, deleteOne: { filter: { a: 1 } } }, /must be one of/],
        ];
        for (const [operation, pattern] of invalid) {
            const result = await h.call({ action: "bulk", ...target, operations: [operation] });
            assert.match(result.blocked ?? "", pattern, JSON.stringify(operation));
        }
        const tooMany = await h.call({
            action: "bulk",
            ...target,
            operations: Array.from({ length: 101 }, () => ({ deleteOne: { filter: { a: 1 } } })),
        });
        assert.match(tooMany.blocked ?? "", /bulk takes 1 to 100 operations/);
    });

    test("create-index: the preview lists the indexes there are, and the index is made with its options", async () => {
        const result = await h.call({
            action: "create-index",
            ...target,
            keys: { status: 1, createdAt: -1 },
            options: { unique: true, name: "by_status" },
        });
        assert.equal(ok(result), "mongo create-index staging orders.orders: created the index status_1_createdAt_-1");
        assert.deepEqual(h.backend.of("createIndex")[0]?.query, {
            db: "orders",
            coll: "orders",
            keys: { status: 1, createdAt: -1 },
            options: { unique: true, name: "by_status" },
        });
        assert.match(result.preview?.body ?? "", /Keys:\n\{\n {2}"status": 1,\n {2}"createdAt": -1\n\}/);
        assert.match(result.preview?.body ?? "", /Existing indexes: _id_, status_1\./);
        assert.equal(result.preview?.summary, "create an index on orders.orders (staging)");
    });

    test("create-index: keys and options are checked", async () => {
        const bad: Array<[Record<string, unknown>, RegExp]> = [
            [{ keys: {} }, /keys takes 1 to 32 fields/],
            [{ keys: { a: 2 } }, /must be 1, -1/],
            [{ keys: { password: 1 } }, /credential/],
            [{ keys: { notes: 1 } }, /denied/],
            [{ keys: { a: 1 }, options: { background: "yes" } }, /options\.background must be true or false/],
            [{ keys: { a: 1 }, options: { expireAfterSeconds: -1 } }, /whole number of seconds/],
            [{ keys: { a: 1 }, options: { collation: {} } }, /"collation" is not supported/],
            [{ keys: { a: 1 }, options: { name: "a b" } }, /plain index name/],
            [{ keys: { a: 1 }, options: { partialFilterExpression: { password: 1 } } }, /credential/],
        ];
        for (const [extra, pattern] of bad)
            assert.match(
                (await h.call({ action: "create-index", ...target, ...extra })).blocked ?? "",
                pattern,
                JSON.stringify(extra),
            );
        ok(
            await h.call({
                action: "create-index",
                ...target,
                keys: { a: 1 },
                options: { partialFilterExpression: { status: "open" }, sparse: true, hidden: false },
            }),
        );
    });

    test("drop-index: the index must exist, its definition is in the preview, and _id_ cannot go", async () => {
        const result = await h.call({ action: "drop-index", ...target, name: "status_1" });
        assert.equal(ok(result), "mongo drop-index staging orders.orders: dropped the index status_1");
        assert.deepEqual(h.backend.of("dropIndex")[0]?.query, { db: "orders", coll: "orders", name: "status_1" });
        assert.match(result.preview?.body ?? "", /Index:\n\{\n {2}"name": "status_1",\n {2}"key": \{\n {4}"status": 1/);
        assert.match(
            (await h.call({ action: "drop-index", ...target, name: "nope_1" })).blocked ?? "",
            /there is no index named nope_1 \(indexes lists them\)/,
        );
        assert.match(
            (await h.call({ action: "drop-index", ...target, name: "_id_" })).blocked ?? "",
            /the _id index cannot be dropped/,
        );
        assert.match((await h.call({ action: "drop-index", ...target, name: "*" })).blocked ?? "", /one index/);
        assert.equal(h.backend.of("dropIndex").length, 1);
    });
});

describe("an aggregation that writes", () => {
    const pipeline = (stage: unknown) => ({
        action: "aggregate",
        ...target,
        pipeline: [{ $match: { status: "closed" } }, stage],
    });

    test("$out: the documents that reach it are counted, and so is the collection it replaces; then it runs", async () => {
        h.backend.answers.aggregate = (query: any) =>
            query.pipeline.some((stage: any) => "$count" in stage) ? [{ n: 40 }] : [];
        h.backend.answers.count = 5;
        const result = await h.call(pipeline({ $out: "archive" }));
        assert.equal(ok(result), "mongo aggregate staging orders.orders: $out wrote 40 documents to orders.archive");
        assert.deepEqual(result.cls, { action: "aggregate", environment: "staging", effect: "write" });
        // Counted for the preview, counted again when the call runs, and then the pipeline itself.
        assert.deepEqual(
            h.backend.of("aggregate").map((call) => (call.query as any).pipeline),
            [
                [{ $match: { status: "closed" } }, { $count: "n" }],
                [{ $match: { status: "closed" } }, { $count: "n" }],
                [{ $match: { status: "closed" } }, { $out: "archive" }],
            ],
        );
        assert.deepEqual(h.backend.of("count")[0]?.query, { db: "orders", coll: "archive", filter: {}, limit: 1001 });
        assert.equal(result.preview?.summary, "$out into orders.archive (staging): 40 documents");
        assert.match(
            result.preview?.body ?? "",
            /40 documents reach the \$out stage \(counted just before this preview\)\.\n\$out replaces orders\.archive, which has 5 documents now\./,
        );
        assert.deepEqual(factsOf(result.id), { inserted: 40 });
    });

    test("$merge adds to a collection, and its target may be in another database", async () => {
        h.backend.answers.aggregate = (query: any) =>
            query.pipeline.some((stage: any) => "$count" in stage) ? [{ n: 3 }] : [];
        const result = await h.call(pipeline({ $merge: { into: { db: "reports", coll: "daily" }, on: "_id" } }));
        assert.equal(ok(result), "mongo aggregate staging orders.orders: $merge wrote 3 documents to reports.daily");
        assert.match(result.preview?.body ?? "", /\$merge adds to reports\.daily/);
        assert.deepEqual(factsOf(result.id), { matched: 3 });
    });

    test("more documents than the cap are refused, and the cap can be raised", async () => {
        h.backend.answers.aggregate = (query: any) =>
            query.pipeline.some((stage: any) => "$count" in stage) ? [{ n: 1500 }] : [];
        assert.match(
            (await h.call(pipeline({ $out: "archive" }))).blocked ?? "",
            /would write 1500 documents, over the cap of 1000/,
        );
        ok(await h.call({ ...pipeline({ $out: "archive" }), limit: 2000 }));
    });
});

describe("a reply that is lost is never answered by sending again", () => {
    test("a timeout: the write was sent once, one read checks what happened, and the message says the outcome is unknown", async () => {
        h.backend.answers.count = 12;
        h.backend.answers.update = () => {
            throw driverError("MongoNetworkTimeoutError", "socket timed out");
        };
        const result = await h.call(update);
        assert.equal(h.backend.of("update").length, 1, "sent once");
        const message = result.error?.message ?? "";
        assert.match(
            message,
            /^mongo update staging orders\.orders: no answer \(the connection to the database dropped\)\. The outcome is unknown: the server may have carried it out\. It was not sent again\. /,
        );
        assert.match(
            message,
            /Read once to check: the filter matches 12 documents now \(12 documents when it was checked before sending\)\.$/,
        );
        // The preview, the check before sending, and the one check after: three counts.
        assert.equal(h.backend.of("count").length, 3);
        assert.equal(h.connects.length, 2, "the check reads on a new connection: the first one failed");
    });

    test("the check shows what changed: the documents that match now", async () => {
        let counts = 0;
        h.backend.answers.count = () => (++counts <= 2 ? 12 : 0);
        h.backend.answers.update = () => {
            throw driverError("MongoNetworkError");
        };
        const result = await h.call(update);
        assert.match(
            result.error?.message ?? "",
            /the filter matches 0 documents now \(12 documents when it was checked before sending\)/,
        );
    });

    test("a server time limit that ran out is unknown too, and so is a time limit of the call", async () => {
        h.backend.answers.count = 3;
        h.backend.answers.update = () => {
            throw driverError("MongoServerError", "operation exceeded time limit", {
                code: 50,
                codeName: "MaxTimeMSExpired",
            });
        };
        const limited = await h.call(update);
        assert.match(
            limited.error?.message ?? "",
            /no answer \(the query ran longer than maxTimeMS 10000.*\)\. The outcome is unknown/,
        );
        h.close();
        h = setupHarness({ deadlineMs: 80 });
        h.backend.answers.count = 3;
        h.backend.answers.update = () => new Promise(() => {});
        const slow = await h.call(update);
        assert.match(
            slow.error?.message ?? "",
            /no answer \(the call hit its time limit or was cancelled\)\. The outcome is unknown.*It was not sent again\./,
        );
        assert.equal(h.backend.of("update").length, 1);
    });

    test("when the check cannot be read either, the message says so and still does not send again", async () => {
        h.backend.answers.count = (_query: any, req: any) => {
            if (req.maxTimeMS === 5000) throw driverError("MongoNetworkError");
            return 4;
        };
        h.backend.answers.update = () => {
            throw driverError("MongoNetworkError");
        };
        const result = await h.call(update);
        assert.match(
            result.error?.message ?? "",
            /It was not sent again\. The check could not be read either \(.*\): read the data to see what happened\./,
        );
        assert.equal(h.backend.of("update").length, 1);
    });

    test("every write is checked in its own way: an insert by id, a delete by count, a bulk by operation, an index by name", async () => {
        const lost = () => {
            throw driverError("MongoNetworkError");
        };
        h.backend.answers.count = 2;
        h.backend.answers.insert = lost;
        const insert = await h.call({ action: "insert", ...target, documents: [{ a: 1 }, { a: 2 }] });
        assert.match(
            insert.error?.message ?? "",
            /Read once to check: 2 of the 2 inserted documents are present \(found by _id\)\./,
        );
        assert.match(
            JSON.stringify(h.backend.of("count").at(-1)?.query),
            /"_id":\{"\$in":\[\{"\$oid":"[0-9a-f]{24}"\},\{"\$oid":"[0-9a-f]{24}"\}\]\}/,
        );
        h.backend.answers.remove = lost;
        const removed = await h.call({ action: "delete", ...target, filter: { a: 1 }, which: "many" });
        assert.match(removed.error?.message ?? "", /the filter matches 2 documents now/);
        h.backend.answers.bulk = lost;
        const bulk = await h.call({
            action: "bulk",
            ...target,
            operations: [{ deleteOne: { filter: { a: 1 } } }, { insertOne: { document: { a: 2 } } }],
        });
        assert.match(
            bulk.error?.message ?? "",
            /Read once per operation to check: operation 1: 2 documents match now \(2 documents before\)\./,
        );
        h.backend.answers.createIndex = lost;
        const created = await h.call({ action: "create-index", ...target, keys: { a: 1 } });
        assert.match(created.error?.message ?? "", /Read once to check: the indexes are now _id_, status_1\./);
        h.backend.answers.dropIndex = lost;
        const dropped = await h.call({ action: "drop-index", ...target, name: "status_1" });
        assert.match(dropped.error?.message ?? "", /Read once to check: the index status_1 still exists\./);
        h.backend.answers.aggregate = (query: any) => {
            if (query.pipeline.some((stage: any) => "$out" in stage)) throw driverError("MongoNetworkError");
            return [{ n: 2 }];
        };
        const out = await h.call({ action: "aggregate", ...target, pipeline: [{ $out: "archive" }] });
        assert.match(
            out.error?.message ?? "",
            /Read once to check: orders\.archive has 2 documents now \(2 documents before\)\./,
        );
    });
});

describe("a write the server rejected, or never received", () => {
    test("a rejection of one document: nothing changed, and nothing is read to check", async () => {
        h.backend.answers.count = 1;
        h.backend.answers.update = () => {
            throw driverError("MongoServerError", "Document failed validation", {
                code: 121,
                codeName: "DocumentValidationFailure",
            });
        };
        const result = await h.call({ ...update, which: "one" });
        assert.match(
            result.error?.message ?? "",
            /^mongo update staging orders\.orders: the database rejected the request \(DocumentValidationFailure\): Document failed validation\. Nothing was changed\.$/,
        );
        assert.equal(h.backend.of("update").length, 1);
        assert.equal(h.backend.of("count").length, 2, "the preview and the check before sending, and no more");
        assert.equal(h.connects.length, 1, "the connection is kept: the server answered");
    });

    test("a rejection of a write of many may be partial: it says so, and checks once", async () => {
        h.backend.answers.count = 6;
        h.backend.answers.update = () => {
            throw driverError("MongoServerError", "E11000 duplicate key error", {
                code: 11000,
                codeName: "DuplicateKey",
            });
        };
        const result = await h.call(update);
        assert.match(
            result.error?.message ?? "",
            /rejected the request \(DuplicateKey, a duplicate key\): E11000 duplicate key error\. Part of it may have been carried out\. It was not sent again\. Read once to check/,
        );
        assert.equal(h.backend.of("update").length, 1);
    });

    test("a database that cannot be reached: nothing was sent, whichever step failed", async () => {
        h.close();
        h = setupHarness({
            connect: async () => {
                throw driverError("MongoServerSelectionError", "no servers");
            },
        });
        const result = await h.call(update);
        assert.match(result.preview?.summary ?? "", /^preview unavailable: cannot reach the staging database/);
        assert.match(
            result.error?.message ?? "",
            /^mongo update staging orders\.orders: cannot reach the staging database: check the network, the VPN and the route, then try again\. Nothing was changed\.$/,
        );
        assert.equal(h.backend.of("update").length, 0);
    });

    test("a count that fails before the write: nothing was sent", async () => {
        h.backend.answers.count = () => {
            throw driverError("MongoServerError", "not authorized", { code: 13, codeName: "Unauthorized" });
        };
        const result = await h.call(update);
        assert.match(
            result.error?.message ?? "",
            /the database user cannot do this in staging \(Unauthorized\): it needs another role\. Nothing was changed\./,
        );
        assert.equal(h.backend.of("update").length, 0);
    });

    test("a refused sign-in on the first connection of a write: nothing was sent", async () => {
        h.close();
        h = setupHarness({
            connect: async () => {
                throw driverError("MongoServerError", "Authentication failed", { code: 18 });
            },
        });
        const result = await h.call(update);
        assert.match(
            result.error?.message ?? "",
            /the database refused the sign-in for staging: check the user and the password reference\. Nothing was changed\./,
        );
    });
});
