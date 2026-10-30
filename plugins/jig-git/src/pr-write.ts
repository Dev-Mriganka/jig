// Pull request writes: create, edit, ready, comment, reply, resolve, review and merge. Each plan reads what could have moved
// and builds the text the user would see, with a digest of it. Each run sends the request once. If the reply is lost, one
// read of GitHub says whether the request went through, and the request is never sent again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { count, describeCounts } from "./ci.ts";
import { announcePushed } from "./events.ts";
import { afterLostReply, gh, ghJson, ghWrite, graphql, lastLine, prNumberFromUrl, repoFlags } from "./github.ts";
import type { GhOptions } from "./github.ts";
import { checkBody, checkBranch, checkNumber, checkTitle, checkWords } from "./names.ts";
import { checksOfPr, viewPr } from "./pr-read.ts";
import type { PrDetail } from "./pr-read.ts";
import type { Call, Planned } from "./previews.ts";
import { digest, reviewPreview } from "./previews.ts";
import { baseBranch, githubRepo, resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { currentBranch, revParse } from "./run.ts";
import { lines } from "./text.ts";

// ---- the body template --------------------------------------------------------------------------------------------

const TEMPLATE_FILES = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

/** The body template: the file `git.prTemplate` names, else the repository's own. */
function readTemplate(repo: Repo, prTemplate: string | undefined): string | undefined {
    const files =
        prTemplate === undefined
            ? TEMPLATE_FILES.map((file) => path.join(repo.root, file))
            : [path.resolve(repo.root, prTemplate.replace(/^~(?=\/|$)/, os.homedir()))];
    for (const file of files) {
        try {
            return fs.readFileSync(file, "utf8");
        } catch {
            // Not there: try the next place.
        }
    }
    return undefined;
}

// ---- helpers ------------------------------------------------------------------------------------------------------

interface OpenPr {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
}

async function openPrFor(repo: Repo, branch: string, call: Call): Promise<OpenPr | undefined> {
    const flags = await repoFlags(repo, call.settings, call.signal);
    const result = await gh(
        [
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--limit",
            "5",
            "--json",
            "number,title,url,baseRefName,headRefName",
            ...flags,
        ],
        { cwd: repo.root, signal: call.signal },
    );
    return ghJson<OpenPr[]>("gh pr list", result).find((row) => row.headRefName === branch);
}

/** What a write passes to gh: the repository to run in, the pull request's repository flags, and the abort signal. */
async function options(repo: Repo, call: Call): Promise<{ flags: string[]; run: GhOptions }> {
    return { flags: await repoFlags(repo, call.settings, call.signal), run: { cwd: repo.root, signal: call.signal } };
}

/**
 * The call for the one read that follows a lost reply. A call that was cancelled has an aborted signal, and the check must
 * still run: it is how we learn whether the request went through before it was cancelled.
 */
function afterwards(call: Call): Call {
    return { ...call, signal: undefined };
}

// ---- create -------------------------------------------------------------------------------------------------------

interface CreateParams {
    repo?: string;
    title?: string;
    body?: string;
    branch?: string;
    base?: string;
    draft?: boolean;
}

export async function planCreate(params: CreateParams, call: Call): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal, settings } = call;
    const title = checkTitle(params.title);
    if (params.body === undefined || params.body.trim() === "") {
        const template = readTemplate(repo, settings.prTemplate);
        throw new Error(
            `pr create needs body: write the description.${template === undefined ? "" : `\nFill in this template:\n---\n${template.trimEnd()}\n---`}`,
        );
    }
    const body = checkBody(params.body);
    const branch = params.branch === undefined ? await currentBranch(repo.root, signal) : checkBranch(params.branch);
    if (!branch) throw new Error(`HEAD is detached in ${repo.name}; pass branch`);
    const base =
        params.base === undefined ? await baseBranch(repo, settings, signal) : checkBranch(params.base, "base");
    if (base === branch) throw new Error(`head and base are both ${branch}; open the pull request from another branch`);
    const local = await revParse(repo.root, `refs/heads/${branch}`, signal);
    const remote = await revParse(repo.root, `refs/remotes/origin/${branch}`, signal);
    if (!local) throw new Error(`branch ${branch} does not exist locally`);
    if (remote !== local)
        throw new Error(
            `${branch} is not pushed to origin at its local tip; run git push first (this tool does not push)`,
        );
    const existing = await openPrFor(repo, branch, call);
    const slug = (await githubRepo(repo, settings, signal))?.slug ?? repo.name;
    const draft = params.draft === true;
    const summary = existing
        ? `pull request ${existing.number} is already open for ${branch}; nothing will be created`
        : `create a pull request ${branch} -> ${base}${draft ? " (draft)" : ""} at ${local.slice(0, 7)} in ${repo.name}`;
    return {
        preview: reviewPreview(
            summary,
            `# ${title}\n\n${body}`,
            digest("pr create", slug, branch, base, local, title, body, draft),
        ),
        run: async () => {
            if (existing) {
                return {
                    text: `Pull request #${existing.number} is already open for ${branch} (base ${existing.baseRefName}): ${existing.url}. No new one was created.`,
                    details: { number: existing.number, created: false },
                };
            }
            const { flags, run } = await options(repo, call);
            const sent = await ghWrite(
                "gh pr create",
                [
                    "pr",
                    "create",
                    "--base",
                    base,
                    "--head",
                    branch,
                    `--title=${title}`,
                    "--body-file",
                    "-",
                    ...(draft ? ["--draft"] : []),
                    ...flags,
                ],
                { ...run, input: body },
            );
            if (sent.kind === "sent") {
                const url = lastLine(sent.result.stdout);
                const number = prNumberFromUrl(url);
                if (number === undefined)
                    throw new Error(
                        `gh pr create printed no pull request URL; run pr list for ${branch} before trying again`,
                    );
                return finishCreate(
                    repo,
                    call,
                    number,
                    branch,
                    base,
                    local,
                    `Created pull request #${number} ${branch} -> ${base} in ${repo.name}: ${url}`,
                );
            }
            // The reply was lost. One look at GitHub says whether the pull request exists.
            let number = 0;
            const found = await afterLostReply("gh pr create", sent.why, async () => {
                const row = await openPrFor(repo, branch, afterwards(call));
                if (!row) return undefined;
                number = row.number;
                return `Created pull request #${row.number} ${branch} -> ${base} in ${repo.name}: ${row.url}`;
            });
            return finishCreate(repo, call, number, branch, base, local, found.text);
        },
    };
}

