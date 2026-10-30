// The GitHub half of the CI watch: what to poll on GitHub, and when the watch is done. jig-core's watch engine calls
// `poll` on a timer, saves the state it returns, and sends the result to the agent. A watch never ends on "all checks":
// its finish line is named when it starts.
//
//   required   the checks that branch protection requires, or every check when nothing is required
//   check      one named check, such as the job that builds the image
//   run        one workflow run
//   pr         a pull request state: approved or merged
//   comment    a bot comment that matches a pattern
//   tag, release   a new tag or release whose name matches a pattern
//
// Every request is a `gh api` call with the ETag of the last answer (see github-checks.ts). The spec holds the name of
// the service and never its repository: each poll finds the repository in the catalog as it is now, so a saved watch
// file cannot point a poll at another one.
import type { Facts, PollOutcome, WatchResult } from "../../../jig-core/src/contract.ts";
import type { CiContext } from "./adapter.ts";
import { addArtifacts } from "./artifacts.ts";
import type { ArtifactSources } from "./artifacts.ts";
import {
    checksOf,
    compactComments,
    compactDefaultBranch,
    compactJobs,
    compactPull,
    compactReleases,
    compactReviews,
    compactRun,
    compactTags,
    encode,
    jobLog,
    requester,
    requiredNames,
} from "./github-checks.ts";
import type { Get, GithubState, PullInfo, Review } from "./github-checks.ts";
import { failureExcerpt } from "./logs.ts";
import { count, describeCounts, judge } from "./model.ts";
import type { Check, Judgement } from "./model.ts";

export type Finish =
    | { kind: "required" }
    | { kind: "check"; name: string }
    | { kind: "run" }
    | { kind: "pr"; state: "approved" | "merged" }
    | { kind: "comment"; pattern: string; bot?: string; since: string }
    | { kind: "tag"; pattern: string }
    | { kind: "release"; pattern: string };

/** What a GitHub watch watches. Plain JSON, because it is saved with the watch. */
export interface GithubSpec {
    system: "github-actions";
    /** The service of the catalog; its `repo` is the repository. */
    service: string;
    pr?: number;
    branch?: string;
    /** The commit whose checks are watched. */
    sha?: string;
    runId?: number;
    finish: Finish;
}

// ---- the poll -----------------------------------------------------------------------------------------------------

function subject(spec: GithubSpec, sha: string | undefined): string {
    const where =
        spec.pr !== undefined
            ? `pull request ${spec.pr}`
            : spec.branch !== undefined
              ? `branch ${spec.branch}`
              : spec.service;
    return sha ? `${where} at ${sha.slice(0, 7)}` : where;
}

/** One line for `watch list`: the service, what it waits for and where. */
export function describeSpec(spec: GithubSpec): string {
    const finish = spec.finish;
    const what =
        finish.kind === "required"
            ? "required checks"
            : finish.kind === "check"
              ? `check ${finish.name}`
              : finish.kind === "run"
                ? `run ${spec.runId}`
                : finish.kind === "pr"
                  ? `${finish.state} state`
                  : finish.kind === "comment"
                    ? `a comment matching ${finish.pattern}`
                    : `a new ${finish.kind} matching ${finish.pattern}`;
    return `${spec.service}: ${what} of ${subject(spec, spec.sha)}`;
}

function links(checks: readonly Check[], max = 5): string[] {
    return checks
        .map((check) => check.url)
        .filter((url): url is string => url !== undefined)
        .slice(0, max);
}

function checkFacts(checks: readonly Check[]): Facts {
    const counts = count(checks);
    return { pass: counts.pass, fail: counts.fail, pending: counts.pending, skipped: counts.skipped };
}

/** What to show of a failed check: the lines of its log around the first error, else the title an app gave it. */
async function failureDetails(slug: string, check: Check, signal: AbortSignal): Promise<string | undefined> {
    if (check.id !== undefined) {
        try {
            const excerpt = failureExcerpt(await jobLog(slug, check.id, { signal }));
            if (excerpt.trim() !== "") return `${check.name}:\n${excerpt}`;
        } catch {
            // Not a GitHub Actions job, or the log is gone: fall back to what the check says about itself.
        }
    }
    return check.title ? `${check.name}: ${check.title}` : undefined;
}

