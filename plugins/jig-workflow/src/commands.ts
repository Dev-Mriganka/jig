// The `/workflow` command: the status of this session's work, the workflows defined, starting one, and reading the files again.
// Starting over a workflow that has state asks you here, with what would be lost: typing the command is the explicit start.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { InputError } from "../../jig-core/src/kit/values.ts";
import * as actions from "./actions.ts";
import type { Runtime } from "./runtime.ts";
import { isTicketKey } from "./ticket.ts";

const USAGE = "Use /workflow, /workflow list, /workflow start [name] [ticket], or /workflow reload.";

export function registerCommands(pi: ExtensionAPI, rt: Runtime): void {
    pi.registerCommand("workflow", {
        description: "Workflows: /workflow shows where this work is, list, start [name] [ticket], reload",
        getArgumentCompletions: (prefix) => {
            const matches = ["list", "start", "reload"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: async (args, ctx) => {
            rt.touch(ctx);
            const say = (text: string, level: "info" | "warning" | "error" = "info") => {
                if (ctx.hasUI) ctx.ui.notify(text, level);
            };
            try {
                const [word = "", ...rest] = args
                    .trim()
                    .split(/\s+/)
                    .filter((part) => part !== "");
                if (word === "") return say((await actions.status(rt, { action: "status" }, { toolCallId: "" })).text);
                if (word === "list") return say(actions.list(rt).text);
                if (word === "reload") {
                    rt.reload();
                    const failed = rt.loaded.failures.length;
                    return say(
                        `Read ${rt.loaded.workflows.size} workflow${rt.loaded.workflows.size === 1 ? "" : "s"}` +
                            (failed === 0
                                ? "."
                                : `; ${failed} file${failed === 1 ? "" : "s"} could not be used (/workflow list says why).`),
                        failed === 0 ? "info" : "warning",
                    );
                }
                if (word === "start") return say(await start(rt, ctx, rest));
                say(USAGE, "warning");
            } catch (error) {
                say((error as Error).message, error instanceof InputError ? "warning" : "error");
            }
        },
    });
}

/** `/workflow start [name] [ticket]`: one word is a workflow's name when there is one of that name, else a ticket. */
async function start(rt: Runtime, ctx: ExtensionCommandContext, words: string[]): Promise<string> {
    if (words.length > 2) throw new InputError(USAGE);
    let name: string | undefined;
    let given: string | undefined;
    if (words.length === 2) [name, given] = words;
    else if (words.length === 1) {
        const [word] = words as [string];
        if (rt.loaded.workflows.has(word) || !isTicketKey(word)) name = word;
        else given = word;
    }
    const ticket = actions.ticketOf(rt, given === undefined ? {} : { ticket: given });
    const chosen = actions.chooseWorkflow(rt, ticket, name);
    const loss = actions.lossText(rt, ticket, chosen);
    let replace = false;
    if (loss !== undefined) {
        if (!ctx.hasUI || !(await ctx.ui.confirm(`Start ${chosen} over the workflow of ${ticket}?`, loss))) {
            return `Nothing changed: ${ticket} keeps its workflow.`;
        }
        replace = true;
    }
    return actions.start(rt, { ticket, name: chosen, replace, confirmed: replace }).text;
}
