// Pi entry point of jig-k8s. The factory only registers: the `k8s` section and the tool's declaration go to jig-core, the
// tool goes to Pi, and a listener hears jig-core's decisions. Nothing is read from a cluster until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateK8s } from "./config.ts";
import { createDecisions, DECISION_EVENT } from "./decisions.ts";
import { createTool } from "./tool.ts";
import type { K8sOptions } from "./tool.ts";

export type { K8sOptions };

/** The extension, with parts a test can replace (the clock and the sleep). Pi loads the default export below. */
export function jigK8s(options: K8sOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const decisions = createDecisions();
        pi.events.on(DECISION_EVENT, (event) => decisions.remember(event));
        const tool = createTool({ ...options, decisions });
        // jig-core may load after this plugin; withJig waits for it. What the tool declares is how jig-core classifies it.
        withJig((api) => {
            api.config.registerSection("k8s", validateK8s);
            api.declareTool({ tool: "k8s", plugin: "jig-k8s", classify: tool.classify });
        });
        pi.registerTool(tool.definition);
    };
}

export default jigK8s();