/** How a check that did not pass ended, in words: "failed", "was skipped", "ended as cancelled". */
function ending(check: Check): string {
    if (check.detail === "skipped") return "was skipped";
    return check.detail === undefined || check.detail === "failure" || check.detail === "error"
        ? "failed"
        : `ended as ${check.detail}`;
}

async function failedChecks(
    spec: GithubSpec,
    slug: string,
    sha: string | undefined,
    judgement: Judgement,
    signal: AbortSignal,
): Promise<WatchResult> {
    const first = judgement.failing[0] as Check;
    const others = judgement.failing.length - 1;
    return {
        outcome: "failed",
        summary:
            `Check ${first.name} ${ending(first)} for ${subject(spec, sha)}` +
            (others > 0 ? ` (and ${others} more failing)` : ""),
        details: await failureDetails(slug, first, signal),
        links: links(judgement.failing),
        facts: checkFacts(judgement.relevant),
    };
}

interface Poll {
    spec: GithubSpec;
    /** `owner/name`, from the catalog as it is now. */
    slug: string;
    ctx: CiContext;
    state: GithubState;
    get: Get;
    signal: AbortSignal;
}

/** The PR and the head commit a GitHub watch of checks looks at. A pull request that moved on ends the watch. */
async function pullAndSha(poll: Poll): Promise<{ pull?: PullInfo; sha?: string; moved?: WatchResult }> {
    const { spec, slug, get } = poll;
    const pull = spec.pr === undefined ? undefined : (await get(`repos/${slug}/pulls/${spec.pr}`, compactPull)).value;
    if (spec.pr !== undefined && pull === undefined)
        throw new Error(`pull request ${spec.pr} was not found in ${slug}`);
    const sha =
        spec.sha ??
        pull?.head ??
        (spec.branch === undefined
            ? undefined
            : (
                  await get(
                      `repos/${slug}/commits/${encode(spec.branch)}`,
                      (body) => (body as { sha?: string }).sha ?? "",
                  )
              ).value);
    if (!sha) throw new Error(`no commit to watch in ${slug}: the watch needs a pull request, a branch or a sha`);
    if (pull && spec.sha && pull.head !== spec.sha) {
        return {
            pull,
            sha,
            moved: {
                outcome: "stopped",
                summary:
                    `Pull request ${spec.pr} moved on to ${pull.head.slice(0, 7)}; ` +
                    `this watch followed ${spec.sha.slice(0, 7)}`,
            },
        };
    }
    return { pull, sha };
}

async function pollChecks(poll: Poll): Promise<WatchResult | undefined> {
    const { spec, slug, state, get, signal } = poll;
    const finish = spec.finish;
    const { pull, sha, moved } = await pullAndSha(poll);
    if (moved) return moved;
    const checks = await checksOf(get, slug, sha as string);
    let judgement: Judgement;
    if (finish.kind === "check") {
        const named = checks.find((check) => check.name === finish.name);
        // A named check that was skipped will never run, so for a watch that waits for it, that is the end.
        const unsettled = named?.bucket === "pending";
        const passed = named?.bucket === "pass";
        judgement = named
            ? {
                  verdict: passed ? "pass" : unsettled ? "pending" : "fail",
                  relevant: [named],
                  missing: [],
                  failing: passed || unsettled ? [] : [named],
              }
            : { verdict: "pending", relevant: [], missing: [finish.name], failing: [] };
    } else {
        const base = pull?.base || (await get(`repos/${slug}`, compactDefaultBranch)).value || "";
        const required = base === "" ? [] : await requiredNames(get, slug, base, state);
        judgement = judge(checks, required);
    }
    if (judgement.verdict === "fail") return failedChecks(spec, slug, sha, judgement, signal);
    if (judgement.verdict === "pending") return undefined;
    const counts = describeCounts(count(judgement.relevant));
    const what = finish.kind === "check" ? `Check ${finish.name} passed` : "Checks passed";
    const result: WatchResult = {
        outcome: "passed",
        summary: `${what} for ${subject(spec, sha)}: ${counts}`,
        links: links(judgement.relevant, 3),
        facts: checkFacts(judgement.relevant),
    };
    return withArtifacts(poll, result, sha as string, checks);
}

