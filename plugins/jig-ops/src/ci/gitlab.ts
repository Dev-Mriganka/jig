// The GitLab CI adapter: the pipelines, jobs and job logs of a project, through GitLab's REST API (v4). Reads are
// plain; `rerun` retries the failed jobs of a pipeline and `trigger` creates a pipeline, and both are previewed and
// sent once.
//
// GitLab has no "rerun everything": its retry runs the failed or cancelled jobs of a pipeline again, so `failed_only:
// false` is refused, and `trigger` on the same ref is the way to run it all.
import { digest, InputError, oneLine, plural } from "../values.ts";
import type { Outcome } from "../values.ts";
import type { ActionTable, CiAdapter, CiContext, CiSystemInfo, Params, Plan, WatchPlan } from "./adapter.ts";
import type { CiService } from "../catalog.ts";
import type { GitlabConfig } from "./config.ts";
import { fullSha, gitlabApi, finished, jobCheck } from "./gitlab-api.ts";
import type { GitlabApi, GitlabJob, Pipeline } from "./gitlab-api.ts";
import { pollGitlab, titleOf } from "./gitlab-watch.ts";
import type { GitlabFinish, GitlabSpec } from "./gitlab-watch.ts";
import { httpFailure, jsonOf } from "./http.ts";
import { afterLostReply } from "./lost.ts";
import { selectLog } from "./logs.ts";
import { count, describeCounts, listChecks } from "./model.ts";
import { RequestFailure } from "./request.ts";

export const TABLE: ActionTable = {
    status: { optional: ["branch", "sha", "run_id", "required_only"] },
    runs: { optional: ["branch", "sha", "state", "limit"] },
    run: { required: ["run_id"] },
    log: { optional: ["run_id", "branch", "sha", "job", "tail", "grep"] },
    rerun: { required: ["run_id"], optional: ["failed_only"] },
    trigger: { required: ["ref"], optional: ["parameters"] },
    watch: { optional: ["branch", "sha", "run_id", "finish", "check"] },
};

/** The statuses `runs` can filter by: GitLab's own. */
const STATES = [
    "created",
    "waiting_for_resource",
    "preparing",
    "waiting_for_callback",
    "pending",
    "running",
    "success",
    "failed",
    "canceling",
    "canceled",
    "skipped",
    "manual",
    "scheduled",
];

function short(sha: string): string {
    return sha.slice(0, 7);
}

function describePipeline(pipeline: Pipeline): string {
    return `#${pipeline.id} ${pipeline.status}  ${pipeline.ref} ${short(pipeline.sha)}`;
}

/** The GitLab entry of a service. A function declaration cannot keep the narrowing of a check made outside it. */
function gitlabConfig(service: CiService): GitlabConfig {
    if (service.ci.system !== "gitlab") throw new Error(`${service.name} is not a GitLab service`);
    return service.ci;
}

