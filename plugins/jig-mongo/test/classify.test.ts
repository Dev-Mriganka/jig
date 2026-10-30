// What jig-core is told about a call before anything runs: its action, its environment and its effect, and the calls it must block
// without asking because their input is invalid. A TypeError is how a declaration says that, so every refusal here is one.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { defaultSection, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
beforeEach(() => void (h = setupHarness()));
afterEach(async () => h.close());

const target = { database: "orders", collection: "orders" };
const classify = (input: Record<string, unknown>) => h.declaration.classify(input);
const refused = (input: Record<string, unknown>, pattern: RegExp, what = "") =>
    assert.throws(
        () => classify(input),
        (error: unknown) => error instanceof TypeError && pattern.test((error as Error).message),
        `${what}: ${JSON.stringify(input).slice(0, 100)}`,
    );

describe("the class of each action", () => {
    const reads: Array<Record<string, unknown>> = [
        { action: "databases" },
        { action: "collections", database: "orders" },
        { action: "schema", ...target },
        { action: "stats", database: "orders" },
        { action: "indexes", ...target },
        { action: "index-stats", ...target },
        { action: "explain", ...target, filter: { status: "open" } },
        { action: "count", ...target },
        { action: "find", ...target, filter: { status: "open" } },
        { action: "distinct", ...target, field: "status" },
        { action: "sample", ...target },
        { action: "aggregate", ...target, pipeline: [{ $match: { status: "open" } }] },
    ];
    const writes: Array<Record<string, unknown>> = [
        { action: "insert", ...target, documents: [{ a: 1 }] },
        { action: "update", ...target, filter: { a: 1 }, update: { $set: { a: 2 } }, which: "one" },
        { action: "update", ...target, filter: { a: 1 }, pipeline: [{ $set: { a: 2 } }], which: "many" },
        { action: "replace", ...target, filter: { a: 1 }, replacement: { a: 2 } },
        { action: "delete", ...target, filter: { a: 1 }, which: "many" },
        { action: "bulk", ...target, operations: [{ deleteOne: { filter: { a: 1 } } }] },
        { action: "create-index", ...target, keys: { a: 1 } },
        { action: "drop-index", ...target, name: "a_1" },
    ];

    test("reads are reads, in the environment the call names", () => {
        for (const environment of ["staging", "production"]) {
            for (const input of reads) {
                const cls = classify({
                    environment,
                    ...input,
                    ...(environment === "production" && input.database === "orders" ? {} : {}),
                });
                assert.deepEqual(cls, { action: input.action, environment, effect: "read" });
            }
        }
    });

    test("writes are writes in a test environment", () => {
        for (const input of writes)
            assert.deepEqual(classify({ environment: "staging", ...input }), {
                action: input.action,
                environment: "staging",
                effect: "write",
            });
    });

    test("an aggregation with $out or $merge as its last stage is a write; any other is a read", () => {
        const pipeline = (...stages: unknown[]) => ({
            environment: "staging",
            action: "aggregate",
            ...target,
            pipeline: stages,
        });
        assert.equal(classify(pipeline({ $match: {} }, { $out: "archive" }))?.effect, "write");
        assert.equal(classify(pipeline({ $match: {} }, { $merge: { into: "archive" } }))?.effect, "write");
        assert.equal(classify(pipeline({ $merge: { into: { db: "reports", coll: "daily" } } }))?.effect, "write");
        assert.equal(classify(pipeline({ $match: {} }, { $limit: 1 }))?.effect, "read");
        assert.equal(
            classify(pipeline({ $lookup: { from: "customers", localField: "a", foreignField: "b", as: "c" } }))?.effect,
            "read",
        );
    });

    test("classifying asks nothing of the database and reads no secret", () => {
        for (const input of [...reads, ...writes]) classify({ environment: "staging", ...input });
        assert.equal(h.backend.calls.length, 0);
        assert.equal(h.connects.length, 0);
        assert.deepEqual(h.jig.resolved, []);
    });
});

