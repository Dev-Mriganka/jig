// Pi entry point of jig-mongo. The factory only registers: the `mongo` section and the tool's declaration go to jig-core, and the
// tool goes to Pi. Nothing is read from a database, a secret store or a bastion host until a call is made.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { MONGO_REPLACE, statusLines, validateMongo } from "./config.ts";
import { createTool } from "./tool.ts";
import type { MongoOptions } from "./tool.ts";

export type { MongoOptions };

/** The extension, with parts a test can replace (the connection to a database, the routes and the timers). Pi loads the default export below. */
export function jigMongo(options: MongoOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const tool = createTool(options);
        // jig-core may load after this plugin; withJig waits for it.
        withJig((api) => {
            api.config.registerSection("mongo", validateMongo, { replace: MONGO_REPLACE });
            api.declareTool({ tool: "mongo", plugin: "jig-mongo", classify: tool.classify, preview: tool.preview });
            // `/jig` says when the index check is off for a production connection: that is the user's choice, and it is shown.
            api.status?.register("jig-mongo", statusLines);
        });
        pi.registerTool(tool.definition);
        // The connections and the SSH forwards end with the session.
        pi.on("session_shutdown", () => {
            void tool.shutdown();
        });
    };
}

export default jigMongo();
