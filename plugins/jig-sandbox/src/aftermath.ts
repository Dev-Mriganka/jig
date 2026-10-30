// What follows a command: the audit of what it created, and the lines after its output that say which rule stopped it.
// The question about an ask-first folder joins here in the step that follows.
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { audit, takeSnapshot } from "./audit.ts";
import type { AuditSnapshot } from "./audit.ts";
import { explainBlocks, explainViolations } from "./explain.ts";
import type { Prepared, Sandbox } from "./sandbox.ts";

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
    /** Runs after it ends, also when it was aborted. The lines go after its output, for the agent. */
    after(input: AfterInput): Promise<string[]>;
}

export interface AftermathDeps {
    sandbox: Sandbox;
    /** Pi's agent folder, where what the audit removes is kept. */
    agentDir: () => string;
    now: () => number;
}

export function createAftermath(deps: AftermathDeps): Aftermath {
    return {
        before: (prepared) => takeSnapshot(prepared.rules),
        async after(input) {
            const lines: string[] = [];
            // The audit first: it undoes what the command planted, and then the explanation can speak of what is left.
            try {
                const result = audit(input.snapshot as AuditSnapshot, input.prepared.rules, {
                    quarantine: path.join(deps.agentDir(), "jig-sandbox", "removed"),
                    home: input.prepared.rules.home,
                    now: deps.now,
                });
                lines.push(...result.lines);
                for (const file of result.createdSecrets) deps.sandbox.createdByAgent.add(file);
                if (input.ctx.hasUI) for (const notice of result.notices) input.ctx.ui.notify(notice, "warning");
            } catch (error) {
                lines.push(
                    `[sandbox] the check of what the command changed failed (${(error as Error).message}); look at your shell start-up files and git hooks.`,
                );
            }
            const explained = explainBlocks(input.output, input.prepared.rules, {
                cwd: input.cwd,
                mode: input.prepared.mode,
            });
            lines.push(...explained.lines, ...explainViolations(input.violations));
            return lines;
        },
    };
}
