// Kubernetes fixtures: pod and workload JSON as `kubectl get -o json` prints it. The names are made up.
import type { Reply } from "./fake-programs.ts";

export interface PodOptions {
    /** The service the pod belongs to. Default `orders-api`. */
    service?: string;
    /** The tag of the service's image. Default `1.4.2`. */
    tag?: string;
    /** A whole image, when the test needs a digest or another registry. */
    image?: string;
    ready?: boolean;
    phase?: string;
    /** A waiting reason, such as CrashLoopBackOff. */
    waiting?: string;
    terminated?: { reason: string; exitCode: number };
    initWaiting?: string;
    restarts?: number;
    /** Set a deletion time: the pod is on its way out. */
    deleting?: boolean;
    created?: string;
    /** The tag of a sidecar container; none by default. */
    sidecar?: string;
    /** Pod annotations. */
    annotations?: Record<string, string>;
    /** An extra init container with this name. */
    initContainer?: string;
}

export const IMAGE = (tag: string, name = "orders-api") => `registry.example.test/shop/${name}:${tag}`;

export function pod(name: string, options: PodOptions = {}): Record<string, unknown> {
    const service = options.service ?? "orders-api";
    const ready = options.ready ?? true;
    const containers: Array<Record<string, unknown>> = [
        { name: service, image: options.image ?? IMAGE(options.tag ?? "1.4.2", service) },
    ];
    const statuses: Array<Record<string, unknown>> = [
        {
            name: service,
            ready,
            restartCount: options.restarts ?? 0,
            state: options.waiting
                ? { waiting: { reason: options.waiting } }
                : options.terminated
                  ? { terminated: options.terminated }
                  : { running: {} },
        },
    ];
    if (options.sidecar !== undefined) {
        containers.push({ name: "mesh-proxy", image: `registry.example.test/mesh/proxy:${options.sidecar}` });
        statuses.push({ name: "mesh-proxy", ready, restartCount: 0, state: { running: {} } });
    }
    return {
        metadata: {
            name,
            labels: { app: service },
            creationTimestamp: options.created ?? "2026-10-15T08:00:00Z",
            ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
            ...(options.deleting ? { deletionTimestamp: "2026-10-15T08:59:00Z" } : {}),
        },
        spec: {
            containers,
            ...(options.initContainer === undefined
                ? {}
                : { initContainers: [{ name: options.initContainer, image: "registry.example.test/tools/init:1" }] }),
        },
        status: {
            phase: options.phase ?? "Running",
            conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
            containerStatuses: statuses,
            ...(options.initWaiting
                ? {
                      initContainerStatuses: [
                          { name: "init", ready: false, state: { waiting: { reason: options.initWaiting } } },
                      ],
                  }
                : {}),
        },
    };
}

/** What `kubectl get -o json` prints for a list: the reply a fake kubectl gives. */
export const list = (...items: unknown[]): Reply => ({ stdout: { apiVersion: "v1", kind: "List", items } });

export interface WorkloadOptions {
    kind?: "StatefulSet" | "Deployment";
    service?: string;
    replicas?: number | null;
    ready?: number;
    updated?: number;
    currentRevision?: string;
    updateRevision?: string;
    deploymentRevision?: string;
    tag?: string;
    /** Where the service's label sits: on the selector (default), only on the pod template, or nowhere. */
    labelsOn?: "selector" | "template" | "none";
}

export function workload(name: string, options: WorkloadOptions = {}): Record<string, unknown> {
    const service = options.service ?? "orders-api";
    const kind = options.kind ?? "StatefulSet";
    const labels = { app: service };
    const on = options.labelsOn ?? "selector";
    const replicas = options.replicas === undefined ? 2 : options.replicas;
    return {
        kind,
        metadata: {
            name,
            ...(kind === "Deployment" && options.deploymentRevision
                ? { annotations: { "deployment.kubernetes.io/revision": options.deploymentRevision } }
                : {}),
        },
        spec: {
            ...(replicas === null ? {} : { replicas }),
            selector: { matchLabels: on === "selector" ? labels : { other: "x" } },
            template: {
                metadata: { labels: on === "none" ? { other: "x" } : labels },
                spec: {
                    containers: [
                        { name: service, image: IMAGE(options.tag ?? "1.4.2", service) },
                        { name: "mesh-proxy", image: "registry.example.test/mesh/proxy:1.20" },
                    ],
                },
            },
        },
        status: {
            readyReplicas: options.ready ?? 2,
            updatedReplicas: options.updated ?? 2,
            ...(kind === "StatefulSet"
                ? {
                      currentRevision: options.currentRevision ?? "orders-api-5d9f",
                      updateRevision: options.updateRevision ?? options.currentRevision ?? "orders-api-5d9f",
                  }
                : {}),
        },
    };
}

