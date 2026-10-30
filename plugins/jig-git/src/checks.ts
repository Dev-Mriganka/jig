// The `checks` tool: GitHub checks and Actions, and watching them in the background. Reads are allowed. `rerun` changes
// GitHub and asks. `watch` starts a watch on jig-core's engine and returns its id at once.
//
// `checks` covers GitHub only. Other CI systems belong in a company plugin.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { jig } from "../../jig-core/src/client.ts";
import { planArtifacts, planLog, planRun, planRuns, planStatus } from "./checks-read.ts";
import { afterLostReply, apiJson, gh, ghJson, ghWrite, repoFlags, requireSlug } from "./github.ts";
import { checkBranch, checkNumber, checkRev } from "./names.ts";
import { describeActions } from "./params.ts";
import type { ActionTable } from "./params.ts";
import { viewPr } from "./pr-read.ts";
import type { Call, Planned } from "./previews.ts";
import { digest } from "./previews.ts";
import { resolveRepo } from "./repo.ts";
import { currentBranch } from "./run.ts";
import { at, buildTool } from "./tool.ts";
import type { JigTool } from "./tool.ts";
import { KIND } from "./watch.ts";
import type { Finish, GithubSpec } from "./watch.ts";

export const CHECKS_ACTIONS = {
    status: {
        summary: "checks of a pull request, branch or commit",
        optional: ["repo", "number", "branch", "sha", "required_only"],
    },
    runs: {
        summary: "workflow runs by branch, commit or state",
        optional: ["repo", "branch", "sha", "state", "limit"],
    },
    run: { summary: "one run's jobs and steps", required: ["run_id"], optional: ["repo"] },
    artifacts: { summary: "a run's artifacts", required: ["run_id"], optional: ["repo"] },
    log: {
        summary: "a failed job's log: the tail, or the lines matching a search",
        optional: ["repo", "run_id", "number", "branch", "sha", "job", "tail", "grep"],
    },
    rerun: {
        summary: "rerun the failed jobs, or the whole run (asks)",
        required: ["run_id"],
        optional: ["repo", "failed_only"],
    },
    watch: {
        summary: "watch in the background until a finish line; returns its id",
        optional: ["repo", "number", "branch", "sha", "run_id", "finish", "check", "pattern", "bot"],
    },
} satisfies ActionTable;

const ACTION_NAMES = Object.keys(CHECKS_ACTIONS) as (keyof typeof CHECKS_ACTIONS)[];
const FINISHES = ["required", "check", "run", "approved", "merged", "comment", "tag", "release"] as const;

