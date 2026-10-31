// Pull requests, read only: view, list and comments. Output is bounded plain text. The comments action puts together what
// GitHub keeps in three places (the conversation, the reviews, and the threads of line comments) so a reviewer's findings
// are read in one call, with the thread ids that `pr reply` and `pr resolve` take.
import { count, describeCounts, fromRollup } from "./ci.ts";
import type { Check } from "./ci.ts";
import { gh, ghJson, graphql, repoFlags, requireRemote } from "./github.ts";
import { checkBranch, checkLine, checkNumber } from "./names.ts";
import type { Call, Planned } from "./previews.ts";
import { readOnly } from "./previews.ts";
import { resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { currentBranch } from "./run.ts";
import { clip, plural } from "./text.ts";

const VIEW_FIELDS =
    "number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url,body,labels,reviewRequests,autoMergeRequest";
const BODY_CHARS = 6000;

export interface PrDetail {
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    author?: { login?: string };
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    mergeable: string;
    mergeStateStatus?: string;
    reviewDecision: string;
    statusCheckRollup: Parameters<typeof fromRollup>[0][] | null;
    url: string;
    body: string | null;
    labels?: { name: string }[];
    reviewRequests?: { login?: string; name?: string; slug?: string }[];
    autoMergeRequest?: { mergeMethod?: string; enabledBy?: { login?: string } } | null;
}

/** The pull request a call means: its number, a head branch, or the branch that is checked out. */
export async function selectorFor(
    repo: Repo,
    params: { number?: number; branch?: string },
    signal?: AbortSignal,
): Promise<string> {
    if (params.number !== undefined) return String(checkNumber(params.number));
    if (params.branch !== undefined) return checkBranch(params.branch);
    const branch = await currentBranch(repo.root, signal);
    if (!branch) throw new Error(`HEAD is detached in ${repo.name}; pass number or branch`);
    return branch;
}

export async function viewPr(repo: Repo, selector: string, call: Call, fields = VIEW_FIELDS): Promise<PrDetail> {
    const flags = await repoFlags(repo, call.settings, call.signal);
    return ghJson<PrDetail>(
        "gh pr view",
        await gh(["pr", "view", selector, "--json", fields, ...flags], { cwd: repo.root, signal: call.signal }),
    );
}

export function checksOfPr(pr: Pick<PrDetail, "statusCheckRollup">): Check[] {
    return (pr.statusCheckRollup ?? []).map(fromRollup);
}

function who(pr: PrDetail): string {
    return pr.author?.login ? ` by @${pr.author.login}` : "";
}

function formatPr(repo: Repo, pr: PrDetail): string {
    const checks = checksOfPr(pr);
    const counts = count(checks);
    const failing = checks.filter((check) => check.bucket === "fail").map((check) => check.name);
    const flags = [pr.state.toLowerCase(), pr.isDraft ? "draft" : ""].filter(Boolean).join(", ");
    const body = (pr.body ?? "").trim();
    const reviewers = (pr.reviewRequests ?? [])
        .map((request) => request.login ?? request.name ?? request.slug ?? "")
        .filter(Boolean);
    const merge = pr.autoMergeRequest
        ? `auto-merge on (${(pr.autoMergeRequest.mergeMethod ?? "merge").toLowerCase()})`
        : undefined;
    return [
        `PR #${pr.number} ${pr.title} [${flags}]${who(pr)} in ${repo.name}`,
        `${pr.headRefName} -> ${pr.baseRefName} at ${pr.headRefOid.slice(0, 7)}; mergeable: ${pr.mergeable || "UNKNOWN"}; review: ${pr.reviewDecision || "none"}`,
        `checks: ${describeCounts(counts)}${failing.length > 0 ? `; failing: ${failing.slice(0, 5).join(", ")}` : ""}`,
        (pr.labels ?? []).length > 0 ? `labels: ${(pr.labels ?? []).map((label) => label.name).join(", ")}` : "",
        reviewers.length > 0 ? `review requested from: ${reviewers.join(", ")}` : "",
        merge ?? "",
        pr.url,
        body
            ? `\n${clip(body, BODY_CHARS)}${body.length > BODY_CHARS ? `\n(${body.length - BODY_CHARS} more characters)` : ""}`
            : "",
    ]
        .filter((line) => line !== "")
        .join("\n");
}

export function planView(params: { repo?: string; number?: number; branch?: string }, call: Call): Planned {
    return readOnly(`pr view ${params.number ?? params.branch ?? "here"} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const pr = await viewPr(repo, await selectorFor(repo, params, call.signal), call);
        return {
            text: formatPr(repo, pr),
            facts: { pr: pr.number },
            details: { number: pr.number, head: pr.headRefOid, state: pr.state },
        };
    });
}

interface PrRow {
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    headRefName: string;
    baseRefName: string;
    url: string;
    author?: { login?: string };
}

export function planList(
    params: { repo?: string; state?: string; author?: string; branch?: string; limit?: number },
    call: Call,
): Planned {
    const state = params.state ?? "open";
    if (!["open", "closed", "merged", "all"].includes(state))
        throw new Error("pr list: state must be one of open, closed, merged, all");
    const author = params.author === undefined ? undefined : checkLine(params.author, "author");
    const head = params.branch === undefined ? undefined : checkBranch(params.branch);
    const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20)));
    return readOnly(`pr list in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const flags = await repoFlags(repo, call.settings, call.signal);
        const args = [
            "pr",
            "list",
            "--state",
            state,
            "--limit",
            String(limit),
            "--json",
            "number,title,state,isDraft,headRefName,baseRefName,url,author",
            ...(author ? [`--author=${author}`] : []),
            ...(head ? ["--head", head] : []),
            ...flags,
        ];
        const rows = ghJson<PrRow[]>("gh pr list", await gh(args, { cwd: repo.root, signal: call.signal }));
        if (rows.length === 0) return { text: `No pull requests match in ${repo.name}.` };
        const lines = rows.map(
            (row) =>
                `#${row.number} ${row.state.toLowerCase()}${row.isDraft ? " draft" : ""} ${row.headRefName} -> ${row.baseRefName}  ${clip(row.title, 100)}${row.author?.login ? `  @${row.author.login}` : ""}`,
        );
        return {
            text: `${repo.name}: ${plural(rows.length, "pull request")}\n${lines.join("\n")}`,
            details: { numbers: rows.map((row) => row.number) },
        };
    });
}

