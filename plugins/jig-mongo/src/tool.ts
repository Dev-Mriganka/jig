// The `mongo` tool: what Pi registers, and the two functions that jig-core's declaration is made of besides its name (classify and
// preview). `classify`, `preview` and `execute` plan the call the same way, from the same configuration, so what jig-core decided
// about and what the person approved is what runs. Planning is where invalid input is found, and every such finding is an
// InputError: jig-core blocks the call without asking.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import type { CallClass, Preview } from "../../jig-core/src/contract.ts";
import type { Access } from "./access.ts";
import type { Backend, Connect, Req } from "./backend.ts";
import { accessFor, settingsOf } from "./config.ts";
import type { Connection, MongoSettings } from "./config.ts";
import { connectDriver } from "./driver.ts";
import { ChangedError, deliveryOf, describeFailure, dropsConnection } from "./errors.ts";
import { ACTIONS, parameters, parseCall } from "./params.ts";
import type { Call } from "./params.ts";
import { planCall } from "./plan.ts";
import type { Planned } from "./plan.ts";
import { Session, systemSessionDeps } from "./session.ts";
import type { SessionDeps } from "./session.ts";
import { InputError, errorMessage, shortList, shown } from "./values.ts";
import type { Prepared, WriteRun } from "./writes.ts";

export interface MongoOptions {
    /** For tests: the connection to a database, in place of the driver's. */
    connect?: Connect;
    /** For tests: the session's collaborators (the routes, the timers and the idle time). */
    session?: Partial<SessionDeps>;
    /** How long one call may take in all, connecting included. */
    deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 90_000;
/** The check after a lost reply is one short read. */
const VERIFY_MS = 15_000;
const VERIFY_MAX_TIME_MS = 5000;
const REMEMBERED = 100;

const DESCRIPTION =
    "MongoDB in your configured environments. Explore: databases, collections, schema, stats. Indexes and plans: indexes, " +
    "index-stats, explain. Query: count, find, distinct, sample, aggregate. Write: insert, update, replace, delete, bulk, " +
    "create-index, drop-index. Filters, documents and pipelines are Extended JSON. Writes show a count and ask first; " +
    "production is read-only. Fields that look like credentials are never returned.";

export interface MongoTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Readonly<Record<string, unknown>>): CallClass;
    preview(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Preview>;
    /** Closes the connections and the forwards. Pi calls it when the session ends. */
    shutdown(): Promise<void>;
}

/** The section as jig-core loaded it. Read on every call, so a configuration change applies. */
function requiredSettings(): MongoSettings {
    const settings = settingsOf(jig().config.section("mongo"));
    if (settings === undefined) {
        throw new InputError(
            'mongo is not set up: add a "mongo" section with "connections" to jig.json (/jig lists configuration problems)',
        );
    }
    return settings;
}

/** Whether a pipeline's last stage writes to a collection, which makes the aggregation a write. */
function endsWithOutput(pipeline: Call["pipeline"]): boolean {
    const last = pipeline?.at(-1);
    return last !== undefined && ("$out" in last || "$merge" in last);
}

/** A call that was checked in full: the connection it uses, the access that applies, and what it will do. */
interface Checked {
    call: Call;
    connection: Connection;
    access: Access;
    production: boolean;
    planned: Planned;
}

function check(input: Readonly<Record<string, unknown>>): Checked {
    const call = parseCall(input);
    const settings = requiredSettings();
    const connection = settings.connections.get(call.environment);
    if (connection === undefined) {
        throw new InputError(
            `unknown environment ${shown(call.environment, 30)}; configured: ${shortList([...settings.connections.keys()])}`,
        );
    }
    const kind = jig().environments.kindOf(call.environment);
    if (kind !== "test" && kind !== "production") {
        throw new InputError(
            `${call.environment} is a ${kind} environment; a database is a test or production environment`,
        );
    }
    const production = kind === "production";
    // The floor denies a write to production as well. This refuses it first, before anyone is asked, and before the call's own
    // details are checked: whatever they are, the answer is the same.
    if (production && (ACTIONS[call.action].effect === "write" || endsWithOutput(call.pipeline))) {
        throw new InputError(
            `${call.environment} is production, which is read-only: ${call.action} is not allowed there`,
        );
    }
    const access = accessFor(settings, call.environment);
    const planned = planCall(call, access);
    return { call, connection, access, production, planned };
}

/** jig-core takes any TypeError to mean that the input is invalid. Only an InputError may say so: a TypeError from a bug here is
 *  an ordinary failure, which shows as "preview unavailable" and leaves the decision to the person. */
function asInvalidInput(error: unknown): unknown {
    if (error instanceof TypeError && !(error instanceof InputError))
        return new Error(`internal error: ${error.message}`);
    return error;
}

