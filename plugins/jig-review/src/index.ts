// jig-review: a private, GitHub-style review of the agent's changes in the browser, before anything is shared. The factory
// only registers: nothing is written and no server starts until the user opens a review.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import type { CallClass, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { ReviewCoordinator } from "./coordinator.ts";
import { reviewRoot } from "./settings.ts";
import { RESOLUTION_TOOL, START_TOOL } from "./tools.ts";

/** Both tools only write this plugin's own review files, in a folder under Pi's agent folder. */
const LOCAL_WRITE: CallClass = { environment: "local", effect: "write" };

export const DECLARATIONS: ToolDeclaration[] = [START_TOOL, RESOLUTION_TOOL].map((tool) => ({
    tool,
    plugin: "jig-review",
    classify: () => LOCAL_WRITE,
}));

export default function (pi: ExtensionAPI) {
    new ReviewCoordinator(pi, process.cwd(), { root: reviewRoot(getAgentDir()) }).register();
    // jig-core may load after this plugin; withJig waits for it.
    withJig((api) => {
        for (const declaration of DECLARATIONS) api.declareTool(declaration);
    });
}
