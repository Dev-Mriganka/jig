// The `/agents` command: the children of this session and any problem, the roles, the end of a child's transcript, and `say` and `stop`
// typed by you. `say` and `stop` are the `message` and `stop` actions of the tool.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { oneLine, stripControl } from "./clean.ts";
import { limitsFor } from "./config.ts";
import { StartError } from "./launch.ts";
import type { Runtime } from "./runtime.ts";

const USAGE = "Use /agents, /agents roles, /agents show <id>, /agents say <id> <text>, or /agents stop <id>.";

/** The roles, with where each came from and the problems of the files that were skipped. */
export function roleReport(rt: Runtime): string {
    const lines: string[] = [];
    for (const role of rt.roles.roles.values()) {
        const settings = rt.settings.roles[role.name];
        const limits = limitsFor(rt.settings, role.name);
        const tools = role.tools === undefined ? "the usual tools" : role.tools.join(", ");
        lines.push(
            `${role.name}${role.writes ? " (writes)" : " (read-only)"}: ${stripControl(role.description)}`,
            `  tools: ${tools}; model: ${settings?.model ?? "the parent's"}; limits: ${limits.maxTurns} turns, ${limits.maxMinutes} min, $${limits.maxCost}; file: ${role.file}`,
        );
    }
    for (const name of Object.keys(rt.settings.roles)) {
        if (!rt.roles.roles.has(name))
            lines.push(`warning: agents.roles.${name} is set in jig.json, but no agent file defines the role ${name}`);
    }
    for (const problem of rt.roles.problems) lines.push(`skipped ${problem.file}: ${stripControl(problem.problem)}`);
    return lines.length === 0 ? "No roles." : lines.join("\n");
}

export function registerCommands(pi: ExtensionAPI, rt: Runtime): void {
    pi.registerCommand("agents", {
        description: "Child agents: /agents, roles, show <id>, say <id> <text>, stop <id>",
        getArgumentCompletions: (prefix) => {
            const matches = ["roles", "show", "say", "stop"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: async (args, ctx: ExtensionCommandContext) => {
            rt.touch(ctx);
            const say = (text: string, level: "info" | "warning" | "error" = "info"): void => {
                if (ctx.hasUI) ctx.ui.notify(text, level);
            };
            try {
                const trimmed = args.trim();
                const [word = "", ref = "", ...rest] = trimmed.split(/\s+/).filter((part) => part !== "");
                if (word === "") {
                    const rows = rt.statusRows();
                    const problems = rt
                        .statusLines()
                        .filter((line) => !line.startsWith("jig-agents: ") || /skipped|failed/.test(line));
                    return say(
                        [...(rows.length === 0 ? ["No children in this session."] : rows), ...problems].join("\n"),
                    );
                }
                if (word === "roles") return say(roleReport(rt));
                if (word === "show") {
                    const child = rt.require(ref);
                    const lines = child.tail(40);
                    return say(
                        lines.length === 0
                            ? `${child.name} has said nothing yet.`
                            : `${child.name}:\n${lines.join("\n")}`,
                    );
                }
                if (word === "say") {
                    const text = trimmed.replace(/^\S+\s+\S+\s*/, "");
                    if (ref === "" || (rest.length === 0 && text === "")) return say(USAGE, "warning");
                    const done = await rt.message(ref, text, ctx);
                    return say(
                        done.resumed
                            ? `${done.child.name} is running again from its saved session.`
                            : `Sent to ${done.child.name}.`,
                    );
                }
                if (word === "stop") {
                    const { outcome } = await rt.stop(ref);
                    return say(outcome.summary);
                }
                say(USAGE, "warning");
            } catch (error) {
                say(oneLine((error as Error).message, 400), error instanceof StartError ? "warning" : "error");
            }
        },
    });
}
