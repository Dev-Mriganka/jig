// What a CI system has to be able to do for the `ci` tool, and how an adapter says what it cannot. The tool knows seven
// actions. An adapter has a method for each one it supports and a row in its table of parameters for it, and no more:
// an action it has no row for is invalid input, and the message names the adapter. GitLab can retry a pipeline and
// Jenkins cannot, and the tool does not pretend otherwise.
//
// An adapter is made for one call (or one poll) of one service, so the sign-in, the signal that stops the call and the
// clock are in its hands, and nothing is kept between calls.
import type { PollOutcome, Preview } from "../../../jig-core/src/contract.ts";
import type { CiService } from "../catalog.ts";
import { InputError, shortList } from "../values.ts";
import type { Outcome } from "../values.ts";
import type { Announce } from "./artifacts.ts";
import type { CiSystem } from "./config.ts";
import type { ArtifactRule } from "./settings.ts";
import type { CiSpec, CiState } from "./watch.ts";

export const CI_ACTIONS = ["status", "runs", "run", "log", "rerun", "trigger", "watch"] as const;
export type CiAction = (typeof CI_ACTIONS)[number];

/** The finish lines of a watch. Only GitHub has all of them; GitLab and Jenkins have the first three. */
export const FINISHES = ["required", "check", "run", "approved", "merged", "comment", "tag", "release"] as const;
export type FinishName = (typeof FINISHES)[number];

/** The parameters of a call besides `action` and `service`, each checked. An action reads only its row's. */
export interface Params {
    /** A pull request number. */
    number?: number;
    branch?: string;
    sha?: string;
    /** A run: a GitHub workflow run, a GitLab pipeline or a Jenkins build number. */
    run_id?: number;
    required_only?: boolean;
    state?: string;
    limit?: number;
    job?: string;
    tail?: number;
    grep?: string;
    failed_only?: boolean;
    /** trigger: the branch or tag to run on. */
    ref?: string;
    /** trigger: variables or build parameters, name to value. */
    parameters?: Readonly<Record<string, string>>;
    finish?: FinishName;
    check?: string;
    pattern?: string;
    bot?: string;
}

export interface ActionRow {
    required?: readonly string[];
    optional?: readonly string[];
}

/** For each action an adapter supports, the parameters it takes. An action without a row is not supported. */
export type ActionTable = Readonly<Partial<Record<CiAction, ActionRow>>>;

/** A write, worked out before it is done: what the user sees, and the one send. */
export interface Plan {
    /** Carries a fingerprint, which the tool compares with the approved preview before it sends. */
    preview: Preview;
    /** Sends the request once. A reply that is lost is checked once and the request is never sent again. */
    send(): Promise<Outcome>;
}

/** A watch, worked out before it is started: what it follows, and when it will end. */
export interface WatchPlan {
    spec: CiSpec;
    /** One line naming what is watched, for `watch list` and the result. */
    title: string;
    /** Finishes "One message arrives when ...". */
    ends: string;
}

/** What an adapter needs from outside, besides the service it is made for. */
export interface CiContext {
    /** The call's own signal: stopping the call stops its requests. */
    signal: AbortSignal | undefined;
    /** The network, for the adapters that speak HTTP. Default: the global `fetch`. */
    fetch?: typeof fetch;
    /** How long one request may take. Default: thirty seconds. */
    timeoutMs?: number;
    /** The clock. Default: the real one. */
    now: () => number;
    /** Publishes an event on Pi's event bus. */
    announce: Announce;
    /** How often a watch polls, in seconds, at least. From `ops.watch.pollSeconds`. */
    pollSeconds: number;
    /** The rules for "the artifact is ready". */
    artifacts: readonly ArtifactRule[];
}

export interface CiAdapter {
    status?(params: Params): Promise<Outcome>;
    runs?(params: Params): Promise<Outcome>;
    run?(params: Params): Promise<Outcome>;
    log?(params: Params): Promise<Outcome>;
    rerun?(params: Params): Promise<Plan>;
    trigger?(params: Params): Promise<Plan>;
    watch?(params: Params): Promise<WatchPlan>;
    /** One poll of a watch this adapter planned. A throw is a failed poll; the engine counts three and pauses. */
    poll(spec: CiSpec, previous: CiState | undefined): Promise<PollOutcome<CiState>>;
}

/** What is known of an adapter without making one: its name, and the actions and parameters it supports. */
export interface CiSystemInfo {
    system: CiSystem;
    /** How a message names it: `GitHub Actions`. */
    label: string;
    table: ActionTable;
    /** Makes the adapter for one call of one service. */
    create(service: CiService, context: CiContext): CiAdapter;
}

/** The actions an adapter supports, in the tool's order. */
export function supportedActions(table: ActionTable): CiAction[] {
    return CI_ACTIONS.filter((action) => table[action] !== undefined);
}

/** `ci status {service, number?, branch?}`: what a call to an action of this adapter looks like. */
export function usage(action: CiAction, row: ActionRow): string {
    const names = ["service", ...(row.required ?? []), ...(row.optional ?? []).map((name) => `${name}?`)];
    return `Usage: ci ${action} {${names.join(", ")}}`;
}

/** The row of an action, or an InputError that names the adapter and lists what it can do. */
export function rowOf(info: CiSystemInfo, service: string, action: CiAction): ActionRow {
    const row = info.table[action];
    if (row !== undefined) return row;
    throw new InputError(
        `ci ${action}: ${info.label} (${service}) does not support ${action}. ` +
            `It supports: ${shortList(supportedActions(info.table))}`,
    );
}
