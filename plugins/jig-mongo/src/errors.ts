// Failures of the route and the server, and what to tell the model about each. A driver error is recognised by its `name` and
// code and not by its class, so a fake in a test can raise one without the driver.
import { InputError } from "./values.ts";

/** A problem with the route or the connection, found before any request was sent: nothing reached the database. */
export class RouteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RouteError";
    }
}

/** A write that was not sent because the counts it was approved with are not the counts now. */
export class ChangedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChangedError";
    }
}

/** What is known about whether a write arrived. */
export type Delivery =
    /** It was never sent: the route, the connection or the call itself failed first. */
    | "not-sent"
    /** The server answered with an error. For a write of one document that means nothing changed. */
    | "rejected"
    /** It may have been carried out: the reply was lost, or the time ran out. */
    | "unknown";

interface DriverError {
    name?: string;
    code?: number;
    codeName?: string;
    message?: string;
}

const AUTH_FAILED = 18;
const UNAUTHORIZED = 13;
const MAX_TIME_EXPIRED = 50;
const DUPLICATE_KEY = 11000;

/** Raised by a driver before it sends anything. */
const BEFORE_SENDING: ReadonlySet<string> = new Set([
    "MongoServerSelectionError",
    "MongoParseError",
    "MongoInvalidArgumentError",
    "MongoAPIError",
    "MongoMissingCredentialsError",
    "MongoNotConnectedError",
    "MongoCompatibilityError",
    "MongoTopologyClosedError",
    "MongoClientClosedError",
]);
const NETWORK: ReadonlySet<string> = new Set(["MongoNetworkError", "MongoNetworkTimeoutError"]);
/**
 * The names under which the driver reports an error the server answered with. A bulk write (`insertMany`, `bulkWrite`) fails
 * with a subclass of `MongoServerError` that has a name of its own, and the same `code`, such as 11000 for a duplicate key.
 */
const SERVER_ERRORS: ReadonlySet<string> = new Set(["MongoServerError", "MongoBulkWriteError"]);

const nameOf = (error: unknown): string => String((error as DriverError | undefined)?.name ?? "");
const codeOf = (error: unknown): number | undefined => (error as DriverError | undefined)?.code;

/** Whether the call ended because its time ran out or it was cancelled. */
export const isAbort = (error: unknown): boolean => nameOf(error) === "AbortError" || nameOf(error) === "TimeoutError";

export function deliveryOf(error: unknown, aborted: boolean): Delivery {
    if (error instanceof InputError || error instanceof RouteError) return "not-sent";
    if (aborted || isAbort(error)) return "unknown";
    const name = nameOf(error);
    if (BEFORE_SENDING.has(name)) return "not-sent";
    if (SERVER_ERRORS.has(name)) {
        const code = codeOf(error);
        if (code === AUTH_FAILED || code === UNAUTHORIZED) return "not-sent";
        return code === MAX_TIME_EXPIRED ? "unknown" : "rejected";
    }
    return "unknown";
}

/** True when the cached connection is suspect and the next call should open a new one. */
export function dropsConnection(error: unknown): boolean {
    if (error instanceof InputError || error instanceof RouteError) return false;
    const name = nameOf(error);
    return (
        NETWORK.has(name) ||
        name === "MongoServerSelectionError" ||
        name === "MongoTopologyClosedError" ||
        (SERVER_ERRORS.has(name) && codeOf(error) === AUTH_FAILED)
    );
}

export interface FailureContext {
    environment: string;
    production: boolean;
    maxTimeMS: number;
    aborted: boolean;
}

/** An error that already says, in one line, what to tell the model: describing it again must not change it. */
const told = (message: string): Error => Object.assign(new Error(message), { told: true });

/** The end of a call that did not finish: one line the model can act on. Production gets no server text, which can echo values. */
export function describeFailure(error: unknown, context: FailureContext): Error {
    if (error instanceof InputError || error instanceof RouteError) return error;
    if ((error as { told?: unknown } | undefined)?.told === true) return error as Error;
    const e = (error ?? {}) as DriverError;
    if (context.aborted || isAbort(error)) return told("the call hit its time limit or was cancelled");
    const name = String(e.name ?? "");
    if (name === "MongoServerSelectionError") {
        return told(
            `cannot reach the ${context.environment} database: check the network, the VPN and the route, then try again`,
        );
    }
    if (NETWORK.has(name)) return told("the connection to the database dropped");
    if (SERVER_ERRORS.has(name)) {
        if (e.code === AUTH_FAILED)
            return told(
                `the database refused the sign-in for ${context.environment}: check the user and the password reference`,
            );
        if (e.code === UNAUTHORIZED)
            return told(
                `the database user cannot do this in ${context.environment} (Unauthorized): it needs another role`,
            );
        if (e.code === MAX_TIME_EXPIRED) {
            return told(
                `the query ran longer than maxTimeMS ${context.maxTimeMS}: narrow the filter to an indexed field, or raise maxTimeMS`,
            );
        }
        const what = e.codeName ?? `code ${e.code ?? "unknown"}`;
        const detail = context.production
            ? ""
            : `: ${String(e.message ?? "")
                  .replace(/\s+/g, " ")
                  .slice(0, 160)}`;
        return told(
            `the database rejected the request (${what}${e.code === DUPLICATE_KEY ? ", a duplicate key" : ""})${detail}`,
        );
    }
    return told(
        `the database driver failed (${name === "" || name === "Error" ? "unknown error" : name}); try again or narrow the request`,
    );
}