export interface EventOptions {
    kind?: string;
    type?: "Normal" | "Warning";
    reason?: string;
    message?: string;
    count?: number;
    /** `lastTimestamp` of the core API. */
    last?: string;
    /** The events API's own fields, for events that have no `lastTimestamp`. */
    eventTime?: string;
    seriesLast?: string;
    first?: string;
    created?: string;
}

/** An event about `kind/name`, as `kubectl get events -o json` prints it. */
export function event(name: string, options: EventOptions = {}): Record<string, unknown> {
    return {
        metadata: {
            name: `${name}.${options.reason ?? "Pulled"}`,
            ...(options.created === undefined ? {} : { creationTimestamp: options.created }),
        },
        involvedObject: { kind: options.kind ?? "Pod", name },
        type: options.type ?? "Normal",
        reason: options.reason ?? "Pulled",
        message: options.message ?? "Successfully pulled image",
        ...(options.count === undefined ? {} : { count: options.count }),
        ...(options.last === undefined ? {} : { lastTimestamp: options.last }),
        ...(options.first === undefined ? {} : { firstTimestamp: options.first }),
        ...(options.eventTime === undefined ? {} : { eventTime: options.eventTime }),
        ...(options.seriesLast === undefined ? {} : { series: { lastObservedTime: options.seriesLast } }),
    };
}

export interface ReplicaSetOptions {
    /** The deployment that owns it. */
    owner?: string;
    service?: string;
    revision?: number;
    tag?: string;
    /** Where the service's label sits: on the pod template (default) or nowhere. */
    labelsOn?: "template" | "none";
}

/** A replica set of a deployment, as `kubectl get replicasets -o json` prints it. */
export function replicaSet(name: string, options: ReplicaSetOptions = {}): Record<string, unknown> {
    const service = options.service ?? "orders-api";
    const owner = options.owner ?? service;
    return {
        kind: "ReplicaSet",
        metadata: {
            name,
            ownerReferences: [{ kind: "Deployment", name: owner }],
            annotations: { "deployment.kubernetes.io/revision": String(options.revision ?? 1) },
        },
        spec: {
            selector: { matchLabels: { other: "x" } },
            template: {
                metadata: { labels: options.labelsOn === "none" ? { other: "x" } : { app: service } },
                spec: { containers: [{ name: service, image: IMAGE(options.tag ?? "1.4.2", service) }] },
            },
        },
    };
}

export interface ControllerRevisionOptions {
    /** The stateful set that owns it. */
    owner?: string;
    service?: string;
    revision?: number;
    tag?: string;
}

/** A controller revision of a stateful set, as `kubectl get controllerrevisions -o json` prints it. */
export function controllerRevision(name: string, options: ControllerRevisionOptions = {}): Record<string, unknown> {
    const service = options.service ?? "ledger";
    return {
        kind: "ControllerRevision",
        metadata: { name, ownerReferences: [{ kind: "StatefulSet", name: options.owner ?? service }] },
        revision: options.revision ?? 1,
        data: {
            spec: {
                template: { spec: { containers: [{ name: service, image: IMAGE(options.tag ?? "1.4.2", service) }] } },
            },
        },
    };
}

/** What `helm history -o json` prints: the latest revisions, oldest first. */
export const history = (...revisions: Array<{ revision: number; status?: string; description?: string }>): Reply => ({
    stdout: revisions.map((entry) => ({
        revision: entry.revision,
        updated: "2026-10-15T08:00:00.000000000Z",
        status: entry.status ?? "superseded",
        chart: "orders-api-0.3.1",
        app_version: "1.4.2",
        description: entry.description ?? "Upgrade complete",
    })),
});

/** What `helm get values --all -o json` prints for a revision that ran `tag`, or for a chart that takes no image tag. */
export const values = (tag?: string | number): Reply => ({
    stdout:
        tag === undefined
            ? { replicaCount: 2 }
            : { replicaCount: 2, image: { repository: "registry.example.test/shop/orders-api", tag } },
});
