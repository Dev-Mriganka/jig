// The translation to the official driver, against a fake of the driver's client: each request of the tool becomes the right driver
// call, with checked Extended JSON turned into BSON on the way. No server is involved; what needs one is in integration.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as driver from "mongodb";
import type { MongoClient } from "mongodb";
import { adaptClient, clientOptions } from "../src/driver.ts";
import type { ConnectTarget } from "../src/backend.ts";

const OID = "65f1f1f1f1f1f1f1f1f1f1f1";

interface Seen {
    path: string;
    args: unknown[];
}

/** A client that records each driver call and answers from `answers`, by the path of the call. */
function fakeClient(answers: Record<string, unknown> = {}): {
    client: MongoClient;
    seen: Seen[];
    closed: () => number;
} {
    const seen: Seen[] = [];
    let closed = 0;
    const cursor = (path: string, args: unknown[]) => ({
        toArray: async () => (answers[path] ?? []) as unknown[],
        explain: async (verbosity: string) => ({ verbosity, ...(answers[`${path}.explain`] as object) }),
        _args: args,
    });
    const record = (path: string, ...args: unknown[]) => void seen.push({ path, args });
    const collection = (db: string, name: string) => {
        const at = (method: string) => `${db}.${name}.${method}`;
        return {
            find: (...args: unknown[]) => (record(at("find"), ...args), cursor(at("find"), args)),
            aggregate: (...args: unknown[]) => (record(at("aggregate"), ...args), cursor(at("aggregate"), args)),
            listIndexes: (...args: unknown[]) => (record(at("listIndexes"), ...args), cursor(at("listIndexes"), args)),
            countDocuments: async (...args: unknown[]) => (
                record(at("countDocuments"), ...args), answers[at("countDocuments")] ?? 0
            ),
            insertMany: async (...args: unknown[]) => (
                record(at("insertMany"), ...args), { insertedCount: (args[0] as unknown[]).length }
            ),
            updateOne: async (...args: unknown[]) => (
                record(at("updateOne"), ...args), { matchedCount: 1, modifiedCount: 1 }
            ),
            updateMany: async (...args: unknown[]) => (
                record(at("updateMany"), ...args), { matchedCount: 5, modifiedCount: 4 }
            ),
            replaceOne: async (...args: unknown[]) => (
                record(at("replaceOne"), ...args), { matchedCount: 1, modifiedCount: 1 }
            ),
            deleteOne: async (...args: unknown[]) => (record(at("deleteOne"), ...args), { deletedCount: 1 }),
            deleteMany: async (...args: unknown[]) => (record(at("deleteMany"), ...args), { deletedCount: 7 }),
            bulkWrite: async (...args: unknown[]) => (
                record(at("bulkWrite"), ...args),
                { insertedCount: 1, matchedCount: 2, modifiedCount: 3, deletedCount: 4 }
            ),
            createIndex: async (...args: unknown[]) => (record(at("createIndex"), ...args), "status_1"),
            dropIndex: async (...args: unknown[]) => void record(at("dropIndex"), ...args),
        };
    };
    const client = {
        db: (name?: string) => ({
            collection: (collectionName: string) => collection(name ?? "", collectionName),
            listCollections: (...args: unknown[]) => (
                record(`${name}.listCollections`, ...args), cursor(`${name}.listCollections`, args)
            ),
            command: async (...args: unknown[]) => (
                record(`${name}.command`, ...args), answers[`${name}.command`] ?? {}
            ),
            admin: () => ({
                listDatabases: async (...args: unknown[]) => (
                    record("admin.listDatabases", ...args), answers["admin.listDatabases"]
                ),
            }),
        }),
        close: async () => void closed++,
    } as unknown as MongoClient;
    return { client, seen, closed: () => closed };
}

const req = { maxTimeMS: 5000, signal: new AbortController().signal };
const ns = { db: "orders", coll: "orders" };

