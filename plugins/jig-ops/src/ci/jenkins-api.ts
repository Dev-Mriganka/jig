// Jenkins' remote access API, for the adapter and the watch: the requests they make, what the replies hold, and how a
// build result or a stage status becomes one of the four words (pass, fail, pending, skipped). The job is the
// catalog's; a call never names one.
import type { CiContext } from "./adapter.ts";
import type { JenkinsConfig } from "./config.ts";
import { httpFailure, jsonOf } from "./http.ts";
import { bucketOf } from "./model.ts";
import type { Check } from "./model.ts";
import { sender } from "./request.ts";
import type { Reply } from "./request.ts";

/** A build, as `tree=` asks for it. `result` is null until the build ends. */
export interface Build {
    number: number;
    result: string | null;
    building: boolean;
    /** When the build was scheduled, in milliseconds since the epoch. */
    timestamp?: number;
    duration?: number;
    url?: string;
}

/** A stage of a pipeline build, from the Pipeline REST API plugin's `wfapi/describe`. */
export interface Stage {
    name: string;
    status: string;
    durationMillis?: number;
}

/** What the job itself says, before a build is asked for. */
export interface JobInfo {
    name?: string;
    buildable?: boolean;
    inQueue?: boolean;
    nextBuildNumber?: number;
}

export const LOG_BYTES = 8 * 1024 * 1024;
const BUILD_FIELDS = "number,result,building,timestamp,duration,url";

/** The permalinks of a job that `build` accepts besides a number. */
export type Which = number | "lastBuild" | "lastFailedBuild";

/** A build's outcome as a word: its result, or `building` while it has none. */
export function resultOf(build: Build): string {
    return build.result ?? (build.building ? "BUILDING" : "PENDING");
}

/** A finished build as a check, so a build and a stage are judged by the same words. */
export function buildCheck(job: string, build: Build): Check {
    const result = (build.result ?? "").toUpperCase();
    let conclusion: string;
    if (build.building || result === "") conclusion = "";
    else if (result === "SUCCESS") conclusion = "success";
    else if (result === "NOT_BUILT") conclusion = "skipped";
    else if (result === "ABORTED") conclusion = "cancelled";
    else conclusion = "failure";
    return {
        name: job,
        bucket: bucketOf(conclusion === "" ? "pending" : "completed", conclusion),
        detail: resultOf(build).toLowerCase(),
        url: build.url,
    };
}

/** A stage as a check. */
export function stageCheck(stage: Stage): Check {
    let conclusion: string;
    switch (stage.status.toUpperCase()) {
        case "SUCCESS":
            conclusion = "success";
            break;
        case "FAILED":
        case "UNSTABLE":
            conclusion = "failure";
            break;
        case "ABORTED":
            conclusion = "cancelled";
            break;
        case "NOT_EXECUTED":
            conclusion = "skipped";
            break;
        case "IN_PROGRESS":
        case "PAUSED_PENDING_INPUT":
            conclusion = "";
            break;
        default:
            // A status nobody knows is not a pass.
            conclusion = "failure";
    }
    return {
        name: stage.name,
        bucket: bucketOf(conclusion === "" ? "pending" : "completed", conclusion),
        detail: stage.status.toLowerCase(),
    };
}

export interface JenkinsApi {
    /** One build of the job, or undefined when there is none (no build yet, or a number that was not built). */
    build(which: Which): Promise<Build | undefined>;
    /** The newest builds first. */
    builds(limit: number): Promise<Build[]>;
    /** The stages of a pipeline build, or undefined when the server cannot tell (no Pipeline REST API plugin). */
    stages(number: number): Promise<Stage[] | undefined>;
    /** The console log of a build. */
    console(number: number): Promise<string>;
    job(): Promise<JobInfo>;
    /** The headers of the CSRF crumb a POST needs, none when the server wants none. Nothing is changed by asking. */
    crumb(): Promise<Crumb>;
    /** Starts a build, once, with the crumb. The reply is returned whatever its status. */
    start(parameters: Readonly<Record<string, string>>, crumb: Crumb): Promise<Reply>;
}

/** Headers that go with a POST: the crumb, and the session cookies it is tied to. */
export type Crumb = Readonly<Record<string, string>>;

