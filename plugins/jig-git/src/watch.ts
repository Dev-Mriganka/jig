// The watch kind `github`: what to poll on GitHub, and when the watch is done. jig-core's watch engine calls `poll` on a
// timer, saves the state it returns, and sends the result to the agent. A watch never ends on "all checks": its finish
// line is named when it starts.
//
//   required   the checks that branch protection requires, or every check when nothing is required
//   check      one named check, such as the job that builds the image
//   run        one workflow run
//   pr         a pull request state: approved or merged
//   comment    a bot comment that matches a pattern
//   tag, release   a new tag or release whose name matches a pattern
//
// Every request is a `gh api` call with the ETag of the last answer. GitHub answers `304` for nothing when the data has
// not changed, and the answer we already hold is used. The ETags and the answers are kept in the watch's state, so a
// watch that resumes after Pi restarts goes on where it was.
import type { Facts, JigApi, PollOutcome, WatchKind, WatchResult } from "../../jig-core/src/contract.ts";
import { fromCheckRun, fromStatus, judge, count, describeCounts } from "./ci.ts";
import type { Check, Judgement } from "./ci.ts";
import { gitSettings } from "./config.ts";
import { apiGet } from "./github.ts";
import { failureExcerpt, jobLog } from "./logs.ts";
import { testArtifacts } from "./artifacts.ts";
import type { Announce, ArtifactSources, Comment, Release, Tag } from "./artifacts.ts";

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
    /** `owner/name`. */
    repo: string;
    pr?: number;
    branch?: string;
    /** The commit whose checks are watched. */
    sha?: string;
    runId?: number;
    finish: Finish;
}

/** What the watch remembers between polls. Plain JSON. */
export interface GithubState {
    /** The last answer to each request, with its ETag. */
    answers: Record<string, { etag?: string; value: unknown }>;
    /** The longest wait in seconds that GitHub asked for. */
    pollSeconds?: number;
    /** The names of the required checks, read once. */
    required?: string[];
    /** Tag or release names that existed on the first poll. */
    known?: string[];
    polls: number;
}

export const KIND = "github";

// ---- requests with ETags ------------------------------------------------------------------------------------------

interface Answer<T> {
    status: number;
    /** The answer, or the one held from before when GitHub said nothing changed. Undefined for a status in `tolerate`. */
    value: T | undefined;
}

export function requester(state: GithubState, signal: AbortSignal) {
    return async function get<T>(
        path: string,
        compact: (body: unknown) => T,
        tolerate: readonly number[] = [404],
    ): Promise<Answer<T>> {
        const held = state.answers[path];
        const response = await apiGet(path, { etag: held?.etag, signal });
        const wait = Number(response.headers["x-poll-interval"]);
        if (Number.isFinite(wait) && wait > 0) state.pollSeconds = Math.max(state.pollSeconds ?? 0, wait);
        if (response.status === 304 && held !== undefined) return { status: 200, value: held.value as T };
        if (response.status >= 200 && response.status < 300) {
            const value = compact(JSON.parse(response.body) as unknown);
            state.answers[path] = { etag: response.headers.etag, value };
            return { status: response.status, value };
        }
        if (tolerate.includes(response.status)) return { status: response.status, value: undefined };
        const message = (() => {
            try {
                return (JSON.parse(response.body) as { message?: string }).message ?? "";
            } catch {
                return "";
            }
        })();
        throw new Error(
            `GitHub answered HTTP ${response.status} for ${path}${message ? `: ${message}` : ""}${response.status === 401 ? " (gh is not signed in: run gh auth login yourself)" : ""}`,
        );
    };
}

export type Get = ReturnType<typeof requester>;

// ---- what each request holds, kept small -------------------------------------------------------------------------

interface PullInfo {
    head: string;
    base: string;
    state: string;
    merged: boolean;
    draft: boolean;
    url: string;
}

const compactPull = (body: unknown): PullInfo => {
    const pull = body as {
        head?: { sha?: string };
        base?: { ref?: string };
        state?: string;
        merged?: boolean;
        draft?: boolean;
        html_url?: string;
    };
    return {
        head: pull.head?.sha ?? "",
        base: pull.base?.ref ?? "",
        state: pull.state ?? "",
        merged: pull.merged === true,
        draft: pull.draft === true,
        url: pull.html_url ?? "",
    };
};

