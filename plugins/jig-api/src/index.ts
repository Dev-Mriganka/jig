// Pi entry point of jig-api. The factory only registers: the `api` section and the tool's declaration go to jig-core, and the
// tool to Pi. Nothing is read or sent until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateApi } from "./config.ts";
import { createTool } from "./tool.ts";
import type { ApiOptions } from "./tool.ts";

export type { ApiOptions };

/** The extension, with parts a test can replace (the clock and the timeouts). Pi loads the default export below. */
export function jigApi(options: ApiOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const tool = createTool(options);
        withJig((api) => {
            api.config.registerSection("api", validateApi);
            api.declareTool({ tool: "api", plugin: "jig-api", classify: tool.classify, preview: tool.preview });
        });
        pi.registerTool(tool.definition);
    };
}

export default jigApi();
