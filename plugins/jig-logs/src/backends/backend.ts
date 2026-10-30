// The seam between the shared search and the store that holds the logs.
//
// Everything that differs between stores is behind `LogBackend`: what an environment must say about where its logs are,
// the request for one bucket, the reading of a reply, what an error reply means, and what the store limits. Everything
// else is shared and does not know which store it talks to: the checks on a call, windows and buckets, halving and
// retrying, paging, excerpts, the sender with its sign-in and its transport, and the words of a failure.
//
// To add a store, write one file in this folder that exports a `LogBackend`, list it in `index.ts`, and follow the
// checklist in docs/backends.md.
import type { Backend, BackendType, Target } from "../config.ts";
import type { Failure } from "../failure.ts";
import type { LogQuery } from "../query.ts";
import type { SearchPage } from "../response.ts";
import type { Range } from "../time.ts";

/**
 * One HTTP request, before the backend's address is put in front of its path and the sign-in is added. Only the
 * adapter knows where a store wants its parameters: in a JSON body (Elasticsearch) or in the address (Loki).
 */
export interface Wire {
    method: "GET" | "POST";
    /** Starts with a slash and goes after `backend.url`. May end in a query string. */
    path: string;
    /** Text sent as `application/json`. A request without one is a plain read. */
    body?: string;
    /** Headers of the request's own, such as Loki's tenant. The sign-in's headers are added after these and win. */
    headers?: Readonly<Record<string, string>>;
}

/** What the store itself limits. These are the stores' defaults; an operator may have set them lower. */
export interface Limits {
    /** The most hits one request may ask for. The tool's own `size` limit never goes above it. */
    maxHits: number;
    /** The longest time span one request may cover. A longer bucket is cut to it. */
    maxWindowMs: number;
}

/** The parts of the messages the model reads that name the store. The rest of every message is shared. */
export interface Words {
    /** What a refused sign-in lacked access to, as "the index". Completes "denied this sign-in access to ...". */
    resource: string;
    /** The settings to check when the store does not accept the sign-in, as "backend.auth". */
    signIn: string;
    /** The `Next:` line for a query the store rejected. */
    queryRejected: string;
    /** The `Next:` line for an HTTP 404. */
    notFound: string;
}

/**
 * What jig.json says for this store, beyond what every store has: `logs.backend.url`, `auth` and `transport`, and the
 * `jigEnvironment` of each environment.
 */
export interface ConfigShape {
    /** Names in `logs.backend` that only this store uses, such as Loki's `tenant`. */
    backendFields: readonly string[];
    /** Names in an environment that only this store uses, such as `index`. */
    environmentFields: readonly string[];
    /** What an environment must have at least, for the message "must be an object with at least an index". */
    needs: string;
    /** An address to show in the message about a missing or wrong `logs.backend.url`. */
    exampleUrl: string;
}

export interface LogBackend {
    /** The value of `logs.backend.type` that selects this store. */
    readonly type: BackendType;

    // ---- configuration -------------------------------------------------------------------------------------------
    readonly config: ConfigShape;
    /** Checks this store's own names in `logs.backend`. One message per problem, each naming its key. */
    checkBackendFields?(raw: Record<string, unknown>, key: string, errors: string[]): void;
    /** Checks this store's own names in one environment. `key` is the environment's path in jig.json. */
    checkEnvironmentFields(raw: Record<string, unknown>, key: string, errors: string[]): void;
    /** The environment with its defaults filled in. Called only when the checks found nothing. */
    environment(name: string, raw: Record<string, unknown>): Target;

    // ---- what the store limits -------------------------------------------------------------------------------------
    readonly limits: Limits;

    // ---- one request -----------------------------------------------------------------------------------------------
    /**
     * Refuses a `query` that is not safe to send. The text is the model's own, so a store whose language can reach
     * beyond what the configuration allows (Loki's stream selector) checks it here. Throws an InputError, and jig-core
     * then blocks the call without asking. Omit it when the text can only ever be a value in the request.
     */
    checkQuery?(text: string): void;
    /**
     * The request that fetches up to `size` hits of `query` from one bucket. `size` 0 asks only how many there are.
     * The model's text may land in one value of it and nowhere else.
     */
    search(query: LogQuery, bucket: Range, size: number): object;
    /**
     * The request that asks whether the environment holds any data in `range`, whatever the query says. It must not
     * carry the phrase, the query or the filters: a search that finds nothing uses it to tell "nothing matches" from
     * "nothing is there".
     */
    probe(query: LogQuery, range: Range): object;
    /** How a request of this environment travels. The shared sender adds the address and the sign-in. */
    wire(target: Target, connection: Backend): (request: object) => Wire;

    // ---- one reply -------------------------------------------------------------------------------------------------
    /**
     * Reads the body of a successful reply to `request`: the hits with their time, message and other fields, how many
     * there are, and whether that count is exact. Undefined when the text is not a result of this store.
     */
    parse(reply: string, request: object): SearchPage | undefined;
    /**
     * What an error reply means in this store's words, before the plain HTTP rules (busy, timed out, rejected) apply.
     * Undefined leaves it to them. A sign-in problem (401, 403) and a redirect never reach it: they are not about one
     * window. Never repeat the reply in a message: a rejected query's text repeats the query.
     */
    classify(status: number, reply: string): Failure | undefined;
    readonly words: Words;
}
