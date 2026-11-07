// The `ticket` tool: the handoff record of the active ticket. Two things the agent cannot keep in its head across a long
// session go here:
// - **evidence the user pasted,** such as the output of a batch they ran themselves, saved to evidence/ like a tool result;
// - **open checks,** the things the agent said it would do before the next step, kept in checks.json until closed.
//
// Every action is local: three write the ticket folder, one reads it. Pasted text takes the path every other result takes:
// `execute` masks it and returns it, jig-core removes secrets from the result, and the tool_result hook of this plugin
// (`finishPasted`) saves what is left and answers with the file's name instead of the text.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { jig } from "../../jig-core/src/client.ts";
import type { CallClass, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { stringEnum } from "../../jig-core/src/kit/schema.ts";
import { InputError } from "../../jig-core/src/kit/values.ts";
import { addCheck, CHECK_TEXT_LIMIT, checkLines, closeCheck, openChecks, readChecks } from "./checks.ts";
import { labelProblem, PASTED_LIMIT, pastedProblem, savePasted } from "./evidence.ts";

export const TOOL_NAME = "ticket";

const ACTIONS = {
    save_evidence: {
        summary: "save text the user pasted, such as a run's output, to evidence/",
        required: ["text", "label"],
    },
    add_check: { summary: "add an open check: something to do before the next step", required: ["text"] },
    list_checks: { summary: "the open checks", required: [] },
    close_check: { summary: "close a check, saying what was found or done", required: ["id", "outcome"] },
    recall: {
        summary: "search earlier tickets by an error, class name or behaviour",
        required: ["query"],
    },
} as const satisfies Record<string, { summary: string; required: readonly string[] }>;

type ActionName = keyof typeof ACTIONS;
const NAMES = Object.keys(ACTIONS) as ActionName[];

/** The actions, in the order the README's table lists them. */
export const ACTION_NAMES: readonly string[] = NAMES;

const parameters = Type.Object(
    {
        action: stringEnum(NAMES, {
            description: NAMES.map((name) => `- ${name}: ${ACTIONS[name].summary}`).join("\n"),
        }),
        text: Type.Optional(
            Type.String({
                description: `save_evidence: the pasted text as the user gave it, at most ${PASTED_LIMIT} bytes. add_check: the check, at most ${CHECK_TEXT_LIMIT} characters.`,
            }),
        ),
        label: Type.Optional(
            Type.String({ maxLength: 40, description: "save_evidence: a few words, such as batch-3-output." }),
        ),
        id: Type.Optional(Type.Integer({ minimum: 1, description: "close_check: the check's number." })),
        query: Type.Optional(
            Type.String({
                maxLength: 2_000,
                description: "recall: the error, class name or behaviour to search earlier tickets for.",
            }),
        ),
        outcome: Type.Optional(
            Type.String({
                description: `close_check: what was found or done, at most ${CHECK_TEXT_LIMIT} characters.`,
            }),
        ),
    },
    { additionalProperties: false },
);

const DESCRIPTION = [
    "The handoff record of the active ticket.",
    "save_evidence keeps text the user pasted (the output of a run they did) in the ticket's evidence, masked.",
    "add_check records something you said you would do before the next step; it is shown with every prompt until close_check.",
    "Before you hand the user a command for the next step, close each open check or say plainly that it is still open.",
    "recall searches earlier tickets' notes and cards by text, without leaving the active ticket in the results.",
].join(" ");

/** Checks a call's input against the action's table. An `InputError` blocks the call without asking anyone. */
export function checkInput(input: Readonly<Record<string, unknown>>): ActionName {
    const action = input.action;
    if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
        throw new InputError(
            `ticket: unknown action ${JSON.stringify(String(action).slice(0, 40))}; use one of ${NAMES.join(", ")}`,
        );
    }
    const name = action as ActionName;
    const required: readonly string[] = ACTIONS[name].required;
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && key !== "action" && !required.includes(key)) {
            throw new InputError(`ticket ${name} does not use ${key}`);
        }
    }
    const missing = required.filter((key) => input[key] === undefined);
    if (missing.length > 0) throw new InputError(`ticket ${name} needs ${missing.join(", ")}`);
    for (const key of ["text", "label", "outcome", "query"]) {
        if (input[key] !== undefined && typeof input[key] !== "string") throw new InputError(`${key} must be text`);
    }
    if (name === "recall" && (input.query as string).trim() === "") throw new InputError("ticket recall needs a query");
    if (name === "save_evidence") {
        const problem = labelProblem(input.label as string) ?? pastedProblem(input.text as string);
        if (problem !== undefined) throw new InputError(problem);
    }
    return name;
}

