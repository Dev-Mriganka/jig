// The parameters of the `runtime` tool, and the checks that turn them into a Call. Everything that reaches kubectl or
// the network has passed through parseCall: the service and the environment are the catalog's, and every other value
// has a known shape and size. parseCall does no I/O.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describeServices, findEnvironment, notSetUp } from "../catalog.ts";
import type { Catalog, Environment } from "../catalog.ts";
import { InputError, shown } from "../values.ts";
import { DNS_LABEL, DNS_SUBDOMAIN } from "./kubernetes/config.ts";
import type { Target } from "./kubernetes/config.ts";

export const ACTIONS = ["pods", "rollout", "logs", "events", "health"] as const;
export type Action = (typeof ACTIONS)[number];

export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 2000;
export const MAX_SINCE_SECONDS = 86_400;
export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 600;

export const parameters = Type.Object(
    {
        action: StringEnum(ACTIONS, { description: "pods, rollout, logs, events or health" }),
        service: Type.String({
            description: "A service from the ops catalog. An unknown name is refused with the names there are",
        }),
        environment: Type.String({ description: "One of the service's environments, such as staging" }),
        waitFor: Type.Optional(Type.String({
            description: "rollout: wait until every pod is ready on this image tag or version, as pods shows it",
        })),
        timeoutSec: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: MAX_WAIT_SECONDS,
            description:
                `rollout with waitFor: seconds to wait, at most ${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS})`,
        })),
        pod: Type.Optional(Type.String({
            description: "logs: a pod of the service, as pods shows it. Default: the first ready pod",
        })),
        container: Type.Optional(Type.String({
            description: "logs: a container of the pod. Default: the service's own container",
        })),
        tail: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: MAX_TAIL,
            description: `logs: lines from the end (default ${DEFAULT_TAIL})`,
        })),
        sinceSeconds: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: MAX_SINCE_SECONDS,
            description: "logs: only lines from the last this many seconds",
        })),
        previous: Type.Optional(Type.Boolean({
            description: "logs: the log of the container's previous run, after a crash",
        })),
    },
    { additionalProperties: false },
);

/** How a health check is made: a GET on the environment's https address, or curl inside one of its pods. */
export type HealthHow = { kind: "url"; url: string } | { kind: "pod"; target: Target };

/** One call, checked: what the tool will do, in a typed form. */
export type Call =
    | { action: "pods"; env: Environment; target: Target }
    | { action: "rollout"; env: Environment; target: Target; waitFor: string | undefined; timeoutSec: number }
    | {
        action: "logs";
        env: Environment;
        target: Target;
        pod: string | undefined;
        container: string | undefined;
        tail: number;
        sinceSeconds: number | undefined;
        previous: boolean;
    }
    | { action: "events"; env: Environment; target: Target }
    | { action: "health"; env: Environment; how: HealthHow };

/** The parameters each action takes besides `service` and `environment`. A parameter of another action is refused, so a
 *  call cannot ask for something the action would ignore. */
const TAKES: Readonly<Record<Action, { required: readonly string[]; optional: readonly string[] }>> = {
    pods: { required: [], optional: [] },
    rollout: { required: [], optional: ["waitFor", "timeoutSec"] },
    logs: { required: [], optional: ["pod", "container", "tail", "sinceSeconds", "previous"] },
    events: { required: [], optional: [] },
    health: { required: [], optional: [] },
};

const USAGE = "Usage: runtime {action, service, environment, ...} with action pods, rollout, logs, events or health";

/** Ends every error about the shape of a call, so the model can correct it at once. */
export function usage(action: Action): string {
    const { required, optional } = TAKES[action];
    const names = ["service", "environment", ...required, ...optional.map((name) => `${name}?`)];
    return `Usage: runtime ${action} {${names.join(", ")}}`;
}

const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$/;

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function fail(action: Action, message: string): never {
    throw new InputError(`runtime ${action}: ${message}`);
}

function checkAction(value: unknown): Action {
    if (!present(value)) throw new InputError(`runtime needs action: ${ACTIONS.join(", ")}. ${USAGE}`);
    if (typeof value === "string" && (ACTIONS as readonly string[]).includes(value)) return value as Action;
    throw new InputError(`runtime: action must be one of ${ACTIONS.join(", ")} (got ${shown(value)}). ${USAGE}`);
}

