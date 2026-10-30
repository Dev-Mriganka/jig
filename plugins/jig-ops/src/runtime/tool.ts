// The `runtime` tool: what Pi registers, and the classification that makes up jig-core's declaration of it.
//
// Every action reads. The tool says where each call acts (the environment of the catalog, which is also the name that
// jig-core knows the environment by) and that it is a read; jig-core decides what that means. A production read is
// allowed and jig-core masks the result, so this plugin masks nothing itself (`masksOwnResults` stays unset).
//
// One thing is refused here and not left to the rules: curl inside a pod, in an environment that jig-core counts as
// production. jig-core can tell the kind of any environment name, so the tool asks it, and the call is blocked in
// classify without asking anyone.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../../jig-core/src/client.ts";
import type { CallClass } from "../../../jig-core/src/contract.ts";
import { catalogOf } from "../catalog.ts";
import { classifying, InputError } from "../values.ts";
import type { Outcome } from "../values.ts";
import { eventsAction } from "./kubernetes/events.ts";
import { inPodHealth } from "./kubernetes/inpod.ts";
import { logsAction } from "./kubernetes/logs.ts";
import { podsAction } from "./kubernetes/pods.ts";
import { rolloutAction } from "./kubernetes/wait.ts";
import type { Waiting } from "./kubernetes/wait.ts";
import { HEALTH_TIMEOUT_MS, urlHealth } from "./health.ts";
import { parameters, parseCall } from "./params.ts";
import type { Call } from "./params.ts";

const DESCRIPTION =
    "Read a service's runtime state from the ops catalog: its pods, its rollout (optionally waiting for a version), " +
    "pod logs, recent events and its health address. It only reads.";

type Input = Readonly<Record<string, unknown>>;

/** The parts of the tool a test replaces. */
export interface RuntimeOptions {
    /** The clock. Default: the real one. */
    now?: () => number;
    /** Waits between polls, and ends early when the call is stopped. Default: a timer. */
    sleep?: Waiting["sleep"];
    /** The `fetch` that health checks use. Default: the global one. */
    fetch?: typeof fetch;
    /** How long a health check waits for an answer. Default: ten seconds. */
    healthTimeoutMs?: number;
}

export interface RuntimeTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Input): CallClass;
}

/** The catalog as jig-core loaded it. Read on every call, so a configuration change applies. */
function currentCatalog() {
    return catalogOf(jig().config.section("ops"));
}

function timerSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", stop);
            resolve();
        }, ms);
        const stop = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", stop, { once: true });
    });
}

/**
 * Throws an InputError for a call that must not run. curl inside a pod does not run in production, whatever the rules
 * say: an environment jig-core counts as production (a name it does not know included) gets its health from an address.
 */
function refuse(call: Call): void {
    if (call.action !== "health" || call.how.kind !== "pod") return;
    if (jig().environments.kindOf(call.env.name) !== "production") return;
    throw new InputError(
        `runtime health is refused in production (${call.env.service} in ${call.env.name}): ` +
            "without a health address it would run curl inside a pod, and nothing is run in a production pod. " +
            'Add "health" (an https address) to its entry in the ops catalog',
    );
}

export function createRuntimeTool(options: RuntimeOptions = {}): RuntimeTool {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? timerSleep;
    const fetchHealth = options.fetch ?? fetch;
    const healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;

    /** One action of one checked call. */
    function run(call: Call, signal: AbortSignal | undefined, progress: (text: string) => void): Promise<Outcome> {
        switch (call.action) {
            case "pods":
                return podsAction({ target: call.target, signal }, now());
            case "rollout":
                return rolloutAction({ target: call.target, signal }, call, { now, sleep, progress });
            case "logs":
                return logsAction({ target: call.target, signal }, call);
            case "events":
                return eventsAction({ target: call.target, signal }, now());
            case "health":
                if (call.how.kind === "url") {
                    return urlHealth(call.how.url, signal, { fetch: fetchHealth, timeoutMs: healthTimeoutMs });
                }
                return inPodHealth({ target: call.how.target, signal });
        }
    }

    return {
        classify(input) {
            // An unknown service or environment, a call that breaks the limits, and a
            // health check that would run in a production pod all throw a TypeError
            // that says what to change, and jig-core blocks the call without asking.
            return classifying(() => {
                const call = parseCall(input, currentCatalog());
                refuse(call);
                return { action: call.action, environment: call.env.name, effect: "read" };
            });
        },

        definition: {
            name: "runtime",
            label: "Runtime",
            description: DESCRIPTION,
            promptSnippet: "runtime: read a service's pods, rollout, logs, events and health from the ops catalog",
            promptGuidelines: [
                "runtime: run pods first; after a deploy call rollout with waitFor once instead of polling pods.",
                "runtime: read the ops skill. A health check in a pod runs in test environments only; " +
                    "sign-in failures are the user's.",
            ],
            parameters,
            async execute(toolCallId, params, signal, onUpdate) {
                const call = parseCall(params as Input, currentCatalog());
                // jig-core has classified the call already; checking again holds when the tool is run without it.
                refuse(call);
                const progress = (text: string) => {
                    onUpdate?.({ content: [{ type: "text", text }], details: undefined });
                };
                const outcome = await run(call, signal, progress);
                jig().addFacts(toolCallId, outcome.facts);
                return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
            },
        },
    };
}
