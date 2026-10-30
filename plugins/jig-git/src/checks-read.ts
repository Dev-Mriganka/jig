// GitHub checks and Actions, read only: status, runs, run, artifacts and log. Pass, fail, pending and skipped are the four
// words for a check everywhere. A failed job's log is cut to its tail or to the lines that match a search, capped at 400
// lines, and scrubbed of anything that looks like a credential.
import { count, describeCounts, fromGhRow, listChecks } from "./ci.ts";
import type { Check } from "./ci.ts";
import { apiJson, gh, ghFailure, ghJson, repoFlags, requireSlug } from "./github.ts";
import { jobLog, selectLog } from "./logs.ts";
import { checkBranch, checkNumber, checkRev } from "./names.ts";
import { selectorFor } from "./pr-read.ts";
import type { Call, Planned } from "./previews.ts";
import { readOnly } from "./previews.ts";
import { baseBranch, resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { currentBranch } from "./run.ts";
import { plural } from "./text.ts";
import { checksOf, compactDefaultBranch, requester, requiredNames } from "./watch.ts";
import type { GithubState } from "./watch.ts";

interface Target {
    number?: number;
    branch?: string;
    sha?: string;
}

// ---- status -------------------------------------------------------------------------------------------------------

export function planStatus(params: Target & { repo?: string; required_only?: boolean }, call: Call): Planned {
    if (params.sha !== undefined && (params.number !== undefined || params.branch !== undefined))
        throw new Error("checks status takes one of number, branch or sha");
    const sha = params.sha === undefined ? undefined : checkRev(params.sha, "sha");
    return readOnly(
        `checks status ${params.number ?? params.branch ?? sha ?? "here"} in ${params.repo ?? "here"}`,
        async () => {
            const repo = await resolveRepo(params.repo, call.signal);
            const required = params.required_only === true;
            let label: string;
            let checks: Check[];
            let note = "";
            if (params.number !== undefined) {
                // For a pull request gh knows which checks are required.
                label = `pull request ${params.number}`;
                const flags = await repoFlags(repo, call.settings, call.signal);
                const result = await gh(
                    [
                        "pr",
                        "checks",
                        String(checkNumber(params.number)),
                        "--json",
                        "name,state,bucket,link,workflow",
                        ...(required ? ["--required"] : []),
                        ...flags,
                    ],
                    { cwd: repo.root, signal: call.signal },
                );
                // gh exits non-zero when checks fail or are pending, and still prints the JSON.
                if (result.stdout.trim().startsWith("["))
                    checks = ghJson<Parameters<typeof fromGhRow>[0][]>("gh pr checks", { ...result, code: 0 }).map(
                        fromGhRow,
                    );
                else if (result.code === 0 || /no (required )?checks/i.test(result.stderr)) checks = [];
                else throw ghFailure("gh pr checks", result);
            } else {
                const slug = await requireSlug(repo, call.settings, call.signal);
                const ref =
                    sha ??
                    (params.branch === undefined
                        ? await currentBranch(repo.root, call.signal)
                        : checkBranch(params.branch));
                if (!ref) throw new Error(`HEAD is detached in ${repo.name}; pass number, branch or sha`);
                label = sha ? `commit ${sha.slice(0, 7)}` : `branch ${ref}`;
                const state: GithubState = { answers: {}, polls: 0 };
                const get = requester(state, call.signal ?? new AbortController().signal);
                checks = await checksOf(get, slug, ref);
                if (required) {
                    const base =
                        (await get(`repos/${slug}`, compactDefaultBranch)).value ||
                        (await baseBranch(repo, call.settings, call.signal));
                    const names = await requiredNames(get, slug, base, state);
                    if (names.length === 0)
                        note = "\nNo required checks are configured for the default branch, so all checks are shown.";
                    else checks = checks.filter((check) => names.includes(check.name));
                }
            }
            const head = `${label}${required ? " (required checks)" : ""}: ${describeCounts(count(checks))}`;
            const facts = count(checks);
            if (checks.length === 0) return { text: `${head}; no checks reported.${note}`, facts: { ...facts } };
            return { text: `${head}\n${listChecks(checks)}${note}`, facts: { ...facts } };
        },
    );
}

// ---- runs ---------------------------------------------------------------------------------------------------------

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

export function planRuns(params: Target & { repo?: string; state?: string; limit?: number }, call: Call): Planned {
    if (params.state !== undefined && !STATES.includes(params.state))
        throw new Error(`checks runs: state must be one of ${STATES.join(", ")}`);
    const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20)));
    return readOnly(`checks runs in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const flags = await repoFlags(repo, call.settings, call.signal);
        const filters = [
            ...(params.branch === undefined ? [] : ["--branch", checkBranch(params.branch)]),
            ...(params.sha === undefined ? [] : ["--commit", checkRev(params.sha, "sha")]),
            ...(params.state === undefined ? [] : ["--status", params.state]),
        ];
        const args = [
            "run",
            "list",
            "--limit",
            String(limit),
            "--json",
            "databaseId,name,workflowName,displayTitle,status,conclusion,headBranch,headSha,event,createdAt,url",
            ...filters,
            ...flags,
        ];
        const rows = ghJson<RunRow[]>("gh run list", await gh(args, { cwd: repo.root, signal: call.signal }));
        if (rows.length === 0) return { text: `No workflow runs match in ${repo.name}.` };
        const lines = rows.map(
            (row) =>
                `#${row.databaseId} ${outcomeOf(row).padEnd(10)} ${row.workflowName || row.name}  ${row.headBranch} ${row.headSha.slice(0, 7)}  ${row.event}  ${row.createdAt.slice(0, 16)}`,
        );
        return {
            text: `${repo.name}: ${plural(rows.length, "run")}\n${lines.join("\n")}`,
            details: { ids: rows.map((row) => row.databaseId) },
        };
    });
}

