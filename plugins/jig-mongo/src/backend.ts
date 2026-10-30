// The seam between the tool and the MongoDB driver. The tool asks for what it needs in these terms, and driver.ts turns each
// call into driver calls. Everything else is tested with a fake of this interface, and driver.ts with a fake of the driver.
//
// Requests hold plain Extended JSON, already checked. Answers hold what the driver returned: values may be BSON classes, which
// bson.ts turns into Extended JSON for the model.
import type { Doc } from "./values.ts";

/** What every call carries: the server's time limit and the call's own end. */
export interface Req {
    maxTimeMS: number;
    signal?: AbortSignal;
}

export interface Namespace {
    db: string;
    coll: string;
}

export interface FindQuery extends Namespace {
    filter: Doc;
    projection?: Doc;
    sort?: Doc;
    limit: number;
}

export interface CountQuery extends Namespace {
    filter: Doc;
    /** Stops counting here: enough to tell a write is over its cap. */
    limit?: number;
}

export interface AggregateQuery extends Namespace {
    pipeline: Doc[];
    /** Keep the BSON type of each number, so `schema` can tell an int from a double. */
    typed?: boolean;
}

export interface ExplainQuery extends Namespace {
    verbosity: "queryPlanner" | "executionStats";
    /** A find, or when `pipeline` is given an aggregation. */
    filter?: Doc;
    projection?: Doc;
    sort?: Doc;
    limit?: number;
    pipeline?: Doc[];
}

export interface UpdateQuery extends Namespace {
    filter: Doc;
    /** Operators, or the stages of an update pipeline. */
    update: Doc | Doc[];
    many: boolean;
}

export interface BulkOutcome {
    inserted: number;
    matched: number;
    modified: number;
    deleted: number;
}

export interface Backend {
    databases(req: Req): Promise<string[]>;
    collections(db: string, req: Req): Promise<Array<{ name: string; type: string }>>;
    dbStats(db: string, req: Req): Promise<Doc>;
    collStats(ns: Namespace, req: Req): Promise<Doc>;
    indexes(ns: Namespace, req: Req): Promise<Doc[]>;
    indexStats(ns: Namespace, req: Req): Promise<Doc[]>;
    find(query: FindQuery, req: Req): Promise<unknown[]>;
    count(query: CountQuery, req: Req): Promise<number>;
    aggregate(query: AggregateQuery, req: Req): Promise<unknown[]>;
    explain(query: ExplainQuery, req: Req): Promise<Doc>;

    insert(query: Namespace & { documents: Doc[] }, req: Req): Promise<{ inserted: number }>;
    update(query: UpdateQuery, req: Req): Promise<{ matched: number; modified: number }>;
    replace(
        query: Namespace & { filter: Doc; replacement: Doc },
        req: Req,
    ): Promise<{ matched: number; modified: number }>;
    remove(query: Namespace & { filter: Doc; many: boolean }, req: Req): Promise<{ deleted: number }>;
    bulk(query: Namespace & { operations: Doc[] }, req: Req): Promise<BulkOutcome>;
    createIndex(query: Namespace & { keys: Doc; options: Doc }, req: Req): Promise<string>;
    dropIndex(query: Namespace & { name: string }, req: Req): Promise<void>;

    close(): Promise<void>;
}

/** What it takes to open a connection. Credentials are here and in the driver's memory, and nowhere else. */
export interface ConnectTarget {
    environment: string;
    /** Which of the environment's connections, when it has several. */
    cluster?: string;
    /** No credentials in it. */
    uri: string;
    user: string;
    password: string;
    authSource?: string;
    tls?: boolean;
    /** Behind a forward the address is local, and the certificate is still the database host's. */
    serverName?: string;
    directConnection?: boolean;
    /** Behind a SOCKS5 proxy the address is the real one, and the driver reaches every host of it through the proxy. */
    proxyHost?: string;
    proxyPort?: number;
    /** Production reads come from a secondary when there is one. */
    production: boolean;
}

export type Connect = (target: ConnectTarget) => Promise<Backend>;
