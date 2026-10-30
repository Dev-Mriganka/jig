// The `watch` tool: jig-core's own tool. It lists and stops the watches of every plugin. Plugins start watches from
// their own tools, such as a CI check, so there is no "start" here.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JigApi } from "../contract.ts";
import type { WatchEngine, WatchEntry } from "./engine.ts";
import { LIST_WINDOW_MS } from "./engine.ts";
import { formatAge } from "./format.ts";

const parameters = Type.Object({
    action: StringEnum(["list", "stop"] as const, { description: "list shows the watches; stop cancels one" }),
    id: Type.Optional(Type.String({ description: "For stop: the id of the watch, as list shows it" })),
});

const DESCRIPTION =
    "List or stop background watches. Plugins start watches from their own tools; " +
    "a finished watch wakes you with a message, so there is no need to poll.";

/** What a result carries besides its text, for a screen or a script. */
interface WatchToolDetails {
    watches?: WatchEntry[];
    stopped?: string;
}

/** One line for a watch: id, title, status, age, and the outcome when it has one. */
function describeEntry(entry: WatchEntry): string {
    const status = entry.waiting ? `waiting for its plugin (${entry.plugin})` : entry.status;
    const parts = [entry.id, entry.title, status, formatAge(entry.ageMs)];
    if (entry.result !== undefined) parts.push(entry.result.outcome);
    return parts.join(" | ");
}

/** Declares the tool to the tool manager and registers it with Pi. `list` reads here, `stop` writes here. */
export function registerWatchTool(pi: ExtensionAPI, api: JigApi, engine: WatchEngine): void {
    api.declareTool({
        tool: "watch",
        plugin: "jig-core",
        classify: (input) => {
            if (input.action === "list") return { action: "list", environment: "local", effect: "read" };
            if (input.action === "stop") return { action: "stop", environment: "local", effect: "write" };
            return undefined;
        },
    });

    pi.registerTool<typeof parameters, WatchToolDetails>({
        name: "watch",
        label: "Watch",
        description: DESCRIPTION,
        promptSnippet: "List or stop background watches, such as a CI check you are waiting for",
        parameters,
        async execute(_toolCallId, params) {
            if (params.action === "stop") return stopWatch(engine, params.id);

            const entries = engine.entries();
            const text = entries.length === 0
                ? `No open watches, and none finished in the last ${LIST_WINDOW_MS / 3_600_000} hours.`
                : entries.map(describeEntry).join("\n");
            return { content: [{ type: "text", text }], details: { watches: entries } };
        },
    });
}

interface StopResult {
    content: [{ type: "text"; text: string }];
    details: WatchToolDetails;
}

function stopWatch(engine: WatchEngine, given: string | undefined): StopResult {
    const id = (given ?? "").trim();
    if (id === "") throw new Error('stop needs the id of a watch: call watch with action "list" to see them');
    const entry = engine.entries().find((candidate) => candidate.id === id);
    if (!engine.stop(id)) {
        if (entry?.status === "done") {
            throw new Error(`Watch ${id} has already finished (${entry.result?.outcome ?? "done"}).`);
        }
        throw new Error(`No open watch has the id "${id.slice(0, 40)}": call watch with action "list" to see them.`);
    }
    return {
        content: [{ type: "text", text: `Stopped watch ${id}${entry === undefined ? "" : ` (${entry.title})`}.` }],
        details: { stopped: id },
    };
}
