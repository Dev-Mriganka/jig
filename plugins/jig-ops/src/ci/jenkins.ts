// The Jenkins adapter: the builds, stages and console logs of a job, through Jenkins' remote access API. Reads are
// plain; `trigger` starts a build with a CSRF crumb, previewed and sent once.
//
// Jenkins has no commit, branch or pull request in the data of a plain job, so a build is found by its number or as the
// last one. It has no rerun either: Jenkins' own rebuild is a plugin, and a build that took passwords as parameters
// cannot be rebuilt from what the API shows, so `rerun` is not offered; `trigger` starts a new build with the
// parameters the call names. Stages are read from the Pipeline REST API plugin when the server has it.
import { digest, duration, InputError, plural } from "../values.ts";
import type { Outcome } from "../values.ts";
import type { CiService } from "../catalog.ts";
import type { JenkinsConfig } from "./config.ts";
import type { ActionTable, CiAdapter, CiContext, CiSystemInfo, Params, Plan, WatchPlan } from "./adapter.ts";
import { httpFailure } from "./http.ts";
import { buildCheck, jenkinsApi, resultOf, stageCheck } from "./jenkins-api.ts";
import type { Build, JenkinsApi, Stage } from "./jenkins-api.ts";
import { pollJenkins, titleOf } from "./jenkins-watch.ts";
import type { JenkinsFinish, JenkinsSpec } from "./jenkins-watch.ts";
import { selectLog } from "./logs.ts";
import { afterLostReply } from "./lost.ts";
import { count, describeCounts, listChecks } from "./model.ts";
import { RequestFailure } from "./request.ts";

export const TABLE: ActionTable = {
    status: { optional: ["run_id"] },
    runs: { optional: ["state", "limit"] },
    run: { optional: ["run_id"] },
    log: { optional: ["run_id", "tail", "grep"] },
    trigger: { optional: ["parameters"] },
    watch: { optional: ["run_id", "finish", "check"] },
};

/** What `runs` can filter by: a Jenkins result, or `building`. */
const STATES = ["building", "success", "unstable", "failure", "aborted", "not_built"];

function when(build: Build): string {
    return build.timestamp === undefined ? "" : new Date(build.timestamp).toISOString().slice(0, 16);
}

function stageLine(stage: Stage): string {
    const took = stage.durationMillis === undefined ? "" : ` (${duration(stage.durationMillis)})`;
    return `${stage.status.toLowerCase().padEnd(12)} ${stage.name}${took}`;
}

/** The Jenkins entry of a service. A function declaration cannot keep the narrowing of a check made outside it. */
function jenkinsConfig(service: CiService): JenkinsConfig {
    if (service.ci.system !== "jenkins") throw new Error(`${service.name} is not a Jenkins service`);
    return service.ci;
}

