// The GitLab half of the CI watch: a pipeline that finished, or the jobs that must pass. jig-core's watch engine calls
// `poll` on a timer, saves the state it returns and sends the result to the agent.
//
//   pipeline   the pipeline ends, or one of its jobs fails (the first failed job ends the watch, as a failed run does)
//   jobs       the named jobs all pass, or the first of them fails. A pipeline that ends without them is a failure
//
// A pipeline is found by its id, by the commit it ran for, or, with only a branch, as the first one created after the
// watch began. The spec holds the name of the service and never the project or the address: each poll finds them in the
// catalog as it is now.
import type { PollOutcome, WatchResult } from "../../../jig-core/src/contract.ts";
import type { CiContext } from "./adapter.ts";
import { addArtifacts } from "./artifacts.ts";
import type { ArtifactSources } from "./artifacts.ts";
import { finished, jobCheck } from "./gitlab-api.ts";
import type { GitlabApi, GitlabJob, Pipeline } from "./gitlab-api.ts";
import { failureExcerpt } from "./logs.ts";
import { count, describeCounts, judge } from "./model.ts";
import type { Check } from "./model.ts";

export type GitlabFinish =
    | { kind: "pipeline" }
    /** One name is a `check`; the catalog's `required` is several. */
    | { kind: "jobs"; names: string[] };

/** What a GitLab watch watches. Plain JSON, because it is saved with the watch. */
export interface GitlabSpec {
    system: "gitlab";
    service: string;
    ref?: string;
    /** The full id of the commit whose pipeline is watched. */
    sha?: string;
    pipelineId?: number;
    finish: GitlabFinish;
    /** When the watch began, in milliseconds. A pipeline found by branch alone must not be older. */
    since: number;
}

/** What a GitLab or Jenkins watch remembers between polls. Plain JSON. */
export interface PlainState {
    polls: number;
    /** The pipeline or build found by the first poll that found one; the others follow it. */
    found?: number;
}

/** Clocks of the agent and the server differ a little, and a pipeline starts a moment before the watch. */
const SKEW_MS = 60_000;

/** One line naming what is watched, such as "pipeline of branch main at abc1234" or "job build of pipeline #12". */
export function titleOf(spec: GitlabSpec): string {
    const sha = spec.sha ? ` at ${spec.sha.slice(0, 7)}` : "";
    const pipeline =
        spec.pipelineId !== undefined
            ? `pipeline #${spec.pipelineId}`
            : spec.ref
              ? `branch ${spec.ref}${sha}`
              : `commit ${spec.sha?.slice(0, 7) ?? "?"}`;
    if (spec.finish.kind === "pipeline") return spec.pipelineId !== undefined ? pipeline : `pipeline of ${pipeline}`;
    const names = spec.finish.names;
    return names.length === 1 ? `job ${names[0]} of ${pipeline}` : `required jobs ${names.join(", ")} of ${pipeline}`;
}

/** One line for `watch list`: the service, then what it waits for. */
export function describeGitlab(spec: GitlabSpec): string {
    return `${spec.service}: ${titleOf(spec)}`;
}

/** The pipeline this watch follows, or undefined when none has been created yet. */
async function findPipeline(api: GitlabApi, spec: GitlabSpec, state: PlainState): Promise<Pipeline | undefined> {
    if (state.found !== undefined) return api.pipeline(state.found);
    if (spec.sha !== undefined) return (await api.pipelines({ sha: spec.sha, per_page: 1 }))[0];
    if (spec.ref !== undefined) {
        const recent = await api.pipelines({ ref: spec.ref, per_page: 5 });
        return recent.find((pipeline) => Date.parse(pipeline.created_at ?? "") >= spec.since - SKEW_MS);
    }
    return undefined;
}

function ending(job: Check): string {
    if (job.detail === "skipped") return "was skipped";
    return job.detail === "failed" || job.detail === undefined ? "failed" : `ended as ${job.detail}`;
}

/** What to show of a failed job: the lines of its log around the first error, else the reason GitLab gives. */
async function failureDetails(api: GitlabApi, job: Check): Promise<string | undefined> {
    if (job.id !== undefined) {
        try {
            const excerpt = failureExcerpt(await api.trace(job.id));
            if (excerpt.trim() !== "") return `${job.name}:\n${excerpt}`;
        } catch {
            // No log: fall back to what GitLab says about the job itself.
        }
    }
    return job.title ? `${job.name}: ${job.title}` : undefined;
}

function links(checks: readonly Check[], max = 5): string[] {
    return checks.flatMap((check) => check.url ?? []).slice(0, max);
}

