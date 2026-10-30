// The parameters of the `deploy` tool, and the checks that turn them into a Call. The version is the only text of a
// call that can reach a command line, and it is checked here to be an image tag. parseCall does no I/O.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describeServices, findEnvironment, notSetUp } from "../catalog.ts";
import type { Catalog, Environment } from "../catalog.ts";
import type { Target } from "../runtime/kubernetes/config.ts";
import { InputError, shown } from "../values.ts";

export const ACTIONS = ["plan", "run", "status", "rollback", "watch"] as const;
export type Action = (typeof ACTIONS)[number];

export const DEFAULT_WATCH_MINUTES = 15;
export const MAX_WATCH_MINUTES = 120;

export const parameters = Type.Object(
    {
        action: StringEnum(ACTIONS, { description: "plan, run, status, rollback or watch" }),
        service: Type.String({
            description: "A service from the ops catalog. An unknown name is refused with the names there are",
        }),
        environment: Type.String({ description: "One of the service's environments, such as staging" }),
        version: Type.Optional(Type.String({
            description: "plan, run, watch: the image tag to deploy or to wait for, such as 1.4.3",
        })),
        timeoutMinutes: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: MAX_WATCH_MINUTES,
            description: `watch: minutes to watch, at most ${MAX_WATCH_MINUTES} (default ${DEFAULT_WATCH_MINUTES})`,
        })),
    },
    { additionalProperties: false },
);

/** One call, checked: what the tool will do, in a typed form. */
export type Call =
    | { action: "plan"; env: Environment; target: Target; version: string }
    | { action: "run"; env: Environment; target: Target; version: string }
    | { action: "status"; env: Environment; target: Target }
    | { action: "rollback"; env: Environment; target: Target }
    | { action: "watch"; env: Environment; target: Target; version: string; timeoutMinutes: number };

/** The parameters each action takes besides `service` and `environment`. A parameter of another action is refused, so a
 *  call cannot ask for something the action would ignore. */
const TAKES: Readonly<Record<Action, { required: readonly string[]; optional: readonly string[] }>> = {
    plan: { required: ["version"], optional: [] },
    run: { required: ["version"], optional: [] },
    status: { required: [], optional: [] },
    rollback: { required: [], optional: [] },
    watch: { required: ["version"], optional: ["timeoutMinutes"] },
};

const USAGE = "Usage: deploy {action, service, environment, ...} with action plan, run, status, rollback or watch";

/** Ends every error about the shape of a call, so the model can correct it at once. */
export function usage(action: Action): string {
    const { required, optional } = TAKES[action];
    const names = ["service", "environment", ...required, ...optional.map((name) => `${name}?`)];
    return `Usage: deploy ${action} {${names.join(", ")}}`;
}

/**
 * An image tag, by the grammar of the registries: 1 to 128 letters, digits, `_`, `.` and `-`, not starting with `.` or
 * `-`. This is stricter than what `runtime rollout` accepts to wait for, because this is written into a cluster: it is
 * never something kubectl or helm could read as a flag, and never a digest or a second image.
 */
export const VERSION = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function fail(action: Action, message: string): never {
    throw new InputError(`deploy ${action}: ${message}`);
}

function checkAction(value: unknown): Action {
    if (!present(value)) throw new InputError(`deploy needs action: ${ACTIONS.join(", ")}. ${USAGE}`);
    if (typeof value === "string" && (ACTIONS as readonly string[]).includes(value)) return value as Action;
    throw new InputError(`deploy: action must be one of ${ACTIONS.join(", ")} (got ${shown(value)}). ${USAGE}`);
}

function checkVersion(action: Action, value: unknown): string {
    if (typeof value === "string" && VERSION.test(value)) return value;
    return fail(
        action,
        "version must be an image tag of 1 to 128 characters (letters, digits, . _ -, not starting with . or -) " +
            `(got ${shown(value)})`,
    );
}

function checkMinutes(action: Action, value: unknown): number {
    if (!present(value)) return DEFAULT_WATCH_MINUTES;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_WATCH_MINUTES) {
        fail(action, `timeoutMinutes must be a whole number from 1 to ${MAX_WATCH_MINUTES} (got ${shown(value)})`);
    }
    return value;
}

/**
 * The Kubernetes runtime is where a rollout is read. An environment without one has nothing to plan, watch or run in.
 */
function kubernetesOf(action: Action, env: Environment): Target {
    if (env.kubernetes === undefined) {
        fail(
            action,
            `${env.service} in ${env.name} has no Kubernetes runtime in the catalog, so there is no rollout to read`,
        );
    }
    return env.kubernetes;
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
    if (extra.length > 0) throw new InputError(`deploy ${action} does not use ${extra.join(", ")}. ${usage(action)}`);
    const missing = ["service", "environment", ...required].filter((name) => !present(input[name]));
    if (missing.length > 0) {
        const services = missing.includes("service") ? ` Known services: ${describeServices(catalog)}.` : "";
        throw new InputError(`deploy ${action} needs ${missing.join(", ")}.${services} ${usage(action)}`);
    }

    const env = findEnvironment(catalog, "deploy", input.service, input.environment);
    const target = kubernetesOf(action, env);
    switch (action) {
        case "plan":
        case "run":
            return { action, env, target, version: checkVersion(action, input.version) };
        case "status":
        case "rollback":
            return { action, env, target };
        case "watch": {
            const version = checkVersion(action, input.version);
            return { action, env, target, version, timeoutMinutes: checkMinutes(action, input.timeoutMinutes) };
        }
    }
}
