// The `api` tool: what Pi registers, and the two functions that jig-core's declaration is made of besides its name (classify
// and preview). `classify`, `preview` and `execute` plan the call the same way, from the same files, so what jig-core
// classified and what the person approved is what is sent. Planning is where invalid input is found, and every such finding
// is an InputError: jig-core blocks the call without asking.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import type { CallClass, Preview } from "../../jig-core/src/contract.ts";
import { loadCatalog } from "./catalog.ts";
import { settingsOf } from "./config.ts";
import type { ApiSettings } from "./config.ts";
import { createHttp } from "./engine/http.ts";
import type { Http, HttpOptions, Sent } from "./engine/http.ts";
import { fingerprintOfAll, READ_METHODS } from "./engine/plan.ts";
import type { Plan } from "./engine/plan.ts";
import { previewOf, previewOfAll } from "./engine/preview.ts";
import { renderResult, statusLine } from "./engine/render.ts";
import { InputError, shortList } from "./engine/values.ts";
import { LostReplyError, NotSentError } from "./engine/wire.ts";
import { parameters, parseCall } from "./params.ts";
import type { Call } from "./params.ts";
import { planCall, planRequest } from "./planning.ts";
import type { PlanContext } from "./planning.ts";
import { listText, readsOf, showText } from "./show.ts";

export type ApiOptions = HttpOptions;

const DESCRIPTION =
    "Run your team's saved API requests by name, filling only their variables: list, show, run, run-folder. " +
    "call sends an ad-hoc request where allowed. The tool signs in. A non-2xx answer is a result.";

export interface ApiTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Readonly<Record<string, unknown>>): CallClass;
    preview(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Preview>;
}

/** An error's message without its closing full stop, so a sentence can follow it. */
const sentence = (error: Error): string => error.message.replace(/[.\s]+$/, "");

/**
 * The error the model reads for a call that got no answer. A write that may have arrived is reported as unknown, and is
 * never sent again: the model is told to read the resource instead.
 */
function describeFailure(plan: Plan, error: unknown): unknown {
    if (error instanceof NotSentError) return new Error(`${plan.label}: ${sentence(error)}. Nothing was sent.`);
    if (!(error instanceof LostReplyError)) return error;
    const why = error.reason === "timeout" ? `timed out after ${plan.timeoutSec} s` : error.message;
    const lead = `${plan.label}: no answer (${why}).`;
    if (READ_METHODS.has(plan.method)) return new Error(`${lead} A ${plan.method} changes nothing, so it can be sent again.`);
    return new Error(
        `${lead} The outcome is unknown: the server may have carried it out. It was not sent again. ` +
            "Check with a GET before trying again.",
    );
}

/** The section as jig-core loaded it. Read on every call, so a configuration change applies. */
function requiredSettings(): ApiSettings {
    const settings = settingsOf(jig().config.section("api"));
    if (settings === undefined) {
        throw new InputError('api is not set up: add an "api" section with "collections" to jig.json (/jig lists configuration problems)');
    }
    return settings;
}

function contextOf(): PlanContext {
    const settings = requiredSettings();
    return { settings, catalog: loadCatalog(settings), kindOf: (name) => jig().environments.kindOf(name) };
}

/** The plans a `run`, `run-folder` or `call` makes, and what to call them. */
interface Prepared {
    plans: Plan[];
    /** The class of the call: its action and effect. */
    action: string;
    effect: "read" | "write";
    environment: string;
    /** `Orders/Smoke` for a folder; undefined for one request. */
    folder?: string;
}

/** Plans every request the call sends. Throws an InputError for anything invalid. */
function prepare(ctx: PlanContext, call: Extract<Call, { action: "run" | "run-folder" | "call" }>): Prepared {
    if (call.action === "call") {
        const plan = planCall(ctx, {
            environment: call.environment, collection: call.collection, method: call.method, url: call.url, body: call.body,
            headers: call.headers, timeoutSec: call.timeoutSec,
        });
        // Only the method decides an ad-hoc call: a name in `reads` cannot turn every call into a read.
        return { plans: [plan], action: "call", effect: READ_METHODS.has(plan.method) ? "read" : "write", environment: plan.jigEnvironment };
    }
    if (call.action === "run") {
        const request = ctx.catalog.request(call.request, call.collection, call.folder);
        const plan = planRequest(ctx, request, call);
        return { plans: [plan], action: request.name, effect: readsOf(ctx.settings, request) ? "read" : "write", environment: plan.jigEnvironment };
    }
    const found = ctx.catalog.folder(call.folder, call.collection);
    // The values are for the whole folder: each request gets the ones it uses, and each value must be used by one of them.
    const given = Object.entries(call.variables ?? {});
    const uses = [...new Set(found.requests.flatMap((request) => request.variables.filter((name) => !name.startsWith("$"))))];
    const unused = given.find(([name]) => !uses.includes(name));
    if (unused !== undefined) {
        const list = shortList(uses, ", ", 70);
        throw new InputError(`${JSON.stringify(unused[0])} is not a variable of any request in ${found.folder}; they use ${list}`);
    }
    const plans = found.requests.map((request) =>
        planRequest(ctx, request, { ...call, variables: Object.fromEntries(given.filter(([name]) => request.variables.includes(name))) }));
    const writes = found.requests.some((request) => !readsOf(ctx.settings, request));
    const first = plans[0] as Plan;
    // A folder is as strict as its strictest request: one write makes it a write.
    return {
        plans,
        action: `${found.collection.name}/${found.folder}`,
        effect: writes ? "write" : "read",
        environment: first.jigEnvironment,
        folder: found.folder,
    };
}

