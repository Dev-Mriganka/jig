// The operating-system process of one child: starting it, noticing that it ended, keeping the tail of what it wrote on stderr, and
// stopping it as gently as it allows (close its input, then SIGTERM, then SIGKILL, each to its whole group). Nothing here knows what
// a child is for; child.ts decides when to stop it and what its end means. A resumed child gets a fresh process, so every handler
// answers only for the process it was attached to: the old one's last events must not end the new one.
import type { ChildProcess } from "node:child_process";
import { tailLines } from "./clean.ts";
import type { Host, PiCommand } from "./host.ts";

const STDERR_CHARS = 8192;
/** How long each step of a stop waits before the next, harder one. */
const STEP_MS = 5_000;
/** After `exit` the pipes may still hold the child's last words; `close` follows when they are read. If it does not, decide anyway. */
const CLOSE_WAIT_MS = 1500;

export class ProcessHandle {
    proc: ChildProcess | undefined;
    exited = false;
    /** How it ended: `exit code 1, signal SIGTERM`, or why it could not start. */
    exitText = "";
    private stderr = "";
    private waiters: Array<() => void> = [];
    private readonly host: Host;

    constructor(host: Host) {
        this.host = host;
    }

    /** Forgets the old process, for a child that starts again. */
    reset(): void {
        this.proc = undefined;
        this.exited = false;
        this.waiters = [];
        this.stderr = "";
        this.exitText = "";
    }

    /**
     * Starts Pi. Throws what `spawn` throws. `gone` is told when this process has ended or could not start, and may be told twice
     * (at `exit` and at `close`); the caller checks that the process is still the current one.
     */
    spawn(
        pi: PiCommand,
        flags: readonly string[],
        env: Record<string, string>,
        cwd: string,
        gone: (proc: ChildProcess) => void,
    ): ChildProcess {
        const { host } = this;
        const proc = host.spawn(pi.file, [...pi.args, ...flags], {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: host.platform !== "win32",
            windowsHide: true,
        });
        this.proc = proc;
        this.exited = false;
        // These are attached first, so a process that ends at once is not missed.
        proc.once("exit", (code, signal) => {
            if (this.proc !== proc) return;
            this.exited = true;
            this.exitText = `exit code ${code ?? "none"}${signal === null ? "" : `, signal ${signal}`}`;
            this.wake();
            setTimeout(() => gone(proc), CLOSE_WAIT_MS).unref();
        });
        proc.once("close", () => gone(proc));
        proc.once("error", (error) => {
            if (this.proc !== proc) return;
            this.exited = true;
            this.exitText = `could not start: ${error.message}`;
            this.wake();
            gone(proc);
        });
        proc.stderr?.on("data", (data: Buffer) => {
            if (this.proc === proc) this.stderr = (this.stderr + data.toString("utf8")).slice(-STDERR_CHARS);
        });
        return proc;
    }

    private wake(): void {
        for (const wake of this.waiters.splice(0)) wake();
    }

    /** The last lines the process wrote on stderr, as a clause for an error message. Empty when it wrote none. */
    stderrNote(): string {
        const lines = tailLines(this.stderr, 4, 200);
        return lines.length === 0 ? "" : ` (the child said: ${lines.join(" | ")})`;
    }

    /** Resolves true when the process has ended, false after `ms`. */
    waitExit(ms: number): Promise<boolean> {
        if (this.exited || this.proc === undefined) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = this.host.timers.setTimeout(() => {
                this.waiters = this.waiters.filter((wake) => wake !== wake0);
                resolve(false);
            }, ms);
            const wake0 = (): void => {
                this.host.timers.clearTimeout(timer);
                resolve(true);
            };
            this.waiters.push(wake0);
        });
    }

    /** Ends the child's input, then its process group, as gently as it allows. */
    async close(endInput: () => void): Promise<void> {
        const pid = this.proc?.pid;
        if (this.proc === undefined || this.exited) return;
        endInput();
        if (await this.waitExit(STEP_MS)) return;
        if (pid !== undefined) this.host.signal(pid, "SIGTERM", true);
        if (await this.waitExit(STEP_MS)) return;
        if (pid !== undefined) this.host.signal(pid, "SIGKILL", true);
        await this.waitExit(2000);
    }

    /** The parent session is ending: no courtesy, but nothing is left running. */
    async terminate(waitMs: number, endInput: () => void): Promise<void> {
        const pid = this.proc?.pid;
        endInput();
        if (pid !== undefined && !this.exited) this.host.signal(pid, "SIGTERM", true);
        if (!(await this.waitExit(waitMs)) && pid !== undefined) {
            this.host.signal(pid, "SIGKILL", true);
            await this.waitExit(1000);
        }
    }
}
