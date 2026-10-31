// The `ci`, `deploy` and `runtime` tools as they run under Pi against a real cluster and real GitHub: the programs are the
// `kubectl`, `helm` and `gh` on PATH, started through the fake jig-core's `exec.run` (which starts real programs from an
// argument list), and only the screen, the secret store and the clock of the watch engine are the fakes the other tests of this
// plugin use. Used by the tests in `it/`.
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import type { PollOutcome, WatchResult } from "../../../jig-core/src/contract.ts";
import { setupHarness } from "./harness.ts";
import type { Harness } from "./harness.ts";
import type { Raw } from "./section.ts";

/** The tools with a section of jig.json. `programEnv` is added to the environment of every program, such as `gh`'s token. */
export function realHarness(t: TestContext, section: Raw, programEnv: Record<string, string> = {}): Harness {
    const h = setupHarness({}, { programEnv });
    h.configure(section);
    t.after(() => h.close());
    return h;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A program the test itself runs to set up or look at the cluster. It throws, with the program's words, when it fails. */
export function run(file: string, args: readonly string[], input?: string): string {
    try {
        return execFileSync(file, [...args], {
            encoding: "utf8",
            input,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 120_000,
        });
    } catch (error) {
        const failed = error as { stderr?: string; message: string };
        throw new Error(`${file} ${args.join(" ")} failed: ${(failed.stderr ?? failed.message).trim().slice(0, 600)}`);
    }
}

/**
 * Polls a watch the way jig-core's engine does, until it ends: the kind's own `poll`, every few seconds, with the state it
 * returned the time before.
 */
export async function untilDone(h: Harness, watchId: string, timeoutMs = 240_000): Promise<WatchResult> {
    const watch = h.jig.watches.find((candidate) => candidate.id === watchId);
    if (watch === undefined) throw new Error(`no watch ${watchId}`);
    const kind = h.jig.kinds.get(watch.kind) as unknown as {
        poll(spec: unknown, state: unknown, signal: AbortSignal): Promise<PollOutcome<unknown>>;
    };
    const stop = Date.now() + timeoutMs;
    let state: unknown;
    for (;;) {
        const outcome = await kind.poll(watch.spec, state, new AbortController().signal);
        if (outcome.done !== undefined) return outcome.done;
        state = outcome.state;
        if (Date.now() > stop) throw new Error(`the watch ${watchId} did not end in ${timeoutMs / 1000} s`);
        await sleep(3000);
    }
}
