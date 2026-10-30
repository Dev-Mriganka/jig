// The official MongoDB driver behind the Backend seam. `adaptClient` is the translation, and takes the client as an argument so
// that a test can give it a fake; `connectDriver` opens a real one. The driver is loaded on first use, so the plugin costs nothing
// until a call needs a database.
import type * as Mongo from "mongodb";
import type { Backend, Connect, ConnectTarget, Namespace, Req } from "./backend.ts";
import { isWrapper } from "./ejson.ts";
import { isObject } from "./values.ts";
import type { Doc } from "./values.ts";

/** The parts of the driver's module that the translation uses. */
export type Driver = Pick<typeof Mongo, "BSON" | "Long">;

/** Shown in the server's logs and profiler, so that a query can be traced back to the tool. */
const COMMENT = "jig-mongo";
const INT32 = { min: -(2 ** 31), max: 2 ** 31 - 1 };

/** Turns checked Extended JSON into BSON values. A number beyond 32 bits is sent as a 64-bit integer. */
export function toBson(value: unknown, driver: Driver): unknown {
    if (Array.isArray(value)) return value.map((item) => toBson(item, driver));
    if (isObject(value)) {
        if (isWrapper(value))
            return (driver.BSON.EJSON.deserialize({ value }, { relaxed: false }) as { value: unknown }).value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toBson(item, driver)]));
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && (value > INT32.max || value < INT32.min))
        return driver.Long.fromNumber(value);
    return value;
}

const omitUndefined = (options: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));

export function adaptClient(client: Mongo.MongoClient, driver: Driver): Backend {
    const bson = <T>(value: T): never => toBson(value, driver) as never;
    const collection = (ns: Namespace) => client.db(ns.db).collection(ns.coll);
    const common = (req: Req) => omitUndefined({ maxTimeMS: req.maxTimeMS, comment: COMMENT, signal: req.signal });
    // The write commands take a time limit and a comment, but no signal: the caller stops waiting when its own time runs out.
    const writing = (req: Req) => omitUndefined({ maxTimeMS: req.maxTimeMS, comment: COMMENT });

    return {
        async databases(req) {
            const result = await client
                .db()
                .admin()
                .listDatabases({ nameOnly: true, authorizedDatabases: true, maxTimeMS: req.maxTimeMS } as never);
            return result.databases.map((database) => database.name);
        },

        async collections(db, req) {
            const found = await client
                .db(db)
                .listCollections({}, { nameOnly: true, authorizedCollections: true, ...common(req) } as never)
                .toArray();
            return found.map((entry) => ({
                name: String(entry.name),
                type: String((entry as { type?: unknown }).type ?? "collection"),
            }));
        },

        dbStats: (db, req) => client.db(db).command({ dbStats: 1, maxTimeMS: req.maxTimeMS }),

        async collStats(ns, req) {
            const rows = await collection(ns)
                .aggregate([{ $collStats: { storageStats: {}, count: {} } }], common(req) as never)
                .toArray();
            return (rows[0] ?? {}) as Doc;
        },

        indexes: async (ns, req) =>
            (await collection(ns)
                .listIndexes(common(req) as never)
                .toArray()) as Doc[],

        indexStats: async (ns, req) =>
            (await collection(ns)
                .aggregate([{ $indexStats: {} }], common(req) as never)
                .toArray()) as Doc[],

        find: (query, req) =>
            collection(query)
                .find(
                    bson(query.filter),
                    omitUndefined({
                        ...common(req),
                        limit: query.limit,
                        projection: query.projection === undefined ? undefined : bson(query.projection),
                        sort: query.sort === undefined ? undefined : bson(query.sort),
                    }) as never,
                )
                .toArray(),

        count: (query, req) =>
            collection(query).countDocuments(
                bson(query.filter),
                omitUndefined({ maxTimeMS: req.maxTimeMS, limit: query.limit }) as never,
            ),

        aggregate: (query, req) =>
            collection(query)
                .aggregate(
                    query.pipeline.map(bson),
                    omitUndefined({
                        ...common(req),
                        allowDiskUse: false,
                        // A number stays an Int32 or a Double, so that a schema can tell them apart.
                        promoteValues: query.typed === true ? false : undefined,
                    }) as never,
                )
                .toArray(),

        async explain(query, req) {
            const target = collection(query);
            if (query.pipeline !== undefined) {
                return (await target
                    .aggregate(query.pipeline.map(bson), common(req) as never)
                    .explain(query.verbosity)) as Doc;
            }
            const cursor = target.find(
                bson(query.filter ?? {}),
                omitUndefined({
                    ...common(req),
                    limit: query.limit,
                    projection: query.projection === undefined ? undefined : bson(query.projection),
                    sort: query.sort === undefined ? undefined : bson(query.sort),
                }) as never,
            );
            return (await cursor.explain(query.verbosity)) as Doc;
        },

        async insert(query, req) {
            const result = await collection(query).insertMany(query.documents.map(bson), {
                ordered: true,
                ...writing(req),
            } as never);
            return { inserted: result.insertedCount };
        },

        async update(query, req) {
            const target = collection(query);
            const update = Array.isArray(query.update) ? query.update.map(bson) : bson(query.update);
            const options = writing(req) as never;
            const result = query.many
                ? await target.updateMany(bson(query.filter), update, options)
                : await target.updateOne(bson(query.filter), update, options);
            return { matched: result.matchedCount, modified: result.modifiedCount };
        },

        async replace(query, req) {
            const result = await collection(query).replaceOne(
                bson(query.filter),
                bson(query.replacement),
                writing(req) as never,
            );
            return { matched: result.matchedCount, modified: result.modifiedCount };
        },

        async remove(query, req) {
            const target = collection(query);
            const result = query.many
                ? await target.deleteMany(bson(query.filter), writing(req) as never)
                : await target.deleteOne(bson(query.filter), writing(req) as never);
            return { deleted: result.deletedCount };
        },

        async bulk(query, req) {
            const result = await collection(query).bulkWrite(query.operations.map(bson), {
                ordered: true,
                ...writing(req),
            } as never);
            return {
                inserted: result.insertedCount,
                matched: result.matchedCount,
                modified: result.modifiedCount,
                deleted: result.deletedCount,
            };
        },

        createIndex: (query, req) =>
            collection(query).createIndex(bson(query.keys), {
                ...(bson(query.options) as object),
                ...writing(req),
            } as never),

        async dropIndex(query, req) {
            await collection(query).dropIndex(query.name, writing(req) as never);
        },

        close: () => client.close(),
    };
}

/** The options of one connection. Credentials are here only; certificates and host names are checked as the driver does by default. */
export function clientOptions(target: ConnectTarget): Record<string, unknown> {
    return omitUndefined({
        // A server that needs no sign-in is reached with an empty user; a configuration always names one.
        auth: target.user === "" ? undefined : { username: target.user, password: target.password },
        authSource: target.authSource,
        tls: target.tls,
        // Behind a forward the address is local, while the certificate is the database host's.
        servername: target.serverName,
        directConnection: target.directConnection === true ? true : undefined,
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 8_000,
        socketTimeoutMS: 120_000,
        maxPoolSize: 2,
        // A write is never sent again by the driver: the tool checks what happened instead.
        retryReads: false,
        retryWrites: false,
        readPreference: target.production ? "secondaryPreferred" : "primaryPreferred",
        appName: "jig-mongo",
    });
}

export const connectDriver: Connect = async (target) => {
    const driver = await import("mongodb");
    const client = new driver.MongoClient(target.uri, clientOptions(target) as never);
    try {
        await client.connect();
    } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
    }
    return adaptClient(client, driver);
};