async function finishCreate(
    repo: Repo,
    call: Call,
    number: number,
    branch: string,
    base: string,
    sha: string,
    text: string,
) {
    // The pull request now exists, so anyone watching the pushed commit can watch it as a pull request.
    await announcePushed({ repo, settings: call.settings, branch, sha, pr: number, signal: call.signal });
    return { text, facts: { pr: number }, details: { number, created: true, base } };
}

// ---- edit and ready -----------------------------------------------------------------------------------------------

interface EditParams {
    repo?: string;
    number?: number;
    title?: string;
    body?: string;
    base?: string;
    labels?: string[];
    reviewers?: string[];
}

export async function planEdit(params: EditParams, call: Call): Promise<Planned> {
    const number = checkNumber(params.number);
    const edit = {
        title: params.title === undefined ? undefined : checkTitle(params.title),
        body: params.body === undefined ? undefined : checkBody(params.body),
        base: params.base === undefined ? undefined : checkBranch(params.base, "base"),
        labels: params.labels === undefined ? undefined : checkWords(params.labels, "labels"),
        reviewers: params.reviewers === undefined ? undefined : checkWords(params.reviewers, "reviewers"),
    };
    if (Object.values(edit).every((value) => value === undefined))
        throw new Error(
            "pr edit needs title, body, base, labels or reviewers. Usage: pr edit {number, title?, body?, base?, labels?, reviewers?, repo?}",
        );
    const repo = await resolveRepo(params.repo, call.signal);
    const shown = lines(
        edit.title !== undefined && `Title: ${edit.title}`,
        edit.base !== undefined && `Base: ${edit.base}`,
        edit.labels !== undefined && `Add labels: ${edit.labels.join(", ")}`,
        edit.reviewers !== undefined && `Request review from: ${edit.reviewers.join(", ")}`,
        edit.body !== undefined && `\nNew description (replaces the whole old one):\n\n${edit.body}`,
    );
    const changing = Object.entries(edit)
        .filter(([, value]) => value !== undefined)
        .map(([name]) => name);
    return {
        preview: reviewPreview(
            `edit the ${changing.join(", ")} of pull request ${number} in ${repo.name}`,
            shown,
            digest("pr edit", repo.root, number, edit),
        ),
        run: async () => {
            const { flags, run } = await options(repo, call);
            const args = [
                "pr",
                "edit",
                String(number),
                ...(edit.title === undefined ? [] : [`--title=${edit.title}`]),
                ...(edit.base === undefined ? [] : ["--base", edit.base]),
                ...(edit.labels === undefined ? [] : [`--add-label=${edit.labels.join(",")}`]),
                ...(edit.reviewers === undefined ? [] : [`--add-reviewer=${edit.reviewers.join(",")}`]),
                ...(edit.body === undefined ? [] : ["--body-file", "-"]),
                ...flags,
            ];
            const done = `Edited the ${changing.join(", ")} of pull request #${number} in ${repo.name}.`;
            const sent = await ghWrite("gh pr edit", args, { ...run, input: edit.body });
            if (sent.kind === "sent") return { text: done, details: { number, changed: changing } };
            return afterLostReply("gh pr edit", sent.why, async () => {
                const now = await viewPr(
                    repo,
                    String(number),
                    afterwards(call),
                    "title,body,baseRefName,labels,reviewRequests",
                );
                const labels = (now.labels ?? []).map((label) => label.name);
                const asked = (now.reviewRequests ?? []).map(
                    (request) => request.login ?? request.name ?? request.slug ?? "",
                );
                const same =
                    (edit.title === undefined || now.title === edit.title) &&
                    (edit.body === undefined || (now.body ?? "").trim() === edit.body.trim()) &&
                    (edit.base === undefined || now.baseRefName === edit.base) &&
                    (edit.labels === undefined || edit.labels.every((label) => labels.includes(label))) &&
                    (edit.reviewers === undefined || edit.reviewers.every((reviewer) => asked.includes(reviewer)));
                return same ? done : undefined;
            });
        },
    };
}

