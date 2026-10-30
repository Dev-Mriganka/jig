// Pi entry point of jig-jira. The factory only registers: the `jira` section and the tool's declaration go to jig-core,
// and the tool to Pi. Nothing is read or sent until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateJira } from "./config.ts";
import { createTool } from "./tool.ts";
import type { JiraOptions } from "./tool.ts";

export type { JiraOptions };

/** The extension, with parts a test can replace (the timeouts). Pi loads the default export below. */
export function jigJira(options: JiraOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const tool = createTool(options);
        withJig((api) => {
            api.config.registerSection("jira", validateJira, { replace: ["auth"] });
            api.declareTool({ tool: "jira", plugin: "jig-jira", classify: tool.classify, preview: tool.preview });
        });
        pi.registerTool(tool.definition);
    };
}

export default jigJira();
