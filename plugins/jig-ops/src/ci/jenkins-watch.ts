// The Jenkins half of the CI watch: a build that finished, or the pipeline stages that must pass. jig-core's watch engine
// calls `poll` on a timer, saves the state it returns and sends the result to the agent.
//
//   build    the build ends (its result is set and it is no longer running)
//   stages   the named stages all pass, or the first of them fails. A build that ends without them is a failure
//
// A build is found by its number, or, with none, as the first one scheduled after the watch began. The spec holds the name
// of the service and never the address or the job: each poll finds them in the catalog as it is now.
import type { PollOutcome, WatchResult } from "../../../jig-core/src/contract.ts";
import { duration } from "../values.ts";
import type { CiContext } from "./adapter.ts";
import { addArtifacts } from "./artifacts.ts";
import { buildCheck, resultOf, stageCheck } from "./jenkins-api.ts";
import type { Build, JenkinsApi } from "./jenkins-api.ts";
import { failureExcerpt } from "./logs.ts";
import { count, describeCounts, judge } from "./model.ts";
import type { Check } from "./model.ts";
import type { PlainState } from "./gitlab-watch.ts";

export type JenkinsFinish =
    | { kind: "build" }
    /** One name is a `check`; the catalog's `required` is several. */
    | { kind: "stages"; names: string[] };

/** What a Jenkins watch watches. Plain JSON, because it is saved with the watch. */
export interface JenkinsSpec {
    system: "jenkins";
    service: string;
    /** The build number, when it is known. */
    build?: number;
    /** The commit the build is for, when the push that caused it is known. Only the artifact rules use it. */
    sha?: string;
    finish: JenkinsFinish;
    /** When the watch began, in milliseconds. A build found without a number must not have been scheduled before. */
    since: number;
}

/** A Jenkins server and the agent may disagree on the time by a few seconds. */
const SKEW_MS = 10_000;

/** One line naming what is watched, such as "build #12 of orders-api" or "stage test of the next build of orders-api". */
export function titleOf(spec: JenkinsSpec): string {
    const build =
        spec.build !== undefined ? `build #${spec.build} of ${spec.service}` : `the next build of ${spec.service}`;
    if (spec.finish.kind === "build") return build;
    const names = spec.finish.names;
    return names.length === 1 ? `stage ${names[0]} of ${build}` : `required stages ${names.join(", ")} of ${build}`;
}

/** One line for `watch list`: the service, then what it waits for. */
export function describeJenkins(spec: JenkinsSpec): string {
    return `${spec.service}: ${titleOf(spec)}`;
}

/** The build this watch follows, or undefined when none has been scheduled yet. */
async function findBuild(api: JenkinsApi, spec: JenkinsSpec, state: PlainState): Promise<Build | undefined> {
    if (state.found !== undefined) return api.build(state.found);
    const last = await api.build("lastBuild");
    if (last === undefined) return undefined;
    return (last.timestamp ?? 0) >= spec.since - SKEW_MS ? last : undefined;
}

function where(job: string, build: Build): string {
    return `build #${build.number} of ${job}`;
}

/** What to show of a failed build: the lines of its console around the first error. */
async function failureDetails(api: JenkinsApi, build: Build): Promise<string | undefined> {
    try {
        const excerpt = failureExcerpt(await api.console(build.number));
        return excerpt.trim() === "" ? undefined : excerpt;
    } catch {
        return undefined;
    }
}

function facts(checks: readonly Check[], build: Build) {
    return { ...count(checks), conclusion: resultOf(build).toLowerCase() };
}

async function evaluate(
    api: JenkinsApi,
    spec: JenkinsSpec,
    job: string,
    build: Build,
    ctx: CiContext,
): Promise<WatchResult | undefined> {
    const finish = spec.finish;
    const links = build.url ? [build.url] : undefined;
    let checks: Check[] = [buildCheck(job, build)];
    let relevant: readonly Check[] = checks;

    if (finish.kind === "stages") {
        const stages = await api.stages(build.number);
        if (stages === undefined) {
            throw new Error(
                `${where(job, build)} has no stage information: watching stages needs a pipeline job and the ` +
                    "Pipeline REST API plugin on the Jenkins server",
            );
        }
        checks = stages.map(stageCheck);
        // A stage that was not executed will never run, so for a watch that waits for it, that is the end.
        const named = checks.map((check) =>
            finish.names.includes(check.name) && check.bucket === "skipped"
                ? { ...check, bucket: "fail" as const }
                : check,
        );
        const judgement = judge(named, finish.names);
        relevant = judgement.relevant;
        if (judgement.verdict === "fail") {
            const first = judgement.failing[0] as Check;
            return {
                outcome: "failed",
                summary: `Stage ${first.name} ${first.detail === "failed" ? "failed" : `ended as ${first.detail}`} in ${where(job, build)}`,
                details: await failureDetails(api, build),
                links,
                facts: facts(relevant, build),
            };
        }
        if (judgement.verdict === "pending") {
            if (build.building) return undefined;
            const never =
                judgement.missing.length > 0 ? judgement.missing : judgement.relevant.map((stage) => stage.name);
            return {
                outcome: "failed",
                summary: `${where(job, build)} ended as ${resultOf(build)} without ${never.join(", ")}`,
                links,
                facts: facts(relevant, build),
            };
        }
    } else {
        if (build.building || build.result === null) return undefined;
        if (build.result !== "SUCCESS") {
            return {
                outcome: "failed",
                summary: `${where(job, build)} ended as ${build.result}`,
                details: await failureDetails(api, build),
                links,
                facts: facts(checks, build),
            };
        }
    }

    const took = build.duration ? ` in ${duration(build.duration)}` : "";
    const passed: WatchResult = {
        outcome: "passed",
        summary:
            finish.kind === "stages"
                ? `Required stages passed in ${where(job, build)}: ${describeCounts(count(relevant))}`
                : `${where(job, build)} succeeded${took}`,
        links,
        facts: facts(relevant, build),
    };
    if (spec.sha === undefined) return passed;
    return addArtifacts(passed, {
        repo: job,
        sha: spec.sha,
        rules: ctx.artifacts,
        // Jenkins keeps one log for the whole build, so a rule can name a stage but cannot read a version from its log.
        sources: {
            checks: async () => checks,
            log: async () => "",
            comments: async () => [],
            tags: async () => [],
            releases: async () => [],
        },
        announce: ctx.announce,
    });
}

/** One poll. A throw is a failed poll: the engine counts three in a row and pauses the watch with one notice. */
export async function pollJenkins(
    api: JenkinsApi,
    spec: JenkinsSpec,
    job: string,
    previous: PlainState | undefined,
    ctx: CiContext,
): Promise<PollOutcome<PlainState>> {
    const known = previous?.found ?? spec.build;
    const state: PlainState =
        known === undefined
            ? { polls: (previous?.polls ?? 0) + 1 }
            : { polls: (previous?.polls ?? 0) + 1, found: known };
    const wait = ctx.pollSeconds * 1000;
    const build = await findBuild(api, spec, state);
    if (build === undefined) return { state, nextPollMs: wait };
    state.found = build.number;
    const done = await evaluate(api, spec, job, build, ctx);
    return done ? { state, done } : { state, nextPollMs: wait };
}
