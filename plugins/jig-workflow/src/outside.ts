// A test command that must run outside the sandbox (`outside: true` in its `workflow.tests` entry), because it needs what the sandbox
// hides, such as a package repository whose token comes from a cloud sign-in. It runs only through the mechanism the `bash` tool
// has for this: the call `bash` with `outside: true` and a reason, made here through Pi's `ctx.executeTool`. So jig-core asks the
// user in the waiting call with the exact command and the reason, a rule that names the command can allow it, no screen means no,
// and jig-sandbox records the run. This plugin decides nothing and records nothing about asking: a refusal is a refusal.
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { shellWord, withEnvironment } from "./environment.ts";
import type { OutsideRunner, ShellRun, TestPlan } from "./tests.ts";

/** What the user reads under "Why:" in the question. The model cannot change it: the plugin makes the call. */
export const OUTSIDE_REASON = "the configured test command needs credentials the sandbox hides";

/**
 * The command line the question shows and a rule can name. The `bash` tool runs in Pi's folder and takes no folder of its own, so
 * the line goes to the repository first: `cd <root> && export A=b && <command>`.
 */
export function outsideCommand(plan: Pick<TestPlan, "root" | "command" | "env">): string {
    if (plan.command === undefined) throw new Error("no test command");
    return `cd ${shellWord(plan.root)} && ${withEnvironment(plan.command, plan.env)}`;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
    return (result.content ?? [])
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("\n");
}

const TIMED_OUT = /Command timed out after \d+ seconds\s*$/;

/**
 * The runner for plans that are set to run outside. A command that ran comes back as a result, whatever its exit code; one that
 * did not run (declined, no screen, a rule that denies, a command too long to show, a result that was withheld) throws with the
 * reason jig-core or the sandbox gave, and the caller records nothing for it.
 */
export function outsideRunner(ctx: ExtensionToolContext | undefined): OutsideRunner {
    return async (plan, options) => {
        if (typeof ctx?.executeTool !== "function") {
            throw new Error(
                "this test command is set to run outside the sandbox, and this call cannot run the bash tool that asks you",
            );
        }
        const outcome = await ctx.executeTool(
            "bash",
            { command: outsideCommand(plan), outside: true, reason: OUTSIDE_REASON, timeout: plan.timeoutSeconds },
            options.signal === undefined ? {} : { signal: options.signal },
        );
        // The words are the tool's result after jig-core cleaned it. The structured copy is read only for the exit code.
        const output = textOf(outcome.result as never);
        const exit = (outcome.result as { structuredContent?: { exit_code?: unknown } }).structuredContent?.exit_code;
        if (typeof exit === "number") return finished(exit, false, output);
        if (!outcome.isError) return finished(0, false, output);
        if (TIMED_OUT.test(output)) return finished(null, true, output);
        // A call jig-core stopped comes back as its reason, which starts with who stopped it.
        const reason = output
            .replace(/^\s*Blocked by jig-core:\s*/, "")
            .trim()
            .split("\n")[0];
        throw new Error(`outside the sandbox was refused: ${reason || "no reason was given"}`);
    };
}

function finished(code: number | null, timedOut: boolean, output: string): ShellRun {
    return { code, timedOut, output, truncated: false };
}
