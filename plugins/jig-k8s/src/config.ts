// The `k8s` section of jig.json: the services the tool can read, and where each one runs in each environment (the
// kubectl context, the namespace and the pod selector). jig-core checks the section with validateK8s when a session
// starts, so the rest of the plugin reads settings that are valid.
//
// A call never names a context or a namespace. It names a service and an environment, and this table says where that is,
// so nothing outside the table can be reached through the tool.
import { InputError, isObject, shortList, shown } from "./values.ts";

/** One service in one environment: everything kubectl needs to find its pods. */
export interface Target {
    service: string;
    /** The environment's name in this section and in a call. */
    environment: string;
    /** The jig-core environment that rules and masking know it by. A name jig-core does not know counts as production. */
    jigEnvironment: string;
    context: string;
    namespace: string;
    /** An equality selector for the service's pods, such as `app=orders-api`. */
    selector: string;
    /** The same selector as pairs, for matching the workloads that own the pods. */
    labels: ReadonlyArray<readonly [key: string, value: string]>;
    /** The container `api` calls into, and the one `logs` reads when a call names none. */
    container?: string;
    /** The port `api` calls, inside the pod. */
    port?: number;
}

export interface K8sSettings {
    /** By service name, then by environment name. Maps, so that a name such as `constructor` is only ever a name. */
    services: ReadonlyMap<string, ReadonlyMap<string, Target>>;
}

