// Evidence that comes from outside the plugin: a review approved in `jig-review`, a CI watch that ended in `jig-ops`, and the
// pull request that `gh pr view` shows. The events arrive on Pi's event bus, where any extension can publish, so each payload
// is checked, and one is used only for a repository that is bound to the ticket. The agent cannot publish on the bus.
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Forge } from "./forge.ts";
import type { Host } from "./host.ts";
import type { CiRecord, Observation, ReviewRecord } from "./store.ts";

export const REVIEW_APPROVED_EVENT = "jig-review:approved";
export const CI_FINISHED_EVENT = "jig-ops:ci-finished";

const COMMIT = /^[0-9a-f]{40}$/;
/** `owner/name`, or a GitLab project's whole path, which may have groups: `platform/payments/orders-api`. */
const SLUG = /^[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100}){1,19}$/;

/** The finish lines of a CI watch that cover the required checks, as the CI adapters name them. */
const COVERING_FINISH = new Set(["required", "pipeline", "jobs", "build", "stages"]);

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realOrResolved(target: string): string {
    try {
        return realpathSync(target);
    } catch {
        return path.resolve(target);
    }
}

// ---- a review that was approved ------------------------------------------------------------------------------------------

/**
 * A `jig-review:approved` payload as a record for a ticket, or undefined when it is not one that counts. It counts when it
 * covers commits (a branch review whose diff was still the one the user saw), is not for another ticket, and names at least one
 * bound repository with a full commit. `cwd` is Pi's folder, where a repository's path from it starts.
 */
export function reviewFromEvent(
    payload: unknown,
    ticket: string,
    bound: readonly string[],
    cwd: string,
    now: Date,
): ReviewRecord | undefined {
    if (
        !isObject(payload) ||
        payload.covered !== true ||
        typeof payload.reviewId !== "string" ||
        payload.reviewId === ""
    ) {
        return undefined;
    }
    if (payload.ticket !== undefined && payload.ticket !== ticket) return undefined;
    if (!Array.isArray(payload.repos)) return undefined;
    const repos: ReviewRecord["repos"] = [];
    for (const entry of payload.repos) {
        if (!isObject(entry) || typeof entry.head !== "string" || !COMMIT.test(entry.head)) continue;
        // `root` is the repository's folder. An event from before it was added names the repository by its path from Pi's folder.
        const where =
            typeof entry.root === "string" && path.isAbsolute(entry.root)
                ? entry.root
                : typeof entry.repo === "string" && !entry.repo.includes("\0")
                  ? path.resolve(cwd, entry.repo)
                  : undefined;
        if (where === undefined) continue;
        const root = realOrResolved(where);
        if (bound.includes(root)) repos.push({ root, head: entry.head });
    }
    return repos.length === 0 ? undefined : { reviewId: payload.reviewId.slice(0, 100), at: now.toISOString(), repos };
}

// ---- a CI watch that ended -----------------------------------------------------------------------------------------------

export interface CiFinished {
    repo: string;
    sha: string;
    outcome: "passed" | "failed";
    finish: string;
}

/** A `jig-ops:ci-finished` payload, or undefined when it is not one that says anything about a commit's required checks. */
export function ciFromEvent(payload: unknown): CiFinished | undefined {
    if (!isObject(payload)) return undefined;
    const { repo, sha, outcome, finish } = payload;
    if (typeof repo !== "string" || !SLUG.test(repo)) return undefined;
    if (typeof sha !== "string" || !COMMIT.test(sha)) return undefined;
    if (outcome !== "passed" && outcome !== "failed") return undefined;
    if (typeof finish !== "string" || !COVERING_FINISH.has(finish)) return undefined;
    return { repo: repo.toLowerCase(), sha, outcome, finish };
}

export function ciRecord(event: CiFinished, now: Date): CiRecord {
    return { ...event, at: now.toISOString() };
}

// ---- the pull request ----------------------------------------------------------------------------------------------------

export interface Rollup {
    pass: number;
    fail: number;
    pending: number;
    total: number;
}