function facts(checks: readonly Check[], pipeline: Pipeline) {
    return { ...count(checks), conclusion: pipeline.status };
}

function where(pipeline: Pipeline): string {
    return `pipeline #${pipeline.id} (${pipeline.ref} at ${pipeline.sha.slice(0, 7)})`;
}

/** The sources the artifact rules read, for a pipeline: its jobs and their logs. GitLab has no pull request comments here. */
function sourcesOf(api: GitlabApi, checks: readonly Check[]): ArtifactSources {
    return {
        checks: async () => checks,
        log: (jobId) => api.trace(jobId),
        comments: async () => [],
        tags: async () => [],
        releases: async () => [],
    };
}

async function evaluate(
    api: GitlabApi,
    spec: GitlabSpec,
    pipeline: Pipeline,
    repo: string,
    ctx: CiContext,
): Promise<WatchResult | undefined> {
    const jobs: GitlabJob[] = await api.jobs(pipeline.id);
    const checks = jobs.map(jobCheck);
    const finish = spec.finish;

    let failing: Check[];
    let relevant: readonly Check[] = checks;
    if (finish.kind === "jobs") {
        // A job that was skipped will never run, so for a watch that waits for it, that is the end.
        const named = checks.map((check) =>
            finish.names.includes(check.name) && check.bucket === "skipped"
                ? { ...check, bucket: "fail" as const }
                : check,
        );
        const judgement = judge(named, finish.names);
        relevant = judgement.relevant;
        failing = judgement.failing;
        if (failing.length === 0 && judgement.verdict === "pending") {
            if (!finished(pipeline)) return undefined;
            const never = judgement.missing.length > 0 ? judgement.missing : judgement.relevant.map((job) => job.name);
            return {
                outcome: "failed",
                summary: `${where(pipeline)} ended as ${pipeline.status} without ${never.join(", ")}`,
                links: pipeline.web_url ? [pipeline.web_url] : undefined,
                facts: facts(relevant, pipeline),
            };
        }
    } else {
        failing = checks.filter((check) => check.bucket === "fail");
    }

    // The first failed job ends the watch; there is no need to wait for the rest of the pipeline.
    if (failing.length > 0) {
        const first = failing[0] as Check;
        const others = failing.length - 1;
        return {
            outcome: "failed",
            summary: `Job ${first.name} ${ending(first)} in ${where(pipeline)}${others > 0 ? ` (and ${others} more failing)` : ""}`,
            details: await failureDetails(api, first),
            links: links(failing),
            facts: facts(relevant, pipeline),
        };
    }
    if (finish.kind === "pipeline") {
        if (!finished(pipeline)) return undefined;
        if (pipeline.status !== "success" && pipeline.status !== "manual") {
            return {
                outcome: "failed",
                summary: `${where(pipeline)} ended as ${pipeline.status}`,
                links: pipeline.web_url ? [pipeline.web_url] : undefined,
                facts: facts(checks, pipeline),
            };
        }
    } else if (judge(checks, finish.names).verdict !== "pass") {
        return undefined;
    }

    const waiting = pipeline.status === "manual" ? "; it waits for a person to start a manual job" : "";
    const passed: WatchResult = {
        outcome: "passed",
        summary:
            `${finish.kind === "jobs" ? "Required jobs passed" : "Pipeline passed"} for ${where(pipeline)}: ` +
            `${describeCounts(count(relevant))}${waiting}`,
        links: pipeline.web_url ? [pipeline.web_url] : undefined,
        facts: facts(relevant, pipeline),
    };
    return addArtifacts(passed, {
        repo,
        sha: pipeline.sha,
        rules: ctx.artifacts,
        sources: sourcesOf(api, checks),
        announce: ctx.announce,
    });
}

/** One poll. A throw is a failed poll: the engine counts three in a row and pauses the watch with one notice. */
export async function pollGitlab(
    api: GitlabApi,
    spec: GitlabSpec,
    repo: string,
    previous: PlainState | undefined,
    ctx: CiContext,
): Promise<PollOutcome<PlainState>> {
    const state: PlainState = { polls: (previous?.polls ?? 0) + 1, found: previous?.found ?? spec.pipelineId };
    const wait = ctx.pollSeconds * 1000;
    const pipeline = await findPipeline(api, spec, state);
    if (pipeline === undefined) return { state, nextPollMs: wait };
    state.found = pipeline.id;
    const done = await evaluate(api, spec, pipeline, repo, ctx);
    return done ? { state, done } : { state, nextPollMs: wait };
}
