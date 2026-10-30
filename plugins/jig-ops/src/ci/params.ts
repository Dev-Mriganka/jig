// The parameters of the `ci` tool, and the checks that turn them into a Call. Everything that reaches `gh` or the network
// has passed through parseCall: the service is the catalog's, which names the repository, the project or the job, and every
// other value has a known shape and size. parseCall does no I/O.
//
// What a call may carry depends on the action and on the CI system of the service, so the rows of the adapter's table are
// the check: a parameter the action does not take is refused, and so is an action the system does not have.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { findCiService, notSetUp } from "../catalog.ts";
import type { Catalog, CiService } from "../catalog.ts";
import { InputError, shortList, shown } from "../values.ts";
import { rowOf, usage, CI_ACTIONS, FINISHES } from "./adapter.ts";
import type { ActionRow, CiAction, CiSystemInfo, Params } from "./adapter.ts";
import { SYSTEMS } from "./adapters.ts";

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;
export const MAX_TAIL = 400;
export const DEFAULT_TAIL = 80;
export const MAX_PARAMETERS = 20;

export const parameters = Type.Object(
    {
        action: StringEnum(CI_ACTIONS, { description: "status, runs, run, log, rerun, trigger or watch" }),
        service: Type.String({
            description:
                "A service from the ops catalog that has a ci entry. An unknown name is refused with the ones there are",
        }),
        number: Type.Optional(Type.Integer({ minimum: 1, description: "A pull request number (GitHub Actions)." })),
        branch: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "A branch. Default: the default branch where there is one.",
            }),
        ),
        sha: Type.Optional(
            Type.String({ minLength: 4, maxLength: 64, description: "A commit. GitLab needs all 40 characters." }),
        ),
        run_id: Type.Optional(
            Type.Integer({
                minimum: 1,
                description: "A GitHub run, a GitLab pipeline or a Jenkins build number, as runs lists them.",
            }),
        ),
        required_only: Type.Optional(Type.Boolean({ description: "status: only the required checks or jobs." })),
        state: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 30,
                description: "runs: queued, in_progress, completed, success, failure ...",
            }),
        ),
        limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `runs: how many (default ${DEFAULT_LIMIT}).` }),
        ),
        job: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "log: a job name or id. Default: the first failed job.",
            }),
        ),
        tail: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_TAIL,
                description: `log: how many lines from the end (default ${DEFAULT_TAIL}).`,
            }),
        ),
        grep: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "log: only lines matching this regular expression.",
            }),
        ),
        failed_only: Type.Optional(
            Type.Boolean({ description: "rerun: only the failed jobs (default), or false for the whole run." }),
        ),
        ref: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "trigger: the branch or tag to run the pipeline on.",
            }),
        ),
        parameters: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
                description: `trigger: variables or build parameters, name to value (at most ${MAX_PARAMETERS}).`,
            }),
        ),
        finish: Type.Optional(
            StringEnum(FINISHES, {
                description:
                    "watch: when it ends. required (default), check (the one in check), run (run_id); GitHub also approved, merged, comment, tag, release.",
            }),
        ),
        check: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "watch: the name of the check, job or stage to wait for.",
            }),
        ),
        pattern: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 300,
                description: "watch: a regular expression for a comment, tag or release name.",
            }),
        ),
        bot: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 100,
                description: "watch: only comments by this login. Default: any bot.",
            }),
        ),
    },
    { additionalProperties: false },
);

/** One call, checked: what the tool will do, in a typed form. */
export interface Call {
    action: CiAction;
    service: CiService;
    info: CiSystemInfo;
    params: Params;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA = /^[0-9a-f]{4,64}$/i;
const STATE = /^[A-Za-z_]{1,30}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9[\]_.-]{0,99}$/;

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function fail(action: CiAction, message: string): never {
    throw new InputError(`ci ${action}: ${message}`);
}

function checkAction(value: unknown): CiAction {
    const USAGE = "Usage: ci {action, service, ...} with action status, runs, run, log, rerun, trigger or watch";
    if (!present(value)) throw new InputError(`ci needs action: ${CI_ACTIONS.join(", ")}. ${USAGE}`);
    if (typeof value === "string" && (CI_ACTIONS as readonly string[]).includes(value)) return value as CiAction;
    throw new InputError(`ci: action must be one of ${CI_ACTIONS.join(", ")} (got ${shown(value)}). ${USAGE}`);
}

function integer(action: CiAction, value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
        fail(action, `${name} must be a whole number from ${min} to ${max} (got ${shown(value)})`);
    }
    return value;
}

function text(action: CiAction, value: unknown, name: string, pattern: RegExp, what: string): string {
    if (typeof value !== "string" || !pattern.test(value))
        fail(action, `${name} must be ${what} (got ${shown(value)})`);
    return value;
}