async function pollRun(poll: Poll): Promise<WatchResult | undefined> {
    const { spec, slug, get, signal } = poll;
    const run = (await get(`repos/${slug}/actions/runs/${spec.runId}`, compactRun)).value;
    if (run === undefined) throw new Error(`run ${spec.runId} was not found in ${slug}`);
    const jobs = (await get(`repos/${slug}/actions/runs/${spec.runId}/jobs?per_page=100`, compactJobs)).value ?? [];
    const failing = jobs.filter((job) => job.bucket === "fail");
    const name = run.name ? `Run ${spec.runId} (${run.name})` : `Run ${spec.runId}`;
    // The first failed job ends the watch; there is no need to wait for the rest of the run.
    if (failing.length > 0) {
        return {
            outcome: "failed",
            summary: `${name}: job ${(failing[0] as Check).name} ${ending(failing[0] as Check)}`,
            details: await failureDetails(slug, failing[0] as Check, signal),
            links: [run.url, ...links(failing, 4)].filter(Boolean),
            facts: checkFacts(jobs),
        };
    }
    if (run.status !== "completed") return undefined;
    if (run.conclusion === "success") {
        return withArtifacts(
            poll,
            {
                outcome: "passed",
                summary: `${name} succeeded at ${run.sha.slice(0, 7)}: ${describeCounts(count(jobs))}`,
                links: [run.url],
                facts: checkFacts(jobs),
            },
            run.sha,
            jobs,
        );
    }
    return {
        outcome: "failed",
        summary: `${name} ended as ${run.conclusion || "unknown"}`,
        links: [run.url],
        facts: checkFacts(jobs),
    };
}

/** The latest review of each person decides: approved when someone approved and nobody asks for changes. */
export function reviewState(reviews: readonly Review[]): { approved: Review[]; changes: Review[] } {
    const latest = new Map<string, Review>();
    for (const review of reviews) {
        if (review.state === "COMMENTED" || review.login === "") continue;
        latest.set(review.login, review);
    }
    const all = [...latest.values()];
    return {
        approved: all.filter((review) => review.state === "APPROVED"),
        changes: all.filter((review) => review.state === "CHANGES_REQUESTED"),
    };
}

async function pollPull(poll: Poll, finish: Extract<Finish, { kind: "pr" }>): Promise<WatchResult | undefined> {
    const { spec, slug, get } = poll;
    const pull = (await get(`repos/${slug}/pulls/${spec.pr}`, compactPull)).value;
    if (pull === undefined) throw new Error(`pull request ${spec.pr} was not found in ${slug}`);
    if (pull.merged) {
        return withArtifacts(
            poll,
            { outcome: "passed", summary: `Pull request ${spec.pr} was merged into ${pull.base}`, links: [pull.url] },
            spec.sha ?? pull.head,
        );
    }
    if (pull.state === "closed")
        return { outcome: "failed", summary: `Pull request ${spec.pr} was closed without merging`, links: [pull.url] };
    if (finish.state === "merged") return undefined;
    const reviews = reviewState(
        (await get(`repos/${slug}/pulls/${spec.pr}/reviews?per_page=100`, compactReviews)).value ?? [],
    );
    if (reviews.changes.length > 0) {
        const review = reviews.changes[0] as Review;
        return {
            outcome: "failed",
            summary: `Changes were requested on pull request ${spec.pr} by ${review.login}`,
            details: review.body || undefined,
            links: [review.url || pull.url],
        };
    }
    if (reviews.approved.length > 0) {
        return {
            outcome: "passed",
            summary:
                `Pull request ${spec.pr} was approved by ${reviews.approved.map((review) => review.login).join(", ")}`,
            links: [pull.url],
        };
    }
    return undefined;
}

async function pollComment(poll: Poll, finish: Extract<Finish, { kind: "comment" }>): Promise<WatchResult | undefined> {
    const { spec, slug, get } = poll;
    const path = `repos/${slug}/issues/${spec.pr}/comments?per_page=100&since=${encode(finish.since)}`;
    const comments = (await get(path, compactComments)).value ?? [];
    const pattern = new RegExp(finish.pattern);
    const found = comments.find(
        (comment) =>
            comment.createdAt >= finish.since &&
            (finish.bot === undefined ? comment.bot : comment.login === finish.bot) &&
            pattern.test(comment.body),
    );
    if (!found) return undefined;
    return withArtifacts(
        poll,
        {
            outcome: "passed",
            summary: `A comment by ${found.login} on pull request ${spec.pr} matches ${finish.pattern}`,
            details: found.body.slice(0, 600),
            links: [found.url],
        },
        spec.sha,
    );
}

