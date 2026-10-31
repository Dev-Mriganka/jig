// What the sandbox does after a background task's process is gone: the audit of what it created and the explanation of what it was
// refused, as it does after a foreground command. The lines are kept on the task, for `bg_output` and `/ps` to show.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Aftermath } from "../aftermath.ts";
import { tailText } from "./output.ts";
import type { Task } from "./types.ts";

export async function afterEnd(
    aftermath: Aftermath,
    context: () => ExtensionContext | undefined,
    task: Task,
    prepared: NonNullable<Task["prepared"]>,
    snapshot: unknown,
    now: () => number,
): Promise<void> {
    let violations: ReadonlyArray<{ line: string }> = [];
    try {
        violations = (await prepared.finish()).violations;
    } catch {
        // The broker is gone; there is nothing to read.
    }
    const ctx = context();
    if (ctx === undefined) return;
    try {
        const tail = tailText(task, 200, 64 * 1024, now()).text;
        task.sandboxLines = await aftermath.after({
            prepared,
            output: tail,
            cwd: task.cwd,
            ctx,
            snapshot,
            violations,
        });
    } catch (error) {
        task.sandboxLines = [
            `[sandbox] the check of what the task changed failed (${(error as Error).message}); look at your shell start-up files and git hooks.`,
        ];
    }
}
