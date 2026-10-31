// Tools for the tests of the role gate. Each is a real Pi tool, declared to the real jig-core with the effect of each action, so a gate sees a
// call exactly as it sees one from a real plugin: `git` has jig-git's own actions, with the reads and the writes it has; `bash` is the
// sandbox's, with `outside`.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withJig } from "../../../jig-core/src/client.ts";
import type { Effect } from "../../../jig-core/src/contract.ts";
import { GIT_ACTIONS } from "../../../jig-git/src/git.ts";
import { bashDeclaration } from "../../../jig-sandbox/src/outside.ts";

/** A tool with an `action` parameter: the effect of each action, and any action not listed is a write. */
export function actionTool(name: string, actions: Record<string, Effect>): ExtensionFactory {
    return (pi) => {
        withJig((api) =>
            api.declareTool({
                tool: name,
                plugin: `jig-${name}`,
                classify: (input) => ({
                    action: String(input.action),
                    environment: "local",
                    effect: actions[String(input.action)] ?? "write",
                }),
            }),
        );
        pi.registerTool({
            name,
            label: name,
            description: `A test tool with actions: ${Object.keys(actions).join(", ")}.`,
            parameters: Type.Object({ action: Type.Unsafe<string>({ type: "string", enum: Object.keys(actions) }) }),
            async execute(_id, params) {
                return { content: [{ type: "text", text: `${name} ${params.action} ran` }], details: {} };
            },
        });
    };
}

/** The actions of jig-git's `git` tool that read, as its README's table says. */
export const GIT_READS: readonly string[] = ["status", "diff", "log", "show", "blame", "branches", "fetch"];

/** The git tool of the tests: every action jig-git has, the reads as reads and the rest as writes. */
export const gitTool = actionTool(
    "git",
    Object.fromEntries(
        Object.keys(GIT_ACTIONS).map((action): [string, Effect] => [
            action,
            GIT_READS.includes(action) ? "read" : "write",
        ]),
    ),
);

/** Two tools without an `action`: one that reads, and one that writes. */
export const plainTools: ExtensionFactory = (pi) => {
    withJig((api) => {
        api.declareTool({
            tool: "look",
            plugin: "jig-test",
            classify: () => ({ environment: "local", effect: "read" }),
        });
        api.declareTool({
            tool: "poke",
            plugin: "jig-test",
            classify: () => ({ environment: "local", effect: "write" }),
        });
    });
    for (const name of ["look", "poke"]) {
        pi.registerTool({
            name,
            label: name,
            description: `A test tool called ${name}.`,
            parameters: Type.Object({}),
            async execute() {
                return { content: [{ type: "text", text: `${name} ran` }], details: {} };
            },
        });
    }
};

/**
 * A `bash` that takes `outside`, declared as jig-sandbox declares it: a plain call is a local write, and `outside: true` is the action
 * `outside`. It runs nothing: it says it ran.
 */
export const bashTool: ExtensionFactory = (pi) => {
    withJig((api) => api.declareTool(bashDeclaration({ folder: () => "/work", home: () => "/home/me" })));
    pi.registerTool({
        name: "bash",
        label: "bash",
        description: "A test shell that runs nothing.",
        parameters: Type.Object({
            command: Type.String(),
            outside: Type.Optional(Type.Boolean()),
            reason: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            return { content: [{ type: "text", text: `bash ran: ${params.command}` }], details: {} };
        },
    });
};

/** Says that `bash` runs in a sandbox, as jig-sandbox does when it is ready. */
export const sandboxOn: ExtensionFactory = () => {
    withJig((api) =>
        api.sandbox.register({
            active: true,
            canWrite: () => false,
            run: async () => ({ code: 0, output: "", timedOut: false, truncated: false }),
        }),
    );
};
