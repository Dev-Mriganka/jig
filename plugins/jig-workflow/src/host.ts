// What the plugin needs from outside itself, in one place: jig-core's programs and sandbox, and the clock. The plugin reaches
// jig-core through `jig()` as every plugin does; tests give a `Host` of their own so that a git repository is real and a
// `gh` or a sandbox is a fake.
import { createHash } from "node:crypto";
import { jig } from "../../jig-core/src/client.ts";
import type { RunOptions, RunResult, SandboxRunOptions, SandboxRunResult } from "../../jig-core/src/contract.ts";

export interface Host {
    /** `git` in a repository, through jig-core: hooks off, a repository that would run a command refused. */
    git(root: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult>;
    /** A program from an argument list, never a shell, through jig-core. */
    run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
    /** The sandbox's way to run a shell command. `canRun` is true only when it is on and can run commands. */
    sandbox: {
        canRun(): boolean;
        run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult>;
    };
    now(): Date;
}

/** The host a real session uses. */
export function coreHost(): Host {
    return {
        git: (root, args, signal) =>
            jig().exec.git(root, args, { timeoutMs: 20_000, ...(signal === undefined ? {} : { signal }) }),
        run: (file, args, options) => jig().exec.run(file, args, options),
        sandbox: {
            canRun: () => {
                try {
                    return jig().sandbox.canRun;
                } catch {
                    return false;
                }
            },
            run: (command, options) => jig().sandbox.run(command, options),
        },
        now: () => new Date(),
    };
}

/** A SHA-256 of text, in hex: the fingerprint of a plan, of a scenario, of the notes. */
export function hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** A short digest of several parts, for a preview's fingerprint. */
export function digest(...parts: ReadonlyArray<string | number | boolean | null | undefined>): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