const compactRuns = (body: unknown): { total: number; checks: Check[] } => {
    const list = body as { total_count?: number; check_runs?: Parameters<typeof fromCheckRun>[0][] };
    return { total: list.total_count ?? 0, checks: (list.check_runs ?? []).map(fromCheckRun) };
};

const compactStatuses = (body: unknown): Check[] => {
    const list = body as { statuses?: Parameters<typeof fromStatus>[0][] };
    return (list.statuses ?? []).map(fromStatus);
};

export const compactDefaultBranch = (body: unknown): string =>
    (body as { default_branch?: string }).default_branch ?? "";

const compactProtection = (body: unknown): string[] => {
    const protection = (
        body as { protection?: { required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } } }
    ).protection;
    const checks = protection?.required_status_checks;
    return [...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((check) => check.context ?? "")].filter(Boolean);
};

const compactRules = (body: unknown): string[] => {
    const rules = Array.isArray(body)
        ? (body as { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[])
        : [];
    return rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => (rule.parameters?.required_status_checks ?? []).map((check) => check.context ?? ""))
        .filter(Boolean);
};

interface Review {
    login: string;
    state: string;
    body: string;
    url: string;
}

const compactReviews = (body: unknown): Review[] =>
    (Array.isArray(body)
        ? (body as { user?: { login?: string }; state?: string; body?: string; html_url?: string }[])
        : []
    ).map((review) => ({
        login: review.user?.login ?? "",
        state: review.state ?? "",
        body: (review.body ?? "").slice(0, 1000),
        url: review.html_url ?? "",
    }));

const compactComments = (body: unknown): Comment[] =>
    (Array.isArray(body)
        ? (body as {
              user?: { login?: string; type?: string };
              body?: string;
              created_at?: string;
              html_url?: string;
          }[])
        : []
    ).map((comment) => ({
        login: comment.user?.login ?? "",
        bot: comment.user?.type === "Bot" || (comment.user?.login ?? "").endsWith("[bot]"),
        body: (comment.body ?? "").slice(0, 4000),
        createdAt: comment.created_at ?? "",
        url: comment.html_url ?? "",
    }));

interface RunInfo {
    status: string;
    conclusion: string;
    name: string;
    url: string;
    sha: string;
}

const compactRun = (body: unknown): RunInfo => {
    const run = body as {
        status?: string;
        conclusion?: string | null;
        name?: string;
        html_url?: string;
        head_sha?: string;
    };
    return {
        status: run.status ?? "",
        conclusion: run.conclusion ?? "",
        name: run.name ?? "",
        url: run.html_url ?? "",
        sha: run.head_sha ?? "",
    };
};

const compactJobs = (body: unknown): Check[] =>
    (body as { jobs?: Parameters<typeof fromCheckRun>[0][] }).jobs?.map(fromCheckRun) ?? [];

const compactTags = (body: unknown): Tag[] =>
    (Array.isArray(body) ? (body as { name?: string; commit?: { sha?: string } }[]) : []).map((tag) => ({
        name: tag.name ?? "",
        sha: tag.commit?.sha ?? "",
    }));

const compactReleases = (body: unknown): Release[] =>
    (Array.isArray(body)
        ? (body as { tag_name?: string; name?: string | null; html_url?: string; draft?: boolean }[])
        : []
    )
        .filter((release) => release.draft !== true)
        .map((release) => ({ tag: release.tag_name ?? "", name: release.name ?? "", url: release.html_url ?? "" }));

// ---- the checks of a commit ---------------------------------------------------------------------------------------

const encode = encodeURIComponent;
const MAX_PAGES = 3;

/** Every check run and commit status of a commit. More than 100 check runs are read page by page, up to 300. */
export async function checksOf(get: Get, slug: string, sha: string): Promise<Check[]> {
    const ref = encode(sha);
    const base = `repos/${slug}/commits/${ref}/check-runs?per_page=100`;
    const first = await get(base, compactRuns);
    const checks = [...(first.value?.checks ?? [])];
    const total = first.value?.total ?? 0;
    for (let page = 2; page <= MAX_PAGES && checks.length < total; page++) {
        checks.push(...((await get(`${base}&page=${page}`, compactRuns)).value?.checks ?? []));
    }
    const statuses = await get(`repos/${slug}/commits/${ref}/status?per_page=100`, compactStatuses);
    return [...checks, ...(statuses.value ?? [])];
}

