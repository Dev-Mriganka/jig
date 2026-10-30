// Is the service running the version it should? The workloads (deployments and statefulsets) behind the pods are read here,
// and `evaluate` turns pods and workloads into a verdict. Nothing in `evaluate` reads a cluster, so every case is a plain
// function of a few objects.
import type { Target } from "./config.ts";
import { getJson } from "./kubectl.ts";
import type { Kube } from "./kubectl.ts";
import { ownContainers, podLine, tagOf } from "./pods.ts";
import type { Container, Pod } from "./pods.ts";
import { isObject, plural, str } from "./values.ts";

export interface Workload {
    kind: "StatefulSet" | "Deployment";
    name: string;
    desired: number;
    ready: number;
    updated: number;
    /** A statefulset: its current revision, and `current -> update` while it rolls. A deployment: its revision number. */
    revision: string | undefined;
    /** The tags the workload's pod template asks for, for the service's own containers. */
    tags: string[];
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** True when every pair is among the labels. */
function carries(labels: unknown, wanted: Target["labels"]): boolean {
    return isObject(labels) && wanted.every(([key, value]) => labels[key] === value);
}

/**
 * A workload belongs to the service when its selector or its pod template carries the labels the target selects pods
 * with. The workload's own labels say nothing: a chart may put others on it.
 */
function owns(item: Record<string, unknown>, target: Target): boolean {
    const spec = isObject(item.spec) ? item.spec : {};
    const selector = isObject(spec.selector) ? spec.selector.matchLabels : undefined;
    const template = isObject(spec.template) ? spec.template : {};
    return carries(selector, target.labels) || carries(isObject(template.metadata) ? template.metadata.labels : undefined, target.labels);
}

export function parseWorkloads(raw: unknown, target: Target): Workload[] {
    const items = isObject(raw) && Array.isArray(raw.items) ? raw.items : [];
    const found: Workload[] = [];
    for (const item of items) {
        if (!isObject(item) || !isObject(item.metadata) || !owns(item, target)) continue;
        const kind = item.kind === "StatefulSet" || item.kind === "Deployment" ? item.kind : undefined;
        const name = str(item.metadata.name);
        if (kind === undefined || name === undefined) continue;

        const spec = isObject(item.spec) ? item.spec : {};
        const status = isObject(item.status) ? item.status : {};
        const template = isObject(spec.template) && isObject(spec.template.spec) ? spec.template.spec : {};
        const containers: Container[] = (Array.isArray(template.containers) ? template.containers : []).filter(isObject).map((container) => {
            const image = str(container.image) ?? "";
            return { name: str(container.name) ?? "", image, tag: tagOf(image) };
        });
        const annotations = isObject(item.metadata.annotations) ? item.metadata.annotations : {};
        const current = str(status.currentRevision);
        const update = str(status.updateRevision);
        const revision = kind === "StatefulSet"
            ? (current !== undefined && update !== undefined && current !== update ? `${current} -> ${update}` : (current ?? update))
            : str(annotations["deployment.kubernetes.io/revision"]);
        found.push({
            kind,
            name,
            // A workload with no `replicas` runs one.
            desired: spec.replicas === undefined ? 1 : count(spec.replicas),
            ready: count(status.readyReplicas),
            updated: count(status.updatedReplicas),
            revision,
            tags: ownContainers(containers, target).map((container) => container.tag).filter((tag): tag is string => tag !== undefined),
        });
    }
    return found;
}

/** The deployments and statefulsets in the namespace that run the target's pods. Their number can be none. */
export async function listWorkloads(kube: Kube): Promise<Workload[]> {
    return parseWorkloads(await getJson(kube, "deployments,statefulsets"), kube.target);
}

export type Verdict = "running" | "rolling" | "failing" | "no-pods";

export interface Rollout {
    verdict: Verdict;
    /** The pod that will not come up, when the verdict is failing. */
    failing: Pod | undefined;
    /** The pods that are not on their way out. */
    live: Pod[];
    /** How many of them are ready, and on the version when there is one to wait for. */
    settled: number;
    /** How many pods the workloads want: the pods that exist, when no workload was found. */
    wanted: number;
    /** The tags the live pods run, once each. */
    tags: string[];
}

/**
 * - failing: a pod is waiting for a reason that does not pass by itself. Checked first, because such a pod can never be
 *   ready.
 * - no-pods: nothing is running.
 * - running: there are as many pods as wanted, every one is ready, and every one runs the version. With no version to
 *   wait for, the pods only have to agree with each other.
 * - rolling: anything else.
 */
export function evaluate(pods: readonly Pod[], workloads: readonly Workload[], version: string | undefined): Rollout {
    const live = pods.filter((pod) => !pod.terminating);
    const wanted = Math.max(1, workloads.length > 0 ? workloads.reduce((sum, workload) => sum + workload.desired, 0) : live.length);
    const onVersion = (pod: Pod) => version === undefined || pod.tags.includes(version);
    const settled = live.filter((pod) => pod.ready && onVersion(pod)).length;
    const tags = [...new Set(live.flatMap((pod) => pod.tags))];
    const agree = new Set(live.map((pod) => pod.tags.join(","))).size === 1;
    const failing = live.find((pod) => pod.failing !== undefined);

    let verdict: Verdict = "rolling";
    if (failing !== undefined) verdict = "failing";
    else if (live.length === 0) verdict = "no-pods";
    else if (live.length >= wanted && settled === live.length && (version !== undefined || agree)) verdict = "running";
    return { verdict, failing, live, settled, wanted, tags };
}

/** The verdict as one sentence. `waited` is how long a wait ran, when it ended because time was up. */
export function verdictLine(rollout: Rollout, target: Target, version: string | undefined, waited?: string): string {
    const { live, settled, wanted, tags } = rollout;
    const of = Math.max(wanted, live.length);
    const run = tags.length === 0 ? "no tag" : tags.join(", ");
    const after = waited === undefined ? "" : ` after waiting ${waited}`;
    switch (rollout.verdict) {
        case "running":
            return `Running: ${settled} of ${plural(of, "pod")} ready on ${version ?? run}.`;
        case "rolling":
            return `Still rolling${after}: ${settled} of ${plural(of, "pod")} ready${version === undefined ? "" : ` on ${version}`}; pods run ${run}.`;
        case "failing": {
            const pod = rollout.failing as Pod;
            return (
                `Failing: pod ${pod.name} is ${pod.failing} (${plural(pod.restarts, "restart")}). ` +
                `Read why with logs (pod: ${pod.name}, previous: true).`
            );
        }
        case "no-pods":
            return `No pods${after} match ${target.selector} in namespace ${target.namespace}.`;
    }
}

export function workloadLines(workloads: readonly Workload[]): string {
    if (workloads.length === 0) return "Workload: no deployment or statefulset runs these pods; judged from the pods.";
    return workloads
        .map((workload) => {
            const revision = workload.revision === undefined ? "" : `, revision ${workload.revision}`;
            const image = workload.tags.length === 0 ? "" : `, image ${workload.tags.join(", ")}`;
            return `Workload: ${workload.kind} ${workload.name}, ${workload.ready}/${workload.desired} ready, ${workload.updated} updated${revision}${image}.`;
        })
        .join("\n");
}

/** One line per pod. With a version to wait for, a pod that is not ready on it says so. */
export function podLines(pods: readonly Pod[], version: string | undefined, now: number): string {
    return pods
        .map((pod) => {
            const behind = version !== undefined && !(pod.ready && pod.tags.includes(version));
            return `${podLine(pod, now)}${behind && !pod.terminating ? `  <- not ready on ${version}` : ""}`;
        })
        .join("\n");
}
