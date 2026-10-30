// The Kubernetes runtime of one environment in the service catalog: the kubectl context, the namespace and the pod
// selector, and for a health check inside a pod the container, the port and the path. The catalog (../../catalog.ts)
// finds this object under `runtime.kubernetes` and hands it to checkKubernetes, so every other module of the adapter
// reads a Target that is valid.
//
// A call never names a context or a namespace. It names a service and an environment, and the catalog says where that
// is, so nothing outside the catalog can be reached through the tools.
import { checkPattern, isObject } from "../../values.ts";

/** One service in one environment: everything kubectl and helm need to find its pods. */
export interface Target {
    service: string;
    /** The environment's name in the catalog. It is also the name that jig-core knows the environment by. */
    environment: string;
    context: string;
    namespace: string;
    /** An equality selector for the service's pods, such as `app=orders-api`. */
    selector: string;
    /** The same selector as pairs, for matching the workloads that own the pods. */
    labels: ReadonlyArray<readonly [key: string, value: string]>;
    /** The service's own container: the one `logs` reads when a call names none, the one whose image tag is the
     *  version, and the one a health check runs curl in. */
    container?: string;
    /** The port a health check calls, inside the pod. Set together with healthPath. */
    port?: number;
    /** The path, and the query if any, of the health GET inside the pod, such as `/actuator/health`. */
    healthPath?: string;
}

/** What the catalog holds under `runtime.kubernetes`. */
export type KubernetesEntry = Omit<Target, "service" | "environment">;

const ENTRY_FIELDS: ReadonlySet<string> = new Set([
    "context",
    "namespace",
    "selector",
    "container",
    "port",
    "healthPath",
]);

/** A kubeconfig context name. Cloud contexts can be long and hold `:` and `/` (an ARN), but none starts with `-`, which
 *  kubectl would read as a flag. */
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,252}$/;
/** What Kubernetes calls a DNS label: namespace and container names. */
export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** What it calls a DNS subdomain: pod names. Neither starts with `-`, so neither can be read as a flag. */
export const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_PAIR = /^([A-Za-z0-9][A-Za-z0-9._/-]{0,252})=([A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const MAX_LABELS = 10;

/**
 * The characters a health path and its query may hold. No `[
 * ] { }` (curl would read them as a pattern), no `#`, no `\`.
 */
const CHARS = "A-Za-z0-9._~/!$&'()*+,;=:@%-";
const PATH_AND_QUERY = new RegExp(`^/[${CHARS}]{0,400}(\\?[${CHARS}]{0,400})?$`);
/** How many times a path is percent-decoded when it is searched for "..". */
const MAX_DECODE_ROUNDS = 5;

/**
 * True when the text holds ".." once it is percent-decoded as far as it goes. A server or a proxy in front of it may
 * decode twice, so `%252e%252e` must not pass as a name. Text that is still changing after several rounds is refused
 * too.
 */
function climbs(path: string): boolean {
    let current = path;
    for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
        if (current.includes("..")) return true;
        const decoded = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        if (decoded === current) return false;
        current = decoded;
    }
    return true;
}

/** `app=orders-api,tier=web` as pairs, or undefined when the text is not that: equality only, so that what kubectl is
 *  given and what the workloads are matched with can never differ. */
function labelsOf(selector: string): Array<[string, string]> | undefined {
    const pairs: Array<[string, string]> = [];
    for (const part of selector.split(",")) {
        const match = LABEL_PAIR.exec(part);
        if (match === null) return undefined;
        pairs.push([match[1] as string, match[2] as string]);
    }
    return pairs.length <= MAX_LABELS ? pairs : undefined;
}

function checkSelector(
    value: unknown,
    key: string,
    errors: string[],
): { text: string; labels: Array<[string, string]> } | undefined {
    if (value === undefined) {
        errors.push(`${key}: required, a label selector for the pods, such as app=orders-api`);
        return undefined;
    }
    const labels = typeof value === "string" ? labelsOf(value) : undefined;
    if (typeof value === "string" && labels !== undefined) return { text: value, labels };
    errors.push(
        `${key}: must be 1 to ${MAX_LABELS} comma-separated key=value pairs, such as app=orders-api (equality only)`,
    );
    return undefined;
}

function checkPort(value: unknown, key: string, errors: string[]): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
    errors.push(`${key}: must be a whole number from 1 to 65535`);
    return undefined;
}

function checkHealthPath(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value === "string" && PATH_AND_QUERY.test(value) && !climbs(value)) return value;
    errors.push(
        `${key}: must start with / and hold only letters, digits and . _ ~ / ! $ & ' ( ) * + , ; = : @ % - ` +
            "(at most 400 characters, one optional ?query, no ..)",
    );
    return undefined;
}

/**
 * Checks the `runtime.kubernetes` object at `at` and returns it read, or undefined with the problems added to `errors`.
 * A misspelt field is an error and not a silent default: `namespce` would otherwise leave a service without its
 * namespace.
 */
export function checkKubernetes(raw: unknown, at: string, errors: string[]): KubernetesEntry | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with context, namespace and selector`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!ENTRY_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    const context = checkPattern(
        raw.context,
        CONTEXT,
        `${at}.context`,
        "a kubectl context name, such as prod-cluster",
        errors,
    );
    const namespace = checkPattern(
        raw.namespace,
        DNS_LABEL,
        `${at}.namespace`,
        "a namespace name, such as orders",
        errors,
    );
    const selector = checkSelector(raw.selector, `${at}.selector`, errors);
    const container = raw.container === undefined
        ? undefined
        : checkPattern(raw.container, DNS_LABEL, `${at}.container`, "a container name", errors);
    const port = raw.port === undefined ? undefined : checkPort(raw.port, `${at}.port`, errors);
    const healthPath = raw.healthPath === undefined
        ? undefined
        : checkHealthPath(raw.healthPath, `${at}.healthPath`, errors);

    // A health check inside a pod needs all three: the path to call, the port it listens on, and the container to run
    // curl in. One of them alone is a half-finished setting, and the check would never run.
    const inPod = raw.healthPath !== undefined || raw.port !== undefined;
    if (inPod) {
        if (raw.healthPath === undefined) {
            errors.push(`${at}.healthPath: required with port, the path of the health check`);
        }
        if (raw.port === undefined) {
            errors.push(`${at}.port: required with healthPath, the port the service listens on in the pod`);
        }
        if (raw.container === undefined) {
            errors.push(`${at}.container: required with healthPath and port, the container curl runs in`);
        }
    }

    if (errors.length > before || context === undefined || namespace === undefined || selector === undefined) {
        return undefined;
    }
    return {
        context,
        namespace,
        selector: selector.text,
        labels: selector.labels,
        ...(container === undefined ? {} : { container }),
        ...(port === undefined ? {} : { port }),
        ...(healthPath === undefined ? {} : { healthPath }),
    };
}
