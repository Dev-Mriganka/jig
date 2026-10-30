// The parameters of the `api` tool. One flat object, because several model providers reject a top-level union. ACTIONS says
// which parameters each action takes; the schema's action list, the usage lines in errors and the checks in parseCall all
// come from it, so they cannot drift apart.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MAX_TIMEOUT_SEC } from "./config.ts";
import { METHODS } from "./engine/plan.ts";
import { InputError, isObject, shown } from "./engine/values.ts";

export type Param =
    | "collection" | "folder" | "request" | "text" | "environment" | "variables" | "method" | "url" | "body" | "headers"
    | "timeoutSec";

interface ActionSpec {
    required: readonly Param[];
    optional: readonly Param[];
}

export const ACTIONS = {
    list: { required: [], optional: ["collection", "folder", "text"] },
    show: { required: ["request"], optional: ["collection", "folder", "environment"] },
    run: { required: ["request", "environment"], optional: ["collection", "folder", "variables", "timeoutSec"] },
    "run-folder": { required: ["folder", "environment"], optional: ["collection", "variables", "timeoutSec"] },
    call: { required: ["environment", "method", "url"], optional: ["collection", "body", "headers", "timeoutSec"] },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];

export function isAction(value: unknown): value is ActionName {
    return typeof value === "string" && Object.hasOwn(ACTIONS, value);
}

/** `Usage: api run {request, environment, collection?, ...}`; a parameter with `?` is optional. */
export function usage(action: ActionName): string {
    const { required, optional }: ActionSpec = ACTIONS[action];
    return `Usage: api ${action} {${[...required, ...optional.map((name) => `${name}?`)].join(", ")}}`;
}

/** The actions with the parameters each needs, for the schema: `list() show(request) ...`. */
function describeActions(): string {
    return ACTION_NAMES.map((name) => `${name}(${ACTIONS[name].required.join(",")})`).join(" ");
}

export const parameters = Type.Object({
    action: StringEnum(ACTION_NAMES, { description: `What to do. Needs: ${describeActions()}` }),
    collection: Type.Optional(Type.String({ description: "A collection's name, to narrow a request or folder, or to call as one" })),
    folder: Type.Optional(Type.String({ description: "A folder's path, such as Orders or Orders/Smoke, to narrow a request or to run" })),
    request: Type.Optional(Type.String({ description: "A saved request's name, from list" })),
    text: Type.Optional(Type.String({ description: "List only requests whose name, folder or address holds this text" })),
    environment: Type.Optional(Type.String({ description: "The collection's name for the environment, such as Staging" })),
    variables: Type.Optional(Type.Object({}, {
        additionalProperties: Type.String(),
        description: 'Values for the variables the request uses, such as {"orderId": "123"}. Never secrets or the host',
    })),
    method: Type.Optional(StringEnum(METHODS, { description: "call: GET, HEAD and OPTIONS read; the others write" })),
    url: Type.Optional(Type.String({ description: "call: the whole address, on a host of the environment" })),
    body: Type.Optional(Type.Unknown({ description: "call: a JSON body, at most 256 KiB. Not for GET" })),
    headers: Type.Optional(Type.Object({}, {
        additionalProperties: Type.String(),
        description: 'call: extra headers, at most 10, such as {"X-Request-Id": "t1"}. The tool adds the sign-in',
    })),
    timeoutSec: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_SEC,
        description: "Seconds to wait for the answer (default 30)",
    })),
});

export type Call =
    | { action: "list"; collection?: string; folder?: string; text?: string }
    | { action: "show"; request: string; collection?: string; folder?: string; environment?: string }
    | { action: "run"; request: string; environment: string; collection?: string; folder?: string; variables?: Record<string, unknown>; timeoutSec?: number }
    | { action: "run-folder"; folder: string; environment: string; collection?: string; variables?: Record<string, unknown>; timeoutSec?: number }
    | { action: "call"; environment: string; method: string; url: string; collection?: string; body?: unknown; headers?: unknown; timeoutSec?: unknown };

const TEXT_PARAMS: readonly Param[] = ["collection", "folder", "request", "text", "environment", "method", "url"];

const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Checks the shape of a call and returns it typed. Every problem is an InputError, a `TypeError` that says what to change,
 * with the usage line when the shape is wrong, so the model can correct the call at once. What a name refers to is checked
 * later, where the names are known.
 */
export function parseCall(input: Readonly<Record<string, unknown>>): Call {
    const action = input.action;
    if (!isAction(action)) {
        throw new InputError(`api: unknown action ${shown(action, 30)}; use one of ${ACTION_NAMES.join(", ")}`);
    }
    const spec: ActionSpec = ACTIONS[action];
    const accepted = new Set<string>(["action", ...spec.required, ...spec.optional]);
    const extra = Object.keys(input).filter((name) => present(input[name]) && !accepted.has(name));
    if (extra.length > 0) throw new InputError(`api ${action} does not use ${extra.join(", ")}. ${usage(action)}`);
    const missing = spec.required.filter((name) => !present(input[name]));
    if (missing.length > 0) throw new InputError(`api ${action} needs ${missing.join(", ")}. ${usage(action)}`);

    for (const name of TEXT_PARAMS) {
        if (present(input[name]) && typeof input[name] !== "string") throw new InputError(`api ${action}: ${name} must be text (got ${shown(input[name], 30)})`);
    }
    if (present(input.variables) && !isObject(input.variables)) {
        throw new InputError(`api ${action}: variables must be an object of name to value, such as {"orderId": "123"}`);
    }
    const copy: Record<string, unknown> = { action };
    for (const name of accepted) if (name !== "action" && present(input[name])) copy[name] = input[name];
    return copy as Call;
}