const SECTION_FIELDS: ReadonlySet<string> = new Set(["services", "environments"]);
const ENTRY_FIELDS: ReadonlySet<string> = new Set(["context", "namespace", "selector", "container", "port"]);

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** A kubeconfig context name. Cloud contexts can be long and hold `:` and `/` (an ARN), but none starts with `-`, which
 *  kubectl would read as a flag. */
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,252}$/;
/** What Kubernetes calls a DNS label: namespace and container names. */
export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** What it calls a DNS subdomain: pod names. Neither starts with `-`, so neither can be read as a flag. */
export const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_PAIR = /^([A-Za-z0-9][A-Za-z0-9._/-]{0,252})=([A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const MAX_SERVICES = 100;
const MAX_ENVIRONMENTS = 20;
const MAX_LABELS = 10;

const NOT_SET_UP = 'k8s is not set up: add a "k8s" section with "services" to jig.json (/jig lists configuration problems)';

export function notSetUp(): InputError {
    return new InputError(NOT_SET_UP);
}

function checkPattern(value: unknown, pattern: RegExp, key: string, what: string, errors: string[]): string | undefined {
    if (value === undefined) {
        errors.push(`${key}: required, ${what}`);
        return undefined;
    }
    if (typeof value === "string" && pattern.test(value)) return value;
    errors.push(`${key}: must be ${what}`);
    return undefined;
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

function checkSelector(value: unknown, key: string, errors: string[]): { text: string; labels: Array<[string, string]> } | undefined {
    if (value === undefined) {
        errors.push(`${key}: required, a label selector for the pods, such as app=orders-api`);
        return undefined;
    }
    const labels = typeof value === "string" ? labelsOf(value) : undefined;
    if (typeof value === "string" && labels !== undefined) return { text: value, labels };
    errors.push(`${key}: must be 1 to ${MAX_LABELS} comma-separated key=value pairs, such as app=orders-api (equality only)`);
    return undefined;
}

function checkPort(value: unknown, key: string, errors: string[]): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
    errors.push(`${key}: must be a whole number from 1 to 65535`);
    return undefined;
}

type Entry = Omit<Target, "service" | "environment" | "jigEnvironment">;

function checkEntry(raw: unknown, at: string, errors: string[]): Entry | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with context, namespace and selector`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!ENTRY_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    const context = checkPattern(raw.context, CONTEXT, `${at}.context`, "a kubectl context name, such as prod-cluster", errors);
    const namespace = checkPattern(raw.namespace, DNS_LABEL, `${at}.namespace`, "a namespace name, such as orders", errors);
    const selector = checkSelector(raw.selector, `${at}.selector`, errors);
    const container = raw.container === undefined
        ? undefined
        : checkPattern(raw.container, DNS_LABEL, `${at}.container`, "a container name", errors);
    const port = raw.port === undefined ? undefined : checkPort(raw.port, `${at}.port`, errors);

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
    };
}

function checkEnvironments(raw: unknown, errors: string[]): Map<string, string> | undefined {
    const names = new Map<string, string>();
    if (raw === undefined) return names;
    if (!isObject(raw)) {
        errors.push("k8s.environments: must be an object that maps an environment name to a jig-core environment name");
        return undefined;
    }
    for (const [name, value] of Object.entries(raw)) {
        if (!ENVIRONMENT_NAME.test(name)) {
            errors.push(`k8s.environments: ${shown(name, 30)} is not a usable environment name (letters, digits, _ and -)`);
        } else if (typeof value !== "string" || !ENVIRONMENT_NAME.test(value)) {
            errors.push(`k8s.environments.${name}: must be the name of a jig-core environment, such as staging`);
        } else {
            names.set(name, value);
        }
    }
    return names;
}

function checkServices(raw: unknown, mapping: ReadonlyMap<string, string>, errors: string[]): K8sSettings["services"] | undefined {
    if (raw === undefined) {
        errors.push('k8s.services: required, an object that maps a service name to its environments');
        return undefined;
    }
    if (!isObject(raw)) {
        errors.push("k8s.services: must be an object that maps a service name to its environments");
        return undefined;
    }
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > MAX_SERVICES) {
        errors.push(`k8s.services: must name 1 to ${MAX_SERVICES} services`);
        return undefined;
    }
    const services = new Map<string, ReadonlyMap<string, Target>>();
    for (const [service, rawEnvironments] of entries) {
        if (!SERVICE_NAME.test(service)) {
            errors.push(
                `k8s.services: ${shown(service, 30)} is not a usable service name ` +
                    "(1 to 40 letters, digits, . _ -, starting with a letter or digit)",
            );
            continue;
        }
        const at = `k8s.services.${service}`;
        if (!isObject(rawEnvironments) || Object.keys(rawEnvironments).length === 0) {
            errors.push(`${at}: must be an object that maps an environment name to { context, namespace, selector }`);
            continue;
        }
        const targets = new Map<string, Target>();
        const environments = Object.entries(rawEnvironments);
        if (environments.length > MAX_ENVIRONMENTS) {
            errors.push(`${at}: at most ${MAX_ENVIRONMENTS} environments`);
            continue;
        }
        for (const [environment, rawEntry] of environments) {
            if (!ENVIRONMENT_NAME.test(environment)) {
                errors.push(`${at}: ${shown(environment, 30)} is not a usable environment name (letters, digits, _ and -)`);
                continue;
            }
            const entry = checkEntry(rawEntry, `${at}.${environment}`, errors);
            if (entry !== undefined) {
                targets.set(environment, {
                    service,
                    environment,
                    jigEnvironment: mapping.get(environment) ?? environment,
                    ...entry,
                });
            }
        }
        services.set(service, targets);
    }
    return services;
}

/**
 * Checks a raw `k8s` section and reads it. `errors` name their key; with any error there are no settings. A misspelt
 * field is an error and not a silent default: `namespce` would otherwise leave a service without its namespace.
 */
export function readK8s(raw: unknown): { settings?: K8sSettings; errors: string[] } {
    if (!isObject(raw)) return { errors: ["k8s: must be an object"] };
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (!SECTION_FIELDS.has(key)) errors.push(`k8s.${key}: unknown field`);
    const mapping = checkEnvironments(raw.environments, errors);
    const services = checkServices(raw.services, mapping ?? new Map(), errors);

    // A mapping for an environment no service has is a typo, and a typo would leave the real one on its own name.
    if (mapping !== undefined && services !== undefined) {
        const used = new Set([...services.values()].flatMap((targets) => [...targets.keys()]));
        for (const name of mapping.keys()) {
            if (!used.has(name)) errors.push(`k8s.environments.${name}: no service has an environment of this name`);
        }
    }
    if (errors.length > 0 || services === undefined) return { errors };
    return { errors, settings: { services } };
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateK8s(raw: unknown): string[] {
    return readK8s(raw).errors;
}

const parsed = new WeakMap<object, K8sSettings | undefined>();

/** The settings in a raw section, or undefined when it is absent or invalid. Read again only when the object changes. */
export function settingsOf(raw: unknown): K8sSettings | undefined {
    if (!isObject(raw)) return undefined;
    if (!parsed.has(raw)) parsed.set(raw, readK8s(raw).settings);
    return parsed.get(raw);
}

/** `orders-api (staging, production), billing (staging)`: what a message offers when a service name is wrong. */
export function describeServices(settings: K8sSettings): string {
    return shortList([...settings.services].map(([name, targets]) => `${name} (${shortList([...targets.keys()], 60)})`));
}

/**
 * The service and environment a call names. A name nobody configured is invalid input, and the message lists the ones
 * there are, because the model has no other way to learn them.
 */
export function findTarget(settings: K8sSettings, service: unknown, environment: unknown): Target {
    const environments = typeof service === "string" ? settings.services.get(service) : undefined;
    if (environments === undefined) {
        throw new InputError(`k8s: no service named ${shown(service, 30)}. Known services: ${describeServices(settings)}`);
    }
    const target = typeof environment === "string" ? environments.get(environment) : undefined;
    if (target === undefined) {
        throw new InputError(
            `k8s: ${service as string} has no environment ${shown(environment, 30)}. ` +
                `Known environments: ${shortList([...environments.keys()])}`,
        );
    }
    return target;
}
