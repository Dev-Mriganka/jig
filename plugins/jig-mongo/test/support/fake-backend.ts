// A fake of the Backend seam: it records every request the plugin makes, and answers from values or functions a test sets.
import type { Backend, Req } from "../../src/backend.ts";

export interface Recorded {
    method: string;
    query: any;
    req: Req;
}

export type Answer = unknown | ((query: any, req: Req) => unknown);

export interface FakeBackend extends Backend {
    calls: Recorded[];
    /** What each method answers; a function is called with the request. A thrown value is the failure. */
    answers: Record<string, Answer>;
    closed: number;
    /** The requests of one method. */
    of(method: string): Recorded[];
    reset(): void;
}

const DEFAULTS: Record<string, Answer> = {
    databases: ["admin", "config", "local", "orders", "billing", "shop"],
    collections: [
        { name: "orders", type: "collection" },
        { name: "cards", type: "collection" },
    ],
    dbStats: {
        db: "orders",
        collections: 3,
        objects: 1200,
        avgObjSize: 310,
        dataSize: 372000,
        storageSize: 200000,
        indexes: 6,
        indexSize: 90000,
    },
    collStats: {
        storageStats: {
            count: 1200,
            size: 372000,
            avgObjSize: 310,
            storageSize: 200000,
            nindexes: 2,
            totalIndexSize: 60000,
        },
    },
    indexes: [
        { name: "_id_", key: { _id: 1 } },
        { name: "status_1", key: { status: 1 }, unique: false },
    ],
    indexStats: [{ name: "status_1", key: { status: 1 }, accesses: { ops: 12, since: "2026-01-01T00:00:00Z" } }],
    find: [],
    count: 3,
    aggregate: [],
    explain: { queryPlanner: { winningPlan: { stage: "COLLSCAN" }, rejectedPlans: [] } },
    insert: (query: any) => ({ inserted: query.documents.length }),
    update: { matched: 1, modified: 1 },
    replace: { matched: 1, modified: 1 },
    remove: { deleted: 1 },
    bulk: { inserted: 0, matched: 1, modified: 1, deleted: 0 },
    createIndex: "status_1_createdAt_-1",
    dropIndex: undefined,
};

const WITH_QUERY = [
    "collStats",
    "indexes",
    "indexStats",
    "find",
    "count",
    "aggregate",
    "explain",
    "insert",
    "update",
    "replace",
    "remove",
    "bulk",
    "createIndex",
    "dropIndex",
] as const;

export function fakeBackend(): FakeBackend {
    const calls: Recorded[] = [];
    const fake: any = {
        calls,
        answers: { ...DEFAULTS } as Record<string, Answer>,
        closed: 0,
        of: (method: string) => calls.filter((call) => call.method === method),
        reset() {
            calls.length = 0;
            fake.answers = { ...DEFAULTS };
            fake.closed = 0;
        },
        close: async () => void fake.closed++,
    };
    const answer = async (method: string, query: unknown, req: Req): Promise<any> => {
        calls.push({ method, query, req });
        const given = fake.answers[method];
        if (typeof given === "function") return (given as (query: unknown, req: Req) => unknown)(query, req);
        return given;
    };
    fake.databases = (req: Req) => answer("databases", undefined, req);
    for (const method of ["collections", "dbStats"]) fake[method] = (db: string, req: Req) => answer(method, db, req);
    for (const method of WITH_QUERY) fake[method] = (query: unknown, req: Req) => answer(method, query, req);
    return fake as FakeBackend;
}

/** An error the way the driver raises one: recognised by its name and code. */
export function driverError(name: string, message = name, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(message), { name, ...extra });
}
