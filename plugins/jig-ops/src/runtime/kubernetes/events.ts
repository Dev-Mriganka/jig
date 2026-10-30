// `events`: what the cluster recently said about the service, such as a pod that could not be scheduled, an image that
// could not be pulled or a container that was killed for its memory. The cluster keeps its events per namespace, so the
// namespace's events are read and only those about the service's own objects are kept: its pods, its deployments and
// statefulsets, and the replica sets a deployment makes (where "could not create pod" is said).
import { clean, isObject, objects, oneLine, plural, str } from "../../values.ts";
import type { Outcome } from "../../values.ts";
import { getJson } from "./kubectl.ts";
import type { Kube } from "./kubectl.ts";
import { age, listPods } from "./pods.ts";
import { listWorkloads, owns } from "./rollout.ts";

/** How many events are shown: the latest ones. */
export const MAX_EVENTS = 30;

interface Event {
    /** `Pod/orders-api-0`. */
    about: string;
    type: string;
    reason: string;
    message: string;
    count: number;
    at: number | undefined;
}

/**
 * The time an event last happened. The core API and the events API each keep it in a different field, and in the events
 * API `eventTime` is the first time of an event that has a series, so the series' last time comes before it.
 */
function timeOf(raw: Record<string, unknown>): number | undefined {
    const series = isObject(raw.series) ? str(raw.series.lastObservedTime) : undefined;
    const metadata = isObject(raw.metadata) ? str(raw.metadata.creationTimestamp) : undefined;
    for (const text of [str(raw.lastTimestamp), series, str(raw.eventTime), str(raw.firstTimestamp), metadata]) {
        const time = Date.parse(text ?? "");
        if (Number.isFinite(time)) return time;
    }
    return undefined;
}

function parseEvent(raw: Record<string, unknown>): Event | undefined {
    const object = isObject(raw.involvedObject) ? raw.involvedObject : {};
    const kind = str(object.kind);
    const name = str(object.name);
    if (kind === undefined || name === undefined) return undefined;
    const count = typeof raw.count === "number" && raw.count > 1 ? raw.count : 1;
    return {
        about: `${kind}/${name}`,
        type: str(raw.type) ?? "Normal",
        reason: str(raw.reason) ?? "Unknown",
        message: oneLine(clean(str(raw.message) ?? ""), 300),
        count,
        at: timeOf(raw),
    };
}

/** `Kind/name` of the replica sets in the namespace that run the target's pods. */
function replicaSetsOf(raw: unknown, target: Kube["target"]): string[] {
    return objects(isObject(raw) ? raw.items : undefined)
        .filter((item) => owns(item, target))
        .flatMap((item) => {
            const name = isObject(item.metadata) ? str(item.metadata.name) : undefined;
            return name === undefined ? [] : [`ReplicaSet/${name}`];
        });
}

function line(event: Event, now: number): string {
    const when = event.at === undefined ? "?" : `${age(event.at, now)} ago`;
    const times = event.count > 1 ? ` (x${event.count})` : "";
    return `- ${when} ${event.type} ${event.reason} ${event.about}: ${event.message}${times}`;
}

export async function eventsAction(kube: Kube, now: number): Promise<Outcome> {
    const { target } = kube;
    const where = `${target.service} in ${target.environment} (namespace ${target.namespace})`;

    // The objects first, then the events, one read after the other so that a test sees a fixed order.
    const pods = await listPods(kube);
    const workloads = await listWorkloads(kube);
    const replicaSets = replicaSetsOf(await getJson(kube, "replicasets"), target);
    const mine = new Set([
        ...pods.map((pod) => `Pod/${pod.name}`),
        ...workloads.map((workload) => `${workload.kind}/${workload.name}`),
        ...replicaSets,
    ]);
    const raw = await getJson(kube, "events", [], "the namespace has too many events to read");

    const found = objects(isObject(raw) ? raw.items : undefined)
        .map(parseEvent)
        .filter((event): event is Event => event !== undefined && mine.has(event.about))
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (found.length === 0) {
        return {
            text:
                `No recent events about the pods and workloads of ${where}. ` +
                "The cluster keeps events for about an hour.",
            facts: { events: 0, warnings: 0 },
            details: { events: 0 },
        };
    }

    const shown = found.slice(-MAX_EVENTS);
    const warnings = shown.filter((event) => event.type === "Warning").length;
    const of = found.length > shown.length ? ` of ${found.length}` : "";
    const head = `${plural(shown.length, "event")}${of} about ${where}, oldest first, ${plural(warnings, "warning")}:`;
    return {
        text: [head, ...shown.map((event) => line(event, now))].join("\n"),
        facts: { events: shown.length, warnings },
        details: { events: shown.length, warnings, total: found.length },
    };
}
