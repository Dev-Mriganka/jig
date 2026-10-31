// An extension for the real Pi that the real-Pi test starts as a child. It gives that Pi a model that follows a script instead of calling
// a service (Pi's own faux provider, registered the way any provider extension does), and two tools: `ask_tool`, which jig-core asks the
// user about before it runs, and `echo_tool`, which never asks. The script is a JSON file named by PI_FAKE_MODEL_SCRIPT:
//   { "steps": [ { "tool": "ask_tool", "args": {} }, { "textFromLastToolResult": "The tool said: " }, { "loop": { "tool": "echo_tool" } } ] }
// A step is one model reply. `loop` repeats its tool call for every reply after it.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep, JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withJig } from "../../../jig-core/src/client.ts";

interface Step {
    tool?: string;
    args?: JsonObject;
    text?: string;
    textFromLastToolResult?: string;
    loop?: { tool: string; args?: JsonObject };
    /** Says which of these texts the model was given anywhere in what it reads, such as a skill's name or a line of AGENTS.md. */
    inspect?: string[];
}

const parameters = Type.Object({ note: Type.Optional(Type.String()) });
const actionParameters = Type.Object({
    action: Type.Unsafe<string>({ type: "string", enum: ["look", "peek", "poke"] }),
});

export default function (pi: ExtensionAPI): void {
    withJig((api) => {
        // A read that jig-core asks about, so a role that may not write can still be asked: its question is what the tests follow.
        api.declareTool({
            tool: "ask_tool",
            plugin: "jig-test",
            classify: () => ({ environment: "local", effect: "read", atLeast: "ask" }),
        });
        api.declareTool({
            tool: "echo_tool",
            plugin: "jig-test",
            classify: () => ({ environment: "local", effect: "read" }),
        });
        api.declareTool({
            tool: "write_tool",
            plugin: "jig-test",
            classify: () => ({ environment: "local", effect: "write" }),
        });
        // `look` and `peek` read, `poke` writes: a tool with actions, for the narrowing of a role.
        api.declareTool({
            tool: "act_tool",
            plugin: "jig-test",
            classify: (input) => ({
                action: String(input.action),
                environment: "local",
                effect: input.action === "poke" ? "write" : "read",
            }),
        });
    });
    pi.registerTool({
        name: "write_tool",
        label: "Write tool",
        description: "A tool that writes, as far as jig-core is told.",
        parameters,
        async execute() {
            return { content: [{ type: "text", text: "write_tool ran" }], details: {} };
        },
    });
    pi.registerTool({
        name: "act_tool",
        label: "Act tool",
        description: "A tool with the actions look, peek and poke.",
        parameters: actionParameters,
        async execute(_id, params) {
            return { content: [{ type: "text", text: `act_tool ${params.action} ran` }], details: {} };
        },
    });
    pi.registerTool({
        name: "ask_tool",
        label: "Ask tool",
        description: "A tool that jig-core asks the user about before it runs.",
        parameters,
        async execute() {
            return { content: [{ type: "text", text: "ask_tool ran" }], details: {} };
        },
    });
    pi.registerTool({
        name: "echo_tool",
        label: "Echo tool",
        description: "A tool that never asks.",
        parameters,
        async execute() {
            return { content: [{ type: "text", text: "echo" }], details: {} };
        },
    });

    const file = process.env.PI_FAKE_MODEL_SCRIPT;
    if (file === undefined) return;
    const steps = (JSON.parse(readFileSync(file, "utf8")) as { steps: Step[] }).steps;
    // The same provider and model ids as the faux provider of the parent's test session, so the child runs the model it is told to.
    const faux = fauxProvider({
        provider: "faux",
        models: [{ id: "faux-1", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    });
    const lastToolResult = (messages: Array<{ role: string; content?: unknown }>): string => {
        const last = [...messages].reverse().find((message) => message.role === "toolResult");
        const content = last?.content;
        return Array.isArray(content)
            ? content.map((block: { text?: string }) => block.text ?? "").join("\n")
            : String(content ?? "");
    };
    const reply =
        (index: number): FauxResponseStep =>
        (context) => {
            let step = steps[Math.min(index, steps.length - 1)] as Step;
            const looping = steps.findIndex((candidate) => candidate.loop !== undefined);
            if (looping >= 0 && index >= looping) step = steps[looping] as Step;
            if (step.loop !== undefined) {
                return fauxAssistantMessage([fauxToolCall(step.loop.tool, step.loop.args ?? {})], {
                    stopReason: "toolUse",
                });
            }
            if (step.tool !== undefined)
                return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: "toolUse" });
            if (step.textFromLastToolResult !== undefined) {
                return fauxAssistantMessage(
                    `${step.textFromLastToolResult}${lastToolResult(context.messages as never)}`,
                );
            }
            if (step.inspect !== undefined) {
                // What the child was given to read: the system prompt and the first message are part of the transcript.
                const seen = JSON.stringify(context.messages);
                return fauxAssistantMessage(
                    `prompt has: ${step.inspect.map((marker) => `${marker}=${seen.includes(marker) ? "yes" : "no"}`).join("; ")}`,
                );
            }
            return fauxAssistantMessage(step.text ?? "done");
        };
    faux.setResponses(Array.from({ length: 300 }, (_unused, index) => reply(index)));
    pi.registerProvider(faux.provider);
}
