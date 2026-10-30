// The GitHub Actions adapter: the checks, runs and logs of a repository on GitHub, through `gh`. It was jig-git's
// `checks` tool. Reads are plain; `rerun` changes GitHub and is previewed; `watch` plans a watch that the kind in
// watch.ts polls.
//
// Pass, fail, pending and skipped are the four words for a check everywhere. A failed job's log is cut to its tail or
// to the lines that match a search, capped at 400 lines, and scrubbed of anything that looks like a credential.
//
// There is no `trigger`: starting a workflow by hand can deploy, and deploys have their own tool and their own rules.
// The `workflow` of the catalog narrows `runs` to one workflow.
import type { CiService } from "../catalog.ts";
import { digest, InputError, plural } from "../values.ts";
import type { Outcome } from "../values.ts";
import type { ActionTable, CiAdapter, CiContext, CiSystemInfo, Params, Plan, WatchPlan } from "./adapter.ts";
import { apiJson, gh, ghFailure, ghJson, ghWrite } from "./gh.ts";
import { checksOf, compactDefaultBranch, jobLog, requester, requiredNames } from "./github-checks.ts";
import type { GithubState } from "./github-checks.ts";
import { pollGithub } from "./github-watch.ts";
import type { Finish, GithubSpec } from "./github-watch.ts";
import { afterLostReply } from "./lost.ts";
import { selectLog } from "./logs.ts";
import { count, describeCounts, fromGhRow, listChecks } from "./model.ts";
import type { Check } from "./model.ts";

export const TABLE: ActionTable = {
    status: { optional: ["number", "branch", "sha", "required_only"] },
    runs: { optional: ["branch", "sha", "state", "limit"] },
    run: { required: ["run_id"] },
    log: { optional: ["run_id", "number", "branch", "sha", "job", "tail", "grep"] },
    rerun: { required: ["run_id"], optional: ["failed_only"] },
    watch: { optional: ["number", "branch", "sha", "run_id", "finish", "check", "pattern", "bot"] },
};

// ---- what gh prints -----------------------------------------------------------------------------------------------

interface RunRow {
    databaseId: number;
    name: string;
    workflowName?: string;
    displayTitle?: string;
    status: string;
    conclusion: string;
    headBranch: string;
    headSha: string;
    event: string;
    createdAt: string;
    url: string;
}

interface Job {
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    url: string;
    steps?: { name: string; status: string; conclusion: string; number: number }[];
}

interface RunDetail extends RunRow {
    jobs: Job[];
}

const STATES = [
    "queued",
    "in_progress",
    "completed",
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
    "stale",
    "waiting",
    "requested",
    "pending",
    "startup_failure",
];

function outcomeOf(row: Pick<RunRow, "status" | "conclusion">): string {
    return row.status === "completed" ? row.conclusion || "completed" : row.status;
}

const ENDS: Record<Finish["kind"] | "approved" | "merged", string> = {
    required: "the required checks all pass, or the first one fails",
    check: "the check passes or fails",
    run: "the run ends, or one of its jobs fails",
    approved: "the pull request is approved, or changes are requested",
    merged: "the pull request is merged or closed",
    comment: "a matching comment appears",
    tag: "a matching tag appears",
    release: "a matching release appears",
    pr: "the pull request reaches the state",
};

function missing(finish: string, name: string): InputError {
    return new InputError(
        `ci watch with finish ${finish} needs ${name}. Usage: ci watch {service, finish: ${finish}, ${name}, ...}`,
    );
}

/** A pattern the watch will compile on every poll: it is checked now, so a bad one never starts a watch. */
function compiled(pattern: string | undefined, finish: string): string {
    if (pattern === undefined) throw missing(finish, "pattern");
    try {
        new RegExp(pattern);
    } catch (error) {
        throw new InputError(`ci watch: pattern is not a valid regular expression: ${(error as Error).message}`);
    }
    return pattern;
}