async function pollTagOrRelease(
    poll: Poll,
    finish: Extract<Finish, { kind: "tag" | "release" }>,
): Promise<WatchResult | undefined> {
    const { spec, slug, state, get } = poll;
    const pattern = new RegExp(finish.pattern);
    const tags = (await get(`repos/${slug}/tags?per_page=100`, compactTags)).value ?? [];
    const releases =
        finish.kind === "release"
            ? ((await get(`repos/${slug}/releases?per_page=30`, compactReleases)).value ?? [])
            : [];
    const names = finish.kind === "tag" ? tags.map((tag) => tag.name) : releases.map((release) => release.tag);
    // What exists on the first poll is old news. A tag on the watched commit counts at once.
    if (state.known === undefined) state.known = names;
    const known = new Set(state.known);
    const onSha = (name: string) =>
        spec.sha !== undefined && tags.some((tag) => tag.name === name && tag.sha === spec.sha);
    const fresh = names.find((name) => pattern.test(name) && (!known.has(name) || onSha(name)));
    if (fresh === undefined) return undefined;
    const url = releases.find((release) => release.tag === fresh)?.url;
    return withArtifacts(
        poll,
        {
            outcome: "passed",
            summary: `A new ${finish.kind} ${fresh} matches ${finish.pattern} in ${slug}`,
            links: url ? [url] : undefined,
        },
        spec.sha,
    );
}

/** Tests the artifact rules when a watch has passed, and adds what they found to the result. */
async function withArtifacts(
    poll: Poll,
    result: WatchResult,
    sha: string | undefined,
    checks?: readonly Check[],
): Promise<WatchResult> {
    const { spec, slug, get, signal, ctx } = poll;
    const rules = ctx.artifacts;
    if (rules.length === 0 || !sha) return result;
    const read = async <T>(path: string, compact: (body: unknown) => T[]): Promise<T[]> =>
        (await get(path, compact)).value ?? [];
    const sources: ArtifactSources = {
        checks: async () => checks ?? checksOf(get, slug, sha),
        log: (jobId) => jobLog(slug, jobId, { signal }),
        comments: () => read(`repos/${slug}/issues/${spec.pr}/comments?per_page=100`, compactComments),
        tags: () => read(`repos/${slug}/tags?per_page=100`, compactTags),
        releases: () => read(`repos/${slug}/releases?per_page=30`, compactReleases),
    };
    return addArtifacts(result, { repo: slug, pr: spec.pr, sha, rules, sources, announce: ctx.announce });
}

async function evaluate(poll: Poll): Promise<WatchResult | undefined> {
    const finish = poll.spec.finish;
    switch (finish.kind) {
        case "required":
        case "check":
            return pollChecks(poll);
        case "run":
            return pollRun(poll);
        case "pr":
            return pollPull(poll, finish);
        case "comment":
            return pollComment(poll, finish);
        case "tag":
        case "release":
            return pollTagOrRelease(poll, finish);
    }
}

/** One poll. A throw is a failed poll: the engine counts three in a row and pauses the watch with one notice. */
export async function pollGithub(
    spec: GithubSpec,
    slug: string,
    previous: GithubState | undefined,
    ctx: CiContext,
): Promise<PollOutcome<GithubState>> {
    const signal = ctx.signal ?? new AbortController().signal;
    const state: GithubState = previous ?? { answers: {}, polls: 0 };
    state.polls++;
    const done = await evaluate({ spec, slug, ctx, state, get: requester(state, signal), signal });
    const wait = Math.max(ctx.pollSeconds, state.pollSeconds ?? 0) * 1000;
    // The engine saves the state as JSON. Passing it through JSON here makes sure that is exactly what it will hold.
    const saved = JSON.parse(JSON.stringify(state)) as GithubState;
    return done ? { state: saved, done } : { state: saved, nextPollMs: wait };
}
