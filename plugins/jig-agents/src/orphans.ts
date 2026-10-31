// A child ends with its parent. If the parent dies without ending it (a crash, a kill), the child's input closes and Pi's RPC mode shuts
// down by itself; this is the second line. At every session start the plugin reads the meta files, and a child that is still running
// while its parent is not is stopped. A process is only touched when its start time still matches the one recorded, so a reused process
// id is never mistaken for a child.
import type { Host } from "./host.ts";
import { agentsRoot, listChildren, writeMeta } from "./store.ts";
import type { Meta, StoredChild } from "./store.ts";

export interface SweepResult {
    /** Children found running after their parent was gone, now stopped. */
    stopped: string[];
    /** Children recorded as running whose process is gone. */
    lost: string[];
}

async function sameProcess(host: Host, pid: number | undefined, start: string | undefined): Promise<boolean> {
    if (pid === undefined || start === undefined || !host.alive(pid)) return false;
    return (await host.processStart(pid)) === start;
}

const LIVE: readonly string[] = ["starting", "running"];

/** True when a child's record says it is running. */
export const recordedRunning = (meta: Meta): boolean => LIVE.includes(meta.state);

function pause(host: Host, ms: number): Promise<void> {
    return new Promise((resolve) => host.timers.setTimeout(resolve, ms));
}

async function end(host: Host, pid: number): Promise<void> {
    host.signal(pid, "SIGTERM", true);
    for (let waited = 0; waited < 3000 && host.alive(pid); waited += 250) await pause(host, 250);
    if (host.alive(pid)) host.signal(pid, "SIGKILL", true);
}

/**
 * Finds children that outlived their parent and stops them; marks children whose process is gone as lost. `owned` holds the ids of the
 * children this session runs, which are never touched. A child whose parent still runs belongs to another live session and is left alone.
 */
export async function sweep(host: Host, state: string, owned: ReadonlySet<string>): Promise<SweepResult> {
    const result: SweepResult = { stopped: [], lost: [] };
    const all: StoredChild[] = listChildren(agentsRoot(state));
    for (const { dir, meta } of all) {
        if (!recordedRunning(meta) || owned.has(meta.id)) continue;
        const childAlive = await sameProcess(host, meta.pid, meta.pidStart);
        // A child of an earlier session of this very process is no one's child any more: its session ended.
        const parentAlive = meta.parentPid !== host.pid && (await sameProcess(host, meta.parentPid, meta.parentStart));
        if (childAlive && parentAlive) continue;
        const update = (note: string): void => {
            try {
                writeMeta(dir, { ...meta, state: "lost", updatedAt: new Date(host.now()).toISOString(), note });
            } catch {
                // The record stays as it was; the next session tries again.
            }
        };
        if (childAlive && meta.pid !== undefined) {
            await end(host, meta.pid);
            update("stopped at a later session start: its parent was gone");
            result.stopped.push(meta.id);
        } else {
            update("its process was gone when a later session started");
            result.lost.push(meta.id);
        }
    }
    return result;
}

/** In a child: how long between looks at whether the parent still exists. */
export const WATCHDOG_MS = 10_000;

/**
 * In a child (a Pi started by `jig-agents`): checks every 10 seconds that the parent process still exists, and asks Pi to shut down when it
 * does not. Returns a function that stops the checks.
 */
export function watchParent(host: Host, parentPid: number, shutdown: () => void): () => void {
    let handle: unknown;
    let stopped = false;
    const look = (): void => {
        if (stopped) return;
        if (!host.alive(parentPid)) {
            shutdown();
            return;
        }
        handle = host.timers.setTimeout(look, WATCHDOG_MS);
    };
    handle = host.timers.setTimeout(look, WATCHDOG_MS);
    return () => {
        stopped = true;
        host.timers.clearTimeout(handle);
    };
}
