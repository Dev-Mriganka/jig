// The state of a ticket's workflow: one file, `<ticket folder>/<KEY>/workflow.json`, written only by this plugin. It holds the
// stage and each piece of evidence with the commit or the plan it is about, so that a result stops counting when either
// changes. The workflow's own definition is not copied here: the name points at the file.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STATE_FILE = "workflow.json";
export const HISTORY_FOLDER = "workflow-history";
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_HISTORY = 200;
const MAX_REVIEWS = 20;
const MAX_CI = 20;
/** Nothing here is larger than a few kilobytes; a file past this is not ours. */
const MAX_STATE_BYTES = 1024 * 1024;

export interface TestResult {
    /** The full commit HEAD was at when the run began. */
    head: string;
    /** Whether the tree had no changes, tracked or untracked, then. */
    clean: boolean;
    passed: boolean;
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    sandboxed: boolean;
    at: string;
    durationMs: number;
}

export type EvidenceKind = "path" | "toolResult" | "text";

export interface ScenarioResult {
    result: "pass" | "fail";
    /** A hash of the scenario's text when the result was recorded. */
    hash: string;
    evidence?: { kind: EvidenceKind; ref: string };
    at: string;
}

/** A `jig-review:approved` event that covers commits. */
export interface ReviewRecord {
    reviewId: string;
    at: string;
    repos: Array<{ root: string; head: string }>;
}

/** A `jig-ops:ci-finished` event for a commit. */
export interface CiRecord {
    /** `owner/name`, lower case. */
    repo: string;
    sha: string;
    outcome: "passed" | "failed";
    /** The finish line of the watch, such as `required`. */
    finish: string;
    at: string;
}

/** The last reading of `gh pr view` for a repository. */
export interface Observation {
    at: string;
    branch: string;
    /** The local HEAD when it was read. */
    head: string;
    pr?: { number: number; state: string; isDraft: boolean; headRefOid: string; url: string };
    checks?: { pass: number; fail: number; pending: number; total: number };
    /** Why there is no reading, when there is none. */
    error?: string;
}

export interface HistoryEntry {
    at: string;
    event: "start" | "advance" | "back";
    from?: string;
    to: string;
}

export interface WorkflowState {
    version: 1;
    workflow: string;
    ticket: string;
    startedAt: string;
    stage: string;
    stageSince: string;
    /** The hash of `notes.md` when the stage began. */
    notesAtStage: string;
    history: HistoryEntry[];
    plan?: { fingerprint: string; at: string; scenarios: number };
    scenarios: Record<string, ScenarioResult>;
    /** By the repository's folder. */
    tests: Record<string, TestResult>;
    reviews: ReviewRecord[];
    ci: CiRecord[];
    observed: Record<string, Observation>;
}

export type ReadState =
    | { kind: "none" }
    | { kind: "state"; state: WorkflowState }
    | { kind: "invalid"; problem: string };

export function statePath(ticketDir: string): string {
    return path.join(ticketDir, STATE_FILE);
}

export function newState(input: {
    workflow: string;
    ticket: string;
    stage: string;
    notesHash: string;
    now: Date;
}): WorkflowState {
    const at = input.now.toISOString();
    return {
        version: 1,
        workflow: input.workflow,
        ticket: input.ticket,
        startedAt: at,
        stage: input.stage,
        stageSince: at,
        notesAtStage: input.notesHash,
        history: [{ at, event: "start", to: input.stage }],
        scenarios: {},
        tests: {},
        reviews: [],
        ci: [],
        observed: {},
    };
}

// ---- reading -------------------------------------------------------------------------------------------------------

