// Capturing what a task prints: carriage returns turned into line feeds, one cleaner per stream, and the cleaned text sent to the
// task's log and to the matcher that wakes the agent. When the process is over it says so once, with its exit code. It needs only the
// task, the child and the clock, so it is apart from the registry (tasks.ts).
import { constants as osConstants } from "node:os";
import { createOutputCleaner } from "../output.ts";
import type { OutputCleaner } from "../output.ts";
import type { Task } from "./types.ts";

/** After the shell exits a grandchild may hold the pipes open; the task is over anyway after this. */
const STDIO_GRACE_MS = 200;

/** Turns carriage returns into line feeds across chunks, so a progress meter is lines and `\r\n` is one line break. */
export class LineEndings {
    private afterReturn = false;

    push(chunk: Buffer): Buffer {
        if (chunk.length === 0) return chunk;
        const out: number[] = [];
        for (const byte of chunk) {
            if (byte === 0x0d) {
                out.push(0x0a);
                this.afterReturn = true;
                continue;
            }
            if (byte === 0x0a && this.afterReturn) {
                this.afterReturn = false;
                continue;
            }
            this.afterReturn = false;
            out.push(byte);
        }
        return Buffer.from(out);
    }
}

/** Sends the child's output to the task's log and matcher, and calls `onEnd` once, with the exit code, when the task is over. */
export function captureOutput(
    task: Task,
    child: NonNullable<Task["child"]>,
    values: string[],
    now: () => number,
    onEnd: (exitCode: number) => void,
): void {
    // One cleaner per stream: an escape sequence or a credential value cut between two chunks is joined again, and the
    // two streams cannot join halves of each other.
    const endings = new LineEndings();
    const cleaners: OutputCleaner[] = [createOutputCleaner(values), createOutputCleaner(values)];
    const take = (data: Buffer): void => {
        if (data.length === 0) return;
        const text = endings.push(data);
        task.log?.append(text, now());
        task.matcher?.push(text, task.streamBytes);
        task.streamBytes += text.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => take(cleaners[0]?.push(chunk) ?? Buffer.alloc(0)));
    child.stderr?.on("data", (chunk: Buffer) => take(cleaners[1]?.push(chunk) ?? Buffer.alloc(0)));
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (finished) return;
        finished = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        for (const cleaner of cleaners) take(cleaner.end());
        onEnd(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1));
    };
    // `close` waits for the pipes, and a grandchild that kept them open must not keep the task running.
    child.once("exit", (code, signal) => {
        const timer = setTimeout(() => finish(code, signal), STDIO_GRACE_MS);
        timer.unref();
        child.once("close", () => {
            clearTimeout(timer);
            finish(code, signal);
        });
    });
}
