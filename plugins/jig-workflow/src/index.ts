// Pi entry point of jig-workflow. The factory only registers: the `workflow` section, the tool's declaration and the gate go to
// jig-core, the tool and the command go to Pi, and the listeners for other plugins' events go to Pi's event bus. Nothing is read
// from a ticket folder or a repository until a session starts or a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { registerCommands } from "./commands.ts";
import { validateWorkflow } from "./config.ts";
import { createGate } from "./gate.ts";
import type { Host } from "./host.ts";
import { coreHost } from "./host.ts";
import { onCiFinished, onReviewApproved } from "./listeners.ts";
import { Runtime } from "./runtime.ts";
import { CI_FINISHED_EVENT, REVIEW_APPROVED_EVENT } from "./sources.ts";
import { startLine, ticketStatus } from "./status.ts";
import { createTool } from "./tool.ts";

/** The custom message that tells the agent where the work is after a compaction. */
export const STATUS_MESSAGE = "jig-workflow-status";

/** What a test can replace: the programs, the sandbox and the clock. A real session uses jig-core's. */
export interface WorkflowOptions {
    host?: Host;
}

/** The extension, with parts a test can replace. Pi loads the default export below. */
export function workflow(options: WorkflowOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const rt = new Runtime(pi, options.host ?? coreHost());
        const tool = createTool(rt);
        // jig-core may load after this plugin; withJig waits for it.
        withJig((api) => {
            // A company's workflow folders and yours add up, theirs first; every other list is replaced by yours, as usual.
            api.config.registerSection("workflow", validateWorkflow, { union: ["folders"] });
            api.declareTool(tool.declaration);
            api.gates.register(createGate(rt));
        });
        pi.registerTool(tool.definition);
        registerCommands(pi, rt);

        const listening = [
            pi.events.on(REVIEW_APPROVED_EVENT, (payload) => onReviewApproved(rt, payload)),
            pi.events.on(CI_FINISHED_EVENT, (payload) => void onCiFinished(rt, payload)),
        ];

        // The gate and the tool ask who the active ticket is: every event that carries a context keeps the session in hand.
        pi.on("input", (_event, ctx) => {
            rt.touch(ctx);
        });
        pi.on("turn_start", (_event, ctx) => {
            rt.touch(ctx);
        });
        pi.on("tool_execution_start", (_event, ctx) => {
            rt.touch(ctx);
        });
        pi.on("tool_result", (event, ctx) => {
            rt.touch(ctx);
            rt.noteResult(event.toolCallId, event.toolName, event.isError);
        });
        pi.on("session_start", async (_event, ctx) => {
            rt.start(ctx);
            try {
                const line = await startLine(rt);
                if (line !== undefined && ctx.hasUI) ctx.ui.notify(line, "info");
            } catch {
                // A line that could not be made is not worth a session that does not start.
            }
        });
        // A compaction may have folded away what the agent knew of the stage, so it is told again, as `jig-memory` tells the notes.
        pi.on("session_compact", async (_event, ctx) => {
            rt.touch(ctx);
            const ticket = rt.activeTicket();
            if (ticket === undefined) return;
            const work = rt.work(ticket);
            if (work.read.kind !== "state") return;
            try {
                const report = await ticketStatus(rt, work, { live: false });
                pi.sendMessage(
                    {
                        customType: STATUS_MESSAGE,
                        content: `Still on the workflow after compaction.\n${report.text}`,
                        display: true,
                        details: { ticket },
                    },
                    { triggerTurn: false },
                );
            } catch {
                // See above.
            }
        });
        pi.on("session_shutdown", () => {
            for (const stop of listening) stop();
        });
    };
}

export default workflow();