describe("the translation to the driver", () => {
    test("find: Extended JSON becomes BSON, and the limit, projection, sort and time limit go with it", async () => {
        const { client, seen } = fakeClient({ "orders.orders.find": [{ a: 1 }] });
        const backend = adaptClient(client, driver);
        const docs = await backend.find(
            {
                ...ns,
                filter: { _id: { $oid: OID }, n: { $gt: 3_000_000_000 } },
                projection: { status: 1 },
                sort: { createdAt: -1 },
                limit: 20,
            },
            req,
        );
        assert.deepEqual(docs, [{ a: 1 }]);
        const [filter, options] = seen[0]!.args as [Record<string, any>, Record<string, any>];
        assert.ok(filter._id instanceof driver.ObjectId);
        assert.ok(filter.n.$gt instanceof driver.Long);
        assert.deepEqual(
            { ...options, signal: undefined },
            {
                maxTimeMS: 5000,
                comment: "jig-mongo",
                limit: 20,
                projection: { status: 1 },
                sort: { createdAt: -1 },
                signal: undefined,
            },
        );
        assert.equal(options.signal, req.signal);
    });

    test("count passes the cap as the limit; with none there is no limit option", async () => {
        const { client, seen } = fakeClient({ "orders.orders.countDocuments": 42 });
        const backend = adaptClient(client, driver);
        assert.equal(await backend.count({ ...ns, filter: { a: 1 }, limit: 1001 }, req), 42);
        await backend.count({ ...ns, filter: {} }, req);
        assert.deepEqual(seen[0]?.args[1], { maxTimeMS: 5000, limit: 1001 });
        assert.deepEqual(seen[1]?.args[1], { maxTimeMS: 5000 });
    });

    test("aggregate: the pipeline is converted, disk use is off, and a typed request keeps the types of numbers", async () => {
        const { client, seen } = fakeClient();
        const backend = adaptClient(client, driver);
        await backend.aggregate({ ...ns, pipeline: [{ $match: { _id: { $oid: OID } } }] }, req);
        await backend.aggregate({ ...ns, pipeline: [], typed: true }, req);
        const [first, second] = seen.map((call) => call.args[1] as Record<string, unknown>);
        assert.equal(first?.allowDiskUse, false);
        assert.ok(!("promoteValues" in (first ?? {})));
        assert.equal(second?.promoteValues, false);
        assert.ok((seen[0]!.args[0] as any[])[0].$match._id instanceof driver.ObjectId);
    });

    test("explain: a find and an aggregation, at the verbosity asked", async () => {
        const { client, seen } = fakeClient({
            "orders.orders.find.explain": { queryPlanner: {} },
            "orders.orders.aggregate.explain": { stages: [] },
        });
        const backend = adaptClient(client, driver);
        assert.deepEqual(await backend.explain({ ...ns, verbosity: "queryPlanner", filter: { a: 1 }, limit: 5 }, req), {
            verbosity: "queryPlanner",
            queryPlanner: {},
        });
        assert.deepEqual(
            await backend.explain({ ...ns, verbosity: "executionStats", pipeline: [{ $match: {} }] }, req),
            { verbosity: "executionStats", stages: [] },
        );
        assert.deepEqual(
            seen.map((call) => call.path),
            ["orders.orders.find", "orders.orders.aggregate"],
        );
    });

    test("listings and statistics: authorized names only, a time limit, the collection statistics through $collStats", async () => {
        const { client, seen } = fakeClient({
            "admin.listDatabases": { databases: [{ name: "orders" }, { name: "shop" }] },
            "orders.listCollections": [
                { name: "orders", type: "collection" },
                { name: "v", type: "view" },
            ],
            "orders.command": { collections: 3 },
            "orders.orders.aggregate": [{ storageStats: { count: 5 } }],
            "orders.orders.listIndexes": [{ name: "_id_", key: { _id: 1 } }],
        });
        const backend = adaptClient(client, driver);
        assert.deepEqual(await backend.databases(req), ["orders", "shop"]);
        assert.deepEqual(await backend.collections("orders", req), [
            { name: "orders", type: "collection" },
            { name: "v", type: "view" },
        ]);
        assert.deepEqual(await backend.dbStats("orders", req), { collections: 3 });
        assert.deepEqual(await backend.collStats(ns, req), { storageStats: { count: 5 } });
        assert.deepEqual(await backend.indexes(ns, req), [{ name: "_id_", key: { _id: 1 } }]);
        assert.equal((seen[0]!.args[0] as Record<string, unknown>).authorizedDatabases, true);
        assert.equal((seen[1]!.args[1] as Record<string, unknown>).authorizedCollections, true);
        assert.deepEqual(seen[2]?.args[0], { dbStats: 1, maxTimeMS: 5000 });
        assert.deepEqual(seen[3]?.args[0], [{ $collStats: { storageStats: {}, count: {} } }]);
    });

    test("the writes: each is one driver call with the converted values, a time limit and a comment, and no signal", async () => {
        const { client, seen } = fakeClient();
        const backend = adaptClient(client, driver);
        assert.deepEqual(await backend.insert({ ...ns, documents: [{ _id: { $oid: OID } }, { a: 1 }] }, req), {
            inserted: 2,
        });
        assert.deepEqual(
            await backend.update({ ...ns, filter: { a: 1 }, update: { $set: { b: 2 } }, many: false }, req),
            { matched: 1, modified: 1 },
        );
        assert.deepEqual(
            await backend.update({ ...ns, filter: { a: 1 }, update: [{ $set: { b: 2 } }], many: true }, req),
            { matched: 5, modified: 4 },
        );
        assert.deepEqual(await backend.replace({ ...ns, filter: { a: 1 }, replacement: { b: 1 } }, req), {
            matched: 1,
            modified: 1,
        });
        assert.deepEqual(await backend.remove({ ...ns, filter: { a: 1 }, many: false }, req), { deleted: 1 });
        assert.deepEqual(await backend.remove({ ...ns, filter: { a: 1 }, many: true }, req), { deleted: 7 });
        assert.deepEqual(await backend.bulk({ ...ns, operations: [{ insertOne: { document: { a: 1 } } }] }, req), {
            inserted: 1,
            matched: 2,
            modified: 3,
            deleted: 4,
        });
        assert.equal(
            await backend.createIndex({ ...ns, keys: { status: 1 }, options: { unique: true } }, req),
            "status_1",
        );
        await backend.dropIndex({ ...ns, name: "status_1" }, req);
        assert.deepEqual(
            seen.map((call) => call.path.split(".").pop()),
            [
                "insertMany",
                "updateOne",
                "updateMany",
                "replaceOne",
                "deleteOne",
                "deleteMany",
                "bulkWrite",
                "createIndex",
                "dropIndex",
            ],
        );
        for (const call of seen) {
            const options = call.args.at(-1) as Record<string, unknown>;
            assert.equal(options.maxTimeMS, 5000, call.path);
            assert.equal(options.comment, "jig-mongo", call.path);
            assert.ok(!("signal" in options), call.path);
        }
        const [documents] = seen[0]!.args as [Array<Record<string, unknown>>];
        assert.ok(documents[0]?._id instanceof driver.ObjectId);
        assert.deepEqual(seen[2]?.args[1], [{ $set: { b: 2 } }]);
        assert.deepEqual((seen[7]!.args[1] as Record<string, unknown>).unique, true);
    });

    test("close closes the client", async () => {
        const { client, closed } = fakeClient();
        await adaptClient(client, driver).close();
        assert.equal(closed(), 1);
    });
});

