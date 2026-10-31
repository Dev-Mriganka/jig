// Merge requests on GitLab, read only: view, list and comments, through `glab api`. Output is bounded plain text in the shape
// the GitHub actions give: the merge request in a few lines, a roll-up of its checks, and the discussions with the thread ids
// that `pr reply` and `pr resolve` take. A thread is `<number>:<discussion id>`, because GitLab addresses a discussion by the
// merge request it is in and its own id.
import { count, describeCounts, bucketOf } from "./ci.ts";
import type { Check } from "./ci.ts";
import type { GitlabHome } from "./forge.ts";
import { glabJson, glabPages, projectBase, withQuery } from "./gitlab.ts";
import { checkBranch, checkLine, checkNumber } from "./names.ts";
import type { Call, Planned } from "./previews.ts";
import { readOnly } from "./previews.ts";
import { entry } from "./pr-read.ts";
import { resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { currentBranch } from "./run.ts";
import { clip, plural } from "./text.ts";

/** What every GitLab action works with: the project, the repository to run glab in, and the call. */
export interface Gl {
    home: GitlabHome;
    repo: Repo;
    call: Call;
}

export interface GlUser {
    id?: number;
    username?: string;
    name?: string;
    bot?: boolean;
}

export interface Mr {
    iid: number;
    title: string;
    /** `opened`, `closed`, `locked` or `merged`. */
    state: string;
    draft?: boolean;
    author?: GlUser | null;
    source_branch: string;
    target_branch: string;
    /** The head of the source branch. */
    sha?: string | null;
    merge_status?: string;
    detailed_merge_status?: string;
    has_conflicts?: boolean;
    labels?: string[];
    reviewers?: GlUser[];
    web_url?: string;
    description?: string | null;
    head_pipeline?: { id: number; status: string; web_url?: string } | null;
    /** Whether the request is set to merge when its pipeline succeeds. */
    merge_when_pipeline_succeeds?: boolean;
}

export interface GlJob {
    name: string;
    status: string;
    allow_failure?: boolean;
    web_url?: string;
}

const BODY_CHARS = 6000;
const JOB_LIMIT = 100;
/** Discussions are read this many pages of 100 deep. */
export const DISCUSSION_PAGES = 5;

/** A GET outside the project, such as a user. */
export function getGlobal<T>(gl: Gl, what: string, endpoint: string): Promise<T> {
    return glabJson<T>(gl.home, what, endpoint, { cwd: gl.repo.root, signal: gl.call.signal });
}

/** A GET on the project, as JSON. `endpoint` is relative to the project, such as `merge_requests/42`. */
export function get<T>(gl: Gl, what: string, endpoint: string): Promise<T> {
    return glabJson<T>(gl.home, what, `${projectBase(gl.home)}/${endpoint}`, {
        cwd: gl.repo.root,
        signal: gl.call.signal,
    });
}

export function getMr(gl: Gl, iid: number): Promise<Mr> {
    return get<Mr>(gl, "glab api (merge request)", `merge_requests/${iid}`);
}

/** The first open merge request whose source branch is `branch`, if there is one. */
export async function openMrFor(gl: Gl, branch: string): Promise<Mr | undefined> {
    const rows = await get<Mr[]>(
        gl,
        "glab api (merge requests)",
        withQuery("merge_requests", {
            source_branch: branch,
            state: "opened",
            per_page: 5,
            order_by: "updated_at",
            sort: "desc",
        }),
    );
    return rows.find((row) => row.source_branch === branch);
}

/** The merge request a call means: its number, a source branch, or the branch that is checked out. */
export async function mrNumber(gl: Gl, params: { number?: number; branch?: string }): Promise<number> {
    if (params.number !== undefined) return checkNumber(params.number);
    const branch =
        params.branch !== undefined ? checkBranch(params.branch) : await currentBranch(gl.repo.root, gl.call.signal);
    if (!branch) throw new Error(`HEAD is detached in ${gl.repo.name}; pass number or branch`);
    const open = await openMrFor(gl, branch);
    if (open) return open.iid;
    // The newest of any state, as gh shows for a branch whose pull request was merged.
    const any = await get<Mr[]>(
        gl,
        "glab api (merge requests)",
        withQuery("merge_requests", {
            source_branch: branch,
            state: "all",
            per_page: 5,
            order_by: "updated_at",
            sort: "desc",
        }),
    );
    const found = any.find((row) => row.source_branch === branch);
    if (!found)
        throw new Error(`no merge request for ${branch} in ${gl.repo.name}: pass number, or open one with pr create`);
    return found.iid;
}

/** The prefix that makes a merge request a draft: GitLab keeps the state in the title. */
export const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-\s+)\s*/i;

