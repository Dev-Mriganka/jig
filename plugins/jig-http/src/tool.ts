// The `http` tool: what Pi registers, and the two functions that jig-core's declaration is made of besides its name
// (classify and preview). `execute` and `preview` check the call the same way and make the same plan, so what the person
// approved is what is sent.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import type { CallClass, Preview } from "../../jig-core/src/contract.ts";
import { settingsOf } from "./config.ts";
import type { HttpSettings } from "./config.ts";
import { createHttp } from "./http.ts";
import type { HttpOptions, Sent } from "./http.ts";
import { findTarget, parameters, parseCall } from "./params.ts";
import { planOf } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { previewOf } from "./preview.ts";
import { renderResult } from "./render.ts";
import { InputError } from "./values.ts";
import { LostReplyError, NotSentError } from "./wire.ts";

const DESCRIPTION =
    "Call a named HTTP API with a method, path, JSON body and headers. GET reads; other methods write. " +
    "The tool adds the sign-in. A non-2xx answer is a result, not an error.";

export interface HttpTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Readonly<Record<string, unknown>>): CallClass;
    preview(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Preview>;
}

/** The section as jig-core loaded it. Read on every call, so a configuration change applies. */
function currentSettings(): HttpSettings | undefined {
    return settingsOf(jig().config.section("http"));
}

/** `http POST billing /v1/accounts`: names a call in a message, without its query or its body. */
function where(plan: Plan): string {
    return `http ${plan.call.method} ${plan.call.target.name} ${plan.call.path}`;
}

/** An error's message without its closing full stop, so a sentence can follow it. */
const sentence = (error: Error): string => error.message.replace(/[.\s]+$/, "");

/**
 * The error the model reads for a call that got no answer. A write that may have arrived is reported as unknown, and is
 * never sent again: the model is told to read the resource instead.
 */
function describeFailure(plan: Plan, error: unknown): unknown {
    if (error instanceof NotSentError) return new Error(`${where(plan)}: ${sentence(error)}. Nothing was sent.`);
    if (!(error instanceof LostReplyError)) return error;
    const why = error.reason === "timeout" ? `timed out after ${plan.call.timeoutSec} s` : error.message;
    const lead = `${where(plan)}: no answer (${why}).`;
    if (plan.call.method === "GET") return new Error(`${lead} A GET changes nothing, so it can be sent again.`);
    return new Error(
        `${lead} The outcome is unknown: the server may have carried it out. It was not sent again. ` +
            "Check with a GET before trying again.",
    );
}

export function createTool(options: HttpOptions = {}): HttpTool {
    const http = createHttp(options);

    return {
        classify(input) {
            // An unknown target throws a TypeError that names the known ones. jig-core cannot decide such a call, so it is
            // blocked without asking.
            const target = findTarget(currentSettings(), input.target);
            return { environment: target.environment, effect: input.method === "GET" ? "read" : "write" };
        },

        async preview(input) {
            try {
                return previewOf(planOf(parseCall(input, currentSettings())));
            } catch (error) {
                // jig-core takes any TypeError from a preview to mean that the input is invalid, and blocks the call without
                // asking. Only an InputError may say so: a TypeError from a bug here is an ordinary failure, which shows as
                // "preview unavailable" and leaves the decision to the person.
                if (error instanceof TypeError && !(error instanceof InputError)) {
                    throw new Error(`internal error: ${error.message}`);
                }
                throw error;
            }
        },

        definition: {
            name: "http",
            label: "HTTP",
            description: DESCRIPTION,
            promptSnippet: "http: call a named HTTP API: GET reads, POST, PUT, PATCH and DELETE write",
            parameters,
            // One call at a time and in order: a write must be done before the read that checks it.
            executionMode: "sequential",
            async execute(toolCallId, params, signal) {
                const plan = planOf(parseCall(params, currentSettings()));

                const approved = jig().approvedPreview(toolCallId);
                if (approved?.fingerprint !== undefined && approved.fingerprint !== plan.fingerprint) {
                    throw new Error(
                        `${where(plan)}: changed since the preview; run it again to see the new preview. Nothing was sent.`,
                    );
                }

                let sent: Sent;
                try {
                    sent = await http.send(plan, signal);
                } catch (error) {
                    throw describeFailure(plan, error);
                }
                jig().addFacts(toolCallId, { status: sent.answer.status });
                return {
                    content: [{ type: "text", text: renderResult(plan, sent) }],
                    details: { target: plan.call.target.name, method: plan.call.method, status: sent.answer.status },
                };
            },
        },
    };
}