// ---- comments -----------------------------------------------------------------------------------------------------

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      comments(first: 100) { totalCount nodes { author { login } body createdAt url } }
      reviews(first: 100) { totalCount nodes { author { login } state body submittedAt url } }
      reviewThreads(first: 100) {
        totalCount
        nodes { id isResolved isOutdated path line comments(first: 50) { nodes { author { login } body createdAt url } } }
      }
    }
  }
}`;

interface Node {
    author?: { login?: string } | null;
    body?: string;
    createdAt?: string;
    submittedAt?: string;
    state?: string;
    url?: string;
}

interface Thread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    line: number | null;
    comments: { nodes: Node[] };
}

interface PullComments {
    number: number;
    url: string;
    comments: { totalCount: number; nodes: Node[] };
    reviews: { totalCount: number; nodes: Node[] };
    reviewThreads: { totalCount: number; nodes: Thread[] };
}

const login = (node: Node): string => node.author?.login ?? "unknown";
const MAX_CHARS = 60_000;
const BODY_LIMIT = 6000;

/** One item of the conversation, as lines. A body is shown whole up to a generous limit. */
export function entry(head: string, body: string): string {
    const text = body.trim();
    return `${head}\n${clip(text, BODY_LIMIT).replace(/^/gm, "    ")}${text.length > BODY_LIMIT ? `\n    (${text.length - BODY_LIMIT} more characters)` : ""}`;
}

export function planComments(
    params: { repo?: string; number?: number; branch?: string; author?: string; unresolved?: boolean },
    call: Call,
): Planned {
    const author = params.author === undefined ? undefined : checkLine(params.author, "author").replace(/^@/, "");
    return readOnly(`pr comments ${params.number ?? params.branch ?? "here"} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const remote = await requireRemote(repo, call.settings, call.signal);
        const { slug } = remote;
        const number =
            params.number ??
            ghJson<{ number: number }>(
                "gh pr view",
                await gh(
                    [
                        "pr",
                        "view",
                        await selectorFor(repo, params, call.signal),
                        "--json",
                        "number",
                        ...(await repoFlags(repo, call.settings, call.signal)),
                    ],
                    { cwd: repo.root, signal: call.signal },
                ),
            ).number;
        const [owner = "", name = ""] = slug.split("/");
        const data = await graphql<{ repository: { pullRequest: PullComments | null } }>(
            QUERY,
            { owner, name, number },
            { cwd: repo.root, signal: call.signal, host: remote.host },
        );
        const pr = data.repository.pullRequest;
        if (!pr) throw new Error(`pull request ${number} was not found in ${slug}`);
        const mentions = (node: Node) => author === undefined || login(node).toLowerCase() === author.toLowerCase();
        const items: Array<{ at: string; text: string }> = [];
        if (!params.unresolved) {
            for (const comment of pr.comments.nodes.filter(mentions))
                items.push({
                    at: comment.createdAt ?? "",
                    text: entry(
                        `${(comment.createdAt ?? "").slice(0, 16)} comment @${login(comment)}`,
                        comment.body ?? "",
                    ),
                });
            for (const review of pr.reviews.nodes.filter((node) => mentions(node) && (node.body ?? "").trim() !== "")) {
                items.push({
                    at: review.submittedAt ?? "",
                    text: entry(
                        `${(review.submittedAt ?? "").slice(0, 16)} review ${(review.state ?? "").toLowerCase()} @${login(review)}`,
                        review.body ?? "",
                    ),
                });
            }
        }
        for (const thread of pr.reviewThreads.nodes) {
            if (params.unresolved && thread.isResolved) continue;
            if (author !== undefined && !thread.comments.nodes.some(mentions)) continue;
            const where = `${thread.path}${thread.line ? `:${thread.line}` : ""}`;
            const state = `${thread.isResolved ? "resolved" : "unresolved"}${thread.isOutdated ? ", outdated" : ""}`;
            const inner = thread.comments.nodes
                .map((comment, index) =>
                    entry(
                        `${index === 0 ? "" : "reply "}@${login(comment)} ${(comment.createdAt ?? "").slice(0, 16)}`,
                        comment.body ?? "",
                    ).replace(/^/gm, "  "),
                )
                .join("\n");
            items.push({
                at: thread.comments.nodes[0]?.createdAt ?? "",
                text: `thread ${thread.id} ${where} [${state}]\n${inner}`,
            });
        }
        items.sort((a, b) => a.at.localeCompare(b.at));
        const shown: string[] = [];
        let size = 0;
        for (const item of items) {
            if (size + item.text.length > MAX_CHARS && shown.length > 0) break;
            shown.push(item.text);
            size += item.text.length;
        }
        const left = items.length - shown.length;
        const more = [
            pr.comments.totalCount > 100 ? "comments" : "",
            pr.reviews.totalCount > 100 ? "reviews" : "",
            pr.reviewThreads.totalCount > 100 ? "threads" : "",
        ].filter(Boolean);
        if (items.length === 0)
            return {
                text: `pull request ${number}: nothing to show${params.unresolved ? " (no unresolved threads)" : ""}.`,
            };
        return {
            text: [
                `pull request ${number}: ${plural(items.length, "item")}`,
                ...shown,
                left > 0 ? `... ${left} more items; filter by author or unresolved` : "",
                more.length > 0
                    ? `(GitHub holds more than 100 ${more.join(", ")}; only the first 100 of each are read)`
                    : "",
            ]
                .filter(Boolean)
                .join("\n"),
            details: { threads: pr.reviewThreads.nodes.map((thread) => thread.id) },
        };
    });
}
