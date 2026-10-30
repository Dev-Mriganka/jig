// What `pr view` says about the checks of a pull request, in one line. The rollup that `gh pr view` prints (check runs and
// commit statuses) becomes a `Check` with one of four buckets: pass, fail, pending or skipped. A check that is still
// running is never a pass, and a cancelled one is a failure. Looking at checks in more detail, and watching them, is the
// `ci` tool of jig-ops.

type Bucket = "pass" | "fail" | "pending" | "skipped";

export interface Check {
    name: string;
    bucket: Bucket;
    /** The conclusion or state as GitHub words it, such as `timed_out`. */
    detail?: string;
    url?: string;
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

interface RollupLike {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    detailsUrl?: string;
    targetUrl?: string;
}

/** An item of `statusCheckRollup` in `gh pr view --json`. */
export function fromRollup(item: RollupLike): Check {
    const isStatus = item.__typename === "StatusContext" || (item.context !== undefined && item.name === undefined);
    return {
        name: item.name ?? item.context ?? "check",
        bucket: isStatus
            ? bucketOf("completed", item.state === "PENDING" ? "pending" : item.state)
            : bucketOf(item.status, item.conclusion),
        detail: (item.conclusion || item.state || item.status || "").toLowerCase() || undefined,
        url: item.detailsUrl ?? item.targetUrl,
    };
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