function gitlab(service: CiService, ctx: CiContext): CiAdapter {
    const config = gitlabConfig(service);
    const api: GitlabApi = gitlabApi(config, ctx);
    const where = config.project;

    /** The pipeline a call means: the id, else the newest for the commit or branch, else the newest of the project. */
    async function pipelineOf(params: Params, only?: string): Promise<Pipeline | undefined> {
        if (params.run_id !== undefined) return api.pipeline(params.run_id);
        const filters: Record<string, string | number> = { per_page: 1 };
        if (params.sha !== undefined) filters.sha = fullSha(params.sha, "ci");
        else if (params.branch !== undefined) filters.ref = params.branch;
        if (only !== undefined) filters.status = only;
        return (await api.pipelines(filters))[0];
    }

    // ---- status ---------------------------------------------------------------------------------------------------

    async function status(params: Params): Promise<Outcome> {
        if (params.run_id !== undefined && (params.branch !== undefined || params.sha !== undefined)) {
            throw new InputError("ci status takes one of run_id, branch or sha");
        }
        if (params.sha !== undefined && params.branch !== undefined) {
            throw new InputError("ci status takes one of run_id, branch or sha");
        }
        const pipeline = await pipelineOf(params);
        if (pipeline === undefined) return { text: `No pipelines match in ${where}.`, facts: {}, details: {} };
        let checks = (await api.jobs(pipeline.id)).map(jobCheck);
        let note = "";
        const required = params.required_only === true;
        if (required) {
            if (config.required.length > 0) {
                checks = checks.filter((check) => config.required.includes(check.name));
            } else {
                note = "\nNo required jobs are named in the catalog, so all jobs are shown.";
            }
        }
        const head =
            `pipeline #${pipeline.id} on ${pipeline.ref} at ${short(pipeline.sha)} is ${pipeline.status}` +
            `${required ? " (required jobs)" : ""}: ${describeCounts(count(checks))}`;
        const facts = { ...count(checks), conclusion: pipeline.status };
        const url = pipeline.web_url ? `\n${pipeline.web_url}` : "";
        if (checks.length === 0) return { text: `${head}; no jobs reported.${note}${url}`, facts, details: {} };
        return { text: `${head}\n${listChecks(checks)}${note}${url}`, facts, details: { pipeline: pipeline.id } };
    }

    // ---- runs -----------------------------------------------------------------------------------------------------

    async function runs(params: Params): Promise<Outcome> {
        if (params.state !== undefined && !STATES.includes(params.state)) {
            throw new InputError(`ci runs: state must be one of ${STATES.join(", ")}`);
        }
        const filters: Record<string, string | number> = {
            per_page: Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20))),
        };
        if (params.branch !== undefined) filters.ref = params.branch;
        if (params.sha !== undefined) filters.sha = fullSha(params.sha, "ci runs");
        if (params.state !== undefined) filters.status = params.state;
        const found = await api.pipelines(filters);
        if (found.length === 0) return { text: `No pipelines match in ${where}.`, facts: {}, details: { ids: [] } };
        const lines = found.map((pipeline) => {
            const created = (pipeline.created_at ?? "").slice(0, 16);
            return `${describePipeline(pipeline).padEnd(48)} ${pipeline.source ?? ""}  ${created}`.trimEnd();
        });
        return {
            text: `${where}: ${plural(found.length, "pipeline")}\n${lines.join("\n")}`,
            facts: {},
            details: { ids: found.map((pipeline) => pipeline.id) },
        };
    }

    // ---- run ------------------------------------------------------------------------------------------------------

    function jobLine(job: GitlabJob): string {
        const reason = job.status === "failed" && job.failure_reason ? `: ${job.failure_reason}` : "";
        const allowed = job.status === "failed" && job.allow_failure ? " (allowed to fail)" : "";
        return `${job.status.padEnd(10)} ${job.name} (stage ${job.stage ?? "?"}, job ${job.id})${allowed}${reason}`;
    }

    async function run(params: Params): Promise<Outcome> {
        const id = params.run_id as number;
        const pipeline = await api.pipeline(id);
        const jobs = await api.jobs(id);
        const out = [
            `Pipeline #${pipeline.id}: ${pipeline.status}`,
            [
                `${pipeline.ref} at ${short(pipeline.sha)}, ${pipeline.source ?? "unknown source"};`,
                pipeline.web_url ?? "",
            ]
                .join(" ")
                .trimEnd(),
            ...jobs.map(jobLine),
        ];
        return {
            text: out.join("\n"),
            facts: { conclusion: pipeline.status },
            details: { jobs: jobs.map((job) => job.id) },
        };
    }

    // ---- log ------------------------------------------------------------------------------------------------------

    async function log(params: Params): Promise<Outcome> {
        const pipeline = await pipelineOf(params, params.run_id === undefined ? "failed" : undefined);
        if (pipeline === undefined) {
            throw new Error("no failed pipeline found for that branch or commit; pass run_id");
        }
        const jobs = await api.jobs(pipeline.id);
        const wanted = params.job;
        const failed = jobs.filter((job) => job.status === "failed" && job.allow_failure !== true);
        const job =
            wanted === undefined
                ? failed[0]
                : (jobs.find((candidate) => String(candidate.id) === wanted || candidate.name === wanted) ??
                  jobs.find((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase())));
        if (job === undefined) {
            const names = jobs.map((candidate) => `${candidate.name} (${candidate.status})`);
            throw new Error(
                wanted === undefined
                    ? `pipeline ${pipeline.id} has no failed job; its jobs: ${names.join(", ")}`
                    : `pipeline ${pipeline.id} has no job called ${wanted}; its jobs: ${names.join(", ")}`,
            );
        }
        const picked = selectLog(await api.trace(job.id), { tail: params.tail, grep: params.grep });
        const head = `Pipeline #${pipeline.id}, job ${job.name} (${job.status}): ${picked.note}`;
        return { text: picked.text === "" ? head : `${head}\n${picked.text}`, facts: {}, details: { job: job.id } };
    }

    // ---- rerun ----------------------------------------------------------------------------------------------------

    async function rerun(params: Params): Promise<Plan> {
        if (params.failed_only === false) {
            throw new InputError(
                "ci rerun: GitLab CI retries the failed jobs of a pipeline only. " +
                    "To run everything again, use ci trigger on the same ref",
            );
        }
        const id = params.run_id as number;
        const pipeline = await api.pipeline(id);
        if (!finished(pipeline)) {
            throw new Error(`pipeline ${id} is ${pipeline.status}; a pipeline can be retried once it has finished`);
        }
        const retryable = (await api.jobs(id)).filter((job) => job.status === "failed" || job.status === "canceled");
        if (retryable.length === 0) {
            throw new Error(`pipeline ${id} has no failed or cancelled jobs, so there is nothing to retry`);
        }
        const names = retryable.map((job) => job.name);
        return {
            preview: {
                summary:
                    `retry the failed jobs of pipeline ${id} (${pipeline.ref}, ${short(pipeline.sha)}) in ${where}: ` +
                    names.join(", "),
                fingerprint: digest(
                    "ci rerun",
                    service.name,
                    where,
                    id,
                    pipeline.status,
                    retryable.map((job) => job.id),
                ),
            },
            send: async () => {
                const done = `Started a retry of the failed jobs of pipeline #${id} in ${where}: ${names.join(", ")}.`;
                // The pipeline leaves its finished state when the retry took effect. Nothing is sent again.
                const lost = (why: string) =>
                    afterLostReply("GitLab retry", why, "GitLab", async () => {
                        const after = await gitlabApi(config, { ...ctx, signal: undefined }).pipeline(id);
                        return finished(after) && after.status === pipeline.status ? undefined : done;
                    });
                let reply: Awaited<ReturnType<typeof api.post>>;
                try {
                    reply = await api.post(`/pipelines/${id}/retry`);
                } catch (error) {
                    if (error instanceof RequestFailure && error.lost) return lost(error.message);
                    if (ctx.signal?.aborted) return lost("the call was cancelled");
                    throw error;
                }
                if (reply.status >= 200 && reply.status < 300) {
                    return { text: done, facts: { outcome: "started" }, details: { pipeline: id } };
                }
                if (reply.status >= 500) return lost(`HTTP ${reply.status}`);
                throw httpFailure("GitLab", `POST /pipelines/${id}/retry`, reply);
            },
        };
    }

    // ---- trigger --------------------------------------------------------------------------------------------------

    async function trigger(params: Params): Promise<Plan> {
        const ref = params.ref as string;
        const variables = Object.entries(params.parameters ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
        // The newest pipeline of the ref is part of what the user approved: if another appears while they read, ask
        // again.
        const latest = (await api.pipelines({ ref, per_page: 1 }))[0];
        const shownVariables =
            variables.length === 0
                ? "none"
                : variables.map(([key, value]) => `${key}=${oneLine(value, 80)}`).join(", ");
        const body = [
            `Service:   ${service.name} (GitLab project ${where})`,
            `Ref:       ${ref}`,
            `Variables: ${shownVariables}`,
            `Latest on this ref: ${latest === undefined ? "none" : describePipeline(latest)}`,
            "",
            "A new pipeline is created once. If the reply is lost, whether it was created is checked once,",
            "and it is not created again.",
        ].join("\n");
        return {
            preview: {
                summary:
                    `create a pipeline on ${ref} in ${where}` +
                    (variables.length > 0 ? ` with ${plural(variables.length, "variable")}` : ""),
                body,
                format: "text",
                fingerprint: digest("ci trigger", service.name, where, ref, variables, latest?.id ?? null),
            },
            send: async () => {
                const sentBody =
                    variables.length === 0
                        ? undefined
                        : { variables: variables.map(([key, value]) => ({ key, value, variable_type: "env_var" })) };
                const created = (pipeline: Pipeline) =>
                    [
                        `Created pipeline #${pipeline.id} on ${pipeline.ref} (${pipeline.status}) in ${where}:`,
                        pipeline.web_url ?? "",
                    ]
                        .join(" ")
                        .trimEnd();
                // A pipeline newer than the one the user saw is taken to be the one this call created.
                const lost = (why: string) =>
                    afterLostReply("GitLab create pipeline", why, "GitLab", async () => {
                        const check = gitlabApi(config, { ...ctx, signal: undefined });
                        const after = (await check.pipelines({ ref, per_page: 1 }))[0];
                        return after === undefined || after.id === latest?.id ? undefined : created(after);
                    });
                let reply: Awaited<ReturnType<typeof api.post>>;
                try {
                    reply = await api.post("/pipeline", { ref }, sentBody);
                } catch (error) {
                    if (error instanceof RequestFailure && error.lost) return lost(error.message);
                    if (ctx.signal?.aborted) return lost("the call was cancelled");
                    throw error;
                }
                if (reply.status >= 500) return lost(`HTTP ${reply.status}`);
                const pipeline = jsonOf<Pipeline>("GitLab", "POST /pipeline", reply);
                return { text: created(pipeline), facts: { outcome: "created" }, details: { pipeline: pipeline.id } };
            },
        };
    }

    // ---- watch ----------------------------------------------------------------------------------------------------

    async function watch(params: Params): Promise<WatchPlan> {
        const finishName =
            params.finish ?? (params.check !== undefined ? "check" : params.run_id !== undefined ? "run" : "required");
        let finish: GitlabFinish;
        switch (finishName) {
            case "run":
                finish = { kind: "pipeline" };
                break;
            case "check":
                if (params.check === undefined) {
                    throw new InputError(
                        "ci watch with finish check needs check, the name of the job. " +
                            "Usage: ci watch {service, finish: check, check, ...}",
                    );
                }
                finish = { kind: "jobs", names: [params.check] };
                break;
            case "required":
                finish =
                    config.required.length > 0 ? { kind: "jobs", names: [...config.required] } : { kind: "pipeline" };
                break;
            default:
                throw new InputError(
                    `ci watch: GitLab CI does not support finish ${finishName}. It supports: required, check, run`,
                );
        }
        if (params.run_id === undefined && params.branch === undefined && params.sha === undefined) {
            throw new InputError(
                "ci watch for GitLab CI needs run_id, branch or sha. Usage: ci watch {service, branch, ...}",
            );
        }
        const spec: GitlabSpec = { system: "gitlab", service: service.name, finish, since: ctx.now() };
        if (params.run_id !== undefined) {
            const pipeline = await api.pipeline(params.run_id);
            Object.assign(spec, { pipelineId: pipeline.id, ref: pipeline.ref, sha: pipeline.sha });
        } else if (params.sha !== undefined) {
            spec.sha = fullSha(params.sha, "ci watch");
            if (params.branch !== undefined) spec.ref = params.branch;
        } else if (params.branch !== undefined) {
            spec.ref = params.branch;
            // The newest pipeline of the branch now. A branch with none yet is followed until one is created.
            const newest = (await api.pipelines({ ref: params.branch, per_page: 1 }))[0];
            if (newest !== undefined) Object.assign(spec, { pipelineId: newest.id, sha: newest.sha });
        }
        const ends =
            finish.kind === "pipeline"
                ? "the pipeline ends, or one of its jobs fails"
                : "the named jobs all pass, or the first one fails";
        return { spec, title: titleOf(spec), ends };
    }

    return {
        status,
        runs,
        run,
        log,
        rerun,
        trigger,
        watch,
        poll: (spec, previous) => {
            if (spec.system !== "gitlab") throw new Error(`a ${spec.system} watch cannot be polled as GitLab CI`);
            const held = previous !== undefined && !("answers" in previous) ? previous : undefined;
            return pollGitlab(api, spec, service.repo ?? where, held, ctx);
        },
    };
}

export const GITLAB: CiSystemInfo = { system: "gitlab", label: "GitLab CI", table: TABLE, create: gitlab };