export async function planReady(params: { repo?: string; number?: number }, call: Call): Promise<Planned> {
    const number = checkNumber(params.number);
    const repo = await resolveRepo(params.repo, call.signal);
    return {
        preview: {
            summary: `mark pull request ${number} in ${repo.name} ready for review`,
            fingerprint: digest("pr ready", repo.root, number),
        },
        run: async () => {
            const { flags, run } = await options(repo, call);
            const done = `Pull request #${number} in ${repo.name} is ready for review.`;
            const sent = await ghWrite("gh pr ready", ["pr", "ready", String(number), ...flags], run);
            if (sent.kind === "sent") return { text: done };
            return afterLostReply("gh pr ready", sent.why, async () =>
                (await viewPr(repo, String(number), afterwards(call), "isDraft")).isDraft ? undefined : done,
            );
        },
    };
}

// ---- comment, reply, resolve, review ------------------------------------------------------------------------------

export async function planComment(
    params: { repo?: string; number?: number; body?: string },
    call: Call,
): Promise<Planned> {
    const number = checkNumber(params.number);
    const body = checkBody(params.body);
    const repo = await resolveRepo(params.repo, call.signal);
    return {
        preview: reviewPreview(
            `comment on pull request ${number} in ${repo.name}`,
            body,
            digest("pr comment", repo.root, number, body),
        ),
        run: async () => {
            const started = new Date().toISOString();
            const { flags, run } = await options(repo, call);
            const sent = await ghWrite(
                "gh pr comment",
                ["pr", "comment", String(number), "--body-file", "-", ...flags],
                { ...run, input: body },
            );
            if (sent.kind === "sent") {
                const url = lastLine(sent.result.stdout);
                return {
                    text: `Commented on pull request #${number} in ${repo.name}${url.startsWith("http") ? `: ${url}` : "."}`,
                    details: { number, url: url || undefined },
                };
            }
            return afterLostReply("gh pr comment", sent.why, async () => {
                const now = ghJson<{ comments: { body: string; createdAt: string; url: string }[] }>(
                    "gh pr view",
                    await gh(["pr", "view", String(number), "--json", "comments", ...flags], { cwd: repo.root }),
                );
                const found = now.comments
                    .slice(-10)
                    .find(
                        (comment) => comment.body.trim() === body.trim() && comment.createdAt >= started.slice(0, 19),
                    );
                return found ? `Commented on pull request #${number} in ${repo.name}: ${found.url}` : undefined;
            });
        },
    };
}