/**
 * The names of the checks that must pass before a branch takes a pull request, from its classic protection and from
 * rulesets. Both are read once and kept. When neither can be read or neither names a check, the list is empty, and every
 * check then counts.
 */
export async function requiredNames(get: Get, slug: string, base: string, state: GithubState): Promise<string[]> {
    if (state.required !== undefined) return state.required;
    const tolerated = [403, 404, 422];
    const classic = await get(`repos/${slug}/branches/${encode(base)}`, compactProtection, tolerated);
    const rulesets = await get(`repos/${slug}/rules/branches/${encode(base)}`, compactRules, tolerated);
    state.required = [...new Set([...(classic.value ?? []), ...(rulesets.value ?? [])])];
    return state.required;
}

// ---- the poll -----------------------------------------------------------------------------------------------------

function subject(spec: GithubSpec, sha: string | undefined): string {
    const where =
        spec.pr !== undefined
            ? `pull request ${spec.pr}`
            : spec.branch !== undefined
              ? `branch ${spec.branch}`
              : spec.repo;
    return sha ? `${where} at ${sha.slice(0, 7)}` : where;
}

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
    return `${spec.repo}: ${what} of ${subject(spec, spec.sha)}`;
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
    sha: string | undefined,
    judgement: Judgement,
    signal: AbortSignal,
): Promise<WatchResult> {
    const first = judgement.failing[0] as Check;
    const others = judgement.failing.length - 1;
    return {
        outcome: "failed",
        summary: `Check ${first.name} ${ending(first)} for ${subject(spec, sha)}${others > 0 ? ` (and ${others} more failing)` : ""}`,
        details: await failureDetails(spec.repo, first, signal),
        links: links(judgement.failing),
        facts: checkFacts(judgement.relevant),
    };
}

interface Poll {
    spec: GithubSpec;
    state: GithubState;
    get: Get;
    signal: AbortSignal;
    announce: Announce;
}

/** The PR and the head commit a checks watch looks at. A pull request that moved on ends the watch. */
async function pullAndSha(poll: Poll): Promise<{ pull?: PullInfo; sha?: string; moved?: WatchResult }> {
    const { spec, get } = poll;
    const pull =
        spec.pr === undefined ? undefined : (await get(`repos/${spec.repo}/pulls/${spec.pr}`, compactPull)).value;
    if (spec.pr !== undefined && pull === undefined)
        throw new Error(`pull request ${spec.pr} was not found in ${spec.repo}`);
    const sha =
        spec.sha ??
        pull?.head ??
        (spec.branch === undefined
            ? undefined
            : (
                  await get(
                      `repos/${spec.repo}/commits/${encode(spec.branch)}`,
                      (body) => (body as { sha?: string }).sha ?? "",
                  )
              ).value);
    if (!sha) throw new Error(`no commit to watch in ${spec.repo}: the watch needs a pull request, a branch or a sha`);
    if (pull && spec.sha && pull.head !== spec.sha) {
        return {
            pull,
            sha,
            moved: {
                outcome: "stopped",
                summary: `Pull request ${spec.pr} moved on to ${pull.head.slice(0, 7)}; this watch followed ${spec.sha.slice(0, 7)}`,
            },
        };
    }
    return { pull, sha };
}

async function pollChecks(poll: Poll): Promise<WatchResult | undefined> {
    const { spec, state, get, signal } = poll;
    const finish = spec.finish;
    const { pull, sha, moved } = await pullAndSha(poll);
    if (moved) return moved;
    const checks = await checksOf(get, spec.repo, sha as string);
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
        const base = pull?.base || (await get(`repos/${spec.repo}`, compactDefaultBranch)).value || "";
        const required = base === "" ? [] : await requiredNames(get, spec.repo, base, state);
        judgement = judge(checks, required);
    }
    if (judgement.verdict === "fail") return failedChecks(spec, sha, judgement, signal);
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
    const { spec, get, signal } = poll;
    const run = (await get(`repos/${spec.repo}/actions/runs/${spec.runId}`, compactRun)).value;
    if (run === undefined) throw new Error(`run ${spec.runId} was not found in ${spec.repo}`);
    const jobs =
        (await get(`repos/${spec.repo}/actions/runs/${spec.runId}/jobs?per_page=100`, compactJobs)).value ?? [];
    const failing = jobs.filter((job) => job.bucket === "fail");
    const name = run.name ? `Run ${spec.runId} (${run.name})` : `Run ${spec.runId}`;
    // The first failed job ends the watch; there is no need to wait for the rest of the run.
    if (failing.length > 0) {
        return {
            outcome: "failed",
            summary: `${name}: job ${(failing[0] as Check).name} ${ending(failing[0] as Check)}`,
            details: await failureDetails(spec.repo, failing[0] as Check, signal),
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
    const { spec, get } = poll;
    const pull = (await get(`repos/${spec.repo}/pulls/${spec.pr}`, compactPull)).value;
    if (pull === undefined) throw new Error(`pull request ${spec.pr} was not found in ${spec.repo}`);
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
        (await get(`repos/${spec.repo}/pulls/${spec.pr}/reviews?per_page=100`, compactReviews)).value ?? [],
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
            summary: `Pull request ${spec.pr} was approved by ${reviews.approved.map((review) => review.login).join(", ")}`,
            links: [pull.url],
        };
    }
    return undefined;
}

