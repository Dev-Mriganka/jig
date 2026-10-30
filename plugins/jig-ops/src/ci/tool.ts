// The `ci` tool: what Pi registers, and the classification and preview that make up jig-core's declaration of it.
//
//   status, runs, run, log   read, at the CI host
//   rerun, trigger           write at the CI host. jig-core asks the user, with the preview as the screen
//   watch                    a local write: it starts a watch on this machine, and changes nothing at the CI host
//
// The CI host is `external` unless the catalog names the jig-core environment it is in (`ci.environment`), and then the
// rules of that environment apply: a CI server that is production gets masked reads and no writes. An action the CI
// system of the service does not have, a parameter it does not take, and a service nobody configured are refused in classify
// with a TypeError, so jig-core blocks the call without asking.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../../jig-core/src/client.ts";
import type { CallClass, Preview } from "../../../jig-core/src/contract.ts";
import { catalogOf, notSetUp } from "../catalog.ts";
import type { Catalog } from "../catalog.ts";
import { classifying, InputError, previewing } from "../values.ts";
import type { Outcome } from "../values.ts";
import type { Plan } from "./adapter.ts";
import type { Announce } from "./artifacts.ts";
import { parameters, parseCall } from "./params.ts";
import type { Call } from "./params.ts";
import { contextFor, CI_KIND } from "./watch.ts";
import type { CiWatchOptions } from "./watch.ts";

const DESCRIPTION =
    "CI for a service from the ops catalog, on GitHub Actions, GitLab CI or Jenkins: status, runs, run, log, rerun (asks), " +
    "trigger (asks), and watch, which waits in the background until a finish line and reports once.";

type Input = Readonly<Record<string, unknown>>;

export interface CiTool {
    definition: ToolDefinition<typeof parameters>;
    classify(input: Input): CallClass;
    preview(input: Input, signal: AbortSignal): Promise<Preview>;
}

/** The catalog as jig-core loaded it. Read on every call, so a configuration change applies. */
function currentCatalog(): Catalog | undefined {
    return catalogOf(jig().config.section("ops"));
}

/** Refuses a send whose plan is no longer the one the user approved. A call that did not ask has nothing to compare. */
function checkUnchanged(toolCallId: string, call: Call, plan: Plan): void {
    const approved = jig().approvedPreview(toolCallId);
    if (approved?.fingerprint === undefined || plan.preview.fingerprint === undefined) return;
    if (approved.fingerprint === plan.preview.fingerprint) return;
    throw new Error(
        `ci ${call.action} of ${call.service.name} changed since the preview; run it again to see the new preview. Nothing was sent`,
    );
}

export function createCiTool(options: CiWatchOptions & { announce: Announce }): CiTool {
    const { announce } = options;

    function adapterOf(call: Call, signal: AbortSignal | undefined) {
        return call.info.create(call.service, contextFor(signal, announce, options));
    }

    /** The write, planned: the same plan serves the preview and the send. */
    async function plan(call: Call, signal: AbortSignal | undefined): Promise<Plan> {
        const adapter = adapterOf(call, signal);
        const planned =
            call.action === "rerun" ? await adapter.rerun?.(call.params) : await adapter.trigger?.(call.params);
        if (planned === undefined)
            throw new InputError(`ci ${call.action}: ${call.info.label} does not support ${call.action}`);
        return planned;
    }

    async function run(call: Call, toolCallId: string, signal: AbortSignal | undefined): Promise<Outcome> {
        const adapter = adapterOf(call, signal);
        const { params } = call;
        switch (call.action) {
            case "status":
            case "runs":
            case "run":
            case "log": {
                const read = adapter[call.action];
                if (read === undefined)
                    throw new InputError(`ci ${call.action}: ${call.info.label} does not support it`);
                return read(params);
            }
            case "rerun":
            case "trigger": {
                const planned = await plan(call, signal);
                checkUnchanged(toolCallId, call, planned);
                return planned.send();
            }
            case "watch": {
                const planned = await adapter.watch?.(params);
                if (planned === undefined) throw new InputError(`ci watch: ${call.info.label} does not support watch`);
                const settings = currentCatalog()?.watch;
                if (settings === undefined) throw notSetUp();
                const id = jig().watches.start({
                    kind: CI_KIND,
                    spec: planned.spec,
                    title: planned.title,
                    timeoutMinutes: settings.timeoutMinutes,
                    stallMinutes: settings.stallMinutes,
                });
                return {
                    text:
                        `Watching ${planned.title} as ${id}. One message arrives when ${planned.ends}. ` +
                        "The watch tool lists and stops watches.",
                    facts: { watch: "started" },
                    details: { id, spec: planned.spec },
                };
            }
        }
    }

    return {
        classify(input) {
            // An unknown service, an action the CI system lacks, and a parameter it does not take all throw a TypeError
            // that says what to change, and jig-core blocks the call without asking.
            return classifying(() => {
                const call = parseCall(input, currentCatalog());
                if (call.action === "watch") return { action: call.action, environment: "local", effect: "write" };
                const environment = call.service.ci.environment ?? "external";
                const effect = call.action === "rerun" || call.action === "trigger" ? "write" : "read";
                return { action: call.action, environment, effect };
            });
        },

        // The review screen of a rerun or a trigger: what is sent, and the state it is sent against. The plan reads the
        // CI system, and the tool plans again when it sends and refuses if the plan is no longer this one.
        async preview(input, signal) {
            return previewing(async () => {
                const call = parseCall(input, currentCatalog());
                const name = call.service.name;
                switch (call.action) {
                    case "rerun":
                    case "trigger":
                        return (await plan(call, signal)).preview;
                    case "watch":
                        return { summary: `watch the CI of ${name}, in the background` };
                    default:
                        return { summary: `ci ${call.action} of ${name}` };
                }
            });
        },

        definition: {
            name: "ci",
            label: "CI",
            description: DESCRIPTION,
            promptSnippet:
                "ci: status, runs, log, rerun, trigger and watch for a service's CI (GitHub Actions, GitLab, Jenkins)",
            promptGuidelines: [
                "ci: after a push or a pull request a watch starts by itself for a service in the catalog; do not poll with status.",
                "ci: rerun and trigger ask the user. When a reply is lost, check once and never send again.",
            ],
            parameters,
            // One call at a time and in order: a rerun is done before the watch that follows it.
            executionMode: "sequential",
            async execute(toolCallId, params, signal) {
                const call = parseCall(params as Input, currentCatalog());
                const outcome = await run(call, toolCallId, signal);
                jig().addFacts(toolCallId, outcome.facts);
                return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
            },
        },
    };
}
