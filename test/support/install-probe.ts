// Loaded by scripts/check-install.mjs into the stock Pi it starts next to the installed package, never by a user. It gives Pi a model that
// calls nothing (a Pi in RPC mode refuses to start without one) and a command, /install-probe, that writes down which file registered
// which tool. Pi's own `get_commands` says the same for commands; Pi has no such request for tools.
import { writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
    pi.registerProvider(
        fauxProvider({
            provider: "faux",
            models: [{ id: "faux-1", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
        }).provider,
    );
    pi.registerCommand("install-probe", {
        description: "Writes the tools of every extension to the file named by JIG_INSTALL_PROBE_OUT",
        handler: async () => {
            const out = process.env.JIG_INSTALL_PROBE_OUT;
            if (out === undefined) throw new Error("JIG_INSTALL_PROBE_OUT is not set");
            const tools = pi.getAllTools().map((tool) => ({ name: tool.name, path: tool.sourceInfo.path }));
            writeFileSync(out, JSON.stringify({ tools }));
        },
    });
}