describe("production is read-only, refused at classification through the kind of the environment", () => {
    const writes: Array<Record<string, unknown>> = [
        { action: "insert", ...target, documents: [{ a: 1 }] },
        { action: "update", ...target, filter: { status: "open" }, update: { $set: { status: "x" } }, which: "one" },
        { action: "replace", ...target, filter: { status: "open" }, replacement: { status: "x" } },
        { action: "delete", ...target, filter: { status: "open" }, which: "one" },
        { action: "bulk", ...target, operations: [{ deleteOne: { filter: { status: "open" } } }] },
        { action: "create-index", ...target, keys: { status: 1 } },
        { action: "drop-index", ...target, name: "status_1" },
        { action: "aggregate", ...target, pipeline: [{ $match: { status: "open" } }, { $out: "orders" }] },
    ];

    test("every write and index change is refused, with the environment named", () => {
        for (const input of writes)
            refused(
                { environment: "production", ...input },
                /production is production, which is read-only: .* is not allowed there/,
                String(input.action),
            );
    });

    test("whatever the environment is called: jig-core's answer for the name decides", () => {
        // `staging` with an allow list is valid as a test environment and as production.
        h.configure({
            ...defaultSection(),
            access: {
                ...(defaultSection().access as object),
                staging: { allow: { "orders.orders": ["_id", "status"] } },
            },
        });
        classify({ environment: "staging", ...writes[1] });
        h.jig.kinds.set("staging", "production");
        refused({ environment: "staging", ...writes[1] }, /staging is production, which is read-only/);
        h.jig.kinds.set("staging", "test");
        classify({ environment: "staging", ...writes[1] });
        const connections = {
            ...(defaultSection().connections as object),
            prod: { uri: "mongodb://db.example.com:27017", user: "u", password: "pass:mongo/production" },
        };
        h.configure({
            ...defaultSection(),
            connections,
            access: { ...(defaultSection().access as object), prod: { allow: { "orders.orders": ["_id", "status"] } } },
        });
        refused({ environment: "prod", ...writes[0] }, /prod is production/);
        assert.equal(classify({ environment: "prod", action: "count", ...target })?.effect, "read");
    });

    test("a read of a collection or a field that is not listed is refused, so nothing is asked", () => {
        refused(
            { environment: "production", action: "find", database: "orders", collection: "payments" },
            /not in the allow list/,
        );
        refused(
            { environment: "production", action: "find", ...target, filter: { internalNotes: 1 } },
            /"internalNotes" is not allowed/,
        );
        refused(
            { environment: "production", action: "find", ...target, projection: { internalNotes: 1 } },
            /not allowed/,
        );
        refused(
            {
                environment: "production",
                action: "aggregate",
                ...target,
                pipeline: [{ $group: { _id: "$internalNotes" } }],
            },
            /not allowed/,
        );
        classify({ environment: "production", action: "find", ...target, filter: { status: "open" } });
    });

    test("production with no allow list reads nothing", () => {
        h.configure({ connections: defaultSection().connections as object });
        refused({ environment: "production", action: "find", ...target }, /nothing is allowed yet/);
        classify({ environment: "staging", action: "find", ...target });
    });
});