function need<T>(value: T | undefined, name: string, who: string): T {
    if (value === undefined) throw new InputError(`${who} needs ${name}`);
    return value;
}

/** One line naming what is watched, such as "checks of pull request 42" or "checks of branch x at abc1234". */
export function titleOf(spec: GithubSpec, slug: string): string {
    const finish = spec.finish;
    const where =
        spec.pr !== undefined
            ? `pull request ${spec.pr}`
            : spec.branch !== undefined
              ? `branch ${spec.branch}${spec.sha ? ` at ${spec.sha.slice(0, 7)}` : ""}`
              : spec.sha
                ? `commit ${spec.sha.slice(0, 7)}`
                : slug;
    switch (finish.kind) {
        case "required":
            return `checks of ${where}`;
        case "check":
            return `check ${finish.name} of ${where}`;
        case "run":
            return `workflow run ${spec.runId}`;
        case "pr":
            return finish.state === "merged"
                ? `merge of pull request ${spec.pr}`
                : `approval of pull request ${spec.pr}`;
        case "comment":
            return `a comment matching ${finish.pattern} on pull request ${spec.pr}`;
        case "tag":
            return `a new tag matching ${finish.pattern} in ${slug}`;
        case "release":
            return `a new release matching ${finish.pattern} in ${slug}`;
    }
}

// ---- the adapter --------------------------------------------------------------------------------------------------

