// The `logs` tool: search one environment's logs. It only reads.
//
// The tool says where each call acts: the jig-core environment of the environment searched, and a read. jig-core
// decides what that means. A production search is allowed and its result is masked there, so this plugin does not
// mask anything itself (`masksOwnResults` stays unset).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import type { CallClass, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { backendOf } from "./backends/index.ts";
import { requireSettings, targetFor } from "./config.ts";
import { checkParams, logsParameters, resolveQuery, resolveView } from "./params.ts";
import { sender } from "./request.ts";
import { runSearch } from "./search.ts";
import { summarize } from "./summary.ts";

type Input = Readonly<Record<string, unknown>>;

/** The parts of the tool a test replaces. */
export interface LogsDeps {
    /** The clock. Relative windows end now. */
    now?: () => number;
    /** The network, for direct requests. */
    fetch?: typeof fetch;
    /** How long one request may take. Default 30 seconds. */
    timeoutMs?: number;
}

export interface JigTool {
    definition: ToolDefinition;
    declaration: ToolDeclaration;
}

/** The tool and its declaration to jig-core. */
export function createLogsTool(deps: LogsDeps = {}): JigTool {
    const now = deps.now ?? Date.now;

    const definition: ToolDefinition = {
        name: "logs",
        label: "Logs",
        description:
            "Search logs by exact phrase, or by a Lucene or LogQL query, over at most 7 days: the number of hits, " +
            "then one line per hit. match, exclude and around choose and shape the lines. It only reads.",
        promptSnippet: "Search logs by phrase or query in a time window",
        promptGuidelines: [
            "logs: search an exact identifier in a narrow window first (30m to 2h); widen the window step by step.",
            "logs: pick lines with match, exclude and around instead of raising size; read the logs skill.",
        ],
        parameters: logsParameters,
        async execute(toolCallId, params, signal, onUpdate) {
            const input = params as Input;
            checkParams(input);
            const settings = requireSettings();
            const target = targetFor(settings, input.environment);
            const query = resolveQuery(input, input.environment as string, target, now());
            const view = resolveView(input);

            const send = sender(settings.backend, backendOf(target).wire(target, settings.backend), {
                signal,
                timeoutMs: deps.timeoutMs,
                fetch: deps.fetch,
            });
            const progress = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
            const outcome = await runSearch(query, { send, signal, now, progress });
            const summary = summarize(query, outcome, view);

            jig().addFacts(toolCallId, {
                status: outcome.status,
                hits: outcome.total.value,
                atLeast: outcome.total.relation === "gte",
                fetched: outcome.hits.length,
                requests: outcome.requests,
            });
            return { content: [{ type: "text", text: summary.text }], details: summary.details };
        },
    };

    const declaration: ToolDeclaration = {
        tool: "logs",
        plugin: "jig-logs",
        classify(input: Input): CallClass {
            // An environment nobody configured is invalid input: the TypeError names the ones that exist.
            const target = targetFor(requireSettings(), input.environment);
            // So is a query that could reach beyond the selector, and jig-core blocks it here without asking.
            if (typeof input.query === "string") backendOf(target).checkQuery?.(input.query);
            return { environment: target.jigEnvironment, effect: "read" };
        },
    };

    return { definition, declaration };
}
