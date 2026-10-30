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

const nameOf = (error: unknown): string => String((error as DriverError | undefined)?.name ?? "");
const codeOf = (error: unknown): number | undefined => (error as DriverError | undefined)?.code;

/** Whether the call ended because its time ran out or it was cancelled. */
export const isAbort = (error: unknown): boolean => nameOf(error) === "AbortError" || nameOf(error) === "TimeoutError";

export function deliveryOf(error: unknown, aborted: boolean): Delivery {
    if (error instanceof InputError || error instanceof RouteError) return "not-sent";
    if (aborted || isAbort(error)) return "unknown";
    const name = nameOf(error);
    if (BEFORE_SENDING.has(name)) return "not-sent";
    if (name === "MongoServerError") {
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
        (name === "MongoServerError" && codeOf(error) === AUTH_FAILED)
    );
}

export interface FailureContext {
    environment: string;
    production: boolean;
    maxTimeMS: number;
    aborted: boolean;
}

/** The end of a call that did not finish: one line the model can act on. Production gets no server text, which can echo values. */
export function describeFailure(error: unknown, context: FailureContext): Error {
    if (error instanceof InputError || error instanceof RouteError) return error;
    const e = (error ?? {}) as DriverError;
    if (context.aborted || isAbort(error)) return new Error("the call hit its time limit or was cancelled");
    const name = String(e.name ?? "");
    if (name === "MongoServerSelectionError") {
        return new Error(
            `cannot reach the ${context.environment} database: check the network, the VPN and the route, then try again`,
        );
    }
    if (NETWORK.has(name)) return new Error("the connection to the database dropped");
    if (name === "MongoServerError") {
        if (e.code === AUTH_FAILED)
            return new Error(
                `the database refused the sign-in for ${context.environment}: check the user and the password reference`,
            );
        if (e.code === UNAUTHORIZED)
            return new Error(
                `the database user cannot do this in ${context.environment} (Unauthorized): it needs another role`,
            );
        if (e.code === MAX_TIME_EXPIRED) {
            return new Error(
                `the query ran longer than maxTimeMS ${context.maxTimeMS}: narrow the filter to an indexed field, or raise maxTimeMS`,
            );
        }
        const what = e.codeName ?? `code ${e.code ?? "unknown"}`;
        const detail = context.production
            ? ""
            : `: ${String(e.message ?? "")
                  .replace(/\s+/g, " ")
                  .slice(0, 160)}`;
        return new Error(
            `the database rejected the request (${what}${e.code === DUPLICATE_KEY ? ", a duplicate key" : ""})${detail}`,
        );
    }
    return new Error(
        `the database driver failed (${name === "" || name === "Error" ? "unknown error" : name}); try again or narrow the request`,
    );
}
