// The watch kind `ops-rollout`: waits in the background until a service's rollout is complete. jig-core's watch engine calls
// `poll` on a timer, saves the state it returns, and sends the result to the agent once.
//
// The watch finishes with:
//   passed     every pod is ready and runs the version, and there are as many as the workloads want;
//   failed     a pod waits for a reason that does not pass by itself (CrashLoopBackOff, ImagePullBackOff, ...);
//   timed-out  the deadline in the spec came and the rollout was still going. The poll says how far it got; the engine would
//              only say that Pi stopped watching.
//
// The spec holds names, never a context or a namespace: each poll finds them in the catalog as it is now, so a watch always
// reads where the catalog says, and a saved watch file cannot point it elsewhere.
import { jig } from "../../jig-core/src/client.ts";
import type { JigApi, PollOutcome, WatchKind, WatchResult } from "../../jig-core/src/contract.ts";
import { catalogOf, findEnvironment, notSetUp } from "./catalog.ts";
import { podLines, verdictLine, workloadLines } from "./runtime/kubernetes/rollout.ts";
import { look } from "./runtime/kubernetes/wait.ts";
import { duration } from "./values.ts";

export const KIND = "ops-rollout";

/** What a rollout watch watches. Plain JSON, because it is saved with the watch. */
export interface RolloutSpec {
    service: string;
    environment: string;
    /** The image tag the pods must run. */
    version: string;
    /** When the watch started, in milliseconds. */
    startedAt: number;
    /** When it gives up, in milliseconds. A little before the engine's own deadline, so the last poll is ours. */
    deadline: number;
}

/** What the watch remembers between polls. Plain JSON. */
export interface RolloutState {
    polls: number;
}

/** One line naming what is watched. */
export function titleOf(service: string, environment: string, version: string): string {
    return `rollout of ${service} to ${version} in ${environment}`;
}

export interface RolloutOptions {
    /** The clock. Default: the real one. */
    now?: () => number;
}

async function pollRollout(
    spec: RolloutSpec,
    previous: RolloutState | undefined,
    signal: AbortSignal,
    now: () => number,
): Promise<PollOutcome<RolloutState>> {
    const catalog = catalogOf(jig().config.section("ops"));
    if (catalog === undefined) throw notSetUp();
    const env = findEnvironment(catalog, KIND, spec.service, spec.environment);
    if (env.kubernetes === undefined) throw new Error(`${spec.service} in ${spec.environment} has no Kubernetes runtime in the catalog`);

    const kube = { target: env.kubernetes, signal };
    const { pods, workloads, rollout } = await look(kube, spec.version);
    const state: RolloutState = { polls: (previous?.polls ?? 0) + 1 };
    const facts = { verdict: rollout.verdict, pods: rollout.live.length, ready: rollout.settled, polls: state.polls };
    const where = `${spec.service} in ${spec.environment}`;
    const details = [workloadLines(workloads), podLines(pods, spec.version, now())].filter((line) => line !== "").join("\n");

    let done: WatchResult | undefined;
    if (rollout.verdict === "running") {
        done = { outcome: "passed", summary: `${where}: ${verdictLine(rollout, kube.target, spec.version)}`, details, facts };
    } else if (rollout.verdict === "failing") {
        done = { outcome: "failed", summary: `${where}: ${verdictLine(rollout, kube.target, spec.version)}`, details, facts };
    } else if (now() >= spec.deadline) {
        const waited = duration(now() - spec.startedAt);
        done = { outcome: "timed-out", summary: `${where}: ${verdictLine(rollout, kube.target, spec.version, waited)}`, details, facts };
    }
    return done === undefined ? { state } : { state, done };
}

/** Registers the watch kind with jig-core. */
export function registerRolloutWatch(api: JigApi, options: RolloutOptions = {}): void {
    const now = options.now ?? Date.now;
    const kind: WatchKind<RolloutSpec, RolloutState> = {
        kind: KIND,
        plugin: "jig-ops",
        // A rollout takes minutes, and each poll is two reads of the cluster.
        intervalMs: 10_000,
        describe: (spec) => titleOf(spec.service, spec.environment, spec.version),
        poll: (spec, state, signal) => pollRollout(spec, state, signal, now),
    };
    api.watches.registerKind(kind);
}