// ---- run ----------------------------------------------------------------------------------------------------------

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

async function viewRun(repo: Repo, id: number, call: Call): Promise<RunDetail> {
    const flags = await repoFlags(repo, call.settings, call.signal);
    return ghJson<RunDetail>(
        "gh run view",
        await gh(
            [
                "run",
                "view",
                String(id),
                "--json",
                "databaseId,name,workflowName,status,conclusion,headBranch,headSha,event,createdAt,url,jobs",
                ...flags,
            ],
            { cwd: repo.root, signal: call.signal },
        ),
    );
}

export function planRun(params: { repo?: string; run_id?: number }, call: Call): Planned {
    const id = checkNumber(params.run_id, "run_id");
    return readOnly(`checks run ${id} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const run = await viewRun(repo, id, call);
        const out = [
            `Run #${run.databaseId} ${run.workflowName || run.name}: ${outcomeOf(run)}`,
            `${run.headBranch} at ${run.headSha.slice(0, 7)}, ${run.event}; ${run.url}`,
        ];
        for (const job of run.jobs) {
            out.push(`${outcomeOf(job).padEnd(10)} ${job.name} (job ${job.databaseId})`);
            // Steps are listed for a job that did not pass: that is where the failure is.
            if (job.conclusion !== "success" && job.conclusion !== "skipped") {
                for (const step of job.steps ?? [])
                    if (step.conclusion !== "success" && step.conclusion !== "skipped")
                        out.push(`    step ${step.number} ${step.name}: ${outcomeOf(step)}`);
            }
        }
        return { text: out.join("\n"), details: { jobs: run.jobs.map((job) => job.databaseId) } };
    });
}

// ---- artifacts ----------------------------------------------------------------------------------------------------

