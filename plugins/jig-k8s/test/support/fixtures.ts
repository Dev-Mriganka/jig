// Kubernetes fixtures: pod and workload JSON as `kubectl get -o json` prints it. The names are made up.
import type { Reply } from "./fake-kubectl.ts";

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
    const containers: Array<Record<string, unknown>> = [{ name: service, image: options.image ?? IMAGE(options.tag ?? "1.4.2", service) }];
    const statuses: Array<Record<string, unknown>> = [{
        name: service,
        ready,
        restartCount: options.restarts ?? 0,
        state: options.waiting
            ? { waiting: { reason: options.waiting } }
            : options.terminated
                ? { terminated: options.terminated }
                : { running: {} },
    }];
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
                ? { initContainerStatuses: [{ name: "init", ready: false, state: { waiting: { reason: options.initWaiting } } }] }
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
