// The parameters of the `k8s` tool, and the checks that turn them into a Call. Everything that reaches kubectl has passed
// through parseCall: the service and the environment are configured ones, and every other value has a known shape and
// size. parseCall does no I/O.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DNS_LABEL, DNS_SUBDOMAIN, describeServices, findTarget, notSetUp } from "./config.ts";
import type { K8sSettings, Target } from "./config.ts";
import { InputError, shortList, shown } from "./values.ts";

export const ACTIONS = ["pods", "status", "logs", "api"] as const;
export type Action = (typeof ACTIONS)[number];

export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 2000;
export const MAX_SINCE_SECONDS = 86_400;
export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 600;

export const parameters = Type.Object(
    {
        action: StringEnum(ACTIONS, { description: "pods, status, logs or api" }),
        service: Type.String({ description: "A configured service. An unknown name is refused with the names there are" }),
        environment: Type.String({ description: "One of the service's environments, such as staging" }),
        waitFor: Type.Optional(Type.String({
            description: "status: wait until every pod is ready on this image tag or version, as pods shows it",
        })),
        timeoutSec: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: MAX_WAIT_SECONDS,
            description: `status with waitFor: seconds to wait, at most ${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS})`,
        })),
        pod: Type.Optional(Type.String({ description: "logs: a pod of the service, as pods shows it. Default: the first ready pod" })),
        container: Type.Optional(Type.String({ description: "logs: a container of the pod. Default: the service's own container" })),
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
        previous: Type.Optional(Type.Boolean({ description: "logs: the log of the container's previous run, after a crash" })),
        path: Type.Optional(Type.String({
            description: "api, test environments only: starts with /, at most one ?query, no ..",
        })),
    },
    { additionalProperties: false },
);

/** One call, checked: what the tool will do, in a typed form. */
export type Call =
    | { action: "pods"; target: Target }
    | { action: "status"; target: Target; waitFor: string | undefined; timeoutSec: number }
    | {
        action: "logs";
        target: Target;
        pod: string | undefined;
        container: string | undefined;
        tail: number;
        sinceSeconds: number | undefined;
        previous: boolean;
    }
    | { action: "api"; target: Target; container: string; port: number; path: string; query: string };

/** The parameters each action takes besides `service` and `environment`. A parameter of another action is refused,
 *  so a call cannot ask for something the action would ignore. */
const TAKES: Readonly<Record<Action, { required: readonly string[]; optional: readonly string[] }>> = {
    pods: { required: [], optional: [] },
    status: { required: [], optional: ["waitFor", "timeoutSec"] },
    logs: { required: [], optional: ["pod", "container", "tail", "sinceSeconds", "previous"] },
    api: { required: ["path"], optional: [] },
};

const USAGE = "Usage: k8s {action, service, environment, ...} with action pods, status, logs or api";

/** Ends every error about the shape of a call, so the model can correct it at once. */
export function usage(action: Action): string {
    const { required, optional } = TAKES[action];
    const names = ["service", "environment", ...required, ...optional.map((name) => `${name}?`)];
    return `Usage: k8s ${action} {${names.join(", ")}}`;
}

/** jig-core always treats this environment name as production. Whether any other name is production is jig-core's to
 *  say, and the plugin hears it per call (see decisions.ts). */
export const PRODUCTION = "production";

/** The characters a path and a query may hold. No `[ ] { }` (curl would read them as a pattern), no `#`, no `\`. */
const CHARS = "A-Za-z0-9._~/!$&'()*+,;=:@%-";
const PATH_AND_QUERY = new RegExp(`^(/[${CHARS}]{0,400})(\\?[${CHARS}]{0,400})?$`);
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$/;

/** How many times a path is percent-decoded when it is searched for "..". */
const MAX_DECODE_ROUNDS = 5;

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function fail(action: Action, message: string): never {
    throw new InputError(`k8s ${action}: ${message}`);
}

function checkAction(value: unknown): Action {
    if (!present(value)) throw new InputError(`k8s needs action: ${ACTIONS.join(", ")}. ${USAGE}`);
    if (typeof value === "string" && (ACTIONS as readonly string[]).includes(value)) return value as Action;
    throw new InputError(`k8s: action must be one of ${ACTIONS.join(", ")} (got ${shown(value)}). ${USAGE}`);
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
    if (typeof value !== "string" || !pattern.test(value)) fail(action, `${name} must be ${what} (got ${shown(value)})`);
    return value;
}