/** Settles like `promise`, but rejects as soon as `signal` aborts: the driver does not stop every operation on a signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

export function createTool(options: MongoOptions = {}): MongoTool {
    const connect = options.connect ?? connectDriver;
    const session = new Session({ ...systemSessionDeps(connect), ...options.session });
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    /** What each preview counted, by fingerprint, so "changed since the preview" can say what it was. */
    const counted = new Map<string, string>();

    const contextOf = (c: Checked, signal: AbortSignal) => ({
        environment: c.call.environment,
        production: c.production,
        maxTimeMS: c.call.maxTimeMS,
        aborted: signal.aborted,
    });

    /** Runs `use` on the environment's connection. Any failure comes out as one line, and a connection that failed is dropped. */
    async function withBackend<T>(c: Checked, signal: AbortSignal, use: (backend: Backend) => Promise<T>): Promise<T> {
        let lease: Awaited<ReturnType<typeof session.acquire>>;
        try {
            lease = await session.acquire(c.connection, c.production, signal);
        } catch (error) {
            throw describeFailure(error, contextOf(c, signal));
        }
        let failed = false;
        try {
            return await use(lease.backend);
        } catch (error) {
            failed = dropsConnection(error);
            throw error;
        } finally {
            lease.release(failed);
        }
    }

    /** One short read, on a connection of its own, to say what a write whose reply was lost did. */
    async function checkAfterLoss(c: Checked, prepared: Prepared): Promise<string> {
        const signal = AbortSignal.timeout(VERIFY_MS);
        const req: Req = { maxTimeMS: VERIFY_MAX_TIME_MS, signal };
        try {
            return await withBackend(c, signal, (backend) => raceAbort(prepared.verify(backend, req), signal));
        } catch (error) {
            return `The check could not be read either (${errorMessage(error)}): read the data to see what happened.`;
        }
    }

    /** What the model is told about a write that did not get an answer. A write that may have arrived is reported as unknown, and is never sent again. */
    async function describeLostWrite(
        c: Checked,
        run: WriteRun,
        prepared: Prepared,
        error: unknown,
        signal: AbortSignal,
    ): Promise<Error> {
        const delivery = deliveryOf(error, signal.aborted);
        const reason = describeFailure(error, contextOf(c, signal)).message;
        if (delivery === "not-sent" || (delivery === "rejected" && run.atomic)) {
            return new Error(`${run.label}: ${reason}. Nothing was changed.`);
        }
        const lead =
            delivery === "rejected"
                ? `${run.label}: ${reason}. Part of it may have been carried out.`
                : `${run.label}: no answer (${reason}). The outcome is unknown: the server may have carried it out.`;
        return new Error(`${lead} It was not sent again. ${await checkAfterLoss(c, prepared)}`);
    }

    /** Nothing is sent if what would be sent now is not what was approved. */
    function guard(toolCallId: string, label: string, prepared: Prepared): void {
        const approved = jig().approvedPreview(toolCallId);
        if (approved?.fingerprint === undefined || approved.fingerprint === prepared.fingerprint) return;
        const before = counted.get(approved.fingerprint);
        const change = before === undefined ? "" : ` (it was ${before}; now ${prepared.counted})`;
        throw new ChangedError(
            `${label}: changed since the preview${change}. Nothing was changed; run it again to see the new preview.`,
        );
    }

    async function runWrite(toolCallId: string, c: Checked, run: WriteRun, signal: AbortSignal) {
        const req: Req = { maxTimeMS: c.call.maxTimeMS, signal };
        let lease: Awaited<ReturnType<typeof session.acquire>>;
        try {
            lease = await session.acquire(c.connection, c.production, signal);
        } catch (error) {
            throw new Error(
                `${run.label}: ${describeFailure(error, contextOf(c, signal)).message}. Nothing was changed.`,
            );
        }
        let prepared: Prepared;
        try {
            prepared = await raceAbort(run.prepare(lease.backend, req), signal);
            guard(toolCallId, run.label, prepared);
        } catch (error) {
            lease.release(dropsConnection(error));
            if (error instanceof InputError || error instanceof ChangedError) throw error;
            throw new Error(
                `${run.label}: ${describeFailure(error, contextOf(c, signal)).message}. Nothing was changed.`,
            );
        }
        try {
            // Sent once. A reply that is lost is never answered by sending again.
            const outcome = await raceAbort(prepared.send(req), signal);
            lease.release(false);
            return outcome;
        } catch (error) {
            lease.release(true);
            throw await describeLostWrite(c, run, prepared, error, signal);
        }
    }

    const tool: MongoTool = {
        classify(input) {
            const c = check(input);
            return { action: c.call.action, environment: c.call.environment, effect: c.planned.effect };
        },

        async preview(input, signal) {
            try {
                const c = check(input);
                if (c.planned.effect === "read") return { summary: c.planned.run.label };
                const run = c.planned.run;
                const prepared = await withBackend(c, signal, (backend) =>
                    raceAbort(run.prepare(backend, { maxTimeMS: c.call.maxTimeMS, signal }), signal),
                );
                if (prepared.preview.fingerprint !== undefined) {
                    counted.set(prepared.preview.fingerprint, prepared.counted);
                    if (counted.size > REMEMBERED) counted.delete(counted.keys().next().value as string);
                }
                return prepared.preview;
            } catch (error) {
                throw asInvalidInput(error);
            }
        },

        shutdown: () => session.closeAll(),

        definition: {
            name: "mongo",
            label: "MongoDB",
            description: DESCRIPTION,
            promptSnippet:
                "mongo: explore, query, explain and (in test environments) change MongoDB; count before find",
            parameters,
            // One call at a time and in order: a write must be done before the read that checks it.
            executionMode: "sequential",
            async execute(toolCallId, params, signal) {
                const c = check(params as Record<string, unknown>);
                const deadline = AbortSignal.timeout(deadlineMs);
                const until = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
                const text = (value: string, details: Record<string, unknown>) => ({
                    content: [{ type: "text" as const, text: value }],
                    details: { action: c.call.action, environment: c.call.environment, ...details },
                });

                if (c.planned.effect === "read") {
                    const run = c.planned.run;
                    const rendered = await withBackend(c, until, (backend) =>
                        raceAbort(run.run(backend, until), until),
                    ).catch((error: unknown) => {
                        throw error instanceof InputError
                            ? error
                            : new Error(`${run.label}: ${describeFailure(error, contextOf(c, until)).message}`);
                    });
                    jig().addFacts(toolCallId, rendered.facts);
                    return text(rendered.text, rendered.details);
                }
                const outcome = await runWrite(toolCallId, c, c.planned.run, until);
                jig().addFacts(toolCallId, outcome.facts);
                return text(outcome.text, outcome.details);
            },
        },
    };
    return tool;
}
