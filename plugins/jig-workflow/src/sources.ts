// Evidence that comes from outside the plugin: a review approved in `jig-review`, a CI watch that ended in `jig-ops`, and the
// pull request that `gh pr view` shows. The events arrive on Pi's event bus, where any extension can publish, so each payload
// is checked, and one is used only for a repository that is bound to the ticket. The agent cannot publish on the bus.
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Host } from "./host.ts";
import type { CiRecord, Observation, ReviewRecord } from "./store.ts";

export const REVIEW_APPROVED_EVENT = "jig-review:approved";
export const CI_FINISHED_EVENT = "jig-ops:ci-finished";

const COMMIT = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

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
 * Reads the pull request of the branch that is checked out in a repository, with `gh pr view`, through jig-core's `exec`
 * (so `gh` signs in the way the user set it up). It reads and changes nothing. What cannot be read is in `error`.
 */
export async function readPullRequest(
    host: Host,
    root: string,
    branch: string,
    head: string,
    signal?: AbortSignal,
): Promise<Observation> {
    const base = { at: host.now().toISOString(), branch, head };
    try {
        const result = await host.run("gh", ["pr", "view", "--json", PR_FIELDS], {
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
