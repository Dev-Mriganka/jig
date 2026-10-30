// Pi entry point of jig-ops. The factory only registers: the `ops` section, the tools' declarations and the watch kind
// go to jig-core, the tools go to Pi. Nothing is read from a cluster until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateOps } from "./catalog.ts";
import { createDeployTool } from "./deploy/tool.ts";
import type { DeployOptions } from "./deploy/tool.ts";
import { createRuntimeTool } from "./runtime/tool.ts";
import type { RuntimeOptions } from "./runtime/tool.ts";
import { registerRolloutWatch } from "./watch.ts";

/** The parts of the plugin a test replaces: the clock, the sleep, the fetch and the timeouts. */
export type OpsOptions = RuntimeOptions & DeployOptions;

/** The extension, with parts a test can replace. Pi loads the default export below. */
export function jigOps(options: OpsOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const runtime = createRuntimeTool(options);
        const deploy = createDeployTool(options);
        // jig-core may load after this plugin; withJig waits for it.
        // What the tools declare is how jig-core classifies them.
        withJig((api) => {
            api.config.registerSection("ops", validateOps);
            api.declareTool({ tool: "runtime", plugin: "jig-ops", classify: runtime.classify });
            api.declareTool({ tool: "deploy", plugin: "jig-ops", classify: deploy.classify, preview: deploy.preview });
            registerRolloutWatch(api, options);
        });
        pi.registerTool(runtime.definition);
        pi.registerTool(deploy.definition);
    };
}

export default jigOps();