/** Whether the merge request is a draft: by its flag, or by the prefix of its title. */
export const isDraft = (mr: Pick<Mr, "draft" | "title">): boolean => mr.draft === true || DRAFT_PREFIX.test(mr.title);

/** The title without the prefix that makes a merge request a draft. */
export function plainTitle(title: string): string {
    let rest = title;
    while (DRAFT_PREFIX.test(rest)) rest = rest.replace(DRAFT_PREFIX, "");
    return rest;
}

// ---- checks -------------------------------------------------------------------------------------------------------

/** One job as a check. A job that may fail does not fail the pipeline, so it does not fail here. */
export function jobCheck(job: GlJob): Check {
    let conclusion: string;
    switch (job.status) {
        case "success":
            conclusion = "success";
            break;
        case "failed":
            conclusion = job.allow_failure === true ? "neutral" : "failure";
            break;
        case "canceled":
        case "canceling":
            conclusion = "cancelled";
            break;
        case "skipped":
            conclusion = "skipped";
            break;
        case "created":
        case "pending":
        case "running":
        case "preparing":
        case "scheduled":
        case "manual":
        case "waiting_for_resource":
        case "waiting_for_callback":
            conclusion = "";
            break;
        default:
            // A status nobody knows is not a pass.
            conclusion = "failure";
    }
    return {
        name: job.name,
        bucket: bucketOf(conclusion === "" ? "pending" : "completed", conclusion),
        detail: job.status,
        ...(job.web_url ? { url: job.web_url } : {}),
    };
}

/** The jobs of the merge request's latest pipeline as checks; undefined when it has no pipeline. */
export async function checksOf(gl: Gl, mr: Mr): Promise<{ checks: Check[]; more: boolean } | undefined> {
    if (!mr.head_pipeline) return undefined;
    const jobs = await get<GlJob[]>(
        gl,
        "glab api (pipeline jobs)",
        withQuery(`pipelines/${mr.head_pipeline.id}/jobs`, { per_page: JOB_LIMIT }),
    );
    return { checks: jobs.map(jobCheck), more: jobs.length >= JOB_LIMIT };
}

// ---- view ---------------------------------------------------------------------------------------------------------

const who = (mr: Mr): string => (mr.author?.username ? ` by @${mr.author.username}` : "");