const REPLY = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { url } }
}`;
const RESOLVE = `mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } }
}`;
const THREAD = `query($thread: ID!) {
  node(id: $thread) { ... on PullRequestReviewThread { isResolved comments(last: 5) { nodes { body url createdAt } } } }
}`;

interface ThreadState {
    node: { isResolved?: boolean; comments?: { nodes: { body: string; url: string; createdAt: string }[] } } | null;
}

function checkThread(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_=-]{8,200}$/.test(value))
        throw new Error("thread must be a review thread id such as PRRT_kwDO...; pr comments lists them");
    return value;
}

/** A GraphQL mutation through gh, with the same lost-reply handling as every other write. */
async function mutate(
    what: string,
    query: string,
    variables: Record<string, unknown>,
    run: GhOptions,
    look: () => Promise<string | undefined>,
    done: (data: unknown) => string,
) {
    const sent = await ghWrite(what, ["api", "graphql", "--input", "-"], {
        ...run,
        input: JSON.stringify({ query, variables }),
    });
    if (sent.kind === "lost") return afterLostReply(what, sent.why, look);
    const parsed = JSON.parse(sent.result.stdout || "{}") as { data?: unknown; errors?: { message?: string }[] };
    if (parsed.errors?.length) throw new Error(`${what} failed: ${parsed.errors[0]?.message ?? "GitHub refused it"}`);
    return { text: done(parsed.data) };
}

export async function planReply(
    params: { repo?: string; thread?: string; body?: string },
    call: Call,
): Promise<Planned> {
    const thread = checkThread(params.thread);
    const body = checkBody(params.body);
    return {
        preview: reviewPreview(`reply in review thread ${thread}`, body, digest("pr reply", thread, body)),
        run: () => {
            const started = new Date().toISOString().slice(0, 19);
            return mutate(
                "gh api graphql (reply)",
                REPLY,
                { thread, body },
                { signal: call.signal },
                async () => {
                    const now = await graphql<ThreadState>(THREAD, { thread });
                    const found = now.node?.comments?.nodes.find(
                        (comment) => comment.body.trim() === body.trim() && comment.createdAt >= started,
                    );
                    return found ? `Replied in review thread ${thread}: ${found.url}` : undefined;
                },
                (data) =>
                    `Replied in review thread ${thread}: ${(data as { addPullRequestReviewThreadReply?: { comment?: { url?: string } } })?.addPullRequestReviewThreadReply?.comment?.url ?? ""}`.trimEnd(),
            );
        },
    };
}

export async function planResolve(params: { repo?: string; thread?: string }, call: Call): Promise<Planned> {
    const thread = checkThread(params.thread);
    return {
        preview: { summary: `resolve review thread ${thread}`, fingerprint: digest("pr resolve", thread) },
        run: () =>
            mutate(
                "gh api graphql (resolve)",
                RESOLVE,
                { thread },
                { signal: call.signal },
                async () =>
                    (await graphql<ThreadState>(THREAD, { thread })).node?.isResolved
                        ? `Resolved review thread ${thread}.`
                        : undefined,
                () => `Resolved review thread ${thread}.`,
            ),
    };
}

export async function planReview(
    params: { repo?: string; number?: number; event?: string; body?: string },
    call: Call,
): Promise<Planned> {
    const number = checkNumber(params.number);
    // Approval is a person's decision: this action has no way to give it.
    if (params.event !== "comment" && params.event !== "request_changes")
        throw new Error(
            "pr review sends a comment or requests changes. It never approves: approval stays with a person.",
        );
    const body = checkBody(params.body);
    const repo = await resolveRepo(params.repo, call.signal);
    const verb = params.event === "comment" ? "a review comment" : "a request for changes";
    return {
        preview: reviewPreview(
            `send ${verb} on pull request ${number} in ${repo.name}`,
            body,
            digest("pr review", repo.root, number, params.event, body),
        ),
        run: async () => {
            const started = new Date().toISOString().slice(0, 19);
            const { flags, run } = await options(repo, call);
            const flag = params.event === "comment" ? "--comment" : "--request-changes";
            const done = `Sent ${verb} on pull request #${number} in ${repo.name}.`;
            const sent = await ghWrite(
                "gh pr review",
                ["pr", "review", String(number), flag, "--body-file", "-", ...flags],
                { ...run, input: body },
            );
            if (sent.kind === "sent") return { text: done };
            return afterLostReply("gh pr review", sent.why, async () => {
                const now = ghJson<{ reviews: { body: string; submittedAt: string; state: string }[] }>(
                    "gh pr view",
                    await gh(["pr", "view", String(number), "--json", "reviews", ...flags], { cwd: repo.root }),
                );
                const state = params.event === "comment" ? "COMMENTED" : "CHANGES_REQUESTED";
                return now.reviews
                    .slice(-10)
                    .some(
                        (review) =>
                            review.state === state &&
                            review.body.trim() === body.trim() &&
                            review.submittedAt >= started,
                    )
                    ? done
                    : undefined;
            });
        },
    };
}

