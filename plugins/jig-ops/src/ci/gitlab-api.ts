// GitLab's REST API (v4), for the adapter and the watch: the requests they make, what the replies hold, and how a job's
// status becomes one of the four words (pass, fail, pending, skipped). The project is the catalog's; a call never names
// one.
import { InputError } from "../values.ts";
import type { CiContext } from "./adapter.ts";
import type { GitlabConfig } from "./config.ts";
import { jsonOf } from "./http.ts";
import type { Check } from "./model.ts";
import { bucketOf } from "./model.ts";
import { sender } from "./request.ts";
import type { Reply } from "./request.ts";

export interface Pipeline {
    id: number;
    status: string;
    ref: string;
    sha: string;
    web_url?: string;
    source?: string;
    created_at?: string;
    finished_at?: string | null;
}

export interface GitlabJob {
    id: number;
    name: string;
    stage?: string;
    status: string;
    allow_failure?: boolean;
    web_url?: string;
    failure_reason?: string;
}

/** The statuses after which a pipeline changes nothing by itself. `manual` waits for a person, not for the server. */
const FINISHED = new Set(["success", "failed", "canceled", "skipped", "manual"]);

export function finished(pipeline: Pipeline): boolean {
    return FINISHED.has(pipeline.status);
}

/** The jobs of the log of a pipeline are cut to a page; GitLab's page is at most this many. */
export const PAGE = 100;
export const LOG_BYTES = 8 * 1024 * 1024;

/** GitLab filters pipelines by the exact commit id, so a short one would silently match nothing. */
export function fullSha(value: string, who: string): string {
    if (!/^[0-9a-f]{40}$/i.test(value)) {
        throw new InputError(
            `${who}: GitLab finds pipelines by the full 40-character commit id; got ${value.slice(0, 12)}`,
        );
    }
    return value.toLowerCase();
}

/** One job as a check. A job that may fail (`allow_failure`) does not fail the pipeline, so it does not fail here. */
export function jobCheck(job: GitlabJob): Check {
    const status = job.status;
    let conclusion: string;
    switch (status) {
        case "success":
            conclusion = "success";
            break;
        case "failed":
            conclusion = job.allow_failure === true ? "neutral" : "failure";
            break;
        case "canceled":
        case "canceling":
            conclusion = "cancelled";
            break;
        case "skipped":
            conclusion = "skipped";
            break;
        case "created":
        case "pending":
        case "running":
        case "preparing":
        case "scheduled":
        case "manual":
        case "waiting_for_resource":
        case "waiting_for_callback":
            conclusion = "";
            break;
        default:
            // A status nobody knows is not a pass.
            conclusion = "failure";
    }
    return {
        name: job.name,
        bucket: bucketOf(conclusion === "" ? "pending" : "completed", conclusion),
        detail: status === "failed" && job.allow_failure === true ? "failed (allowed)" : status,
        url: job.web_url,
        id: job.id,
        ...(job.failure_reason && job.failure_reason !== "script_failure" ? { title: job.failure_reason } : {}),
    };
}

export interface GitlabApi {
    pipeline(id: number): Promise<Pipeline>;
    /** The newest pipelines first. `query` holds GitLab's own filters: ref, sha, status, per_page. */
    pipelines(query: Readonly<Record<string, string | number>>): Promise<Pipeline[]>;
    /** The jobs of a pipeline, retried ones left out, at most one page. */
    jobs(pipelineId: number): Promise<GitlabJob[]>;
    /** The log of a job. */
    trace(jobId: number): Promise<string>;
    /** A POST under the project. The reply is returned whatever its status: the caller knows what each one means. */
    post(path: string, query?: Readonly<Record<string, string>>, body?: unknown): Promise<Reply>;
}

export function gitlabApi(config: GitlabConfig, ctx: CiContext): GitlabApi {
    const send = sender(
        { system: "gitlab", url: config.url, auth: config.auth },
        { signal: ctx.signal, timeoutMs: ctx.timeoutMs },
    );
    const project = `/api/v4/projects/${encodeURIComponent(config.project)}`;
    const queryOf = (query: Readonly<Record<string, string | number>> = {}): string => {
        const text = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
        return text === "" ? "" : `?${text}`;
    };

    return {
        async pipeline(id) {
            return jsonOf<Pipeline>(
                "GitLab",
                `GET /pipelines/${id}`,
                await send({ method: "GET", path: `${project}/pipelines/${id}` }),
            );
        },
        async pipelines(query) {
            const path = `${project}/pipelines${queryOf(query)}`;
            return jsonOf<Pipeline[]>("GitLab", "GET /pipelines", await send({ method: "GET", path }));
        },
        async jobs(pipelineId) {
            const path = `${project}/pipelines/${pipelineId}/jobs${queryOf({ per_page: PAGE })}`;
            const jobs = jsonOf<GitlabJob[]>(
                "GitLab",
                `GET /pipelines/${pipelineId}/jobs`,
                await send({ method: "GET", path }),
            );
            // GitLab lists the newest job first; the order of the stages is the order the jobs were created.
            return [...jobs].sort((a, b) => a.id - b.id);
        },
        async trace(jobId) {
            const reply = await send({
                method: "GET",
                path: `${project}/jobs/${jobId}/trace`,
                headers: { accept: "text/plain" },
                maxBytes: LOG_BYTES,
            });
            if (reply.status === 404)
                throw new Error(`job ${jobId} has no log (it has not started, or the log was erased)`);
            if (reply.status < 200 || reply.status > 299) {
                throw new Error(`GitLab GET /jobs/${jobId}/trace failed: HTTP ${reply.status}`);
            }
            return reply.body;
        },
        post(path, query, body) {
            return send({
                method: "POST",
                path: `${project}${path}${queryOf(query)}`,
                ...(body === undefined
                    ? {}
                    : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
            });
        },
    };
}
