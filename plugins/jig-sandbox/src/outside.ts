// Running one command outside the sandbox. The agent asks by calling `bash` with `outside: true` and a `reason`; jig-core
// classifies the call as its own action, asks the user (or lets a rule that names the command allow it), and only an
// approved call runs, with Pi's ordinary local operations and not wrapped. Everything about asking is jig-core's; this file
// is what the sandbox plugin says to it: how a call is classified, what the user sees, and the list of runs.
import { createHash } from "node:crypto";
import type { CallClass, Preview, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { shown } from "./pathing.ts";

/** The longest reason and command the dialog shows in full. A command that is longer cannot be approved by reading it. */
export const MAX_REASON_CHARS = 300;
export const MAX_COMMAND_CHARS = 1_000;
const MAX_COMMAND_LINES = 8;

/** One command that ran outside the sandbox in this session. */
export interface OutsideRun {
    at: Date;
    command: string;
    folder: string;
    reason: string;
    /** How it was allowed. */
    how: "once" | "session" | "rule";
}

/** Control characters made visible, so a command cannot hide itself in the dialog (a carriage return, a terminal sequence). */
export function visible(text: string): string {
    return text.replace(
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
        (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}

/** A digest of what the user is shown, so a call that changed after they approved it does not run. */
export function fingerprintOutside(command: string, reason: string, folder: string): string {
    return createHash("sha256")
        .update(JSON.stringify([command, reason, folder]))
        .digest("hex");
}

/** What is wrong with a request to run outside, as one sentence for the agent, or undefined when it is fine. */
export function outsideProblem(input: Readonly<Record<string, unknown>>): string | undefined {
    const { command, reason } = input;
    if (typeof command !== "string" || command.trim() === "") return "bash needs a command";
    if (typeof reason !== "string" || reason.trim() === "") {
        return `outside needs a reason: say in one sentence why the sandbox blocks what you need and no Jig tool does it (at most ${MAX_REASON_CHARS} characters)`;
    }
    if (reason.length > MAX_REASON_CHARS)
        return `the reason is ${reason.length} characters; at most ${MAX_REASON_CHARS}`;
    if (command.length > MAX_COMMAND_CHARS || command.split("\n").length > MAX_COMMAND_LINES) {
        return `the command is too long to show in full (at most ${MAX_COMMAND_CHARS} characters and ${MAX_COMMAND_LINES} lines): put it in a script in the project and run that, or split it`;
    }
    return undefined;
}

/** The declaration of `bash` for jig-core: only a call that asks to run outside is classified here. */
export function bashDeclaration(options: { folder: () => string; home: () => string }): ToolDeclaration {
    return {
        tool: "bash",
        plugin: "jig-sandbox",
        extendsDefaults: true,
        classify(input): CallClass | undefined {
            // A task outlives the call that started it, so the question about running it outside would be about a command
            // nobody could watch: it is refused, and nobody is asked.
            if (input.outside === true && input.background === true) {
                throw new TypeError(
                    "a background task cannot run outside the sandbox: run it in the sandbox, or run the command in the foreground with outside: true",
                );
            }
            if (input.outside !== true) return undefined;
            const problem = outsideProblem(input);
            // A TypeError says the input is invalid: the call is blocked with this message and nobody is asked.
            if (problem !== undefined) throw new TypeError(problem);
            return { action: "outside", environment: "local", effect: "write", atLeast: "ask", approval: "dialog" };
        },
        async preview(input): Promise<Preview> {
            if (input.outside !== true)
                return { summary: `bash: ${visible(String(input.command ?? "")).slice(0, 200)}` };
            const problem = outsideProblem(input);
            if (problem !== undefined) throw new TypeError(problem);
            const command = String(input.command);
            const reason = String(input.reason);
            const folder = options.folder();
            const lines = (text: string): string => visible(text).split("\n").join("\n          ");
            return {
                summary: "Run outside the sandbox? It gets your credentials and full network.",
                body: [
                    `Command:  ${lines(command)}`,
                    `Folder:   ${shown(folder, options.home())}`,
                    `Why:      ${lines(reason)}`,
                ].join("\n"),
                format: "text",
                fingerprint: fingerprintOutside(command, reason, folder),
                answers: { allow: "Run once", session: "This exact command, this session", decline: "No" },
            };
        },
        examples: { outside: { outside: true, command: "docker compose up", reason: "an example" } },
    };
}