function line(action: CiAction, value: unknown, name: string, max: number): string {
    if (typeof value !== "string" || value === "" || value.length > max || CONTROL.test(value)) {
        fail(action, `${name} must be one line of 1 to ${max} characters (got ${shown(value)})`);
    }
    return value;
}

function expression(action: CiAction, value: unknown, name: string, max: number): string {
    const source = line(action, value, name, max);
    try {
        new RegExp(source);
    } catch (error) {
        fail(action, `${name} is not a valid regular expression: ${(error as Error).message}`);
    }
    return source;
}

function flag(action: CiAction, value: unknown, name: string): boolean {
    if (typeof value !== "boolean") fail(action, `${name} must be true or false (got ${shown(value)})`);
    return value;
}

/** Variables or build parameters: a name and a one-line value each. They go to a CI system, so both are closed in shape. */
function variables(action: CiAction, value: unknown): Record<string, string> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(action, `parameters must be an object of names and values (got ${shown(value)})`);
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_PARAMETERS) fail(action, `parameters: at most ${MAX_PARAMETERS} names`);
    const found: Record<string, string> = {};
    for (const [name, content] of entries) {
        if (!NAME.test(name))
            fail(action, `parameters: ${shown(name, 30)} is not a usable name (letters, digits, _ . -)`);
        if (typeof content !== "string" || content.length > 500 || CONTROL.test(content)) {
            fail(action, `parameters.${name} must be one line of text of at most 500 characters`);
        }
        found[name] = content;
    }
    return found;
}

/** The value of one parameter, checked by what it is. */
function valueOf(action: CiAction, name: string, value: unknown): unknown {
    switch (name) {
        case "number":
        case "run_id":
            return integer(action, value, name, 1, Number.MAX_SAFE_INTEGER);
        case "limit":
            return integer(action, value, name, 1, MAX_LIMIT);
        case "tail":
            return integer(action, value, name, 1, MAX_TAIL);
        case "branch":
        case "ref":
            return text(action, value, name, BRANCH, "a branch or tag name");
        case "sha":
            return text(action, value, name, SHA, "a commit id of 4 to 64 hexadecimal digits");
        case "state":
            return text(action, value, name, STATE, "a state such as failure");
        case "bot":
            return text(action, value, name, LOGIN, "a login");
        case "required_only":
        case "failed_only":
            return flag(action, value, name);
        case "grep":
            return expression(action, value, name, 200);
        case "pattern":
            return expression(action, value, name, 300);
        case "job":
        case "check":
            return line(action, value, name, 200);
        case "parameters":
            return variables(action, value);
        case "finish":
            if (typeof value === "string" && (FINISHES as readonly string[]).includes(value)) return value;
            return fail(action, `finish must be one of ${FINISHES.join(", ")} (got ${shown(value)})`);
        default:
            return fail(action, `${name} is not a parameter`);
    }
}

/** What a call to the tool must name: the action and the service, then the row of the system for the action. */
function rowCheck(
    action: CiAction,
    service: CiService,
    info: CiSystemInfo,
    input: Readonly<Record<string, unknown>>,
): Params {
    const row: ActionRow = rowOf(info, service.name, action);
    const takes = [...(row.required ?? []), ...(row.optional ?? [])];
    const extra = Object.keys(input).filter(
        (name) => present(input[name]) && name !== "action" && name !== "service" && !takes.includes(name),
    );
    if (extra.length > 0) {
        throw new InputError(
            `ci ${action}: ${info.label} (${service.name}) does not take ${extra.join(", ")}. ${usage(action, row)}`,
        );
    }
    const missing = (row.required ?? []).filter((name) => !present(input[name]));
    if (missing.length > 0) throw new InputError(`ci ${action} needs ${missing.join(", ")}. ${usage(action, row)}`);
    const found: Record<string, unknown> = {};
    for (const name of takes) if (present(input[name])) found[name] = valueOf(action, name, input[name]);
    return found as Params;
}

/**
 * Checks a call and returns it in a typed form. Every problem is an InputError, a `TypeError` that says what to change,
 * with the usage line when the shape is wrong, so the model can correct the call at once.
 */
export function parseCall(input: Readonly<Record<string, unknown>>, catalog: Catalog | undefined): Call {
    if (catalog === undefined) throw notSetUp();
    const action = checkAction(input.action);
    if (!present(input.service)) {
        const withCi = [...catalog.services.values()].filter((service) => service.ci !== undefined);
        const known = shortList(withCi.map((service) => `${service.name} (${service.ci?.system})`));
        throw new InputError(
            `ci ${action} needs service. Services with a ci entry: ${known === "" ? "none have one" : known}`,
        );
    }
    const service = findCiService(catalog, "ci", input.service);
    const info = SYSTEMS[service.ci.system];
    return { action, service, info, params: rowCheck(action, service, info, input) };
}