function formatMr(gl: Gl, mr: Mr, rollup: Awaited<ReturnType<typeof checksOf>>): string {
    const flags = [mr.state, isDraft(mr) ? "draft" : ""].filter(Boolean).join(", ");
    const body = (mr.description ?? "").trim();
    const reviewers = (mr.reviewers ?? []).map((user) => user.username ?? user.name ?? "").filter(Boolean);
    const status = mr.has_conflicts ? "conflict" : (mr.detailed_merge_status ?? mr.merge_status ?? "unknown");
    let checks = "checks: none (no pipeline)";
    if (rollup) {
        const failing = rollup.checks.filter((check) => check.bucket === "fail").map((check) => check.name);
        checks = `checks: ${describeCounts(count(rollup.checks))}${failing.length > 0 ? `; failing: ${failing.slice(0, 5).join(", ")}` : ""}${rollup.more ? ` (only the first ${JOB_LIMIT} jobs are read)` : ""}`;
    }
    const pipeline = mr.head_pipeline ? `; pipeline #${mr.head_pipeline.id} ${mr.head_pipeline.status}` : "";
    return [
        `MR !${mr.iid} ${mr.title} [${flags}]${who(mr)} in ${gl.repo.name}`,
        `${mr.source_branch} -> ${mr.target_branch} at ${(mr.sha ?? "").slice(0, 7)}; merge status: ${status}${pipeline}`,
        checks,
        (mr.labels ?? []).length > 0 ? `labels: ${(mr.labels ?? []).join(", ")}` : "",
        reviewers.length > 0 ? `review requested from: ${reviewers.join(", ")}` : "",
        mr.merge_when_pipeline_succeeds ? "auto-merge on (when the pipeline succeeds)" : "",
        mr.web_url ?? "",
        body
            ? `\n${clip(body, BODY_CHARS)}${body.length > BODY_CHARS ? `\n(${body.length - BODY_CHARS} more characters)` : ""}`
            : "",
    ]
        .filter((line) => line !== "")
        .join("\n");
}

export function planView(
    params: { repo?: string; number?: number; branch?: string },
    call: Call,
    home: GitlabHome,
): Planned {
    return readOnly(`pr view ${params.number ?? params.branch ?? "here"} in ${params.repo ?? "here"}`, async () => {
        const gl: Gl = { home, repo: await resolveRepo(params.repo, call.signal), call };
        const mr = await getMr(gl, await mrNumber(gl, params));
        return {
            text: formatMr(gl, mr, await checksOf(gl, mr)),
            facts: { pr: mr.iid },
            details: { number: mr.iid, head: mr.sha, state: mr.state },
        };
    });
}

// ---- list ---------------------------------------------------------------------------------------------------------

const STATES: Readonly<Record<string, string>> = { open: "opened", closed: "closed", merged: "merged", all: "all" };

export function planList(
    params: { repo?: string; state?: string; author?: string; branch?: string; limit?: number },
    call: Call,
    home: GitlabHome,
): Planned {
    const state = params.state ?? "open";
    if (!Object.hasOwn(STATES, state)) throw new Error("pr list: state must be one of open, closed, merged, all");
    const author = params.author === undefined ? undefined : checkLine(params.author, "author").replace(/^@/, "");
    const mine = params.author === "@me";
    const source = params.branch === undefined ? undefined : checkBranch(params.branch);
    const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20)));
    return readOnly(`pr list in ${params.repo ?? "here"}`, async () => {
        const gl: Gl = { home, repo: await resolveRepo(params.repo, call.signal), call };
        const rows = await get<Mr[]>(
            gl,
            "glab api (merge requests)",
            withQuery("merge_requests", {
                state: STATES[state],
                per_page: limit,
                order_by: "updated_at",
                sort: "desc",
                ...(mine ? { scope: "created_by_me" } : { author_username: author }),
                source_branch: source,
            }),
        );
        if (rows.length === 0) return { text: `No merge requests match in ${gl.repo.name}.` };
        const lines = rows.map(
            (row) =>
                `!${row.iid} ${row.state}${isDraft(row) ? " draft" : ""} ${row.source_branch} -> ${row.target_branch}  ${clip(plainTitle(row.title), 100)}${row.author?.username ? `  @${row.author.username}` : ""}`,
        );
        return {
            text: `${gl.repo.name}: ${plural(rows.length, "merge request")}\n${lines.join("\n")}`,
            details: { numbers: rows.map((row) => row.iid) },
        };
    });
}

// ---- comments -----------------------------------------------------------------------------------------------------

export interface GlNote {
    id: number;
    /** `DiffNote` for a comment on a line of the diff, `DiscussionNote` inside a thread, null for a single comment. */
    type?: string | null;
    body?: string | null;
    author?: GlUser | null;
    created_at?: string;
    system?: boolean;
    resolvable?: boolean;
    resolved?: boolean;
    position?: {
        new_path?: string | null;
        old_path?: string | null;
        new_line?: number | null;
        old_line?: number | null;
    } | null;
}