function integer(action: Action, value: unknown, name: string, min: number, max: number): number | undefined {
    if (!present(value)) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
        fail(action, `${name} must be a whole number from ${min} to ${max} (got ${shown(value)})`);
    }
    return value;
}

function text(action: Action, value: unknown, name: string, pattern: RegExp, what: string): string | undefined {
    if (!present(value)) return undefined;
    if (typeof value !== "string" || !pattern.test(value)) {
        fail(action, `${name} must be ${what} (got ${shown(value)})`);
    }
    return value;
}

/** The Kubernetes runtime of an environment, for the actions that read the cluster. */
function kubernetesOf(action: Action, env: Environment): Target {
    if (env.kubernetes === undefined) {
        // The catalog needs a runtime for a deploy method, so an environment without one has a health address only.
        fail(
            action,
            `${env.service} in ${env.name} has no Kubernetes runtime in the catalog (it has a health address only)`,
        );
    }
    return env.kubernetes;
}

/**
 * How `health` checks an environment: its https address when it has one, otherwise
 * curl inside a pod when its Kubernetes runtime names a health path. Whether curl
 * in a pod is allowed is for the tool to decide, from the kind of environment.
 */
function healthHow(env: Environment): HealthHow {
    if (env.health !== undefined) return { kind: "url", url: env.health };
    if (env.kubernetes?.healthPath !== undefined) return { kind: "pod", target: env.kubernetes };
    return fail(
        "health",
        `${env.service} in ${env.name} has no health check in the catalog. Add "health" (an https address), ` +
            "or healthPath, port and container to its Kubernetes runtime",
    );
}

/**
 * Checks a call and returns it in a typed form. Every problem is an InputError, a `TypeError` that says what to change,
 * with the usage line when the shape is wrong, so the model can correct the call at once.
 */
export function parseCall(input: Readonly<Record<string, unknown>>, catalog: Catalog | undefined): Call {
    if (catalog === undefined) throw notSetUp();
    const action = checkAction(input.action);
    const { required, optional } = TAKES[action];

    const known = new Set(["action", "service", "environment", ...required, ...optional]);
    const extra = Object.keys(input).filter((name) => present(input[name]) && !known.has(name));
    if (extra.length > 0) throw new InputError(`runtime ${action} does not use ${extra.join(", ")}. ${usage(action)}`);
    const missing = ["service", "environment", ...required].filter((name) => !present(input[name]));
    if (missing.length > 0) {
        const services = missing.includes("service") ? ` Known services: ${describeServices(catalog)}.` : "";
        throw new InputError(`runtime ${action} needs ${missing.join(", ")}.${services} ${usage(action)}`);
    }

    const env = findEnvironment(catalog, "runtime", input.service, input.environment);
    switch (action) {
        case "pods":
            return { action, env, target: kubernetesOf(action, env) };
        case "events":
            return { action, env, target: kubernetesOf(action, env) };
        case "health":
            return { action, env, how: healthHow(env) };
        case "rollout": {
            const target = kubernetesOf(action, env);
            const waitFor = text(action, input.waitFor, "waitFor", IMAGE_TAG, "an image tag or version, such as 1.4.2");
            const timeoutSec = integer(action, input.timeoutSec, "timeoutSec", 1, MAX_WAIT_SECONDS);
            if (waitFor === undefined && timeoutSec !== undefined) fail(action, "timeoutSec is used only with waitFor");
            return { action, env, target, waitFor, timeoutSec: timeoutSec ?? DEFAULT_WAIT_SECONDS };
        }
        case "logs": {
            const target = kubernetesOf(action, env);
            const previous = input.previous;
            if (present(previous) && typeof previous !== "boolean") {
                fail(action, `previous must be true or false (got ${shown(previous)})`);
            }
            return {
                action,
                env,
                target,
                pod: text(action, input.pod, "pod", DNS_SUBDOMAIN, "a pod name, as pods shows it"),
                container: text(action, input.container, "container", DNS_LABEL, "a container name"),
                tail: integer(action, input.tail, "tail", 1, MAX_TAIL) ?? DEFAULT_TAIL,
                sinceSeconds: integer(action, input.sinceSeconds, "sinceSeconds", 1, MAX_SINCE_SECONDS),
                previous: previous === true,
            };
        }
    }
}