/** jig-core takes any TypeError to mean that the input is invalid. Only an InputError may say so: a TypeError from a bug here
 *  is an ordinary failure, which shows as "preview unavailable" and leaves the decision to the person. */
function asInvalidInput(error: unknown): unknown {
    if (error instanceof TypeError && !(error instanceof InputError)) return new Error(`internal error: ${error.message}`);
    return error;
}

/** Summary lines for a folder run: one per request, stopping at the first failure. */
async function runFolder(
    http: Http,
    prepared: Prepared,
    signal: AbortSignal | undefined,
): Promise<{ text: string; ran: number; failed: boolean }> {
    const lines: string[] = [];
    let failure: string | undefined;
    let ran = 0;
    for (const [index, plan] of prepared.plans.entries()) {
        const number = `${index + 1}. ${plan.request}`;
        if (failure !== undefined) {
            lines.push(`${number}: skipped`);
            continue;
        }
        try {
            const sent: Sent = await http.send(plan, signal);
            ran++;
            lines.push(`${number}: ${statusLine(plan, sent.answer)}`);
            if (sent.answer.status < 200 || sent.answer.status >= 300) failure = renderResult(plan, sent);
        } catch (error) {
            const described = describeFailure(plan, error);
            lines.push(`${number}: ${described instanceof Error ? described.message.replace(`${plan.label}: `, "") : "failed"}`);
            failure = described instanceof Error ? described.message : "failed";
            ran++;
        }
    }
    const first = prepared.plans[0] as Plan;
    const outcome = failure === undefined ? ", all answered 2xx" : ", stopped at the first failure";
    const head = `Folder ${prepared.folder ?? ""} in ${first.environment} (${first.jigEnvironment}): ` +
        `${ran} of ${prepared.plans.length} ran${outcome}`;
    const text = [head, ...lines, ...(failure === undefined ? [] : ["", "Failed request:", failure])].join("\n");
    return { text, ran, failed: failure !== undefined };
}

export function createTool(options: ApiOptions = {}): ApiTool {
    const http = createHttp(options);

    /** Nothing is sent if what would be sent now is not what was approved. */
    function guard(toolCallId: string, label: string, fingerprint: string): void {
        const approved = jig().approvedPreview(toolCallId);
        if (approved?.fingerprint !== undefined && approved.fingerprint !== fingerprint) {
            throw new Error(`${label}: changed since the preview; run it again to see the new preview. Nothing was sent.`);
        }
    }

    return {
        classify(input) {
            const call = parseCall(input);
            switch (call.action) {
                case "list":
                case "show":
                    requiredSettings();
                    return { action: call.action, environment: "local", effect: "read" };
                default: {
                    // The call is planned in full, so that anything invalid is found now and blocks the call without asking.
                    const prepared = prepare(contextOf(), call);
                    return { action: prepared.action, environment: prepared.environment, effect: prepared.effect };
                }
            }
        },

        async preview(input) {
            try {
                const call = parseCall(input);
                if (call.action === "list" || call.action === "show") return { summary: `api ${call.action}` };
                const prepared = prepare(contextOf(), call);
                return prepared.folder === undefined
                    ? previewOf(prepared.plans[0] as Plan)
                    : previewOfAll(`Folder ${prepared.folder}`, prepared.plans);
            } catch (error) {
                throw asInvalidInput(error);
            }
        },

        definition: {
            name: "api",
            label: "API",
            description: DESCRIPTION,
            promptSnippet: "api: run the team's saved API requests by name (list, show, run, run-folder); call for an ad-hoc one",
            parameters,
            // One call at a time and in order: a write must be done before the read that checks it.
            executionMode: "sequential",
            async execute(toolCallId, params, signal) {
                const call = parseCall(params);
                const text = (value: string, details: Record<string, unknown> = {}) =>
                    ({ content: [{ type: "text" as const, text: value }], details });
                if (call.action === "list" || call.action === "show") {
                    const ctx = contextOf();
                    if (call.action === "list") {
                        const filter = { collection: call.collection, folder: call.folder, text: call.text };
                        return text(listText(ctx.catalog, ctx.settings, filter), { action: "list" });
                    }
                    const request = ctx.catalog.request(call.request, call.collection, call.folder);
                    return text(showText(ctx.catalog, ctx.settings, request, call.environment), { action: "show", request: request.name });
                }

                const prepared = prepare(contextOf(), call);
                const first = prepared.plans[0] as Plan;
                if (prepared.folder !== undefined) {
                    guard(toolCallId, `api run-folder ${prepared.folder}`, fingerprintOfAll(prepared.plans));
                    const folder = await runFolder(http, prepared, signal);
                    jig().addFacts(toolCallId, { requests: prepared.plans.length, ran: folder.ran, failed: folder.failed ? 1 : 0 });
                    return text(folder.text, { folder: prepared.folder, requests: prepared.plans.length, ran: folder.ran, failed: folder.failed });
                }

                guard(toolCallId, first.label, first.fingerprint);
                let sent: Sent;
                try {
                    sent = await http.send(first, signal);
                } catch (error) {
                    throw describeFailure(first, error);
                }
                jig().addFacts(toolCallId, { status: sent.answer.status });
                return text(renderResult(first, sent), { request: first.request, method: first.method, status: sent.answer.status });
            },
        },
    };
}