export interface GlDiscussion {
    id: string;
    individual_note?: boolean;
    notes: GlNote[];
}

/** The thread a reply or a resolve takes: the merge request and the discussion, which GitLab needs both of. */
export const threadId = (iid: number, discussion: string): string => `${iid}:${discussion}`;

const login = (note: GlNote): string => note.author?.username ?? "unknown";
const MAX_CHARS = 60_000;

/** The file and line a diff comment stands on, such as `src/orders.ts:42`; the old side when the line was removed. */
function placeOf(note: GlNote): string {
    const position = note.position;
    if (!position) return "";
    const file = position.new_path ?? position.old_path ?? "";
    const line = position.new_line ?? position.old_line;
    return `${file}${line ? `:${line}` : ""}`;
}

/** A thread that can be resolved and is not: one of its notes is resolvable and open. */
const isOpen = (discussion: GlDiscussion): boolean =>
    discussion.notes.some((note) => note.resolvable === true && note.resolved !== true);

export function planComments(
    params: { repo?: string; number?: number; branch?: string; author?: string; unresolved?: boolean },
    call: Call,
    home: GitlabHome,
): Planned {
    const author = params.author === undefined ? undefined : checkLine(params.author, "author").replace(/^@/, "");
    return readOnly(`pr comments ${params.number ?? params.branch ?? "here"} in ${params.repo ?? "here"}`, async () => {
        const gl: Gl = { home, repo: await resolveRepo(params.repo, call.signal), call };
        const number = await mrNumber(gl, params);
        const { items: all, more } = await glabPages<GlDiscussion>(
            home,
            "glab api (discussions)",
            `${projectBase(home)}/merge_requests/${number}/discussions?per_page=100`,
            DISCUSSION_PAGES,
            { cwd: gl.repo.root, signal: call.signal },
        );
        const by = (note: GlNote) => author === undefined || login(note).toLowerCase() === author.toLowerCase();
        const items: Array<{ at: string; text: string }> = [];
        for (const discussion of all) {
            const notes = discussion.notes.filter((note) => note.system !== true && (note.body ?? "").trim() !== "");
            if (notes.length === 0) continue;
            if (params.unresolved && !isOpen(discussion)) continue;
            if (author !== undefined && !notes.some(by)) continue;
            const thread = threadId(number, discussion.id);
            const first = notes[0] as GlNote;
            if (discussion.individual_note === true) {
                items.push({
                    at: first.created_at ?? "",
                    text: entry(
                        `${(first.created_at ?? "").slice(0, 16)} comment @${login(first)} (thread ${thread})`,
                        first.body ?? "",
                    ),
                });
                continue;
            }
            const where = placeOf(first);
            const state = discussion.notes.some((note) => note.resolvable === true)
                ? isOpen(discussion)
                    ? "unresolved"
                    : "resolved"
                : "not resolvable";
            const inner = notes
                .map((note, index) =>
                    entry(
                        `${index === 0 ? "" : "reply "}@${login(note)} ${(note.created_at ?? "").slice(0, 16)}`,
                        note.body ?? "",
                    ).replace(/^/gm, "  "),
                )
                .join("\n");
            items.push({
                at: first.created_at ?? "",
                text: `thread ${thread}${where ? ` ${where}` : ""} [${state}]\n${inner}`,
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
        if (items.length === 0)
            return {
                text: `merge request ${number}: nothing to show${params.unresolved ? " (no unresolved threads)" : ""}.`,
            };
        return {
            text: [
                `merge request ${number}: ${plural(items.length, "item")}`,
                ...shown,
                left > 0 ? `... ${left} more items; filter by author or unresolved` : "",
                more
                    ? `(GitLab holds more than ${DISCUSSION_PAGES * 100} threads; only the first ${DISCUSSION_PAGES * 100} are read)`
                    : "",
            ]
                .filter(Boolean)
                .join("\n"),
            details: { threads: all.map((discussion) => threadId(number, discussion.id)) },
        };
    });
}
