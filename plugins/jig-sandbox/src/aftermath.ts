// What follows a command: the lines after its output that say which rule stopped it. The audit of what the command
// created, and the question about an ask-first folder, join here in the steps that follow.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { explainBlocks, explainViolations } from "./explain.ts";
import type { Prepared } from "./sandbox.ts";

export interface AfterInput {
    prepared: Prepared;
    /** The tail of what the command printed. */
    output: string;
    cwd: string;
    ctx: ExtensionContext;
    /** What `before` returned for this command. */
    snapshot: unknown;
    violations: ReadonlyArray<{ line: string }>;
}

export interface Aftermath {
    /** Runs before the command starts, with the rules it will run under. */
    before(prepared: Prepared, cwd: string): unknown;
    /** Runs after it ends. The lines go after its output, for the agent. */
    after(input: AfterInput): Promise<string[]>;
}

export function createAftermath(): Aftermath {
    return {
        before: () => undefined,
        async after(input) {
            const explained = explainBlocks(input.output, input.prepared.rules, {
                cwd: input.cwd,
                mode: input.prepared.mode,
            });
            return [...explained.lines, ...explainViolations(input.violations)];
        },
    };
}