async function pollComment(poll: Poll, finish: Extract<Finish, { kind: "comment" }>): Promise<WatchResult | undefined> {
    const { spec, get } = poll;
    const path = `repos/${spec.repo}/issues/${spec.pr}/comments?per_page=100&since=${encode(finish.since)}`;
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
    const { spec, state, get } = poll;
    const pattern = new RegExp(finish.pattern);
    const tags = (await get(`repos/${spec.repo}/tags?per_page=100`, compactTags)).value ?? [];
    const releases =
        finish.kind === "release"
            ? ((await get(`repos/${spec.repo}/releases?per_page=30`, compactReleases)).value ?? [])
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
            summary: `A new ${finish.kind} ${fresh} matches ${finish.pattern} in ${spec.repo}`,
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
    const { spec, get, signal, announce } = poll;
    const rules = gitSettings().artifacts;
    if (rules.length === 0 || !sha) return result;
    const read = async <T>(path: string, compact: (body: unknown) => T[]): Promise<T[]> =>
        (await get(path, compact)).value ?? [];
    const sources: ArtifactSources = {
        checks: async () => checks ?? checksOf(get, spec.repo, sha),
        log: (jobId) => jobLog(spec.repo, jobId, { signal }),
        comments: () => read(`repos/${spec.repo}/issues/${spec.pr}/comments?per_page=100`, compactComments),
        tags: () => read(`repos/${spec.repo}/tags?per_page=100`, compactTags),
        releases: () => read(`repos/${spec.repo}/releases?per_page=30`, compactReleases),
    };
    try {
        const found = await testArtifacts({ repo: spec.repo, pr: spec.pr, sha, rules, sources, announce });
        if (found.length === 0) return result;
        const line = `Ready: ${found.map((artifact) => `${artifact.kind} ${artifact.ref}`).join(", ")}`;
        return {
            ...result,
            details: [result.details, line].filter(Boolean).join("\n"),
            facts: { ...(result.facts ?? {}), artifacts: found.length },
        };
    } catch (error) {
        return {
            ...result,
            details: [result.details, `The artifact rules could not be tested: ${(error as Error).message}`]
                .filter(Boolean)
                .join("\n"),
        };
    }
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
async function pollGithub(
    spec: GithubSpec,
    previous: GithubState | undefined,
    signal: AbortSignal,
    announce: Announce,
): Promise<PollOutcome<GithubState>> {
    const state: GithubState = previous ?? { answers: {}, polls: 0 };
    state.polls++;
    const done = await evaluate({ spec, state, get: requester(state, signal), signal, announce });
    const wait = Math.max(gitSettings().watch.pollSeconds, state.pollSeconds ?? 0) * 1000;
    // The engine saves the state as JSON. Passing it through JSON here makes sure that is exactly what it will hold.
    const saved = JSON.parse(JSON.stringify(state)) as GithubState;
    return done ? { state: saved, done } : { state: saved, nextPollMs: wait };
}

/** Registers the watch kind with jig-core. `announce` publishes the "artifact ready" event on Pi's event bus. */
export function registerGithubWatch(api: JigApi, announce: Announce): void {
    const kind: WatchKind<GithubSpec, GithubState> = {
        kind: KIND,
        plugin: "jig-git",
        intervalMs: 30_000,
        describe: describeSpec,
        poll: (spec, state, signal) => pollGithub(spec, state, signal, announce),
    };
    api.watches.registerKind(kind);
}