describe("the options of a connection", () => {
    const target: ConnectTarget = {
        environment: "staging",
        uri: "mongodb://127.0.0.1:41000/",
        user: "agent",
        password: "db-pass-1",
        production: false,
        serverName: "db.staging.example.com",
        directConnection: true,
        tls: true,
        authSource: "admin",
    };

    test("credentials go in the options, retries are off, and the driver itself accepts every option", async () => {
        const options = clientOptions(target);
        assert.deepEqual(options.auth, { username: "agent", password: "db-pass-1" });
        assert.equal(options.retryWrites, false);
        assert.equal(options.retryReads, false);
        assert.equal(options.readPreference, "primaryPreferred");
        for (const unsafe of [
            "tlsAllowInvalidCertificates",
            "tlsAllowInvalidHostnames",
            "tlsInsecure",
            "checkServerIdentity",
        ])
            assert.ok(!(unsafe in options), unsafe);
        const client = new driver.MongoClient(target.uri, options as never);
        try {
            assert.equal(client.options.credentials?.username, "agent");
            assert.equal(client.options.credentials?.source, "admin");
            assert.equal(client.options.retryWrites, false);
            assert.equal(client.options.directConnection, true);
            assert.equal(client.options.tls, true);
            assert.equal((client.options as unknown as { servername?: string }).servername, "db.staging.example.com");
        } finally {
            await client.close();
        }
    });

    test("production reads from a secondary when there is one, and the options that are not given are not set", () => {
        const { directConnection: _d, tls: _t, serverName: _s, authSource: _a, ...plain } = target;
        const options = clientOptions({ ...plain, production: true });
        assert.equal(options.readPreference, "secondaryPreferred");
        for (const absent of ["directConnection", "tls", "servername", "authSource", "proxyHost", "proxyPort"])
            assert.ok(!(absent in options), absent);
    });

    test("a SOCKS5 proxy goes to the driver as proxyHost and proxyPort, which it accepts, with the real address and no direct connection", async () => {
        const proxied: ConnectTarget = {
            environment: "staging",
            uri: "mongodb://a.example.com:27017,b.example.com:27017/orders?replicaSet=rs0",
            user: "agent",
            password: "db-pass-1",
            production: false,
            proxyHost: "127.0.0.1",
            proxyPort: 41_555,
        };
        const options = clientOptions(proxied);
        assert.equal(options.proxyHost, "127.0.0.1");
        assert.equal(options.proxyPort, 41_555);
        assert.ok(!("directConnection" in options));
        assert.ok(!("servername" in options));
        const client = new driver.MongoClient(proxied.uri, options as never);
        try {
            assert.equal(client.options.proxyHost, "127.0.0.1");
            assert.equal(client.options.proxyPort, 41_555);
            assert.deepEqual(
                client.options.hosts.map((host) => host.toString()),
                ["a.example.com:27017", "b.example.com:27017"],
            );
            assert.equal(client.options.replicaSet, "rs0");
        } finally {
            await client.close();
        }
    });
});
