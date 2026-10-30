// Pi entry point of jig-ops. The factory only registers: the `ops` section, the tools' declarations and the watch kinds go
// to jig-core, the tools go to Pi, and the listener for pushes goes to Pi's event bus. Nothing is read from a cluster or a
// CI server until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateOps } from "./catalog.ts";
import { createAutoWatch, listenForPushes } from "./ci/autowatch.ts";
import { createCiTool } from "./ci/tool.ts";
import { registerCiWatch } from "./ci/watch.ts";
import type { CiWatchOptions } from "./ci/watch.ts";
import { createDeployTool } from "./deploy/tool.ts";
import type { DeployOptions } from "./deploy/tool.ts";
import { createRuntimeTool } from "./runtime/tool.ts";
import type { RuntimeOptions } from "./runtime/tool.ts";
import { registerRolloutWatch } from "./watch.ts";

/** The parts of the plugin a test replaces: the clock, the sleep, the fetch and the timeouts. */
export type OpsOptions = RuntimeOptions & DeployOptions & CiWatchOptions;

/** The extension, with parts a test can replace. Pi loads the default export below. */
export function jigOps(options: OpsOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        // "Artifact ready" is published on Pi's event bus, for any plugin that wants to act on it.
        const announce = (event: string, payload: unknown): void => pi.events.emit(event, payload);
        const runtime = createRuntimeTool(options);
        const deploy = createDeployTool(options);
        const ci = createCiTool({ ...options, announce });
        // jig-core may load after this plugin; withJig waits for it.
        // What the tools declare is how jig-core classifies them.
        withJig((api) => {
            api.config.registerSection("ops", validateOps);
            api.declareTool({ tool: "runtime", plugin: "jig-ops", classify: runtime.classify });
            api.declareTool({ tool: "deploy", plugin: "jig-ops", classify: deploy.classify, preview: deploy.preview });
            api.declareTool({ tool: "ci", plugin: "jig-ops", classify: ci.classify, preview: ci.preview });
            registerRolloutWatch(api, options);
            registerCiWatch(api, announce, options);
        });
        pi.registerTool(runtime.definition);
        pi.registerTool(deploy.definition);
        pi.registerTool(ci.definition);
        listenForPushes(pi, createAutoWatch(options.now));
    };
}

export default jigOps();