export function jenkinsApi(config: JenkinsConfig, ctx: CiContext): JenkinsApi {
    const http = { system: "jenkins", url: config.url, auth: config.auth } as const;
    const send = sender(http, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
    // A job in a folder is `/job/folder/job/name`. Each part is encoded, so a space or a slash in a name is only a
    // name.
    const job = `/job/${config.job.split("/").map(encodeURIComponent).join("/job/")}`;
    const get = (path: string, accept = "application/json", maxBytes?: number) =>
        send({ method: "GET", path, headers: { accept }, ...(maxBytes === undefined ? {} : { maxBytes }) });

    return {
        async build(which) {
            const reply = await get(`${job}/${which}/api/json?tree=${BUILD_FIELDS}`);
            if (reply.status === 404) return undefined;
            return jsonOf<Build>("Jenkins", `GET ${which} build`, reply);
        },
        async builds(limit) {
            const tree = encodeURIComponent(`builds[${BUILD_FIELDS}]{0,${limit}}`);
            const reply = await get(`${job}/api/json?tree=${tree}`);
            return jsonOf<{ builds?: Build[] }>("Jenkins", "GET builds", reply).builds ?? [];
        },
        async stages(number) {
            const reply = await get(`${job}/${number}/wfapi/describe`);
            // A job that is not a pipeline, or a server without the plugin, has no such page.
            if (reply.status === 404) return undefined;
            const found = jsonOf<{ stages?: Array<{ name?: string; status?: string; durationMillis?: number }> }>(
                "Jenkins",
                `GET build ${number} stages`,
                reply,
            );
            return (found.stages ?? []).map((stage) => ({
                name: stage.name ?? "stage",
                status: stage.status ?? "",
                ...(stage.durationMillis === undefined ? {} : { durationMillis: stage.durationMillis }),
            }));
        },
        async console(number) {
            const reply = await get(`${job}/${number}/consoleText`, "text/plain", LOG_BYTES);
            if (reply.status === 404) throw new Error(`build ${number} has no console log`);
            if (reply.status < 200 || reply.status > 299)
                throw httpFailure("Jenkins", `GET build ${number} console`, reply);
            return reply.body;
        },
        async job() {
            const tree = "name,buildable,inQueue,nextBuildNumber";
            return jsonOf<JobInfo>("Jenkins", "GET job", await get(`${job}/api/json?tree=${tree}`));
        },
        crumb: () => crumbFor(send),
        async start(parameters, crumb) {
            const names = Object.keys(parameters);
            const headers: Record<string, string> = { ...crumb };
            if (names.length > 0) headers["content-type"] = "application/x-www-form-urlencoded";
            return send({
                method: "POST",
                path: names.length > 0 ? `${job}/buildWithParameters` : `${job}/build`,
                headers,
                ...(names.length > 0 ? { body: new URLSearchParams(Object.entries(parameters)).toString() } : {}),
            });
        },
    };
}

/**
 * The CSRF crumb a POST needs, when the server asks for one. A crumb is requested from `/crumbIssuer/api/json`; a
 * server with no crumb issuer answers 404, and then none is needed. A crumb is tied to the web session it was issued
 * in, so the cookies of its reply go back with the POST. A request signed in with an API token needs no crumb, and one
 * is sent anyway: it does no harm. Nothing has been sent that changes anything when this fails.
 */
async function crumbFor(send: (request: { method: "GET"; path: string }) => Promise<Reply>): Promise<Crumb> {
    const reply = await send({ method: "GET", path: "/crumbIssuer/api/json" });
    if (reply.status === 404) return {};
    const issued = jsonOf<{ crumb?: string; crumbRequestField?: string }>("Jenkins", "GET crumb", reply);
    if (typeof issued.crumb !== "string" || typeof issued.crumbRequestField !== "string") {
        throw new Error("Jenkins GET crumb returned a reply without a crumb");
    }
    const headers: Record<string, string> = { [issued.crumbRequestField]: issued.crumb };
    if (reply.cookies.length > 0) headers.cookie = reply.cookies.join("; ");
    return headers;
}

/** Whether the message of a failed POST says the crumb was the problem, for a better hint. */
export function crumbRefused(reply: Reply): boolean {
    return reply.status === 403 && /crumb/i.test(reply.body);
}
