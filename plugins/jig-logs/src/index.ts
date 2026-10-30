// jig-logs: log search for the agent. One tool, `logs`, that reads the logs of an Elasticsearch, OpenSearch or Loki
// backend. The tool only says what each call does; jig-core decides whether it runs and masks what comes back.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateLogsSection } from "./config.ts";
import { createLogsTool } from "./tool.ts";

const tool = createLogsTool();

export default function (pi: ExtensionAPI) {
    pi.registerTool(tool.definition);
    // jig-core may load after this plugin; withJig waits for it. What the tool declares is how jig-core classifies it.
    withJig((api) => {
        api.declareTool(tool.declaration);
        api.config.registerSection("logs", validateLogsSection);
    });
}