describe("input that is invalid blocks the call without asking", () => {
    test("an unknown environment lists the configured ones", () => {
        refused(
            { environment: "qa", action: "find", ...target },
            /unknown environment "qa"; configured: staging, production/,
        );
        refused({ action: "find", ...target }, /needs environment/);
    });

    test("a database or collection that is denied: by the system, by the deny list, by a missing allow", () => {
        refused(
            { environment: "staging", action: "find", database: "admin", collection: "users" },
            /always denied/,
            "admin",
        );
        refused(
            { environment: "staging", action: "find", database: "local", collection: "oplog" },
            /always denied/,
            "local",
        );
        refused({ environment: "staging", action: "collections", database: "config" }, /always denied/, "config");
        refused(
            { environment: "staging", action: "find", database: "orders", collection: "system.profile" },
            /system collections/,
            "system.profile",
        );
        refused(
            { environment: "staging", action: "find", database: "billing", collection: "cards" },
            /billing\.cards is denied/,
            "deny list",
        );
        refused(
            {
                environment: "staging",
                action: "insert",
                database: "billing",
                collection: "cards",
                documents: [{ a: 1 }],
            },
            /billing\.cards is denied/,
            "a write to a denied collection",
        );
        refused(
            {
                environment: "staging",
                action: "create-index",
                database: "billing",
                collection: "cards",
                keys: { a: 1 },
            },
            /billing\.cards is denied/,
            "an index on a denied collection",
        );
        refused(
            {
                environment: "staging",
                action: "aggregate",
                ...target,
                pipeline: [{ $out: { db: "billing", coll: "cards" } }],
            },
            /billing\.cards is denied/,
            "$out into a denied collection",
        );
    });

    test("a field that is denied, in a filter, a projection, a sort, distinct, a pipeline or a write", () => {
        refused(
            { environment: "staging", action: "find", ...target, filter: { password: "x" } },
            /credential/,
            "filter",
        );
        refused(
            { environment: "staging", action: "find", ...target, filter: { notes: "x" } },
            /"notes" is denied by the access list/,
            "filter, deny list",
        );
        refused(
            { environment: "staging", action: "find", ...target, projection: { apiKey: 1 } },
            /credential/,
            "projection",
        );
        refused({ environment: "staging", action: "find", ...target, sort: { token: 1 } }, /credential/, "sort");
        refused(
            { environment: "staging", action: "distinct", ...target, field: "customer.secret" },
            /credential/,
            "distinct",
        );
        refused(
            { environment: "staging", action: "count", ...target, filter: { $or: [{ clientSecret: 1 }] } },
            /credential/,
            "count",
        );
        refused(
            { environment: "staging", action: "aggregate", ...target, pipeline: [{ $project: { x: "$password" } }] },
            /credential/,
            "a rename",
        );
        refused(
            {
                environment: "staging",
                action: "aggregate",
                ...target,
                pipeline: [
                    {
                        $lookup: {
                            from: { db: "billing", coll: "cards" },
                            localField: "a",
                            foreignField: "b",
                            as: "c",
                        },
                    },
                ],
            },
            /billing\.cards is denied/,
            "a lookup",
        );
        refused(
            {
                environment: "staging",
                action: "update",
                ...target,
                filter: { a: 1 },
                update: { $set: { password: "x" } },
                which: "one",
            },
            /credential/,
            "an update",
        );
        refused(
            {
                environment: "staging",
                action: "update",
                ...target,
                filter: { notes: 1 },
                update: { $set: { a: 1 } },
                which: "one",
            },
            /denied/,
            "an update's filter",
        );
        refused(
            { environment: "staging", action: "insert", ...target, documents: [{ a: { token: "t" } }] },
            /credential/,
            "an insert",
        );
        refused(
            { environment: "staging", action: "explain", ...target, filter: { password: 1 } },
            /credential/,
            "explain",
        );
    });

    test("server-side JavaScript: $where, $function and $accumulator, in a filter, a pipeline or an update", () => {
        refused(
            { environment: "staging", action: "find", ...target, filter: { $where: "this.a == 1" } },
            /\$where runs JavaScript/,
        );
        refused(
            { environment: "staging", action: "count", ...target, filter: { $or: [{ $where: "true" }] } },
            /\$where runs JavaScript/,
        );
        refused(
            {
                environment: "staging",
                action: "aggregate",
                ...target,
                pipeline: [{ $addFields: { x: { $function: { body: "function(){}", args: [], lang: "js" } } } }],
            },
            /\$function runs JavaScript/,
        );
        refused(
            {
                environment: "staging",
                action: "aggregate",
                ...target,
                pipeline: [
                    {
                        $group: {
                            _id: null,
                            x: {
                                $accumulator: {
                                    init: "f",
                                    accumulate: "f",
                                    accumulateArgs: [],
                                    merge: "f",
                                    lang: "js",
                                },
                            },
                        },
                    },
                ],
            },
            /\$accumulator runs JavaScript/,
        );
        refused(
            {
                environment: "staging",
                action: "update",
                ...target,
                filter: { $where: "x" },
                update: { $set: { a: 1 } },
                which: "one",
            },
            /\$where runs JavaScript/,
        );
    });

    test("an environment may allow JavaScript; once jig-core calls it production the section is refused, because it never can", () => {
        h.configure({
            ...defaultSection(),
            access: {
                ...(defaultSection().access as object),
                staging: { allow: { "orders.orders": ["_id", "status"] }, javascript: true },
            },
        });
        assert.equal(
            classify({ environment: "staging", action: "find", ...target, filter: { $where: "this.a == 1" } })?.effect,
            "read",
        );
        h.jig.kinds.set("staging", "production");
        refused(
            { environment: "staging", action: "find", ...target, filter: { $where: "true" } },
            /mongo is not set up/,
        );
    });

    test("an update or a delete with an empty filter would change every document", () => {
        const update = {
            environment: "staging",
            action: "update",
            ...target,
            update: { $set: { a: 1 } },
            which: "many",
        };
        refused({ ...update, filter: {} }, /the filter is empty, so it would change every document/);
        refused({ ...update, which: "one", filter: {} }, /the filter is empty/);
        refused(
            { environment: "staging", action: "delete", ...target, filter: {}, which: "many" },
            /the filter is empty/,
        );
        refused(
            { environment: "staging", action: "replace", ...target, filter: {}, replacement: { a: 1 } },
            /the filter is empty/,
        );
        refused(
            { environment: "staging", action: "bulk", ...target, operations: [{ deleteMany: { filter: {} } }] },
            /bulk operation 1: the filter is empty|the filter is empty/,
        );
        refused(
            { environment: "staging", action: "update", ...target, update: { $set: { a: 1 } }, which: "many" },
            /needs filter/,
        );
    });

    test("limit raises the cap of a write of many, and does nothing for one", () => {
        refused(
            {
                environment: "staging",
                action: "update",
                ...target,
                filter: { a: 1 },
                update: { $set: { a: 2 } },
                which: "one",
                limit: 5,
            },
            /limit raises the cap of a write of many/,
        );
        classify({
            environment: "staging",
            action: "update",
            ...target,
            filter: { a: 1 },
            update: { $set: { a: 2 } },
            which: "many",
            limit: 2000,
        });
        refused(
            {
                environment: "staging",
                action: "insert",
                ...target,
                documents: Array.from({ length: 1001 }, () => ({ a: 1 })),
            },
            /insert takes at most 1000 documents; raise limit/,
        );
        classify({
            environment: "staging",
            action: "insert",
            ...target,
            documents: Array.from({ length: 1001 }, () => ({ a: 1 })),
            limit: 1001,
        });
    });

    test("the shape of the call: unknown action, missing parameters, a parameter the action does not use", () => {
        refused({ environment: "staging", action: "launch" }, /unknown action/);
        refused({ environment: "staging", action: "find", database: "orders" }, /needs collection/);
        refused({ environment: "staging", action: "count", ...target, sort: { a: 1 } }, /does not use sort/);
        refused(
            { environment: "staging", action: "update", ...target, filter: { a: 1 }, which: "one" },
            /needs update/,
        );
    });

    test("the section is invalid or absent: the tool is not set up", () => {
        h.configure({
            connections: { staging: { uri: "mongodb://agent:pw@db.example.com:27017", user: "a", password: "pass:x" } },
        });
        refused({ environment: "staging", action: "find", ...target }, /mongo is not set up/);
        h.jig.setSection("mongo", undefined);
        refused({ environment: "staging", action: "find", ...target }, /mongo is not set up/);
    });
});