function githubActions(service: CiService, ctx: CiContext): CiAdapter {
    const slug = service.repo as string;
    const { signal } = ctx;
    const flags = ["-R", slug];
    const workflow = service.ci.system === "github-actions" ? service.ci.workflow : undefined;

    const defaultBranch = async (): Promise<string> => {
        const found = (await apiJson<{ default_branch?: string }>(`repos/${slug}`, { signal })).default_branch;
        if (!found) throw new Error(`GitHub did not say which branch is the default of ${slug}`);
        return found;
    };

    // ---- status ---------------------------------------------------------------------------------------------------

    async function status(params: Params): Promise<Outcome> {
        const targets = [params.number, params.branch, params.sha].filter((value) => value !== undefined);
        if (targets.length > 1) throw new InputError("ci status takes one of number, branch or sha");
        const required = params.required_only === true;
        let label: string;
        let checks: Check[];
        let note = "";
        if (params.number !== undefined) {
            // For a pull request gh knows which checks are required.
            label = `pull request ${params.number}`;
            const result = await gh(
                [
                    "pr",
                    "checks",
                    String(params.number),
                    "--json",
                    "name,state,bucket,link,workflow",
                    ...(required ? ["--required"] : []),
                    ...flags,
                ],
                { signal },
            );
            // gh exits non-zero when checks fail or are pending, and still prints the JSON.
            if (result.stdout.trim().startsWith("[")) {
                checks = ghJson<Parameters<typeof fromGhRow>[0][]>("gh pr checks", { ...result, code: 0 }).map(
                    fromGhRow,
                );
            } else if (result.code === 0 || /no (required )?checks/i.test(result.stderr)) {
                checks = [];
            } else {
                throw ghFailure("gh pr checks", result);
            }
        } else {
            const ref = params.sha ?? params.branch ?? (await defaultBranch());
            label = params.sha ? `commit ${params.sha.slice(0, 7)}` : `branch ${ref}`;
            const state: GithubState = { answers: {}, polls: 0 };
            const get = requester(state, signal ?? new AbortController().signal);
            checks = await checksOf(get, slug, ref);
            if (required) {
                const base = (await get(`repos/${slug}`, compactDefaultBranch)).value || (await defaultBranch());
                const names = await requiredNames(get, slug, base, state);
                if (names.length === 0) {
                    note = "\nNo required checks are configured for the default branch, so all checks are shown.";
                } else {
                    checks = checks.filter((check) => names.includes(check.name));
                }
            }
        }
        const head = `${label}${required ? " (required checks)" : ""}: ${describeCounts(count(checks))}`;
        const facts = { ...count(checks) };
        if (checks.length === 0) return { text: `${head}; no checks reported.${note}`, facts, details: {} };
        return { text: `${head}\n${listChecks(checks)}${note}`, facts, details: {} };
    }

    // ---- runs -----------------------------------------------------------------------------------------------------

    async function runs(params: Params): Promise<Outcome> {
        if (params.state !== undefined && !STATES.includes(params.state)) {
            throw new InputError(`ci runs: state must be one of ${STATES.join(", ")}`);
        }
        const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20)));
        const filters = [
            ...(params.branch === undefined ? [] : ["--branch", params.branch]),
            ...(params.sha === undefined ? [] : ["--commit", params.sha]),
            ...(params.state === undefined ? [] : ["--status", params.state]),
            ...(workflow === undefined ? [] : ["--workflow", workflow]),
        ];
        const fields =
            "databaseId,name,workflowName,displayTitle,status,conclusion,headBranch,headSha,event,createdAt,url";
        const args = ["run", "list", "--limit", String(limit), "--json", fields, ...filters, ...flags];
        const rows = ghJson<RunRow[]>("gh run list", await gh(args, { signal }));
        if (rows.length === 0) return { text: `No workflow runs match in ${slug}.`, facts: {}, details: { ids: [] } };
        const lines = rows.map(
            (row) =>
                `#${row.databaseId} ${outcomeOf(row).padEnd(10)} ${row.workflowName || row.name}  ` +
                `${row.headBranch} ${row.headSha.slice(0, 7)}  ${row.event}  ${row.createdAt.slice(0, 16)}`,
        );
        return {
            text: `${slug}: ${plural(rows.length, "run")}\n${lines.join("\n")}`,
            facts: {},
            details: { ids: rows.map((row) => row.databaseId) },
        };
    }

    // ---- run ------------------------------------------------------------------------------------------------------

    async function viewRun(id: number, fields: string): Promise<RunDetail> {
        return ghJson<RunDetail>(
            "gh run view",
            await gh(["run", "view", String(id), "--json", fields, ...flags], { signal }),
        );
    }

    const RUN_FIELDS = "databaseId,name,workflowName,status,conclusion,headBranch,headSha,event,createdAt,url,jobs";

    /** The artifacts of a run, as lines. A run's artifacts are part of what it is, so `run` shows them. */
    async function artifactLines(id: number): Promise<string[]> {
        try {
            const list = await apiJson<{
                total_count: number;
                artifacts: { name: string; size_in_bytes: number; expired: boolean; created_at: string }[];
            }>(`repos/${slug}/actions/runs/${id}/artifacts?per_page=100`, { signal });
            if (list.artifacts.length === 0) return ["Artifacts: none"];
            return [
                `Artifacts: ${plural(list.total_count, "artifact")}`,
                ...list.artifacts.map(
                    (artifact) =>
                        `    ${artifact.name}  ${(artifact.size_in_bytes / 1024).toFixed(0)} KiB  ` +
                        `${artifact.created_at.slice(0, 16)}${artifact.expired ? "  expired" : ""}`,
                ),
            ];
        } catch (error) {
            return [`Artifacts: could not be listed (${(error as Error).message})`];
        }
    }

    async function run(params: Params): Promise<Outcome> {
        const id = need(params.run_id, "run_id", "ci run");
        const detail = await viewRun(id, RUN_FIELDS);
        const out = [
            `Run #${detail.databaseId} ${detail.workflowName || detail.name}: ${outcomeOf(detail)}`,
            `${detail.headBranch} at ${detail.headSha.slice(0, 7)}, ${detail.event}; ${detail.url}`,
        ];
        for (const job of detail.jobs) {
            out.push(`${outcomeOf(job).padEnd(10)} ${job.name} (job ${job.databaseId})`);
            // Steps are listed for a job that did not pass: that is where the failure is.
            if (job.conclusion !== "success" && job.conclusion !== "skipped") {
                for (const step of job.steps ?? []) {
                    if (step.conclusion !== "success" && step.conclusion !== "skipped") {
                        out.push(`    step ${step.number} ${step.name}: ${outcomeOf(step)}`);
                    }
                }
            }
        }
        out.push(...(await artifactLines(id)));
        return { text: out.join("\n"), facts: {}, details: { jobs: detail.jobs.map((job) => job.databaseId) } };
    }

    // ---- log ------------------------------------------------------------------------------------------------------

    /** The run whose log is wanted: the one named, else the newest failed run of the pull request, branch or commit. */
    async function runToRead(params: Params): Promise<number> {
        if (params.run_id !== undefined) return params.run_id;
        let filters: string[];
        if (params.number !== undefined) {
            const pr = ghJson<{ headRefOid: string }>(
                "gh pr view",
                await gh(["pr", "view", String(params.number), "--json", "headRefOid", ...flags], { signal }),
            );
            filters = ["--commit", pr.headRefOid];
        } else if (params.sha !== undefined) {
            filters = ["--commit", params.sha];
        } else {
            filters = ["--branch", params.branch ?? (await defaultBranch())];
        }
        const rows = ghJson<RunRow[]>(
            "gh run list",
            await gh(
                ["run", "list", "--status", "failure", "--limit", "1", "--json", "databaseId", ...filters, ...flags],
                {
                    signal,
                },
            ),
        );
        const found = rows[0];
        if (!found) throw new Error("no failed run found for that pull request, branch or commit; pass run_id");
        return found.databaseId;
    }

    async function log(params: Params): Promise<Outcome> {
        const id = await runToRead(params);
        const detail = await viewRun(id, RUN_FIELDS);
        const failed = detail.jobs.filter(
            (job) => job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "cancelled",
        );
        const wanted = params.job;
        const job =
            wanted === undefined
                ? failed[0]
                : (detail.jobs.find(
                      (candidate) => String(candidate.databaseId) === wanted || candidate.name === wanted,
                  ) ?? detail.jobs.find((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase())));
        if (!job) {
            const names = detail.jobs.map((candidate) => `${candidate.name} (${outcomeOf(candidate)})`);
            throw new Error(
                wanted === undefined
                    ? `run ${id} has no failed job; its jobs: ${names.join(", ")}`
                    : `run ${id} has no job called ${wanted}; its jobs: ${names.join(", ")}`,
            );
        }
        const raw = await jobLog(slug, job.databaseId, { signal });
        const picked = selectLog(raw, { tail: params.tail, grep: params.grep });
        const head = `Run #${id}, job ${job.name} (${outcomeOf(job)}): ${picked.note}`;
        return {
            text: picked.text === "" ? head : `${head}\n${picked.text}`,
            facts: {},
            details: { job: job.databaseId },
        };
    }

    // ---- rerun ----------------------------------------------------------------------------------------------------

    async function rerun(params: Params): Promise<Plan> {
        const id = need(params.run_id, "run_id", "ci rerun");
        const failedOnly = params.failed_only !== false;
        // The signal is for the first look. The look after a lost reply must run even when the call was cancelled.
        const viewed = async (stop?: AbortSignal) =>
            ghJson<{ name: string; status: string; attempt: number; headBranch: string }>(
                "gh run view",
                await gh(["run", "view", String(id), "--json", "name,status,attempt,headBranch", ...flags], {
                    signal: stop,
                }),
            );
        const found = await viewed(signal);
        if (found.status !== "completed") {
            throw new Error(`run ${id} is ${found.status}; a run can be rerun once it has completed`);
        }
        return {
            preview: {
                summary:
                    `rerun ${failedOnly ? "the failed jobs" : "all jobs"} of run ${id} ` +
                    `(${found.name}, ${found.headBranch}) in ${slug}`,
                fingerprint: digest("ci rerun", service.name, slug, id, found.attempt, failedOnly),
            },
            send: async () => {
                const what = failedOnly ? "the failed jobs of " : "";
                const done = `Started a rerun of ${what}run #${id} (${found.name}) in ${slug}.`;
                const sent = await ghWrite(
                    "gh run rerun",
                    ["run", "rerun", String(id), ...(failedOnly ? ["--failed"] : []), ...flags],
                    { signal },
                );
                if (sent.kind === "sent") return { text: done, facts: { outcome: "started" }, details: { run: id } };
                return afterLostReply("gh run rerun", sent.why, "GitHub", async () =>
                    (await viewed()).attempt > found.attempt ? done : undefined,
                );
            },
        };
    }

    // ---- watch ----------------------------------------------------------------------------------------------------

    async function watch(params: Params): Promise<WatchPlan> {
        const kind =
            params.finish ?? (params.run_id !== undefined ? "run" : params.check !== undefined ? "check" : "required");
        let finish: Finish;
        switch (kind) {
            case "required":
                finish = { kind: "required" };
                break;
            case "check":
                if (params.check === undefined) throw missing("check", "check");
                finish = { kind: "check", name: params.check };
                break;
            case "run":
                need(params.run_id, "run_id", "ci watch with finish run");
                finish = { kind: "run" };
                break;
            case "approved":
            case "merged":
                need(params.number, "number", `ci watch with finish ${kind}`);
                finish = { kind: "pr", state: kind };
                break;
            case "comment":
                need(params.number, "number", "ci watch with finish comment");
                finish = {
                    kind: "comment",
                    pattern: compiled(params.pattern, "comment"),
                    ...(params.bot === undefined ? {} : { bot: params.bot }),
                    since: new Date(ctx.now()).toISOString(),
                };
                break;
            default:
                finish = { kind, pattern: compiled(params.pattern, kind) };
        }
        // The commit to watch is fixed now, so the watch is about what exists today and not about a branch that moves
        // on.
        const needsCommit = finish.kind === "required" || finish.kind === "check";
        const spec: GithubSpec = { system: "github-actions", service: service.name, finish };
        if (params.number !== undefined) spec.pr = params.number;
        if (params.run_id !== undefined) spec.runId = params.run_id;
        if (params.sha !== undefined) {
            spec.sha = (await apiJson<{ sha: string }>(`repos/${slug}/commits/${params.sha}`, { signal })).sha;
        } else if (params.number !== undefined && (needsCommit || finish.kind === "pr")) {
            const pr = ghJson<{ headRefOid: string; headRefName: string }>(
                "gh pr view",
                await gh(["pr", "view", String(params.number), "--json", "headRefOid,headRefName", ...flags], {
                    signal,
                }),
            );
            spec.sha = pr.headRefOid;
            spec.branch = pr.headRefName;
        } else if (needsCommit) {
            const branch = params.branch ?? (await defaultBranch());
            spec.branch = branch;
            spec.sha = (
                await apiJson<{ sha: string }>(`repos/${slug}/commits/${encodeURIComponent(branch)}`, { signal })
            ).sha;
        }
        if (params.branch !== undefined && spec.branch === undefined) spec.branch = params.branch;
        return { spec, title: titleOf(spec, slug), ends: ENDS[kind] };
    }

    return {
        status,
        runs,
        run,
        log,
        rerun,
        watch,
        poll: (spec, previous) => {
            if (spec.system !== "github-actions")
                throw new Error(`a ${spec.system} watch cannot be polled as GitHub Actions`);
            const held = previous !== undefined && "answers" in previous ? previous : undefined;
            return pollGithub(spec, slug, held, ctx);
        },
    };
}

export const GITHUB_ACTIONS: CiSystemInfo = {
    system: "github-actions",
    label: "GitHub Actions",
    table: TABLE,
    create: githubActions,
};
