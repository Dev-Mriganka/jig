// The `deploy` tool: what Pi registers, and the classification and preview that jig-core's declaration is made of besides its
// name.
//
//   plan, status  read, in the environment of the call
//   run, rollback write in the environment of the call. jig-core asks the user, with the preview as the screen; the floor
//                 denies production anyway
//   watch         a local write: it starts a watch on this machine, and changes no environment
//
// What may not run is refused in classify with a TypeError, so jig-core blocks the call without asking: an unknown service or
// environment, an environment the catalog gives no deploy method, production, and a rollback outside a test environment. The
// kind of an environment is asked of jig-core, which knows every name; a name it does not know counts as production.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../../jig-core/src/client.ts";
import type { CallClass, Preview } from "../../../jig-core/src/contract.ts";
import { catalogOf } from "../catalog.ts";
import type { Kube } from "../runtime/kubernetes/kubectl.ts";
import { classifying, InputError, previewing } from "../values.ts";
import type { Outcome } from "../values.ts";
import { planAction, rollbackAction, runAction, statusAction, watchAction } from "./actions.ts";
import type { Context } from "./actions.ts";
import { parameters, parseCall } from "./params.ts";
import type { Call } from "./params.ts";
import { planRollback, planRun, refusal } from "./plan.ts";
import { createRecords } from "./records.ts";

const DESCRIPTION =
    "Deploy a version of a service with the method the ops catalog names: plan what would change, run it (the user is asked " +
    "first), status, rollback (test environments only), and watch the rollout in the background. Never production.";

type Input = Readonly<Record<string, unknown>>;

/** The parts of the tool a test replaces. */
export interface DeployOptions {
    /** The clock. Default: the real one. */
    now?: () => number;
    /** How long a command that changes the cluster may run before it is stopped. Default: helm six minutes, kubectl one. */
    writeTimeoutMs?: number;
}

export interface DeployTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Input): CallClass;
    preview(input: Input, signal: AbortSignal): Promise<Preview>;
}

/** The catalog as jig-core loaded it. Read on every call, so a configuration change applies. */
function currentCatalog() {
    return catalogOf(jig().config.section("ops"));
}

/** Throws an InputError for a deploy or a rollback that may not run. */
function refuse(call: Call): void {
    if (call.action !== "run" && call.action !== "rollback") return;
    const why = refusal(call.action, call.env, jig().environments.kindOf(call.env.name));
    if (why !== undefined) throw new InputError(`deploy ${call.action} is refused: ${why}`);
}

export function createDeployTool(options: DeployOptions = {}): DeployTool {
    const ctx: Context = { now: options.now ?? Date.now, writeTimeoutMs: options.writeTimeoutMs, records: createRecords() };

    function run(call: Call, toolCallId: string, signal: AbortSignal | undefined): Promise<Outcome> | Outcome {
        const kube: Kube = { target: call.target, signal };
        switch (call.action) {
            case "plan":
                return planAction(call, kube);
            case "run":
                return runAction(call, kube, toolCallId, ctx);
            case "status":
                return statusAction(call, kube, ctx);
            case "rollback":
                return rollbackAction(call, kube, toolCallId, ctx);
            case "watch":
                return watchAction(call, ctx);
        }
    }

    return {
        classify(input) {
            return classifying(() => {
                const call = parseCall(input, currentCatalog());
                refuse(call);
                // A watch lives on this machine and reads the cluster; it changes no environment.
                if (call.action === "watch") return { action: call.action, environment: "local", effect: "write" };
                const effect = call.action === "run" || call.action === "rollback" ? "write" : "read";
                return { action: call.action, environment: call.env.name, effect };
            });
        },

        // The review screen of a deploy or a rollback: the exact command, and the versions it goes between. The plan reads the
        // cluster, and the tool plans again when it runs and refuses if the plan is no longer this one.
        async preview(input, signal) {
            return previewing(async () => {
                const call = parseCall(input, currentCatalog());
                refuse(call);
                const kube: Kube = { target: call.target, signal };
                const kind = jig().environments.kindOf(call.env.name);
                const where = `${call.env.service} in ${call.env.name}`;
                switch (call.action) {
                    case "run":
                        return (await planRun(call.env, call.version, kube, kind)).preview;
                    case "rollback":
                        return (await planRollback(call.env, kube, kind)).preview;
                    case "plan":
                        return { summary: `plan the deploy of ${call.version} to ${where}` };
                    case "status":
                        return { summary: `show the last deploy and the rollout of ${where}` };
                    case "watch":
                        return { summary: `watch the rollout of ${where} to ${call.version}, in the background` };
                }
            });
        },

        definition: {
            name: "deploy",
            label: "Deploy",
            description: DESCRIPTION,
            promptSnippet: "deploy: plan, run (asks the user), status, rollback and watch a service's rollout; never production",
            promptGuidelines: [
                "deploy: plan first, then run; run asks the user. Then watch with the same version instead of polling.",
                "deploy: when run says the outcome is unknown, do not run it again. Check with status and tell the user.",
            ],
            parameters,
            // One call at a time and in order: a deploy must be done before the watch that follows it.
            executionMode: "sequential",
            async execute(toolCallId, params, signal) {
                const call = parseCall(params as Input, currentCatalog());
                // jig-core has classified the call already; checking again holds when the tool is run without it.
                refuse(call);
                const outcome = await run(call, toolCallId, signal);
                jig().addFacts(toolCallId, outcome.facts);
                return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
            },
        },
    };
}