/** Every action acts on the ticket folder on this machine. Only list_checks reads. */
export function classify(input: Readonly<Record<string, unknown>>): CallClass {
    const action = checkInput(input);
    return {
        action,
        environment: "local",
        effect: action === "list_checks" || action === "recall" ? "read" : "write",
    };
}

export const declaration: ToolDeclaration = { tool: TOOL_NAME, plugin: "jig-memory", classify };

/** What the tool needs from the session: the active ticket and where its folder is, and the clock. */
export interface TicketHost {
    active(): { folder: string; key: string } | undefined;
    now(): Date;
    /** Search earlier tickets by text. Read only; the active ticket is excluded by the caller. */
    search(query: string): { text: string; entries: number };
}

const text = (value: string, details: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: value }],
    details,
});

export function ticketTool(host: TicketHost): ToolDefinition<typeof parameters> {
    return {
        name: TOOL_NAME,
        label: "Ticket",
        description: DESCRIPTION,
        promptSnippet:
            "ticket: search earlier tickets (recall); save pasted output (save_evidence); track open checks (add_check, list_checks, close_check)",
        parameters,
        executionMode: "sequential",
        async execute(toolCallId, params) {
            const input = params as Readonly<Record<string, unknown>>;
            const action = checkInput(input);
            if (action === "recall") {
                const found = host.search(input.query as string);
                jig().addFacts(toolCallId, { entries: found.entries, queries: 1 });
                return text(found.text, { action, entries: found.entries });
            }
            const ticket = host.active();
            if (ticket === undefined) throw new Error("No active ticket: /ticket KEY makes one active.");
            const { folder, key } = ticket;
            const now = host.now();
            if (action === "save_evidence") {
                // Masked here, as a production result is; jig-core removes secrets from the result next, and finishPasted
                // saves what is left. The pasted text may hold anything, so it is always masked, whatever it came from.
                const masked = jig().mask.text(input.text as string);
                return text(masked, { action, key, label: input.label, pending: true });
            }
            if (action === "add_check") {
                const check = addCheck(folder, key, input.text as string, now);
                const open = openChecks(folder, key).length;
                return text(
                    `Check #${check.id} added to ${key} (${open} open). It is shown with every prompt until you close it with ` +
                        "close_check. Before you hand the user a command for the next step, close it or say plainly that it is still open.",
                    { action, key, id: check.id, open },
                );
            }
            if (action === "close_check") {
                const closed = closeCheck(folder, key, input.id as number, input.outcome as string, now);
                const open = openChecks(folder, key);
                const left = open.length === 0 ? "No check is open." : `Still open:\n${checkLines(open)}`;
                return text(`Check #${closed.id} closed: ${closed.outcome}\n${left}`, {
                    action,
                    key,
                    id: closed.id,
                    open: open.length,
                });
            }
            const all = readChecks(folder, key);
            const open = all.filter((check) => check.status === "open");
            const closed = all.length - open.length;
            const head = open.length === 0 ? `${key}: no open checks` : `${key}: ${open.length} open`;
            const list = open.length === 0 ? "" : `\n${checkLines(open)}`;
            return text(`${head} (${closed} closed).${list}`, { action, key, open: open.length, closed });
        },
    };
}

/** A tool_result as this plugin's hook sees it. */
export interface ResultEvent {
    toolName: string;
    input: Readonly<Record<string, unknown>>;
    content: ReadonlyArray<{ type: string; text?: string }>;
    details?: unknown;
    isError: boolean;
}

/**
 * For a `save_evidence` result: saves the text as jig-core left it, masked and without secrets, and gives the model the
 * file's name instead of the text it already has. Undefined for any other result.
 */
export function finishPasted(
    event: ResultEvent,
    folder: string,
    now: Date,
): { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean } | undefined {
    const details = event.details as
        | { action?: unknown; key?: unknown; label?: unknown; pending?: unknown }
        | undefined;
    if (event.toolName !== TOOL_NAME || event.isError || details?.pending !== true) return undefined;
    const key = String(details.key);
    const label = String(details.label);
    const pasted = event.content.flatMap((part) =>
        part.type === "text" && part.text !== undefined ? [part.text] : [],
    );
    try {
        const name = savePasted(folder, key, label, pasted.join("\n"), now);
        const bytes = Buffer.byteLength(pasted.join("\n"));
        return {
            content: [
                {
                    type: "text",
                    text: `Saved the pasted text (${bytes} bytes, masked, secrets removed) to ${key}'s evidence/${name}, and a line in evidence/index.md.`,
                },
            ],
            details: { action: "save_evidence", key, file: `evidence/${name}` },
        };
    } catch (error) {
        const why = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
        return {
            content: [{ type: "text", text: `Could not save the pasted text for ${key}: ${why}. Nothing was saved.` }],
            details: { action: "save_evidence", key },
            isError: true,
        };
    }
}