/**
 * True when the text holds ".." once it is percent-decoded as far as it goes. A server or a proxy in front of it may
 * decode twice, so `%252e%252e` must not pass as a name. Text that is still changing after several rounds is refused too.
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

function checkPath(path: unknown): { path: string; query: string } {
    const match = typeof path === "string" ? PATH_AND_QUERY.exec(path) : null;
    if (typeof path !== "string" || match === null || climbs(path)) {
        fail(
            "api",
            "path must start with / and hold only letters, digits and . _ ~ / ! $ & ' ( ) * + , ; = : @ % - " +
                `(at most 400 characters, one optional ?query, no ..) (got ${shown(path)})`,
        );
    }
    return { path: match?.[1] ?? "", query: match?.[2] ?? "" };
}

/** `api` never runs where the name already says production. The names jig-core calls production beyond this one are
 *  checked when the call runs, from jig-core's own decision. */
function productionRefusal(settings: K8sSettings, target: Target): InputError {
    const open = [...(settings.services.get(target.service)?.values() ?? [])]
        .filter((other) => other.jigEnvironment !== PRODUCTION && other.container !== undefined && other.port !== undefined)
        .map((other) => other.environment);
    const instead = open.length === 0 ? "" : `; ${target.service} has it in ${shortList(open, 60)}`;
    return new InputError(
        `k8s api is refused in production (${target.service} in ${target.environment}): it runs in test environments only${instead}`,
    );
}

/**
 * Checks a call and returns it in a typed form. Every problem is an InputError, a `TypeError` that says what to change,
 * with the usage line when the shape is wrong, so the model can correct the call at once.
 */
export function parseCall(input: Readonly<Record<string, unknown>>, settings: K8sSettings | undefined): Call {
    if (settings === undefined) throw notSetUp();
    const action = checkAction(input.action);
    const { required, optional } = TAKES[action];

    const known = new Set(["action", "service", "environment", ...required, ...optional]);
    const extra = Object.keys(input).filter((name) => present(input[name]) && !known.has(name));
    if (extra.length > 0) throw new InputError(`k8s ${action} does not use ${extra.join(", ")}. ${usage(action)}`);
    const missing = ["service", "environment", ...required].filter((name) => !present(input[name]));
    if (missing.length > 0) {
        const services = missing.includes("service") ? ` Known services: ${describeServices(settings)}.` : "";
        throw new InputError(`k8s ${action} needs ${missing.join(", ")}.${services} ${usage(action)}`);
    }

    const target = findTarget(settings, input.service, input.environment);
    switch (action) {
        case "pods":
            return { action, target };
        case "status": {
            const waitFor = text(action, input.waitFor, "waitFor", IMAGE_TAG, "an image tag or version, such as 1.4.2");
            const timeoutSec = integer(action, input.timeoutSec, "timeoutSec", 1, MAX_WAIT_SECONDS);
            if (waitFor === undefined && timeoutSec !== undefined) fail(action, "timeoutSec is used only with waitFor");
            return { action, target, waitFor, timeoutSec: timeoutSec ?? DEFAULT_WAIT_SECONDS };
        }
        case "logs": {
            const previous = input.previous;
            if (present(previous) && typeof previous !== "boolean") fail(action, `previous must be true or false (got ${shown(previous)})`);
            return {
                action,
                target,
                pod: text(action, input.pod, "pod", DNS_SUBDOMAIN, "a pod name, as pods shows it"),
                container: text(action, input.container, "container", DNS_LABEL, "a container name"),
                tail: integer(action, input.tail, "tail", 1, MAX_TAIL) ?? DEFAULT_TAIL,
                sinceSeconds: integer(action, input.sinceSeconds, "sinceSeconds", 1, MAX_SINCE_SECONDS),
                previous: previous === true,
            };
        }
        case "api": {
            if (target.jigEnvironment === PRODUCTION) throw productionRefusal(settings, target);
            if (target.container === undefined || target.port === undefined) {
                fail(
                    action,
                    `not set up for ${target.service} in ${target.environment}: ` +
                        'add "container" and "port" to its entry in the k8s section of jig.json',
                );
            }
            return { action, target, container: target.container, port: target.port, ...checkPath(input.path) };
        }
    }
}
