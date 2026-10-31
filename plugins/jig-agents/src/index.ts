// Pi entry point of jig-agents. The factory only registers: the `agents` section, the tool's declaration and the kind of watch go to
// jig-core, the tool and the command go to Pi. Nothing starts until a session does, and a child ends with the session that started it.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { JIG_EVENTS } from "../../jig-core/src/contract.ts";
import type { WatchDoneEvent } from "../../jig-core/src/contract.ts";
import { registerCommands } from "./commands.ts";
import { validateAgents } from "./config.ts";
import { realHost } from "./host.ts";
import type { Host } from "./host.ts";
import { installRoleGate } from "./role-gate.ts";
import { loadRoles, shippedFolder } from "./roles.ts";
import { Runtime } from "./runtime.ts";
import { createTool, describeTool } from "./tool.ts";
import { watchKind } from "./watch.ts";

/** What a test can replace: Pi's program, the clock and the process table. A real session uses the real ones. */
export interface AgentsOptions {
    host?: Host;
    /** Gives a test the runtime the factory made. */
    onRuntime?: (runtime: Runtime) => void;
}

/** The extension, with parts a test can replace. Pi loads the default export below. */
export function agents(options: AgentsOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const host = options.host ?? realHost();
        const rt = new Runtime(pi, host);
        options.onRuntime?.(rt);
        // A child enforces the narrowing its role gave it: a gate for the policy in its environment. A policy that cannot be read refuses
        // every call, and is reported when the session starts, which the parent's start-up check reads as a plugin that failed to load.
        const policyProblem = installRoleGate(host.env());
        if (policyProblem !== undefined) {
            pi.on("session_start", () => {
                throw new Error(policyProblem);
            });
        }
        // The tool's description lists the roles. It starts with the ones that ship, and is registered again at session start when
        // the user's or a company's files change the list.
        let described = describeTool(loadRoles([shippedFolder()]).roles.values());
        const tool = createTool(rt, described);
        // jig-core may load after this plugin; withJig waits for it.
        withJig((api) => {
            // What a role's `ask` adds up: a company's and yours both apply. Everything else in a role is replaced by the later layer.
            api.config.registerSection("agents", validateAgents, { union: ["roles.*.ask.*"] });
            api.declareTool(tool.declaration);
            api.watches.registerKind(watchKind(rt));
            api.status?.register("jig-agents", () => rt.statusLines());
        });
        pi.registerTool(tool.definition);
        registerCommands(pi, rt);

        const stopListening = pi.events.on(JIG_EVENTS.watchDone, (event) => rt.onWatchDone(event as WatchDoneEvent));
        // A question from a child is asked on the latest screen Pi gave this plugin, so every event that carries a context keeps it.
        pi.on("input", (_event, ctx) => rt.touch(ctx));
        pi.on("turn_start", (_event, ctx) => rt.touch(ctx));
        pi.on("tool_execution_start", (_event, ctx) => rt.touch(ctx));
        pi.on("session_start", (_event, ctx) => {
            rt.begin(ctx);
            const next = describeTool(rt.roles.roles.values());
            if (next !== described) {
                described = next;
                pi.registerTool(createTool(rt, next).definition);
            }
        });
        pi.on("session_shutdown", async () => {
            stopListening();
            await rt.end();
        });
    };
}

export default agents();
