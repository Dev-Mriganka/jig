// How the three background tools are classified for jig-core. They act on this machine only: `bg_output` and `bg_list` read, and
// `bg_kill` writes (it stops a process). With jig-core's defaults a local write is allowed, so none of them asks.
import type { CallClass, ToolDeclaration } from "../../../jig-core/src/contract.ts";

const local = (effect: CallClass["effect"]): CallClass => ({ environment: "local", effect });

export function backgroundDeclarations(): ToolDeclaration[] {
    return [
        { tool: "bg_output", plugin: "jig-sandbox", classify: () => local("read") },
        { tool: "bg_list", plugin: "jig-sandbox", classify: () => local("read") },
        { tool: "bg_kill", plugin: "jig-sandbox", classify: () => local("write") },
    ];
}