export function readState(ticketDir: string): ReadState {
    const file = statePath(ticketDir);
    if (!existsSync(file)) return { kind: "none" };
    let raw: unknown;
    try {
        if (statSync(file).size > MAX_STATE_BYTES)
            return { kind: "invalid", problem: `${file} is larger than it can be` };
        raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        return { kind: "invalid", problem: `${file} cannot be read (${(error as Error).message.split("\n")[0]})` };
    }
    const state = normalize(raw);
    return typeof state === "string"
        ? { kind: "invalid", problem: `${file} is not a workflow state (${state})` }
        : { kind: "state", state };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): value is string => typeof value === "string";
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** The state, or a reason it is not one. An entry of a collection that is malformed is dropped; the rest is kept. */
function normalize(raw: unknown): WorkflowState | string {
    if (!isObject(raw)) return "not an object";
    if (raw.version !== 1) return `version ${JSON.stringify(raw.version)} is not one this plugin reads`;
    for (const key of ["workflow", "ticket", "startedAt", "stage", "stageSince", "notesAtStage"] as const) {
        if (!str(raw[key])) return `${key} is missing`;
    }
    const state: WorkflowState = {
        version: 1,
        workflow: raw.workflow as string,
        ticket: raw.ticket as string,
        startedAt: raw.startedAt as string,
        stage: raw.stage as string,
        stageSince: raw.stageSince as string,
        notesAtStage: raw.notesAtStage as string,
        history: [],
        scenarios: {},
        tests: {},
        reviews: [],
        ci: [],
        observed: {},
    };
    if (Array.isArray(raw.history)) {
        for (const entry of raw.history) {
            if (
                isObject(entry) &&
                str(entry.at) &&
                str(entry.to) &&
                ["start", "advance", "back"].includes(String(entry.event))
            ) {
                state.history.push({
                    at: entry.at,
                    event: entry.event as HistoryEntry["event"],
                    ...(str(entry.from) ? { from: entry.from } : {}),
                    to: entry.to,
                });
            }
        }
    }
    if (isObject(raw.plan) && str(raw.plan.fingerprint) && str(raw.plan.at) && typeof raw.plan.scenarios === "number") {
        state.plan = { fingerprint: raw.plan.fingerprint, at: raw.plan.at, scenarios: raw.plan.scenarios };
    }
    if (isObject(raw.scenarios)) {
        for (const [number, entry] of Object.entries(raw.scenarios)) {
            if (
                !isObject(entry) ||
                !str(entry.hash) ||
                !str(entry.at) ||
                !["pass", "fail"].includes(String(entry.result))
            )
                continue;
            const evidence = entry.evidence;
            state.scenarios[number] = {
                result: entry.result as "pass" | "fail",
                hash: entry.hash,
                at: entry.at,
                ...(isObject(evidence) &&
                str(evidence.ref) &&
                ["path", "toolResult", "text"].includes(String(evidence.kind))
                    ? { evidence: { kind: evidence.kind as EvidenceKind, ref: evidence.ref } }
                    : {}),
            };
        }
    }
    if (isObject(raw.tests)) {
        for (const [root, entry] of Object.entries(raw.tests)) {
            if (
                isObject(entry) &&
                str(entry.head) &&
                FULL_COMMIT.test(entry.head) &&
                typeof entry.clean === "boolean" &&
                typeof entry.passed === "boolean" &&
                str(entry.command) &&
                str(entry.at)
            ) {
                state.tests[root] = {
                    head: entry.head,
                    clean: entry.clean,
                    passed: entry.passed,
                    command: entry.command,
                    exitCode: typeof entry.exitCode === "number" ? entry.exitCode : null,
                    timedOut: entry.timedOut === true,
                    sandboxed: entry.sandboxed === true,
                    at: entry.at,
                    durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
                };
            }
        }
    }
    if (Array.isArray(raw.reviews)) {
        for (const entry of raw.reviews) {
            if (!isObject(entry) || !str(entry.reviewId) || !str(entry.at) || !Array.isArray(entry.repos)) continue;
            const repos = entry.repos.flatMap((repo: unknown) =>
                isObject(repo) && str(repo.root) && str(repo.head) && FULL_COMMIT.test(repo.head)
                    ? [{ root: repo.root, head: repo.head }]
                    : [],
            );
            state.reviews.push({ reviewId: entry.reviewId, at: entry.at, repos });
        }
    }
    if (Array.isArray(raw.ci)) {
        for (const entry of raw.ci) {
            if (
                isObject(entry) &&
                str(entry.repo) &&
                str(entry.sha) &&
                FULL_COMMIT.test(entry.sha) &&
                (entry.outcome === "passed" || entry.outcome === "failed") &&
                str(entry.finish) &&
                str(entry.at)
            ) {
                state.ci.push({
                    repo: entry.repo,
                    sha: entry.sha,
                    outcome: entry.outcome,
                    finish: entry.finish,
                    at: entry.at,
                });
            }
        }
    }
    if (isObject(raw.observed)) {
        for (const [root, entry] of Object.entries(raw.observed)) {
            if (!isObject(entry) || !str(entry.at) || !str(entry.branch) || !str(entry.head)) continue;
            const pr = entry.pr;
            const checks = entry.checks;
            state.observed[root] = {
                at: entry.at,
                branch: entry.branch,
                head: entry.head,
                ...(isObject(pr) && typeof pr.number === "number" && str(pr.state) && str(pr.headRefOid) && str(pr.url)
                    ? {
                          pr: {
                              number: pr.number,
                              state: pr.state,
                              isDraft: pr.isDraft === true,
                              headRefOid: pr.headRefOid,
                              url: pr.url,
                          },
                      }
                    : {}),
                ...(isObject(checks) &&
                [checks.pass, checks.fail, checks.pending, checks.total].every((n) => typeof n === "number")
                    ? {
                          checks: {
                              pass: checks.pass as number,
                              fail: checks.fail as number,
                              pending: checks.pending as number,
                              total: checks.total as number,
                          },
                      }
                    : {}),
                ...(str(entry.error) ? { error: entry.error } : {}),
            };
        }
    }
    return state;
}