/** What GitHub's roll-up of checks and statuses comes to. A check run and a commit status are told apart by their fields. */
export function parseRollup(rollup: unknown): Rollup {
    const counts: Rollup = { pass: 0, fail: 0, pending: 0, total: 0 };
    if (!Array.isArray(rollup)) return counts;
    for (const item of rollup) {
        if (!isObject(item)) continue;
        counts.total++;
        if (typeof item.status === "string") {
            // A check run: pending until it is completed, then by its conclusion.
            if (item.status !== "COMPLETED") counts.pending++;
            else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(item.conclusion))) counts.pass++;
            else counts.fail++;
        } else {
            // A commit status.
            const state = String(item.state);
            if (state === "SUCCESS") counts.pass++;
            else if (state === "PENDING" || state === "EXPECTED") counts.pending++;
            else counts.fail++;
        }
    }
    return counts;
}

const PR_FIELDS = "number,state,isDraft,headRefOid,url,statusCheckRollup";

/**
 * Reads the pull request of the branch that is checked out in a repository, through jig-core's `exec` (so `gh` or `glab` signs in
 * the way the user set it up). On GitHub that is `gh pr view`; on GitLab it is the merge request of the branch and its pipeline,
 * read with `glab api`. It reads and changes nothing. What cannot be read is in `error`.
 */
export async function readPullRequest(
    host: Host,
    root: string,
    branch: string,
    head: string,
    signal?: AbortSignal,
    forge: Forge = { forge: "github" },
): Promise<Observation> {
    if (forge.forge === "gitlab") return readMergeRequest(host, root, branch, head, forge, signal);
    const base = { at: host.now().toISOString(), branch, head };
    try {
        // With the repository named (origin's host is an alias), gh cannot work the branch out for itself, so it is named too.
        const where = forge.repo === undefined ? [] : [branch, "-R", forge.repo];
        const result = await host.run("gh", ["pr", "view", ...where, "--json", PR_FIELDS], {
            cwd: root,
            timeoutMs: 20_000,
            ...(signal === undefined ? {} : { signal }),
        });
        if (result.code !== 0) {
            const why = firstLine(result.stderr) || `gh exited ${result.code}`;
            // The usual answer for a branch nobody has opened a pull request for: not an error.
            return /no pull requests? found/i.test(result.stderr) ? base : { ...base, error: why };
        }
        const parsed: unknown = JSON.parse(result.stdout);
        if (!isObject(parsed) || typeof parsed.number !== "number" || typeof parsed.state !== "string") {
            return { ...base, error: "gh pr view gave an answer this plugin does not read" };
        }
        return {
            ...base,
            pr: {
                number: parsed.number,
                state: parsed.state,
                isDraft: parsed.isDraft === true,
                headRefOid: typeof parsed.headRefOid === "string" ? parsed.headRefOid : "",
                url: typeof parsed.url === "string" ? parsed.url : "",
            },
            checks: parseRollup(parsed.statusCheckRollup),
        };
    } catch (error) {
        return { ...base, error: firstLine((error as Error).message) || "gh could not be run" };
    }
}

// ---- the merge request on GitLab ------------------------------------------------------------------------------------------

/** A draft is a title with a prefix on GitLab, as well as a flag. */
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-\s+)\s*/i;
const JOB_LIMIT = 100;

/** GitLab's state of a merge request as the pull request states of GitHub are written, which the conditions compare. */
function stateOf(state: unknown): string {
    switch (state) {
        case "opened":
            return "OPEN";
        case "merged":
            return "MERGED";
        case "closed":
            return "CLOSED";
        default:
            return String(state).toUpperCase();
    }
}

/**
 * What a pipeline's jobs come to, counted as the roll-up of GitHub's checks is: a job that may fail does not fail the pipeline, a
 * job that has not finished (or waits for someone to start it) is pending, and a status nobody knows is not a pass.
 */
