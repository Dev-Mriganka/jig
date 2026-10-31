// The `workflow` tool: how the agent takes work through its workflow. Reads (`list`, `status`) run; every other action is a local
// write. Four of them ask the user, inside the waiting call: the plan, a stage that needs you, replacing a workflow, and tests
// outside the sandbox. `jig-core` governs the calls, and this plugin's gate makes the asks unavoidable.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CallClass, Preview, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { InputError } from "../../jig-core/src/kit/values.ts";
import * as actions from "./actions.ts";
import type { ActionResult, Params } from "./actions.ts";
import { TOOL_NAME } from "./gate.ts";
import type { Runtime } from "./runtime.ts";

/** What each action takes: its required parameters, and the optional ones. Anything else is invalid input. */
const ACTIONS = {
    list: { summary: "the workflows defined, and the files that failed", optional: [] },
    status: {
        summary: "the stage, what is missing, the holds in force; no ticket: all active work",
        optional: ["ticket"],
    },
    start: { summary: "start a workflow for a ticket", optional: ["name", "ticket", "replace"] },
    bind: {
        summary: "a worktree for a repository on the work's branch",
        required: ["repo"],
        optional: ["ticket", "dir", "base"],
    },
    "submit-plan": { summary: "check plan.md and ask the user to approve it", optional: ["ticket"] },
    test: { summary: "run the bound repositories' tests at HEAD, in the sandbox", optional: ["ticket", "repo"] },
    scenario: {
        summary: "record pass or fail for a numbered scenario; a pass needs evidence",
        required: ["number", "result"],
        optional: ["ticket", "evidence"],
    },
    advance: { summary: "move to the next stage when every exit condition holds", optional: ["ticket"] },
    back: { summary: "move to an earlier stage", optional: ["ticket", "to"] },
} as const satisfies Record<string, { summary: string; required?: readonly string[]; optional: readonly string[] }>;

type ActionName = keyof typeof ACTIONS;
const NAMES = Object.keys(ACTIONS) as ActionName[];

/** The actions, in the order the README's table lists them. */
export const ACTION_NAMES: readonly string[] = NAMES;

const parameters = Type.Object(
    {
        action: StringEnum(NAMES, {
            description: NAMES.map((name) => `- ${name}: ${ACTIONS[name].summary}`).join("\n"),
        }),
        ticket: Type.Optional(
            Type.String({ maxLength: 64, description: "The ticket key. Default: the session's active ticket." }),
        ),
        name: Type.Optional(
            Type.String({
                maxLength: 64,
                description: "start: the workflow. Default: the one whose pattern matches the ticket.",
            }),
        ),
        replace: Type.Optional(
            Type.Boolean({ description: "start: replace the workflow the ticket already has. It asks the user." }),
        ),
        repo: Type.Optional(
            Type.String({
                maxLength: 500,
                description:
                    "bind: the repository to branch from (a folder in the workspace, or an absolute path). test: one bound repository.",
            }),
        ),
        dir: Type.Optional(
            Type.String({
                maxLength: 100,
                description: "bind: the folder name of the worktree. Default: the repository's name and the ticket.",
            }),
        ),
        base: Type.Optional(
            Type.String({ maxLength: 200, description: "bind: the branch to cut from. Default: git's base." }),
        ),
        number: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 50, description: "scenario: the number in plan.md." }),
        ),
        result: Type.Optional(StringEnum(["pass", "fail"] as const, { description: "scenario: what happened." })),
        evidence: Type.Optional(
            Type.Object(
                {
                    path: Type.Optional(
                        Type.String({
                            maxLength: 500,
                            description: "A file in the ticket folder, such as evidence/accept-1.png.",
                        }),
                    ),
                    toolResult: Type.Optional(
                        Type.String({ maxLength: 200, description: "The id of a tool call from this session." }),
                    ),
                    text: Type.Optional(
                        Type.String({ maxLength: 2000, description: "What you observed, 10 to 2000 characters." }),
                    ),
                },
                {
                    additionalProperties: false,
                    description: "scenario, for a pass: exactly one of path, toolResult or text.",
                },
            ),
        ),
        to: Type.Optional(
            Type.String({ maxLength: 64, description: "back: the stage to go back to. Default: the one before." }),
        ),
    },
    { additionalProperties: false },
);

const DESCRIPTION = [
    "Take a piece of work, such as a ticket, through its workflow: stages, each with a goal and the conditions that let you leave it.",
    "Start with action status to see the stage, what is missing and which calls are held. The plugin records evidence itself:",
    "test runs the tests at the current commit, submit-plan asks the user to approve plan.md, scenario records what you ran",
    "with evidence, and advance moves on only when every exit condition holds. You cannot mark anything passed yourself.",
    "A held call (git push, edit, ...) is refused with the condition it waits for.",
].join(" ");

