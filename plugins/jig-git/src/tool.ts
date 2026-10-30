// What the four tools have in common. A tool is its parameter schema, its table of actions, how an action is classified,
// and `plan`: the one function that checks a call and works out what it would do. From those this file builds both halves
// of a Jig tool:
//   - the Pi tool, whose execute() plans, compares the plan with the preview the user approved, and runs it;
//   - the declaration for jig-core, whose preview() is the same plan, and whose classify() says where it acts.
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CallClass, Preview, ToolDeclaration } from "../../jig-core/src/contract.ts";
import { gitSettings } from "./config.ts";
import { checkParams } from "./params.ts";
import type { ActionTable } from "./params.ts";
import { checkUnchanged, toResult } from "./previews.ts";
import type { Call, Planned } from "./previews.ts";
import { setWorkingDirectory } from "./repo.ts";

type Input = Readonly<Record<string, unknown>>;

interface ToolSpec {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines?: string[];
    parameters: TSchema;
    table: ActionTable;
    /** Where an action acts and whether it reads or writes. Depends on the action, and for a few on the operation. */
    classify(input: Input): CallClass | undefined;
    /** Checks a call and works out what it would do. Reads state, changes nothing. */
    plan(params: Input, call: Call): Promise<Planned>;
}

export interface JigTool {
    definition: ToolDefinition;
    declaration: ToolDeclaration;
}

export function buildTool(spec: ToolSpec): JigTool {
    const definition: ToolDefinition = {
        name: spec.name,
        label: spec.label,
        description: spec.description,
        promptSnippet: spec.promptSnippet,
        promptGuidelines: spec.promptGuidelines,
        parameters: spec.parameters,
        // Calls run one at a time and in order: a push must be done before the pull request that needs it is opened.
        executionMode: "sequential",
        async execute(
            toolCallId: string,
            params: unknown,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionToolContext,
        ) {
            setWorkingDirectory(ctx.cwd);
            const input = params as Input;
            const action = checkParams(spec.name, spec.table, input);
            const planned = await spec.plan(input, { toolCallId, signal, settings: gitSettings() });
            checkUnchanged(toolCallId, planned, `${spec.name} ${action}`);
            return toResult(toolCallId, await planned.run());
        },
    };
    const declaration: ToolDeclaration = {
        tool: spec.name,
        plugin: "jig-git",
        classify: spec.classify,
        async preview(input: Input, signal: AbortSignal): Promise<Preview> {
            checkParams(spec.name, spec.table, input);
            return (await spec.plan(input, { toolCallId: "", signal, settings: gitSettings() })).preview;
        },
    };
    return { definition, declaration };
}

/** A class for a read or a write at one place. */
export function at(
    action: string,
    environment: "local" | "external",
    effect: "read" | "write",
    more: Partial<CallClass> = {},
): CallClass {
    return { action, environment, effect, ...more };
}
