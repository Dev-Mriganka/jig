// What GitHub says about a commit, a pull request, a run, the tags and the releases, read through `gh api` with the
// ETag of the last answer. GitHub answers `304` for nothing when the data has not changed, and the answer we already
// hold is used. The ETags and the answers are kept in the watch's state, so a watch that resumes after Pi restarts goes
// on where it was; a read that is not part of a watch uses a state of its own and throws it away.
import { fromCheckRun, fromStatus } from "./model.ts";
import type { Check } from "./model.ts";
import { apiGet, gh, ghAllowsEscapes, ghFailure } from "./gh.ts";
import type { GhOptions } from "./gh.ts";
import type { Comment, Release, Tag } from "./artifacts.ts";

/** What a GitHub watch remembers between polls. Plain JSON. */
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

// ---- requests with ETags ------------------------------------------------------------------------------------------

interface Answer<T> {
    status: number;
    /** The answer, or the one held when GitHub said nothing changed. Undefined for a status in `tolerate`. */
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
            `GitHub answered HTTP ${response.status} for ${path}${message ? `: ${message}` : ""}` +
                (response.status === 401 ? " (gh is not signed in: run gh auth login yourself)" : ""),
        );
    };
}

export type Get = ReturnType<typeof requester>;

// ---- what each request holds, kept small -------------------------------------------------------------------------

export interface PullInfo {
    head: string;
    base: string;
    state: string;
    merged: boolean;
    draft: boolean;
    url: string;
}

export const compactPull = (body: unknown): PullInfo => {
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

export interface Review {
    login: string;
    state: string;
    body: string;
    url: string;
}

export const compactReviews = (body: unknown): Review[] =>
    (Array.isArray(body)
        ? (body as { user?: { login?: string }; state?: string; body?: string; html_url?: string }[])
        : []
    ).map((review) => ({
        login: review.user?.login ?? "",
        state: review.state ?? "",
        body: (review.body ?? "").slice(0, 1000),
        url: review.html_url ?? "",
    }));

export const compactComments = (body: unknown): Comment[] =>
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

export interface RunInfo {
    status: string;
    conclusion: string;
    name: string;
    url: string;
    sha: string;
}

export const compactRun = (body: unknown): RunInfo => {
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

export const compactJobs = (body: unknown): Check[] =>
    (body as { jobs?: Parameters<typeof fromCheckRun>[0][] }).jobs?.map(fromCheckRun) ?? [];

export const compactTags = (body: unknown): Tag[] =>
    (Array.isArray(body) ? (body as { name?: string; commit?: { sha?: string } }[]) : []).map((tag) => ({
        name: tag.name ?? "",
        sha: tag.commit?.sha ?? "",
    }));

export const compactReleases = (body: unknown): Release[] =>
    (Array.isArray(body)
        ? (body as { tag_name?: string; name?: string | null; html_url?: string; draft?: boolean }[])
        : []
    )
        .filter((release) => release.draft !== true)
        .map((release) => ({ tag: release.tag_name ?? "", name: release.name ?? "", url: release.html_url ?? "" }));

// ---- the checks of a commit ---------------------------------------------------------------------------------------

export const encode = encodeURIComponent;
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
 * rulesets. Both are read once and kept. When neither can be read or neither names a check, the list is empty, and
 * every check then counts.
 */
export async function requiredNames(get: Get, slug: string, base: string, state: GithubState): Promise<string[]> {
    if (state.required !== undefined) return state.required;
    const tolerated = [403, 404, 422];
    const classic = await get(`repos/${slug}/branches/${encode(base)}`, compactProtection, tolerated);
    const rulesets = await get(`repos/${slug}/rules/branches/${encode(base)}`, compactRules, tolerated);
    state.required = [...new Set([...(classic.value ?? []), ...(rulesets.value ?? [])])];
    return state.required;
}

const LOG_BYTES = 8 * 1024 * 1024;

/** The log of one job, as text. A job is a check run of GitHub Actions; its id is the check run's id. */
export async function jobLog(slug: string, jobId: number, options: GhOptions = {}): Promise<string> {
    // A log is text with colour codes in it. A gh that checks for escape sequences must be told that this is expected; the
    // log is cleaned of them when the model's text is made (see logs.ts).
    const flags = (await ghAllowsEscapes(options)) ? ["--allow-escape-sequences"] : [];
    const result = await gh(["api", ...flags, `repos/${slug}/actions/jobs/${jobId}/logs`], {
        ...options,
        maxBytes: LOG_BYTES,
    });
    if (result.code !== 0 || result.timedOut) {
        if (/HTTP 410|HTTP 404/.test(result.stderr)) {
            throw new Error(
                `the log of job ${jobId} is not available (it expired, or the job is not a GitHub Actions job)`,
            );
        }
        throw ghFailure(`gh api job ${jobId} logs`, result);
    }
    return result.stdout;
}
