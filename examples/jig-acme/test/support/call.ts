// One governed tool call, the way Pi makes it: the `tool_call` hook decides, and the tool's result passes the `tool_result` hook
// before the model sees it. The tool is a stand-in that returns the text the test gives it.
import type { World } from "./world.ts";

export interface Outcome {
    blocked: boolean;
    reason?: string;
    /** What the model reads: the result after redaction and masking, or the reason the call was blocked. */
    text: string;
}

let counter = 0;

export async function call(
    world: World,
    tool: string,
    input: Record<string, unknown>,
    result = "ok",
): Promise<Outcome> {
    const toolCallId = `acme-call-${++counter}`;
    const event = { toolCallId, toolName: tool, input };
    const answer = (await world.host.fire("tool_call", event, world.ctx)) as
        | { block?: boolean; reason?: string }
        | undefined;
    if (answer?.block === true) {
        return {
            blocked: true,
            ...(answer.reason === undefined ? {} : { reason: answer.reason }),
            text: answer.reason ?? "",
        };
    }
    const replacement = (await world.host.fire(
        "tool_result",
        { ...event, content: [{ type: "text", text: result }], details: undefined, isError: false },
        world.ctx,
    )) as { content?: Array<{ type: string; text?: string }> } | undefined;
    await world.host.fire(
        "tool_execution_end",
        { toolCallId, toolName: tool, result: { content: [{ type: "text", text: result }] }, isError: false },
        world.ctx,
    );
    const content = replacement?.content ?? [{ type: "text", text: result }];
    return { blocked: false, text: content.map((part) => part.text ?? "").join("\n") };
}