function jenkins(service: CiService, ctx: CiContext): CiAdapter {
    const config = jenkinsConfig(service);
    const api: JenkinsApi = jenkinsApi(config, ctx);
    const job = config.job;

    /** The build a call means: the number, else the last one. A job that was never built has none, and says so. */
    async function buildOf(params: Params, which: "lastBuild" | "lastFailedBuild" = "lastBuild"): Promise<Build> {
        const found = await api.build(params.run_id ?? which);
        if (found !== undefined) return found;
        throw new Error(
            params.run_id !== undefined
                ? `${job} has no build ${params.run_id}`
                : which === "lastFailedBuild"
                  ? `${job} has no failed build; pass run_id`
                  : `${job} has no build yet`,
        );
    }

    function headOf(build: Build): string {
        const took = build.duration ? `, took ${duration(build.duration)}` : "";
        const at = when(build) === "" ? "" : ` (${when(build)})`;
        return `build #${build.number} of ${job}: ${resultOf(build)}${took}${at}`;
    }

    // ---- status ---------------------------------------------------------------------------------------------------

    async function status(params: Params): Promise<Outcome> {
        const build = await buildOf(params);
        const stages = (await api.stages(build.number)) ?? [];
        const checks = stages.length > 0 ? stages.map(stageCheck) : [buildCheck(job, build)];
        const facts = { ...count(checks), conclusion: resultOf(build).toLowerCase() };
        const counted = stages.length > 0 ? `; stages: ${describeCounts(count(checks))}` : "";
        const body = stages.length > 0 ? `\n${listChecks(checks)}` : "";
        return {
            text: headOf(build) + counted + body + (build.url ? `\n${build.url}` : ""),
            facts,
            details: { build: build.number },
        };
    }

    // ---- runs -----------------------------------------------------------------------------------------------------

    async function runs(params: Params): Promise<Outcome> {
        const wanted = params.state?.toLowerCase();
        if (wanted !== undefined && !STATES.includes(wanted)) {
            throw new InputError(`ci runs: state must be one of ${STATES.join(", ")}`);
        }
        const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20)));
        // A filter is applied to the builds Jenkins sent, so ask for all that may be wanted and cut after.
        const all = await api.builds(wanted === undefined ? limit : 100);
        const found = all
            .filter((build) => wanted === undefined || resultOf(build).toLowerCase() === wanted)
            .slice(0, limit);
        if (found.length === 0) return { text: `No builds match in ${job}.`, facts: {}, details: { numbers: [] } };
        const lines = found.map((build) => `#${build.number} ${resultOf(build).padEnd(10)} ${when(build)}`.trimEnd());
        return {
            text: `${job}: ${plural(found.length, "build")}\n${lines.join("\n")}`,
            facts: {},
            details: { numbers: found.map((build) => build.number) },
        };
    }

    // ---- run ------------------------------------------------------------------------------------------------------

    async function run(params: Params): Promise<Outcome> {
        const build = await buildOf(params);
        const stages = await api.stages(build.number);
        const out = [headOf(build), build.url ?? ""].filter(Boolean);
        if (stages === undefined)
            out.push("(no stage information: not a pipeline job, or the server lacks the Pipeline REST API plugin)");
        else out.push(...stages.map(stageLine));
        return {
            text: out.join("\n"),
            facts: { conclusion: resultOf(build).toLowerCase() },
            details: { build: build.number },
        };
    }

    // ---- log ------------------------------------------------------------------------------------------------------

    async function log(params: Params): Promise<Outcome> {
        const build = await buildOf(params, "lastFailedBuild");
        const picked = selectLog(await api.console(build.number), { tail: params.tail, grep: params.grep });
        const head = `Build #${build.number} of ${job} (${resultOf(build)}): ${picked.note}`;
        return {
            text: picked.text === "" ? head : `${head}\n${picked.text}`,
            facts: {},
            details: { build: build.number },
        };
    }

    // ---- trigger --------------------------------------------------------------------------------------------------

    async function trigger(params: Params): Promise<Plan> {
        const entries = Object.entries(params.parameters ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
        const parameters = Object.fromEntries(entries);
        const before = await api.job();
        if (before.buildable === false) throw new Error(`${job} is disabled in Jenkins, so it cannot be built`);
        const shownParameters =
            entries.length === 0
                ? "none (a plain build)"
                : entries.map(([key, value]) => `${key}=${value.slice(0, 80)}`).join(", ");
        const body = [
            `Service:    ${service.name} (Jenkins job ${job})`,
            `Parameters: ${shownParameters}`,
            `Next build number: ${before.nextBuildNumber ?? "unknown"}` +
                (before.inQueue ? "; a build is already waiting in the queue" : ""),
            "",
            "A build is queued once. If the reply is lost, whether it was queued is checked once,",
            "and it is not queued again.",
        ].join("\n");
        return {
            preview: {
                summary:
                    `start a build of ${job}` +
                    (entries.length > 0 ? ` with ${plural(entries.length, "parameter")}` : ""),
                body,
                format: "text",
                fingerprint: digest(
                    "ci trigger",
                    service.name,
                    job,
                    entries,
                    before.nextBuildNumber ?? null,
                    before.inQueue ?? null,
                ),
            },
            send: async () => {
                const queued = `Queued a build of ${job}.`;
                // A build that was queued moves the next number on, or fills the queue.
                const lost = (why: string) =>
                    afterLostReply("Jenkins build", why, "Jenkins", async () => {
                        const after = await jenkinsApi(config, { ...ctx, signal: undefined }).job();
                        const moved = (after.nextBuildNumber ?? 0) > (before.nextBuildNumber ?? Infinity);
                        return moved || (after.inQueue === true && before.inQueue !== true) ? queued : undefined;
                    });
                // The crumb is asked for before anything is sent. If that fails, nothing has changed.
                const crumb = await api.crumb();
                let reply: Awaited<ReturnType<typeof api.start>>;
                try {
                    reply = await api.start(parameters, crumb);
                } catch (error) {
                    if (error instanceof RequestFailure && error.lost) return lost(error.message);
                    if (ctx.signal?.aborted) return lost("the call was cancelled");
                    throw error;
                }
                if (reply.status >= 500) return lost(`HTTP ${reply.status}`);
                // Jenkins answers 201 with the address of the queue item, or 303 when the same request is already
                // queued.
                if (reply.status !== 201 && reply.status !== 303)
                    throw httpFailure("Jenkins", `POST build of ${job}`, reply);
                const item = reply.headers.location;
                const merged =
                    reply.status === 303 ? " (the same request was already queued, so it was merged with it)" : "";
                return {
                    text: `${queued}${merged}${item ? ` Queue item: ${item}` : ""}`,
                    facts: { outcome: reply.status === 303 ? "merged" : "queued" },
                    details: { status: reply.status },
                };
            },
        };
    }

    // ---- watch ----------------------------------------------------------------------------------------------------

    async function watch(params: Params): Promise<WatchPlan> {
        const finishName =
            params.finish ?? (params.check !== undefined ? "check" : params.run_id !== undefined ? "run" : "required");
        let finish: JenkinsFinish;
        switch (finishName) {
            case "run":
                finish = { kind: "build" };
                break;
            case "check":
                if (params.check === undefined) {
                    throw new InputError(
                        "ci watch with finish check needs check, the name of the stage. " +
                            "Usage: ci watch {service, finish: check, check, ...}",
                    );
                }
                finish = { kind: "stages", names: [params.check] };
                break;
            case "required":
                finish =
                    config.required.length > 0 ? { kind: "stages", names: [...config.required] } : { kind: "build" };
                break;
            default:
                throw new InputError(
                    `ci watch: Jenkins does not support finish ${finishName}. It supports: required, check, run`,
                );
        }
        const spec: JenkinsSpec = { system: "jenkins", service: service.name, finish, since: ctx.now() };
        if (params.run_id !== undefined) {
            spec.build = (await buildOf(params)).number;
        } else {
            // A build that is running now is the one to follow. Otherwise the next one that is scheduled.
            const last = await api.build("lastBuild");
            if (last?.building === true) spec.build = last.number;
        }
        const ends = finish.kind === "build" ? "the build ends" : "the named stages all pass, or the first one fails";
        return { spec, title: titleOf(spec), ends };
    }

    return {
        status,
        runs,
        run,
        log,
        trigger,
        watch,
        poll: (spec, previous) => {
            if (spec.system !== "jenkins") throw new Error(`a ${spec.system} watch cannot be polled as Jenkins`);
            const held = previous !== undefined && !("answers" in previous) ? previous : undefined;
            return pollJenkins(api, spec, job, held, ctx);
        },
    };
}

export const JENKINS: CiSystemInfo = { system: "jenkins", label: "Jenkins", table: TABLE, create: jenkins };
