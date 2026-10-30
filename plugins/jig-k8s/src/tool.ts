// The `k8s` tool: what Pi registers, and the classification that jig-core's declaration is made of besides its name.
//
// Every action reads. The tool says where each call acts (the jig-core environment of the service's environment) and
// that it is a read; jig-core decides what that means. A production read is allowed and jig-core masks the result, so
// this plugin masks nothing itself (`masksOwnResults` stays unset).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { apiAction } from "./api.ts";
import { settingsOf } from "./config.ts";
import { requireNotProduction } from "./decisions.ts";
import type { Decisions } from "./decisions.ts";
import type { Kube } from "./kubectl.ts";
import { logsAction } from "./logs.ts";
import { parameters, parseCall } from "./params.ts";
import type { Call } from "./params.ts";
import { podsAction } from "./pods.ts";
import { statusAction } from "./status.ts";
import type { Waiting } from "./status.ts";
import { InputError } from "./values.ts";
import type { Outcome } from "./values.ts";

const DESCRIPTION =
    "Read a service's Kubernetes state with kubectl: its pods, its rollout status (optionally waiting for a " +
    "version), pod logs, and a GET on its API from inside a pod (test environments only). It only reads.";

type Input = Readonly<Record<string, unknown>>;

/** The parts of the tool a test replaces. */
export interface K8sOptions {
    /** The clock. Default: the real one. */
    now?: () => number;
    /** Waits between polls, and ends early when the call is stopped. Default: a timer. */
    sleep?: Waiting["sleep"];
}

export interface K8sTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Input): CallClass;
}

/** The section as jig-core loaded it. Read on every call, so a configuration change applies. */
function currentSettings() {
    return settingsOf(jig().config.section("k8s"));
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

export function createTool(options: K8sOptions & { decisions: Decisions }): K8sTool {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? timerSleep;

    /** One action of one checked call. */
    function run(call: Call, kube: Kube, toolCallId: string, progress: (text: string) => void): Promise<Outcome> {
        switch (call.action) {
            case "pods":
                return podsAction(kube, now());
            case "status":
                return statusAction(kube, call, { now, sleep, progress });
            case "logs":
                return logsAction(kube, call);
            case "api":
                // classify can refuse only the environment that is always production. The rest is jig-core's decision
                // for this call, and a command in a pod waits for it.
                requireNotProduction(options.decisions, toolCallId, call.target);
                return apiAction(kube, call);
        }
    }

    return {
        classify(input) {
            try {
                // An unknown service or environment, a call that breaks the limits, and `api` where it is not allowed
                // all throw a TypeError that says what to change, and jig-core blocks the call without asking.
                const call = parseCall(input, currentSettings());
                return { action: call.action, environment: call.target.jigEnvironment, effect: "read" };
            } catch (error) {
                // jig-core takes any TypeError to mean that the input is invalid. Only an InputError may say so: a
                // TypeError from a bug here is an ordinary failure, and must not be told to the model as its own
                // mistake.
                if (error instanceof TypeError && !(error instanceof InputError)) {
                    throw new Error(`internal error: ${error.message}`);
                }
                throw error;
            }
        },

        definition: {
            name: "k8s",
            label: "Kubernetes",
            description: DESCRIPTION,
            promptSnippet:
                "k8s: read a service's pods, rollout status, logs, and (in test environments) its API, through kubectl",
            promptGuidelines: [
                "k8s: run pods first; after a deploy call status with waitFor once instead of polling pods.",
                "k8s: read the k8s skill. api works in test environments only; sign-in failures are the user's.",
            ],
            parameters,
            async execute(toolCallId, params, signal, onUpdate) {
                const call = parseCall(params as Input, currentSettings());
                const kube: Kube = { target: call.target, signal };
                const progress = (text: string) => {
                    onUpdate?.({ content: [{ type: "text", text }], details: undefined });
                };
                const outcome = await run(call, kube, toolCallId, progress);
                jig().addFacts(toolCallId, outcome.facts);
                return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
            },
        },
    };
}