// ---- merge --------------------------------------------------------------------------------------------------------

const METHODS = ["merge", "squash", "rebase"] as const;
type Method = (typeof METHODS)[number];

export async function planMerge(
    params: { repo?: string; number?: number; method?: string; auto?: boolean },
    call: Call,
): Promise<Planned> {
    const number = checkNumber(params.number);
    if (!METHODS.includes(params.method as Method)) throw new Error("method is required: merge, squash or rebase");
    const method = params.method as Method;
    const auto = params.auto === true;
    const repo = await resolveRepo(params.repo, call.signal);
    const pr: PrDetail = await viewPr(repo, String(number), call);
    const state = pr.state ?? "OPEN";
    if (state !== "OPEN") throw new Error(`pull request ${number} is ${state.toLowerCase()}, not open`);
    if (pr.isDraft) throw new Error(`pull request ${number} is a draft; mark it ready for review first`);
    if (pr.mergeable === "CONFLICTING")
        throw new Error(
            `pull request ${number} conflicts with ${pr.baseRefName}; resolve the conflicts on ${pr.headRefName} first`,
        );
    const counts = count(checksOfPr(pr));
    const head = pr.headRefOid;
    // The merge is pinned to this commit. Without one there is nothing to pin it to, and it must not run unpinned.
    if (!head)
        throw new Error(`GitHub did not say which commit pull request ${number} is at, so the merge cannot be pinned`);
    const what = auto ? `turn on auto-merge (${method}) for` : `${method}-merge`;
    return {
        preview: {
            summary: `${what} pull request ${number} into ${pr.baseRefName} in ${repo.name}: ${pr.title} (head ${head.slice(0, 7)})`,
            body: lines(
                `${pr.title}`,
                `From ${pr.headRefName} at ${head.slice(0, 7)} into ${pr.baseRefName}, by ${method}.`,
                `Checks: ${describeCounts(counts)}. Review: ${pr.reviewDecision || "none"}.`,
                `It merges only while the head is still ${head.slice(0, 7)}.`,
            ),
            format: "text",
            fingerprint: digest("pr merge", repo.root, number, pr.title, method, head, pr.baseRefName, auto),
        },
        run: async () => {
            const { flags, run } = await options(repo, call);
            const done = auto
                ? `Auto-merge is on for pull request #${number} (${method}) in ${repo.name}: it merges when its requirements are met.`
                : `Merged pull request #${number} into ${pr.baseRefName} (${method}) at ${head.slice(0, 7)} in ${repo.name}.`;
            // --match-head-commit makes GitHub refuse when the head is no longer the commit that was shown.
            const sent = await ghWrite(
                "gh pr merge",
                [
                    "pr",
                    "merge",
                    String(number),
                    `--${method}`,
                    "--match-head-commit",
                    head,
                    ...(auto ? ["--auto"] : []),
                    ...flags,
                ],
                run,
            );
            if (sent.kind === "sent") return { text: done, details: { number, head, method } };
            return afterLostReply("gh pr merge", sent.why, async () => {
                const now = ghJson<{ state: string; autoMergeRequest: unknown }>(
                    "gh pr view",
                    await gh(["pr", "view", String(number), "--json", "state,autoMergeRequest", ...flags], {
                        cwd: repo.root,
                    }),
                );
                return (
                    auto ? now.autoMergeRequest !== null && now.autoMergeRequest !== undefined : now.state === "MERGED"
                )
                    ? done
                    : undefined;
            });
        },
    };
}
