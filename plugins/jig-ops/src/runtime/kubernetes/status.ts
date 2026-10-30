// `status`: the rollout of a service, seen once, or watched until its pods run a given version.
//
// A wait polls the cluster and backs off between polls, so a long rollout costs a few dozen reads and not hundreds. It
// ends when the version is running, when a pod cannot come up, or when the time is up; the last two are results, not
// errors, so the model sees which pod failed or how far the rollout got.
import type { Kube } from "./kubectl.ts";
import type { Call } from "./params.ts";
import { listPods } from "./pods.ts";
import type { Pod } from "./pods.ts";
import { evaluate, listWorkloads, podLines, verdictLine, workloadLines } from "./rollout.ts";
import type { Rollout, Workload } from "./rollout.ts";
import { duration } from "./values.ts";
import type { Outcome } from "./values.ts";

/** What a wait needs from outside: the clock, a sleep that a stopped call ends, and a way to say how it is going. */
export interface Waiting {
    now(): number;
    sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
    progress(text: string): void;
}

/** The first poll is at once, the next after 2 s, then each wait is half as long again, never more than 15 s. */
export const POLL_FIRST_MS = 2_000;
export const POLL_MAX_MS = 15_000;
export function nextDelay(ms: number): number {
    return Math.min(POLL_MAX_MS, Math.round(ms * 1.5));
}

interface Snapshot {
    pods: Pod[];
    workloads: Workload[];
    rollout: Rollout;
}

/** The pods, then the workloads, read one after the other so that the calls of a test come in a fixed order. */
async function look(kube: Kube, version: string | undefined): Promise<Snapshot> {
    const pods = await listPods(kube);
    const workloads = await listWorkloads(kube);
    return { pods, workloads, rollout: evaluate(pods, workloads, version) };
}

function render(kube: Kube, snapshot: Snapshot, version: string | undefined, now: number, waited?: string): string {
    const { target } = kube;
    const verdict = verdictLine(snapshot.rollout, target, version, waited);
    const head = `${target.service} in ${target.environment} (namespace ${target.namespace}): ${verdict}`;
    const lines = [head, workloadLines(snapshot.workloads), podLines(snapshot.pods, version, now)];
    return lines.filter((line) => line !== "").join("\n");
}

function outcome(text: string, snapshot: Snapshot, more: { polls: number; timedOut: boolean }): Outcome {
    const { verdict, live, settled, wanted, tags } = snapshot.rollout;
    return {
        text,
        facts: { verdict, pods: live.length, ready: settled, polls: more.polls, timedOut: more.timedOut },
        details: { verdict, pods: live.length, ready: settled, wanted, tags, ...more },
    };
}

/** The error of a wait that the user stopped. The rollout goes on whatever happens to the wait. */
function stopped(last: Snapshot | undefined): Error {
    let seen = "";
    if (last !== undefined) {
        const { verdict, settled, wanted } = last.rollout;
        seen = ` (last seen: ${verdict}, ${settled} of ${wanted} ready)`;
    }
    return new Error(
        `k8s status: the wait was stopped${seen}. ` +
            "The rollout itself is not affected: run status with waitFor to wait again",
    );
}

async function waitForVersion(kube: Kube, version: string, timeoutSec: number, deps: Waiting): Promise<Outcome> {
    const started = deps.now();
    const deadline = started + timeoutSec * 1000;
    let delay = POLL_FIRST_MS;
    let last: Snapshot | undefined;

    for (let polls = 1; ; polls++) {
        try {
            last = await look(kube, version);
        } catch (error) {
            // A stopped call surfaces as a failed kubectl. The user stopped the wait, so that is what the error says.
            if (kube.signal?.aborted) throw stopped(last);
            throw error;
        }
        const { verdict, live, settled, wanted, tags } = last.rollout;
        if (verdict === "running" || verdict === "failing") {
            return outcome(render(kube, last, version, deps.now()), last, { polls, timedOut: false });
        }
        if (deadline - deps.now() <= 0) {
            const text = render(kube, last, version, deps.now(), duration(deps.now() - started));
            return outcome(text, last, { polls, timedOut: true });
        }

        const { service, environment } = kube.target;
        const running = tags.join(", ") || "no tag";
        const of = Math.max(wanted, live.length);
        deps.progress(`${service} ${environment}: ${settled} of ${of} ready on ${version}, running ${running}`);
        try {
            await deps.sleep(Math.min(delay, deadline - deps.now()), kube.signal);
        } catch (error) {
            if (kube.signal?.aborted) throw stopped(last);
            throw error;
        }
        delay = nextDelay(delay);
    }
}

/** `status`: the workloads and pods of the service, and whether they are running one version. */
export async function statusAction(
    kube: Kube,
    call: Extract<Call, { action: "status" }>,
    deps: Waiting,
): Promise<Outcome> {
    if (call.waitFor === undefined) {
        const snapshot = await look(kube, undefined);
        return outcome(render(kube, snapshot, undefined, deps.now()), snapshot, { polls: 1, timedOut: false });
    }
    return waitForVersion(kube, call.waitFor, call.timeoutSec, deps);
}