const ChecksParams = Type.Object(
    {
        action: StringEnum(ACTION_NAMES, { description: describeActions(CHECKS_ACTIONS) }),
        repo: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 1000,
                description:
                    "A folder in the workspace, or an absolute path inside a work tree. Omit it for the repo Pi runs in.",
            }),
        ),
        number: Type.Optional(Type.Integer({ minimum: 1, description: "A pull request number." })),
        branch: Type.Optional(
            Type.String({ minLength: 1, maxLength: 200, description: "A branch. Default: the checked-out branch." }),
        ),
        sha: Type.Optional(Type.String({ minLength: 4, maxLength: 64, description: "A commit." })),
        run_id: Type.Optional(Type.Integer({ minimum: 1, description: "A workflow run id, as runs lists them." })),
        required_only: Type.Optional(
            Type.Boolean({ description: "status: only the checks that branch protection requires." }),
        ),
        state: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 30,
                description: "runs: queued, in_progress, completed, success, failure, cancelled ...",
            }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "runs: how many. Default 20." })),
        job: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "log: a job name or id. Default: the first failed job.",
            }),
        ),
        tail: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 400, description: "log: how many lines from the end. Default 80." }),
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
        finish: Type.Optional(
            StringEnum(FINISHES, {
                description:
                    "watch: when it ends. required (default): the required checks. check: the one named in check. run: run_id. approved, merged: the pull request. comment: a bot comment matching pattern. tag, release: a new one matching pattern.",
            }),
        ),
        check: Type.Optional(
            Type.String({ minLength: 1, maxLength: 200, description: "watch: the name of the check to wait for." }),
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

/** Reads are external reads, rerun changes GitHub, and starting a watch is a local write: the engine lives on this machine. */
function classifyChecks(input: Readonly<Record<string, unknown>>): CallClass | undefined {
    const action = input.action;
    switch (action) {
        case "status":
        case "runs":
        case "run":
        case "artifacts":
        case "log":
            return at(action, "external", "read");
        case "rerun":
            return at(action, "external", "write");
        case "watch":
            return at(action, "local", "write");
        default:
            return undefined;
    }
}

// ---- rerun --------------------------------------------------------------------------------------------------------

async function planRerun(
    params: { repo?: string; run_id?: number; failed_only?: boolean },
    call: Call,
): Promise<Planned> {
    const id = checkNumber(params.run_id, "run_id");
    const failedOnly = params.failed_only !== false;
    const repo = await resolveRepo(params.repo, call.signal);
    const flags = await repoFlags(repo, call.settings, call.signal);
    // The signal is for the first look. The look after a lost reply must run even when the call was cancelled.
    const view = async (signal?: AbortSignal) =>
        ghJson<{ name: string; status: string; attempt: number; headBranch: string }>(
            "gh run view",
            await gh(["run", "view", String(id), "--json", "name,status,attempt,headBranch", ...flags], {
                cwd: repo.root,
                signal,
            }),
        );
    const run = await view(call.signal);
    if (run.status !== "completed")
        throw new Error(`run ${id} is ${run.status}; a run can be rerun once it has completed`);
    return {
        preview: {
            summary: `rerun ${failedOnly ? "the failed jobs" : "all jobs"} of run ${id} (${run.name}, ${run.headBranch}) in ${repo.name}`,
            fingerprint: digest("checks rerun", repo.root, id, run.attempt, failedOnly),
        },
        run: async () => {
            const done = `Started a rerun of ${failedOnly ? "the failed jobs of " : ""}run #${id} (${run.name}) in ${repo.name}.`;
            const sent = await ghWrite(
                "gh run rerun",
                ["run", "rerun", String(id), ...(failedOnly ? ["--failed"] : []), ...flags],
                { cwd: repo.root, signal: call.signal },
            );
            if (sent.kind === "sent") return { text: done };
            return afterLostReply("gh run rerun", sent.why, async () =>
                (await view()).attempt > run.attempt ? done : undefined,
            );
        },
    };
}

// ---- watch --------------------------------------------------------------------------------------------------------

interface WatchParams {
    repo?: string;
    number?: number;
    branch?: string;
    sha?: string;
    run_id?: number;
    finish?: (typeof FINISHES)[number];
    check?: string;
    pattern?: string;
    bot?: string;
}

const ENDS: Record<(typeof FINISHES)[number], string> = {
    required: "the required checks all pass, or the first one fails",
    check: "the check passes or fails",
    run: "the run ends, or one of its jobs fails",
    approved: "the pull request is approved, or changes are requested",
    merged: "the pull request is merged or closed",
    comment: "a matching comment appears",
    tag: "a matching tag appears",
    release: "a matching release appears",
};

function compiled(pattern: string | undefined, what: string): string {
    if (pattern === undefined)
        throw new Error(`checks watch with finish ${what} needs pattern. Usage: checks watch {finish, pattern, ...}`);
    try {
        new RegExp(pattern);
    } catch (error) {
        throw new Error(`checks watch: pattern is not a valid regular expression: ${(error as Error).message}`);
    }
    return pattern;
}

async function planWatch(params: WatchParams, call: Call): Promise<Planned> {
    const finishKind =
        params.finish ?? (params.run_id !== undefined ? "run" : params.check !== undefined ? "check" : "required");
    const repo = await resolveRepo(params.repo, call.signal);
    const slug = await requireSlug(repo, call.settings, call.signal);
    const { signal } = call;
    let finish: Finish;
    switch (finishKind) {
        case "required":
            finish = { kind: "required" };
            break;
        case "check":
            if (params.check === undefined)
                throw new Error(
                    "checks watch with finish check needs check, the name of the check. Usage: checks watch {finish: check, check, ...}",
                );
            finish = { kind: "check", name: params.check };
            break;
        case "run":
            checkNumber(params.run_id, "run_id");
            finish = { kind: "run" };
            break;
        case "approved":
        case "merged":
            checkNumber(params.number, "number");
            finish = { kind: "pr", state: finishKind };
            break;
        case "comment":
            checkNumber(params.number, "number");
            finish = {
                kind: "comment",
                pattern: compiled(params.pattern, "comment"),
                ...(params.bot === undefined ? {} : { bot: params.bot }),
                since: new Date().toISOString(),
            };
            break;
        default:
            finish = { kind: finishKind, pattern: compiled(params.pattern, finishKind) };
    }
    // The commit to watch is fixed now, so the watch is about what exists today and not about a branch that moves on.
    const needsCommit = finish.kind === "required" || finish.kind === "check";
    const spec: GithubSpec = { repo: slug, finish };
    if (params.number !== undefined) spec.pr = checkNumber(params.number);
    if (params.run_id !== undefined) spec.runId = checkNumber(params.run_id, "run_id");
    if (params.sha !== undefined) {
        spec.sha = (
            await apiJson<{ sha: string }>(`repos/${slug}/commits/${checkRev(params.sha, "sha")}`, {
                cwd: repo.root,
                signal,
            })
        ).sha;
    } else if (params.number !== undefined && (needsCommit || finish.kind === "pr")) {
        const pr = await viewPr(repo, String(params.number), call, "headRefOid,headRefName");
        spec.sha = pr.headRefOid;
        spec.branch = pr.headRefName;
    } else if (needsCommit) {
        const branch =
            params.branch === undefined ? await currentBranch(repo.root, signal) : checkBranch(params.branch);
        if (!branch) throw new Error(`HEAD is detached in ${repo.name}; pass number, branch or sha`);
        spec.branch = branch;
        spec.sha = (
            await apiJson<{ sha: string }>(`repos/${slug}/commits/${encodeURIComponent(branch)}`, {
                cwd: repo.root,
                signal,
            })
        ).sha;
    }
    if (params.branch !== undefined && spec.branch === undefined) spec.branch = checkBranch(params.branch);
    const title = titleOf(spec);
    return {
        preview: {
            summary: `watch ${title} in ${repo.name}, until ${ENDS[finishKind]}`,
            fingerprint: digest("checks watch", spec),
        },
        run: async () => {
            const settings = call.settings.watch;
            const id = jig().watches.start({
                kind: KIND,
                spec,
                title,
                timeoutMinutes: settings.timeoutMinutes,
                stallMinutes: settings.stallMinutes,
            });
            return {
                text: `Watching ${title} as ${id}. One message arrives when ${ENDS[finishKind]}. The watch tool lists and stops watches.`,
                details: { id, spec },
            };
        },
    };
}

/** One line naming what is watched, such as "checks of pull request 42" or "checks of branch x at abc1234". */
function titleOf(spec: GithubSpec): string {
    const finish = spec.finish;
    const where =
        spec.pr !== undefined
            ? `pull request ${spec.pr}`
            : spec.branch !== undefined
              ? `branch ${spec.branch}${spec.sha ? ` at ${spec.sha.slice(0, 7)}` : ""}`
              : spec.sha
                ? `commit ${spec.sha.slice(0, 7)}`
                : spec.repo;
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
            return `a new tag matching ${finish.pattern} in ${spec.repo}`;
        case "release":
            return `a new release matching ${finish.pattern} in ${spec.repo}`;
    }
}

function planChecks(params: Readonly<Record<string, unknown>>, call: Call): Promise<Planned> | Planned {
    const p = params as never;
    switch (params.action) {
        case "status":
            return planStatus(p, call);
        case "runs":
            return planRuns(p, call);
        case "run":
            return planRun(p, call);
        case "artifacts":
            return planArtifacts(p, call);
        case "log":
            return planLog(p, call);
        case "rerun":
            return planRerun(p, call);
        case "watch":
            return planWatch(p, call);
        default:
            throw new Error(`checks: unknown action ${String(params.action)}`);
    }
}

export const checksTool: JigTool = buildTool({
    name: "checks",
    label: "Checks",
    description:
        "GitHub checks and Actions: status, runs, run, artifacts, log, rerun, and watch, which waits in the background until a finish line and reports once. GitHub only.",
    promptSnippet: "GitHub checks and Actions: status, log, watch",
    promptGuidelines: [
        "After a push or a pull request a watch starts by itself and reports when the checks finish; do not poll with checks status.",
    ],
    parameters: ChecksParams,
    table: CHECKS_ACTIONS,
    classify: classifyChecks,
    plan: async (params, call) => planChecks(params, call),
});
