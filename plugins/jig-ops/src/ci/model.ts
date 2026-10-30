// What a CI system says about a check, a job or a stage, in one shape. GitHub check runs (Actions and apps), commit
// statuses (older CI systems) and the rows of `gh pr checks`, GitLab jobs and Jenkins stages all become a `Check` with
// one of four buckets: pass, fail, pending or skipped. A check that is still running is never a pass, and a cancelled
// one is a failure.

export type Bucket = "pass" | "fail" | "pending" | "skipped";

export interface Check {
    name: string;
    bucket: Bucket;
    /** The conclusion or state as the CI system words it, such as `timed_out`. */
    detail?: string;
    url?: string;
    /** For a job, its id, the key to its log. On GitHub the id of the check run is the id of the job. */
    id?: number;
    /** What an app wrote as the check's title, when it wrote one. */
    title?: string;
}

const FAILED = new Set([
    "failure",
    "timed_out",
    "cancelled",
    "canceled",
    "action_required",
    "startup_failure",
    "stale",
    "error",
]);
const PASSED = new Set(["success", "neutral", "passed"]);

/** One check as pass, fail, pending or skipped, from GitHub's status and conclusion (or a commit status's state). */
export function bucketOf(status: string | undefined, conclusion: string | undefined): Bucket {
    const outcome = (conclusion ?? "").toLowerCase();
    const state = (status ?? "").toLowerCase();
    if (state !== "" && state !== "completed") return "pending";
    if (
        outcome === "" ||
        outcome === "pending" ||
        outcome === "expected" ||
        outcome === "queued" ||
        outcome === "in_progress" ||
        outcome === "waiting"
    )
        return "pending";
    if (outcome === "skipped" || outcome === "skipping") return "skipped";
    if (FAILED.has(outcome)) return "fail";
    return PASSED.has(outcome) ? "pass" : "fail";
}

interface CheckRunLike {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    details_url?: string;
    output?: { title?: string | null };
}

/** An item of GitHub's `check_runs` list. */
export function fromCheckRun(run: CheckRunLike): Check {
    return {
        name: run.name ?? "check",
        bucket: bucketOf(run.status, run.conclusion ?? undefined),
        detail: run.conclusion ?? run.status,
        url: run.html_url ?? run.details_url,
        id: run.id,
        title: run.output?.title ?? undefined,
    };
}

interface StatusLike {
    context?: string;
    state?: string;
    target_url?: string | null;
    description?: string | null;
}

/** An item of GitHub's combined commit status: a state of `success`, `pending`, `failure` or `error`. */
export function fromStatus(status: StatusLike): Check {
    return {
        name: status.context ?? "status",
        bucket: bucketOf("completed", status.state === "pending" ? "pending" : status.state),
        detail: status.state,
        url: status.target_url ?? undefined,
        title: status.description ?? undefined,
    };
}

interface GhCheckRow {
    name: string;
    state?: string;
    bucket?: string;
    link?: string;
}

/** A row of `gh pr checks --json name,state,bucket,link`. gh's buckets are pass, fail, pending, skipping and cancel. */
export function fromGhRow(row: GhCheckRow): Check {
    const bucket: Bucket =
        row.bucket === "pass"
            ? "pass"
            : row.bucket === "skipping"
              ? "skipped"
              : row.bucket === "pending"
                ? "pending"
                : "fail";
    return { name: row.name, bucket, detail: row.state?.toLowerCase(), url: row.link || undefined };
}

interface Counts {
    pass: number;
    fail: number;
    pending: number;
    skipped: number;
}

export function count(checks: readonly Check[]): Counts {
    const counts: Counts = { pass: 0, fail: 0, pending: 0, skipped: 0 };
    for (const check of checks) counts[check.bucket]++;
    return counts;
}

export function describeCounts(counts: Counts): string {
    return `${counts.pass} pass, ${counts.fail} fail, ${counts.pending} pending, ${counts.skipped} skipped`;
}

export interface Judgement {
    verdict: "pass" | "fail" | "pending";
    /** The checks that decide: the required ones, or every check when nothing says which are required. */
    relevant: Check[];
    /** Required checks nobody has reported yet. */
    missing: string[];
    failing: Check[];
}

/**
 * Whether the checks that matter have passed. `required` names them; without names, every reported check matters. A
 * required check that has not been reported yet is pending, not absent: a build that has not started is not a build
 * that passed. The first failure among the relevant checks decides at once.
 */
export function judge(checks: readonly Check[], required: readonly string[]): Judgement {
    const missing: string[] = [];
    const relevant: Check[] = [];
    if (required.length > 0) {
        for (const name of required) {
            const found = checks.find((check) => check.name === name);
            if (found) relevant.push(found);
            else missing.push(name);
        }
    } else {
        relevant.push(...checks);
    }
    const failing = relevant.filter((check) => check.bucket === "fail");
    if (failing.length > 0) return { verdict: "fail", relevant, missing, failing };
    const settled = relevant.every((check) => check.bucket === "pass" || check.bucket === "skipped");
    const anything = relevant.length > 0 || missing.length > 0;
    return { verdict: settled && missing.length === 0 && anything ? "pass" : "pending", relevant, missing, failing };
}

const ORDER: Record<Bucket, number> = { fail: 0, pending: 1, skipped: 3, pass: 2 };

/** One line per check, failures first, then pending, passing and skipped. */
export function listChecks(checks: readonly Check[], max = 60): string {
    const sorted = [...checks].sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || a.name.localeCompare(b.name));
    const shown = sorted
        .slice(0, max)
        .map((check) => `${check.bucket.padEnd(8)} ${check.name}${check.url ? ` ${check.url}` : ""}`);
    return `${shown.join("\n")}${sorted.length > max ? `\n... ${sorted.length - max} more` : ""}`;
}