// ---- writing -------------------------------------------------------------------------------------------------------

/** Writes the state through a temporary file and a rename, so a crash leaves the old state or the new, never half of one. */
export function writeState(ticketDir: string, state: WorkflowState): void {
    mkdirSync(ticketDir, { recursive: true, mode: FOLDER_MODE });
    const trimmed: WorkflowState = {
        ...state,
        history: state.history.slice(-MAX_HISTORY),
        reviews: state.reviews.slice(-MAX_REVIEWS),
        ci: state.ci.slice(-MAX_CI),
    };
    const file = statePath(ticketDir);
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify(trimmed, null, 2)}\n`, { flag: "wx", mode: FILE_MODE });
        renameSync(temp, file);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

/** Reads the state, changes it, and writes it back in one step. Returns what `change` returned. */
export function updateState<T>(ticketDir: string, change: (state: WorkflowState) => T): T | undefined {
    const read = readState(ticketDir);
    if (read.kind !== "state") return undefined;
    const result = change(read.state);
    writeState(ticketDir, read.state);
    return result;
}

/** Keeps the state of a workflow that is being replaced, so that nothing is lost silently. Returns the file. */
export function archiveState(ticketDir: string, state: WorkflowState, now: Date): string {
    const folder = path.join(ticketDir, HISTORY_FOLDER);
    mkdirSync(folder, { recursive: true, mode: FOLDER_MODE });
    const stamp = now.toISOString().replace(/:/g, "-");
    const file = path.join(folder, `${stamp}-${state.workflow}.json`);
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: FILE_MODE });
    return file;
}

/** What a switch would lose, as short phrases with counts, for the question and the refusal. */
export function whatIsLost(state: WorkflowState): string[] {
    const lost = [`the stage (${state.stage})`];
    if (state.plan !== undefined) lost.push("the plan approval");
    const tests = Object.keys(state.tests).length;
    if (tests > 0) lost.push(`${tests} test result${tests === 1 ? "" : "s"}`);
    const scenarios = Object.keys(state.scenarios).length;
    if (scenarios > 0) lost.push(`${scenarios} scenario result${scenarios === 1 ? "" : "s"}`);
    if (state.reviews.length > 0)
        lost.push(`${state.reviews.length} review record${state.reviews.length === 1 ? "" : "s"}`);
    if (state.ci.length > 0 || Object.keys(state.observed).length > 0) lost.push("the CI and pull request readings");
    return lost;
}
