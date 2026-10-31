// What the plugin needs from outside itself, in one place: which Pi to run, the process table, the clock and the environment. The plugin
// reaches jig-core through `jig()` as every plugin does; tests give a `Host` of their own, with a fake child in place of Pi and a clock
// they move by hand.
import { spawn as nodeSpawn, execFile } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface Timers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** The program and the leading arguments that start Pi, before the flags the plugin builds. */
export interface PiCommand {
    file: string;
    args: string[];
}

export interface Host {
    /** How to start the same Pi as this one. */
    piCommand(): PiCommand;
    spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
    now(): number;
    timers: Timers;
    env(): NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    /** This process's id: a child records it, so a later session can tell whose child it is. */
    pid: number;
    /** An identity for a process that does not repeat when the id is reused: its start time. Undefined when it cannot be read. */
    processStart(pid: number): Promise<string | undefined>;
    /** Whether a process with this id exists. */
    alive(pid: number): boolean;
    /** Sends a signal to a process, or to its group when `group` is set. False when there is no such process. */
    signal(pid: number, signal: NodeJS.Signals, group: boolean): boolean;
    /** Ends this process now. A child whose parent is gone uses it when Pi, idle, has not shut down after being asked to. */
    exit(code: number): void;
}

/** Real timers that never keep Pi alive. */
export const realTimers: Timers = {
    setTimeout(callback, ms) {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
    },
    clearTimeout(handle) {
        clearTimeout(handle as NodeJS.Timeout);
    },
};

/** Whether a folder or one of its parents is the Pi package. */
function insidePiPackage(file: string): boolean {
    for (let folder = path.dirname(file); ; ) {
        try {
            const manifest = readFileSync(path.join(folder, "package.json"), "utf8");
            if (/"name"\s*:\s*"@earendil-works\/pi-coding-agent"/.test(manifest)) return true;
        } catch {
            // No package.json here; look higher.
        }
        const parent = path.dirname(folder);
        if (parent === folder) return false;
        folder = parent;
    }
}

/**
 * The same program as this process: Node and Pi's own entry file, not whichever `pi` comes first on PATH, which may be a wrapper. A single
 * compiled Pi has no entry file, and then the executable alone starts it.
 */
export function thisPi(argv: readonly string[] = process.argv, execPath: string = process.execPath): PiCommand {
    const entry = argv[1];
    if (entry !== undefined) {
        try {
            const real = realpathSync(entry);
            if (insidePiPackage(real)) return { file: execPath, args: [real] };
        } catch {
            // Not a file on disk: a compiled program.
        }
    }
    return { file: execPath, args: [] };
}

function startTimeOnLinux(pid: number): string | undefined {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        // Fields after the command name, which is in parentheses and may hold spaces: the start time is field 22 of the whole line.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return rest[19];
    } catch {
        return undefined;
    }
}

export function realHost(): Host {
    return {
        piCommand: () => thisPi(),
        spawn: (file, args, options) => nodeSpawn(file, [...args], options),
        now: () => Date.now(),
        timers: realTimers,
        env: () => process.env,
        platform: process.platform,
        pid: process.pid,
        processStart(pid) {
            if (process.platform === "linux") return Promise.resolve(startTimeOnLinux(pid));
            return new Promise((resolve) => {
                execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000 }, (error, stdout) => {
                    const text = stdout.trim();
                    resolve(error !== null || text === "" ? undefined : text);
                });
            });
        },
        alive(pid) {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                // EPERM: it exists and belongs to someone else.
                return (error as NodeJS.ErrnoException).code === "EPERM";
            }
        },
        exit: (code) => process.exit(code),
        signal(pid, signal, group) {
            try {
                process.kill(group && process.platform !== "win32" ? -pid : pid, signal);
                return true;
            } catch {
                return false;
            }
        },
    };
}
