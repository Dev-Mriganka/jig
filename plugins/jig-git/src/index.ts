// jig-git: git, GitHub and CI for the agent. Four tools, `git`, `pr`, `checks` and `release`, and the GitHub watch kind that
// jig-core's engine runs. The tools only say what each call does; jig-core decides whether it runs, and asks the user.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { checksTool } from "./checks.ts";
import { validateGitSection } from "./config.ts";
import { gitTool } from "./git.ts";
import { prTool } from "./pr.ts";
import { releaseTool } from "./release.ts";
import { setWorkingDirectory } from "./repo.ts";
import type { JigTool } from "./tool.ts";
import { registerGithubWatch } from "./watch.ts";

const tools: JigTool[] = [gitTool, prTool, checksTool, releaseTool];

export default function (pi: ExtensionAPI) {
    // The tools' previews run without a context, so the folder Pi works in is remembered from the start of the session.
    pi.on("session_start", (_event, ctx) => setWorkingDirectory(ctx.cwd));
    for (const tool of tools) pi.registerTool(tool.definition);
    // jig-core may load after this plugin; withJig waits for it. What the tools declare is how jig-core classifies them.
    withJig((api) => {
        for (const tool of tools) api.declareTool(tool.declaration);
        api.config.registerSection("git", validateGitSection);
        registerGithubWatch(api, (event, payload) => pi.events.emit(event, payload));
    });
}
