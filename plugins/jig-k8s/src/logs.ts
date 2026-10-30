// `logs`: the last lines of one pod's log. The pod is the one the call names or the first Ready one, and it must be a
// pod of the service: the selector decides which pods the tool can reach, so a pod name cannot lead to another
// service's logs.
import type { Target } from "./config.ts";
import { cutMark, LOGS, readKubectl, wasCut } from "./kubectl.ts";
import type { Kube } from "./kubectl.ts";
import type { Call } from "./params.ts";
import { firstReady, listPods, ownContainers } from "./pods.ts";
import type { Pod } from "./pods.ts";
import { clean, linesOf, plural, shortList } from "./values.ts";
import type { Outcome } from "./values.ts";

const MIB = 1024 * 1024;

/** The pod a call reads: the named one, which must belong to the service, or else the first Ready one. */
function choosePod(pods: readonly Pod[], given: string | undefined, target: Target): Pod {
    if (given !== undefined) {
        const found = pods.find((pod) => pod.name === given);
        if (found !== undefined) return found;
        const offer = pods.length === 0 ? "it has no pods" : `use ${shortList(pods.map((pod) => pod.name), 120)}`;
        throw new Error(
            `${given} is not a pod of ${target.service} in ${target.environment} (${offer}). Run pods to see them`,
        );
    }
    const ready = firstReady(pods);
    if (ready === undefined) {
        throw new Error(
            `${target.service} has no ready pod in ${target.environment} to read logs from: ` +
                "run pods, then pass pod (with previous: true for a crashed container)",
        );
    }
    return ready;
}

/**
 * The container to read. One the call names must be in the pod (an init container too). Otherwise the service's own
 * container, when it can be told from the sidecars; when it cannot, none is named and kubectl takes its default.
 */
function chooseContainer(pod: Pod, given: string | undefined, target: Target): string | undefined {
    if (given !== undefined) {
        const names = [...pod.containers.map((container) => container.name), ...pod.initContainers];
        if (!names.includes(given)) {
            throw new Error(`${pod.name} has no container ${given} (it has ${shortList(names, 120)})`);
        }
        return given;
    }
    const own = ownContainers(pod.containers, target);
    return own.length < pod.containers.length || pod.containers.length === 1 ? own[0]?.name : undefined;
}

/** Who is read: the pod, and the container when one was chosen. When none was, a pod with several says so, so the model
 *  knows which names it can ask for. */
function whose(pod: Pod, container: string | undefined): string {
    if (container !== undefined) return `${pod.name} (container ${container})`;
    if (pod.containers.length <= 1) return pod.name;
    return `${pod.name} (kubectl chose the container; the pod has ${shortList(pod.containers.map((c) => c.name), 80)})`;
}

export async function logsAction(kube: Kube, call: Extract<Call, { action: "logs" }>): Promise<Outcome> {
    const pod = choosePod(await listPods(kube), call.pod, kube.target);
    const container = chooseContainer(pod, call.container, kube.target);
    const args = [
        pod.name,
        ...(container === undefined ? [] : ["-c", container]),
        `--tail=${call.tail}`,
        ...(call.sinceSeconds === undefined ? [] : [`--since=${call.sinceSeconds}s`]),
        ...(call.previous ? ["--previous"] : []),
    ];
    const stdout = await readKubectl(kube, "logs", args, LOGS);

    // A log longer than the limit was cut by jig-core, which marks the cut. The mark is not a line of the log.
    const cut = wasCut(stdout, LOGS.maxBytes);
    const lines = linesOf(clean(cut ? stdout.slice(0, stdout.length - cutMark(LOGS.maxBytes).length) : stdout));

    const window = [
        `tail ${call.tail}`,
        ...(call.sinceSeconds === undefined ? [] : [`last ${call.sinceSeconds} s`]),
        ...(call.previous ? ["previous run"] : []),
    ].join(", ");
    const cutNote = cut ? `, cut at ${LOGS.maxBytes / MIB} MiB` : "";
    const head = `${whose(pod, container)}: ${plural(lines.length, "line")} (${window})${cutNote}`;
    return {
        text: `${head}\n${lines.length === 0 ? "(no lines)" : lines.join("\n")}`,
        facts: { lines: lines.length, previous: call.previous, cut },
        details: { pod: pod.name, ...(container === undefined ? {} : { container }), lines: lines.length, cut },
    };
}