export function parseJobs(jobs: unknown): Rollup {
    const counts: Rollup = { pass: 0, fail: 0, pending: 0, total: 0 };
    if (!Array.isArray(jobs)) return counts;
    for (const job of jobs) {
        if (!isObject(job)) continue;
        counts.total++;
        switch (job.status) {
            case "success":
            case "skipped":
                counts.pass++;
                break;
            case "failed":
                if (job.allow_failure === true) counts.pass++;
                else counts.fail++;
                break;
            case "created":
            case "pending":
            case "running":
            case "preparing":
            case "scheduled":
            case "manual":
            case "waiting_for_resource":
            case "waiting_for_callback":
                counts.pending++;
                break;
            default:
                // Cancelled, or a status nobody knows: not a pass.
                counts.fail++;
        }
    }
    return counts;
}

/** A line for a failed `glab api`, with the way to mend a sign-in that is missing. */
function glabLine(result: { code: number; stderr: string }, hostName: string): string {
    const said = firstLine(result.stderr) || `glab exited ${result.code}`;
    return /glab auth login|not logged in|\b401\b|unauthorized|no token|authentication required|invalid token/i.test(
        result.stderr,
    )
        ? `${said} (glab is not signed in for ${hostName}: run glab auth login --hostname ${hostName} yourself)`
        : said;
}

async function readMergeRequest(
    host: Host,
    root: string,
    branch: string,
    head: string,
    forge: Extract<Forge, { forge: "gitlab" }>,
    signal?: AbortSignal,
): Promise<Observation> {
    const base = { at: host.now().toISOString(), branch, head };
    const project = `projects/${encodeURIComponent(forge.path)}`;
    const get = async (endpoint: string): Promise<unknown> => {
        const result = await host.run("glab", ["api", "--hostname", forge.host, `${project}/${endpoint}`], {
            cwd: root,
            timeoutMs: 20_000,
            ...(signal === undefined ? {} : { signal }),
        });
        if (result.code !== 0) throw new Error(glabLine(result, forge.host));
        try {
            return JSON.parse(result.stdout);
        } catch {
            throw new Error("glab api gave an answer that is not JSON");
        }
    };
    const query = (state: string): string =>
        `merge_requests?source_branch=${encodeURIComponent(branch)}&state=${state}&per_page=5&order_by=updated_at&sort=desc`;
    try {
        // A merge request from a branch of this project, and not from a fork whose branch has the same name.
        const own = (row: unknown): row is Record<string, unknown> =>
            isObject(row) &&
            row.source_branch === branch &&
            (row.source_project_id === undefined ||
                row.target_project_id === undefined ||
                row.source_project_id === row.target_project_id);
        const listed = async (state: string): Promise<Record<string, unknown> | undefined> => {
            const rows = await get(query(state));
            return Array.isArray(rows) ? rows.find(own) : undefined;
        };
        // The open one first; else the newest of any state, so a merged or closed request is said to be that.
        const found = (await listed("opened")) ?? (await listed("all"));
        if (found === undefined) return base;
        if (typeof found.iid !== "number" || typeof found.state !== "string") {
            return { ...base, error: "glab api gave an answer this plugin does not read" };
        }
        const sha = typeof found.sha === "string" ? found.sha : "";
        const title = typeof found.title === "string" ? found.title : "";
        const pipeline = isObject(found.head_pipeline) ? found.head_pipeline : undefined;
        let checks: Rollup = { pass: 0, fail: 0, pending: 0, total: 0 };
        // A pipeline of an older commit says nothing about this head: until one is made for it there are no checks to count.
        if (
            pipeline !== undefined &&
            typeof pipeline.id === "number" &&
            (pipeline.sha === undefined || pipeline.sha === sha)
        ) {
            checks = parseJobs(await get(`pipelines/${pipeline.id}/jobs?per_page=${JOB_LIMIT}`));
        }
        return {
            ...base,
            pr: {
                number: found.iid,
                state: stateOf(found.state),
                isDraft: found.draft === true || DRAFT_PREFIX.test(title),
                headRefOid: sha,
                url: typeof found.web_url === "string" ? found.web_url : "",
            },
            checks,
        };
    } catch (error) {
        return { ...base, error: firstLine((error as Error).message) || "glab could not be run" };
    }
}

function firstLine(text: string): string {
    return (
        text
            .trim()
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim()
            .slice(0, 200) ?? ""
    );
}
