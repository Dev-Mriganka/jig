// This module's only contact with processes: signals and `/proc`. Everything above it (the stop, the grace period, the
// kill, the clean-up of a crashed session) runs against the `ProcessPort` interface, so a test can fake it. The group-kill
// idea and the errno handling come from gvanderclay/pi-bg-bash (MIT, see docs/background.md, "Credit").
import { readdirSync, readFileSync } from "node:fs";
import type { StopOutcome } from "./types.ts";

export interface ProcessPort {
    /**
     * The process groups of the descendants of `pid`, other than `pid`'s own. Under bubblewrap the command is in a session
     * of its own, a different group from the shell that started it, and only a signal sent there reaches its traps.
     */
    innerGroups(pid: number): number[];
    /** Every descendant of `pid`, nearest first. */
    descendants(pid: number): number[];
    /** Signals a process (a positive number) or a whole group (a negative one). False when nothing was left to signal. */
    signal(target: number, signal: NodeJS.Signals): boolean;
    alive(pid: number): boolean;
    /** Field 22 of `/proc/<pid>/stat`, the start time: with the pid it names one process for good. */
    startTicks(pid: number): string | undefined;
}

interface Stat {
    pid: number;
    ppid: number;
    pgrp: number;
    startTicks: string;
}

/** `pid (comm) S ppid pgrp session ...`: the name may hold spaces and parentheses, so the fields are read after the last `)`. */
export function parseStat(text: string): Stat | undefined {
    const close = text.lastIndexOf(")");
    const open = text.indexOf("(");
    if (close < 0 || open < 0) return undefined;
    const fields = text.slice(close + 2).split(" ");
    const pid = Number(text.slice(0, open).trim());
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    const startTicks = fields[19];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgrp) || !startTicks) return undefined;
    return { pid, ppid, pgrp, startTicks };
}

function readStat(pid: number): Stat | undefined {
    try {
        return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
        return undefined;
    }
}

/** Every process, grouped by parent. */
function childrenByParent(): Map<number, Stat[]> {
    const children = new Map<number, Stat[]>();
    let names: string[];
    try {
        names = readdirSync("/proc");
    } catch {
        return children;
    }
    for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const stat = readStat(Number(name));
        if (stat) children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), stat]);
    }
    return children;
}

function walk(pid: number): Stat[] {
    const children = childrenByParent();
    const found: Stat[] = [];
    const queue = [pid];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        for (const child of children.get(next) ?? []) {
            found.push(child);
            queue.push(child.pid);
        }
    }
    return found;
}

export const realPort: ProcessPort = {
    innerGroups(pid) {
        return [
            ...new Set(
                walk(pid)
                    .filter((stat) => stat.pgrp !== pid)
                    .map((stat) => stat.pgrp),
            ),
        ];
    },
    descendants: (pid) => walk(pid).map((stat) => stat.pid),
    signal(target, signal) {
        if (!Number.isInteger(target) || Math.abs(target) <= 1) throw new Error(`refusing to signal ${target}`);
        try {
            process.kill(target, signal);
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ESRCH" || code === "EPERM") return false;
            throw error;
        }
    },
    alive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
        }
    },
    startTicks: (pid) => readStat(pid)?.startTicks,
};

/** How long a task gets after the polite stop before the hard one. */
export const GRACE_MS = 3_000;
const AFTER_KILL_MS = 1_000;
/** Just after a task starts its inner groups may not exist yet, so an empty answer is asked again once. */
const FRESH_MS = 1_000;
const RETRY_MS = 50;

export interface TerminateDeps {
    port: ProcessPort;
    /** Resolves true when the task has ended, false after `ms`. */
    ended(ms: number): Promise<boolean>;
    sleep(ms: number): Promise<void>;
    now(): number;
    graceMs?: number;
}

/**
 * Stops a task: SIGTERM to its inner groups (so its own traps run and a server can close), the grace period, then SIGKILL to
 * every group. `ageMs` is how long the task has run.
 */
export async function terminate(pid: number, ageMs: number, deps: TerminateDeps): Promise<StopOutcome> {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal process group ${pid}`);
    const { port } = deps;
    const started = deps.now();
    let groups = port.innerGroups(pid);
    if (groups.length === 0 && ageMs < FRESH_MS) {
        await deps.sleep(RETRY_MS);
        groups = port.innerGroups(pid);
    }
    // Never TERM the outer group while an inner one exists: the outer bubblewrap would die first, and its death kills the
    // command before any trap can run.
    if (groups.length > 0) for (const group of groups) port.signal(-group, "SIGTERM");
    else port.signal(-pid, "SIGTERM");
    if (await deps.ended(deps.graceMs ?? GRACE_MS)) return { how: "term", ms: deps.now() - started };
    port.signal(-pid, "SIGKILL");
    for (const group of port.innerGroups(pid).concat(groups)) port.signal(-group, "SIGKILL");
    const gone = await deps.ended(AFTER_KILL_MS);
    return { how: gone ? "kill" : "stuck", ms: deps.now() - started };
}