export function planArtifacts(params: { repo?: string; run_id?: number }, call: Call): Planned {
    const id = checkNumber(params.run_id, "run_id");
    return readOnly(`checks artifacts of run ${id} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const slug = await requireSlug(repo, call.settings, call.signal);
        const list = await apiJson<{
            total_count: number;
            artifacts: { name: string; size_in_bytes: number; expired: boolean; created_at: string }[];
        }>(`repos/${slug}/actions/runs/${id}/artifacts?per_page=100`, { cwd: repo.root, signal: call.signal });
        if (list.artifacts.length === 0) return { text: `Run #${id} has no artifacts.` };
        const lines = list.artifacts.map(
            (artifact) =>
                `${artifact.name}  ${(artifact.size_in_bytes / 1024).toFixed(0)} KiB  ${artifact.created_at.slice(0, 16)}${artifact.expired ? "  expired" : ""}`,
        );
        return { text: `Run #${id}: ${plural(list.total_count, "artifact")}\n${lines.join("\n")}` };
    });
}

// ---- log ----------------------------------------------------------------------------------------------------------

/** The run whose log is wanted: the one named, else the newest failed run of the pull request, branch or commit. */
async function runToRead(repo: Repo, params: Target & { run_id?: number }, call: Call): Promise<number> {
    if (params.run_id !== undefined) return checkNumber(params.run_id, "run_id");
    const flags = await repoFlags(repo, call.settings, call.signal);
    let filters: string[];
    if (params.number !== undefined) {
        const pr = ghJson<{ headRefOid: string }>(
            "gh pr view",
            await gh(["pr", "view", await selectorFor(repo, params, call.signal), "--json", "headRefOid", ...flags], {
                cwd: repo.root,
                signal: call.signal,
            }),
        );
        filters = ["--commit", pr.headRefOid];
    } else if (params.sha !== undefined) {
        filters = ["--commit", checkRev(params.sha, "sha")];
    } else {
        const branch =
            params.branch === undefined ? await currentBranch(repo.root, call.signal) : checkBranch(params.branch);
        if (!branch) throw new Error(`HEAD is detached in ${repo.name}; pass run_id, number, branch or sha`);
        filters = ["--branch", branch];
    }
    const rows = ghJson<RunRow[]>(
        "gh run list",
        await gh(["run", "list", "--status", "failure", "--limit", "1", "--json", "databaseId", ...filters, ...flags], {
            cwd: repo.root,
            signal: call.signal,
        }),
    );
    const found = rows[0];
    if (!found) throw new Error("no failed run found for that pull request, branch or commit; pass run_id");
    return found.databaseId;
}

export function planLog(
    params: Target & { repo?: string; run_id?: number; job?: string; tail?: number; grep?: string },
    call: Call,
): Planned {
    if (params.grep !== undefined) {
        try {
            new RegExp(params.grep);
        } catch (error) {
            throw new Error(`checks log: grep is not a valid regular expression: ${(error as Error).message}`);
        }
    }
    return readOnly(`checks log in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const slug = await requireSlug(repo, call.settings, call.signal);
        const id = await runToRead(repo, params, call);
        const run = await viewRun(repo, id, call);
        const failed = run.jobs.filter(
            (job) => job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "cancelled",
        );
        const wanted = params.job;
        const job =
            wanted === undefined
                ? failed[0]
                : (run.jobs.find((candidate) => String(candidate.databaseId) === wanted || candidate.name === wanted) ??
                  run.jobs.find((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase())));
        if (!job) {
            const names = (wanted === undefined ? run.jobs : run.jobs.filter((candidate) => candidate.name !== "")).map(
                (candidate) => `${candidate.name} (${outcomeOf(candidate)})`,
            );
            throw new Error(
                wanted === undefined
                    ? `run ${id} has no failed job; its jobs: ${names.join(", ")}`
                    : `run ${id} has no job called ${wanted}; its jobs: ${names.join(", ")}`,
            );
        }
        const raw = await jobLog(slug, job.databaseId, { cwd: repo.root, signal: call.signal });
        const picked = selectLog(raw, { tail: params.tail, grep: params.grep });
        const head = `Run #${id}, job ${job.name} (${outcomeOf(job)}): ${picked.note}`;
        return { text: picked.text === "" ? head : `${head}\n${picked.text}`, details: { job: job.databaseId } };
    });
}