/** Checks a call's input against the action's table. An `InputError` blocks the call without asking anyone. */
export function checkInput(input: Readonly<Record<string, unknown>>): ActionName {
    const action = input.action;
    if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
        throw new InputError(
            `workflow: unknown action ${JSON.stringify(String(action).slice(0, 40))}; use one of ${NAMES.join(", ")}`,
        );
    }
    const spec = ACTIONS[action as ActionName] as { required?: readonly string[]; optional: readonly string[] };
    const accepted = new Set<string>(["action", ...(spec.required ?? []), ...spec.optional]);
    for (const [name, value] of Object.entries(input)) {
        if (value !== undefined && !accepted.has(name)) throw new InputError(`workflow ${action} does not use ${name}`);
    }
    const missing = (spec.required ?? []).filter((name) => input[name] === undefined);
    if (missing.length > 0) throw new InputError(`workflow ${action} needs ${missing.join(", ")}`);
    if (action === "scenario") {
        if (input.result === "pass" && input.evidence === undefined) {
            throw new InputError(
                "a pass needs evidence: a path in the ticket folder, a tool result of this session, or what you observed",
            );
        }
        const evidence = input.evidence as Record<string, unknown> | undefined;
        if (
            evidence !== undefined &&
            ["path", "toolResult", "text"].filter((key) => evidence[key] !== undefined).length !== 1
        ) {
            throw new InputError("evidence needs exactly one of path, toolResult or text");
        }
    }
    return action as ActionName;
}

/** Where each action acts and whether it writes. Everything is local; a few ask, and the gate makes sure of it. */
function classify(input: Readonly<Record<string, unknown>>): CallClass {
    const action = checkInput(input);
    switch (action) {
        case "list":
        case "status":
            return { action, environment: "local", effect: "read" };
        case "submit-plan":
            return { action, environment: "local", effect: "write", atLeast: "ask", approval: "review" };
        case "start":
            return input.replace === true
                ? { action, environment: "local", effect: "write", atLeast: "ask", approval: "dialog" }
                : { action, environment: "local", effect: "write" };
        default:
            return { action, environment: "local", effect: "write" };
    }
}

export function createTool(rt: Runtime): { definition: ToolDefinition; declaration: ToolDeclaration } {
    /** The question for a call that asks. Throwing an `InputError` here blocks the call without asking. */
    async function preview(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Preview> {
        const action = checkInput(input);
        const params = input as unknown as Params;
        switch (action) {
            case "submit-plan": {
                const question = await actions.planPreview(rt, params);
                return {
                    summary: question.summary,
                    body: question.body,
                    format: "markdown",
                    fingerprint: question.fingerprint,
                    answers: { allow: "Approve this plan", decline: "Not yet" },
                };
            }
            case "advance": {
                const question = await actions.advancePreview(rt, params, signal);
                return {
                    summary: question.summary,
                    body: question.body,
                    format: "markdown",
                    fingerprint: question.fingerprint,
                    answers: { allow: "Move on", decline: "Not yet" },
                };
            }
            case "start": {
                const ticket = actions.ticketOf(rt, params);
                const name = actions.chooseWorkflow(rt, ticket, params.name);
                const loss = actions.lossText(rt, ticket, name);
                return {
                    summary: loss ?? `Start ${name} on ${ticket}`,
                    fingerprint: actions.replaceFingerprint(rt, ticket, name),
                    answers: { allow: "Replace it", decline: "Keep it" },
                };
            }
            case "test": {
                const { ticket, plans, views } = await actions.plannedTests(rt, params);
                const question = actions.testQuestion(ticket, plans);
                return {
                    summary: question.summary,
                    body: question.body,
                    format: "markdown",
                    fingerprint: actions.testFingerprint(ticket, plans, views),
                    answers: { allow: "Run them once", decline: "No" },
                };
            }
            default:
                return { summary: `workflow ${action}` };
        }
    }

    const declaration: ToolDeclaration = { tool: TOOL_NAME, plugin: "jig-workflow", classify, preview };

    const definition: ToolDefinition<typeof parameters> = {
        name: TOOL_NAME,
        label: "Workflow",
        description: DESCRIPTION,
        promptSnippet: "Take work through its workflow: status, test, submit-plan, scenario, advance",
        promptGuidelines: [
            "Call workflow with action status when you start on a ticket and after each stage: it says what is missing and how to fix it.",
            "Never claim a test passed or a plan was approved; workflow test and workflow submit-plan make the plugin record it.",
        ],
        parameters,
        // Each action reads the state and writes it back, and a move depends on the evidence it just read.
        executionMode: "sequential",
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            rt.touch(ctx);
            const call = { toolCallId, ...(signal === undefined ? {} : { signal }), ctx };
            const result = await run(rt, params as Params, call);
            return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
        },
    };
    return { definition, declaration };
}

async function run(rt: Runtime, params: Params, call: actions.Call): Promise<ActionResult> {
    const action = checkInput(params as unknown as Record<string, unknown>);
    switch (action) {
        case "list":
            return actions.list(rt);
        case "status":
            return actions.status(rt, params, call);
        case "start": {
            const ticket = actions.ticketOf(rt, params);
            const name = actions.chooseWorkflow(rt, ticket, params.name);
            const loss = actions.lossText(rt, ticket, name);
            // The user's yes to replacing is the preview they approved for this call, with this fingerprint.
            const approved = rt.host.approvedPreview(call.toolCallId);
            const confirmed =
                approved !== undefined && approved.fingerprint === actions.replaceFingerprint(rt, ticket, name);
            if (params.replace === true && loss !== undefined && !confirmed) {
                throw new Error(
                    "the user was not asked to replace the workflow, or the workflow changed since they were. Nothing was changed. Call start again.",
                );
            }
            return actions.start(rt, { ticket, name, replace: params.replace === true, confirmed });
        }
        case "bind":
            return actions.bind(rt, params, call);
        case "submit-plan":
            return actions.submitPlan(rt, params, call);
        case "test":
            return actions.runTestsAction(rt, params, call);
        case "scenario":
            return actions.scenario(rt, params);
        case "advance":
            return actions.advance(rt, params, call);
        case "back":
            return actions.back(rt, params);
    }
}
