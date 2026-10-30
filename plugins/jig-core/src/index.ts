// jig-core: the tool manager. It sits over every tool call, whoever wrote the tool, through Pi's hooks:
//
//   tool_call            classify the call, decide allow / ask / deny, ask the user if a rule says so
//   tool_result          redact secrets, mask production data, cut very long output
//   tool_execution_end   write the call's record
//   turn_end             write the model turn's record
//
// It also runs the watch engine (src/watch) and registers the `watch` tool.
//
// The factory only registers things. It starts nothing long-lived (Pi's documentation forbids it): the configuration is
// loaded when the session starts.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildApi } from "./api.ts";
import { publishJig, withdrawJig } from "./client.ts";
import { cleanupSpill } from "./cap.ts";
import { registerCommands } from "./commands.ts";
import { describeProblem } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { gate } from "./gate.ts";
import { configFile } from "./paths.ts";
import { cleanupPreviews } from "./preview-html.ts";
import { cleanupRecords } from "./records.ts";
import { finishCall, finishTurn, toolResult } from "./results.ts";
import { createState, loadPersonalConfig } from "./state.ts";
import type { JigCoreOptions, JigState } from "./state.ts";
import { registerWatchTool } from "./watch/tool.ts";

export type { JigCoreOptions };

/** The extension, with parts a test can replace (the masker, the browser). Pi loads the default export below. */
export function jigCore(options: JigCoreOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const state = createState(pi, options);
        state.configPath = () => configFile(getAgentDir());
        const api = buildApi(state);

        pi.on("session_start", (_event, ctx) => startSession(state, ctx));
        pi.on("tool_call", (event, ctx) => gate(state, event, ctx));
        pi.on("tool_result", (event, ctx) => toolResult(state, event, ctx));
        pi.on("tool_execution_end", (event, ctx) => finishCall(state, event, ctx));
        pi.on("turn_end", (event, ctx) => finishTurn(state, event, ctx));
        pi.on("session_shutdown", () => {
            // Safe to run twice: cancellation, reload and exit can all arrive here.
            withdrawJig(api);
            state.sessionAllows.clear();
            state.calls.clear();
            state.watches.end();
            state.screen = undefined;
        });
        registerCommands(pi, state);
        registerWatchTool(pi, api, state.watches);

        // Last, so the hooks are in place before other plugins start declaring their tools. A plugin whose start-up
        // callback throws must not take the tool manager, or the other plugins, down with it: the error is kept
        // for `/jig`.
        for (const error of publishJig(api)) {
            state.startupProblems.push(`a plugin failed while loading: ${errorMessage(error)}`);
        }
    };
}

function startSession(state: JigState, ctx: ExtensionContext): void {
    state.sessionId = ctx.sessionManager.getSessionId();
    state.screen = ctx.hasUI ? ctx.ui : undefined;
    loadPersonalConfig(state);
    // Watches saved by this session before Pi was closed start polling again.
    state.watches.begin(state.sessionId);

    const problems = [...state.policy().problems.map(describeProblem), ...state.startupProblems];
    if (problems.length > 0 && ctx.hasUI) {
        const shown = problems.slice(0, 5).join("\n");
        const more = problems.length > 5 ? `\n... and ${problems.length - 5} more (see /jig)` : "";
        ctx.ui.notify(`jig-core: ${problems.length} configuration problem${problems.length === 1 ? "" : "s"}\n${shown}${more}`, "error");
    }

    // Old records, spill files and preview pages are removed when a session starts.
    const { config } = state.personal;
    for (const clean of [
        () => cleanupRecords(config.records.retentionDays, state.now()),
        () => cleanupSpill(config.spill.retentionDays, state.now().getTime()),
        () => cleanupPreviews(config.spill.retentionDays, state.now().getTime()),
    ]) {
        try {
            clean();
        } catch {
            // Cleaning up is a courtesy; a session should still start.
        }
    }
}

export default jigCore();
