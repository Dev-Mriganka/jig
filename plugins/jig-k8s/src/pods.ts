// The pods of a service, read from `kubectl get pods -o json`: whether each is ready, what it is doing, how often it
// restarted, and the image tag of the containers that run the service itself. Also the `pods` action.
import type { Target } from "./config.ts";
import { getJson } from "./kubectl.ts";
import type { Kube } from "./kubectl.ts";
import { isObject, plural, str } from "./values.ts";
import type { Outcome } from "./values.ts";

export interface Container {
    name: string;
    image: string;
    tag: string | undefined;
}

export interface Pod {
    name: string;
    ready: boolean;
    readyContainers: number;
    totalContainers: number;
    /** What `kubectl get pods` would print under STATUS. */
    status: string;
    restarts: number;
    created: number | undefined;
    /** Being deleted: on its way out, so it counts for nothing. */
    terminating: boolean;
    containers: Container[];
    initContainers: string[];
    /** The tags of the service's own containers. A sidecar carries a version of its own. */
    tags: string[];
    /** A waiting reason that means the pod will not come up by itself. */
    failing: string | undefined;
}

/** Waiting reasons after which a pod stays down until someone changes something. */
const FAILING_REASONS: readonly string[] = [
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "InvalidImageName",
];

/** The tag of `registry:5000/path/name:tag`. A digest or an untagged image has none. */
export function tagOf(image: string): string | undefined {
    const withoutDigest = image.split("@")[0] ?? "";
    const colon = withoutDigest.lastIndexOf(":");
    return colon > withoutDigest.lastIndexOf("/") ? withoutDigest.slice(colon + 1) : undefined;
}

/** `name` of `registry/path/name:tag`. */
function imageName(image: string): string {
    const withoutDigest = image.split("@")[0] ?? "";
    return (withoutDigest.split("/").pop() ?? "").split(":")[0] ?? "";
}

/**
 * The containers that run the service itself, as against the sidecars a platform adds. The configured container wins; a
 * pod with one container has no sidecar; otherwise the container or the image that is named like the service. When none is,
 * every container is.
 */
export function ownContainers(containers: readonly Container[], target: Target): Container[] {
    const configured = containers.filter((container) => container.name === target.container);
    if (configured.length > 0) return configured;
    if (containers.length === 1) return [...containers];
    const named = containers.filter((container) => container.name === target.service || imageName(container.image) === target.service);
    return named.length > 0 ? named : [...containers];
}

function containersOf(list: unknown): Container[] {
    return (Array.isArray(list) ? list : []).filter(isObject).map((container) => {
        const image = str(container.image) ?? "";
        return { name: str(container.name) ?? "", image, tag: tagOf(image) };
    });
}

function waitingReason(status: Record<string, unknown>): string | undefined {
    return isObject(status.state) && isObject(status.state.waiting) ? str(status.state.waiting.reason) : undefined;
}

/** Why a container ended, when it ended badly. */
function terminatedReason(status: Record<string, unknown>): string | undefined {
    if (!isObject(status.state) || !isObject(status.state.terminated)) return undefined;
    return status.state.terminated.exitCode === 0 ? undefined : (str(status.state.terminated.reason) ?? "Error");
}

export function parsePod(raw: unknown, target: Target): Pod | undefined {
    if (!isObject(raw) || !isObject(raw.metadata)) return undefined;
    const name = str(raw.metadata.name);
    if (name === undefined) return undefined;
    const status = isObject(raw.status) ? raw.status : {};
    const statuses = (Array.isArray(status.containerStatuses) ? status.containerStatuses : []).filter(isObject);
    const initStatuses = (Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : []).filter(isObject);
    const spec = isObject(raw.spec) ? raw.spec : {};
    const containers = containersOf(spec.containers);

    const terminating = str(raw.metadata.deletionTimestamp) !== undefined;
    const waiting = [...initStatuses.map(waitingReason), ...statuses.map(waitingReason)].filter((reason): reason is string => reason !== undefined);
    const initWaiting = initStatuses.map(waitingReason).find((reason) => reason !== undefined);
    // The order kubectl uses for its STATUS column.
    const display = terminating
        ? "Terminating"
        : initWaiting !== undefined
            ? `Init:${initWaiting}`
            : (statuses.map(waitingReason).find((reason) => reason !== undefined) ??
                statuses.map(terminatedReason).find((reason) => reason !== undefined) ??
                str(status.reason) ??
                str(status.phase) ??
                "Unknown");
    const conditions = (Array.isArray(status.conditions) ? status.conditions : []).filter(isObject);
    const created = Date.parse(str(raw.metadata.creationTimestamp) ?? "");

    return {
        name,
        ready: conditions.some((condition) => condition.type === "Ready" && condition.status === "True"),
        readyContainers: statuses.filter((container) => container.ready === true).length,
        totalContainers: containers.length,
        status: display,
        restarts: statuses.reduce((sum, container) => sum + (typeof container.restartCount === "number" ? container.restartCount : 0), 0),
        created: Number.isFinite(created) ? created : undefined,
        terminating,
        containers,
        initContainers: containersOf(spec.initContainers).map((container) => container.name),
        tags: ownContainers(containers, target).map((container) => container.tag).filter((tag): tag is string => tag !== undefined),
        failing: waiting.find((reason) => FAILING_REASONS.includes(reason)),
    };
}

/** The pods that match the target's selector, in the order kubectl lists them. */
export async function listPods(kube: Kube): Promise<Pod[]> {
    const raw = await getJson(kube, "pods", [`--selector=${kube.target.selector}`]);
    const items = isObject(raw) && Array.isArray(raw.items) ? raw.items : [];
    return items.map((item) => parsePod(item, kube.target)).filter((pod): pod is Pod => pod !== undefined);
}

/** The first pod that is Ready and not on its way out. */
export function firstReady(pods: readonly Pod[]): Pod | undefined {
    return pods.find((pod) => pod.ready && !pod.terminating);
}

/** "5m", "3h", "2d". */
export function age(created: number | undefined, now: number): string {
    if (created === undefined) return "?";
    const seconds = Math.max(0, Math.round((now - created) / 1000));
    if (seconds < 120) return `${seconds}s`;
    if (seconds < 7200) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 172_800) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
}

/** The tags of a pod's own containers, as a person reads them. */
function tagsText(pod: Pod): string {
    return pod.tags.length === 0 ? "no tag" : pod.tags.join(", ");
}

export function podLine(pod: Pod, now: number): string {
    return (
        `- ${pod.name}: ${pod.readyContainers}/${pod.totalContainers} ready, ${pod.status}, ` +
        `${plural(pod.restarts, "restart")}, ${age(pod.created, now)}, image ${tagsText(pod)}`
    );
}

/** `pods`: the service's pods, one line each. */
export async function podsAction(kube: Kube, now: number): Promise<Outcome> {
    const { target } = kube;
    const pods = await listPods(kube);
    const where = `${target.service} in ${target.environment} (namespace ${target.namespace})`;
    if (pods.length === 0) {
        return {
            text: `No pods match ${target.selector} for ${where}.`,
            facts: { pods: 0, ready: 0 },
            details: { pods: [] },
        };
    }
    const ready = pods.filter((pod) => pod.ready && !pod.terminating).length;
    return {
        text: `${plural(pods.length, "pod")} of ${where}:\n${pods.map((pod) => podLine(pod, now)).join("\n")}`,
        facts: { pods: pods.length, ready },
        details: {
            pods: pods.map((pod) => ({ name: pod.name, ready: pod.ready, status: pod.status, restarts: pod.restarts, tags: pod.tags })),
        },
    };
}
