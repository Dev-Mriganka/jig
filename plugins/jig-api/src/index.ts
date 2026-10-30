// Pi entry point of jig-http. The factory only registers: the `http` section and the tool's declaration go to jig-core, and
// the tool to Pi. Nothing is read or sent until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateHttp } from "./config.ts";
import type { HttpOptions } from "./engine/http.ts";
import { createTool } from "./tool.ts";

export type { HttpOptions };

/** The extension, with parts a test can replace (the clock and the timeouts). Pi loads the default export below. */
export function jigHttp(options: HttpOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const tool = createTool(options);
        withJig((api) => {
            api.config.registerSection("http", validateHttp);
            api.declareTool({ tool: "http", plugin: "jig-api", classify: tool.classify, preview: tool.preview });
        });
        pi.registerTool(tool.definition);
    };
}

export default jigHttp();
