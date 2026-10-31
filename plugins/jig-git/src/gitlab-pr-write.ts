// Merge request writes on GitLab: create, edit, ready, comment, reply, resolve, review and merge, through `glab api`. They follow
// the GitHub writes step for step. Each plan reads what could have moved and builds the text the user would see, with a digest
// of it; each run sends the request once, and when the reply is lost one read says whether it went through. A request is the
// REST call itself with a JSON body, so the preview is exactly what is sent.
import { count, describeCounts } from "./ci.ts";
import type { GitlabHome } from "./forge.ts";
import { announcePushed } from "./events.ts";
import { answerOf, glabWrite, mrUrl, projectBase, withQuery } from "./gitlab.ts";
import { afterLostReply } from "./github.ts";
import {
    checksOf,
    DRAFT_PREFIX,
    get,
    getGlobal,
    getMr,
    isDraft,
    openMrFor,
    parseThread,
    plainTitle,
    threadId,
} from "./gitlab-pr-read.ts";
import type { Gl, GlDiscussion, GlNote, GlUser, Mr } from "./gitlab-pr-read.ts";
import { checkBody, checkBranch, checkNumber, checkWords } from "./names.ts";
import { startCommentWatch, watchingText } from "./pr-watch.ts";
import { afterwards, readTemplate, ruledTitle } from "./pr-write.ts";
import type { Call, Planned } from "./previews.ts";
import { digest, reviewPreview } from "./previews.ts";
import { baseBranch, resolveRepo } from "./repo.ts";
import { currentBranch, revParse } from "./run.ts";
import { lines } from "./text.ts";

/** Where GitLab keeps merge request templates: a folder of named Markdown files. `Default.md` is the one GitLab fills in. */
const TEMPLATE_FILES = [
    ".gitlab/merge_request_templates/Default.md",
    ".gitlab/merge_request_templates/default.md",
    ".gitlab/merge_request_templates/DEFAULT.md",
];

async function glOf(params: { repo?: string }, call: Call, home: GitlabHome): Promise<Gl> {
    return { home, repo: await resolveRepo(params.repo, call.signal), call };
}

/** What a write passes to glab: the repository to run in and the abort signal. */
const run = (gl: Gl) => ({ cwd: gl.repo.root, signal: gl.call.signal });

const endpoint = (gl: Gl, rest: string): string => `${projectBase(gl.home)}/${rest}`;

/** `Draft: ` before a title makes a merge request a draft; GitLab has no flag to send. */
const asDraft = (title: string): string => (DRAFT_PREFIX.test(title) ? title : `Draft: ${title}`);

// ---- create -------------------------------------------------------------------------------------------------------

interface CreateParams {
    repo?: string;
    title?: string;
    body?: string;
    branch?: string;
    base?: string;
    draft?: boolean;
}

export async function planCreate(params: CreateParams, call: Call, home: GitlabHome): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal, settings } = call;
    const title = ruledTitle(params.title, settings);
    if (params.body === undefined || params.body.trim() === "") {
        const template = readTemplate(repo, settings.prTemplate, TEMPLATE_FILES);
        throw new Error(
            `pr create needs body: write the description.${template === undefined ? "" : `\nFill in this template:\n---\n${template.trimEnd()}\n---`}`,
        );
    }
    const body = checkBody(params.body);
    const branch = params.branch === undefined ? await currentBranch(repo.root, signal) : checkBranch(params.branch);
    if (!branch) throw new Error(`HEAD is detached in ${repo.name}; pass branch`);
    const base =
        params.base === undefined ? await baseBranch(repo, settings, signal) : checkBranch(params.base, "base");
    if (base === branch)
        throw new Error(`head and base are both ${branch}; open the merge request from another branch`);
    const local = await revParse(repo.root, `refs/heads/${branch}`, signal);
    const remote = await revParse(repo.root, `refs/remotes/origin/${branch}`, signal);
    if (!local) throw new Error(`branch ${branch} does not exist locally`);
    if (remote !== local)
        throw new Error(
            `${branch} is not pushed to origin at its local tip; run git push first (this tool does not push)`,
        );
    const gl: Gl = { home, repo, call };
    const existing = await openMrFor(gl, branch);
    const draft = params.draft === true;
    const sentTitle = draft ? asDraft(title) : title;
    const summary = existing
        ? `merge request ${existing.iid} is already open for ${branch}; nothing will be created`
        : `create a merge request ${branch} -> ${base}${draft ? " (draft)" : ""} at ${local.slice(0, 7)} in ${repo.name}`;
    return {
        preview: reviewPreview(
            summary,
            `# ${sentTitle}\n\n${body}`,
            digest("mr create", home.host, home.path, branch, base, local, sentTitle, body),
        ),
        run: async () => {
            if (existing) {
                return {
                    text: `Merge request !${existing.iid} is already open for ${branch} (target ${existing.target_branch}): ${existing.web_url ?? mrUrl(home, existing.iid)}. No new one was created.`,
                    details: { number: existing.iid, created: false },
                };
            }
            const sent = await glabWrite(
                "glab api (create merge request)",
                home,
                "POST",
                endpoint(gl, "merge_requests"),
                { source_branch: branch, target_branch: base, title: sentTitle, description: body },
                run(gl),
            );
            if (sent.kind === "sent") {
                const mr = answerOf<Mr>(sent);
                if (typeof mr?.iid !== "number")
                    throw new Error(
                        `glab api (create merge request) gave no merge request; run pr list for ${branch} before trying again`,
                    );
                return finishCreate(
                    gl,
                    mr.iid,
                    branch,
                    base,
                    local,
                    `Created merge request !${mr.iid} ${branch} -> ${base} in ${repo.name}: ${mr.web_url ?? mrUrl(home, mr.iid)}`,
                );
            }
            // The reply was lost. One look at GitLab says whether the merge request exists.
            let number = 0;
            const found = await afterLostReply(
                "glab api (create merge request)",
                sent.why,
                async () => {
                    const row = await openMrFor({ ...gl, call: afterwards(call) }, branch);
                    if (!row) return undefined;
                    number = row.iid;
                    return `Created merge request !${row.iid} ${branch} -> ${base} in ${repo.name}: ${row.web_url ?? mrUrl(home, row.iid)}`;
                },
                "GitLab",
            );
            return finishCreate(gl, number, branch, base, local, found.text);
        },
    };
}

async function finishCreate(gl: Gl, number: number, branch: string, base: string, sha: string, text: string) {
    const { call, repo, home } = gl;
    // The merge request now exists, so anyone watching the pushed commit can watch it as a merge request.
    await announcePushed({ repo, settings: call.settings, branch, sha, pr: number, signal: call.signal });
    const watching = watchComments(gl, number);
    return {
        text: watching === undefined ? text : `${text}\n${watching.text}`,
        facts: { pr: number },
        details: {
            number,
            created: true,
            base,
            ...(watching?.id === undefined ? {} : { watch: watching.id }),
            project: home.path,
        },
    };
}

/** With `git.watchComments` at `after-create`, the new merge request's comments are watched. A watch that cannot start is said, and never undoes the merge request. */
function watchComments(gl: Gl, number: number): { text: string; id?: string } | undefined {
    if (gl.call.settings.watchComments !== "after-create") return undefined;
    try {
        const spec = { slug: gl.home.path, number, forge: "gitlab" as const, host: gl.home.host };
        const { id, already } = startCommentWatch(spec);
        return { id, text: watchingText(spec, id, already) };
    } catch (error) {
        return {
            text: `(The watch on its comments could not start: ${(error as Error).message}. pr watch starts it.)`,
        };
    }
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

/** The ids GitLab wants for people named by username. A name GitLab does not know is an error that says so. */
async function idsOf(gl: Gl, names: readonly string[]): Promise<number[]> {
    const ids: number[] = [];
    for (const name of names) {
        const login = name.replace(/^@/, "");
        const rows = await getGlobal<GlUser[]>(gl, "glab api (users)", withQuery("users", { username: login }));
        const found = rows.find((user) => (user.username ?? "").toLowerCase() === login.toLowerCase());
        if (found?.id === undefined) throw new Error(`GitLab has no user "${login}" to request a review from`);
        ids.push(found.id);
    }
    return ids;
}

export async function planEdit(params: EditParams, call: Call, home: GitlabHome): Promise<Planned> {
    const number = checkNumber(params.number);
    const edit = {
        title: params.title === undefined ? undefined : ruledTitle(params.title, call.settings),
        body: params.body === undefined ? undefined : checkBody(params.body),
        base: params.base === undefined ? undefined : checkBranch(params.base, "base"),
        labels: params.labels === undefined ? undefined : checkWords(params.labels, "labels"),
        reviewers: params.reviewers === undefined ? undefined : checkWords(params.reviewers, "reviewers"),
    };
    if (Object.values(edit).every((value) => value === undefined))
        throw new Error(
            "pr edit needs title, body, base, labels or reviewers. Usage: pr edit {number, title?, body?, base?, labels?, reviewers?, repo?}",
        );
    const gl = await glOf(params, call, home);
    const mr = await getMr(gl, number);
    // A draft is a title with a prefix: a new title without it would make the merge request ready for review.
    const title = edit.title !== undefined && isDraft(mr) ? asDraft(edit.title) : edit.title;
    const added = edit.reviewers === undefined ? undefined : await idsOf(gl, edit.reviewers);
    const reviewerIds =
        added === undefined
            ? undefined
            : [...new Set([...(mr.reviewers ?? []).flatMap((user) => user.id ?? []), ...added])];
    const shown = lines(
        title !== undefined && `Title: ${title}`,
        edit.base !== undefined && `Target branch: ${edit.base}`,
        edit.labels !== undefined &&
            `Add labels: ${edit.labels.join(", ")} (a label GitLab does not have yet is created)`,
        edit.reviewers !== undefined && `Request review from: ${edit.reviewers.join(", ")}`,
        edit.body !== undefined && `\nNew description (replaces the whole old one):\n\n${edit.body}`,
    );
    const changing = Object.entries(edit)
        .filter(([, value]) => value !== undefined)
        .map(([name]) => name);
    return {
        preview: reviewPreview(
            `edit the ${changing.join(", ")} of merge request ${number} in ${gl.repo.name}`,
            shown,
            digest("mr edit", home.host, home.path, number, { ...edit, title, reviewerIds }),
        ),
        run: async () => {
            const body = {
                ...(title === undefined ? {} : { title }),
                ...(edit.body === undefined ? {} : { description: edit.body }),
                ...(edit.base === undefined ? {} : { target_branch: edit.base }),
                ...(edit.labels === undefined ? {} : { add_labels: edit.labels.join(",") }),
                ...(reviewerIds === undefined ? {} : { reviewer_ids: reviewerIds }),
            };
            const done = `Edited the ${changing.join(", ")} of merge request !${number} in ${gl.repo.name}.`;
            const sent = await glabWrite(
                "glab api (edit merge request)",
                home,
                "PUT",
                endpoint(gl, `merge_requests/${number}`),
                body,
                run(gl),
            );
            if (sent.kind === "sent") return { text: done, details: { number, changed: changing } };
            return afterLostReply(
                "glab api (edit merge request)",
                sent.why,
                async () => {
                    const now = await getMr({ ...gl, call: afterwards(call) }, number);
                    const labels = now.labels ?? [];
                    const asked = (now.reviewers ?? []).flatMap((user) => user.id ?? []);
                    const same =
                        (title === undefined || now.title === title) &&
                        (edit.body === undefined || (now.description ?? "").trim() === edit.body.trim()) &&
                        (edit.base === undefined || now.target_branch === edit.base) &&
                        (edit.labels === undefined || edit.labels.every((label) => labels.includes(label))) &&
                        (reviewerIds === undefined || reviewerIds.every((id) => asked.includes(id)));
                    return same ? done : undefined;
                },
                "GitLab",
            );
        },
    };
}

export async function planReady(
    params: { repo?: string; number?: number },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const number = checkNumber(params.number);
    const gl = await glOf(params, call, home);
    const mr = await getMr(gl, number);
    if (mr.state !== "opened") throw new Error(`merge request ${number} is ${mr.state}, not open`);
    const draft = isDraft(mr);
    const title = plainTitle(mr.title);
    if (draft && title.trim() === "")
        throw new Error(`merge request ${number} has no title besides Draft:; edit its title first`);
    const done = `Merge request !${number} in ${gl.repo.name} is ready for review.`;
    return {
        preview: {
            summary: draft
                ? `mark merge request ${number} in ${gl.repo.name} ready for review`
                : `merge request ${number} in ${gl.repo.name} is already ready for review; nothing will be changed`,
            fingerprint: digest("mr ready", home.host, home.path, number, mr.title),
        },
        run: async () => {
            if (!draft) return { text: `Merge request !${number} in ${gl.repo.name} was already ready for review.` };
            const sent = await glabWrite(
                "glab api (ready)",
                home,
                "PUT",
                endpoint(gl, `merge_requests/${number}`),
                { title },
                run(gl),
            );
            if (sent.kind === "sent") return { text: done };
            return afterLostReply(
                "glab api (ready)",
                sent.why,
                async () => (isDraft(await getMr({ ...gl, call: afterwards(call) }, number)) ? undefined : done),
                "GitLab",
            );
        },
    };
}

// ---- comment, reply, resolve, review ------------------------------------------------------------------------------

/** The newest notes of a merge request, for the one read that follows a lost reply. */
function recentNotes(gl: Gl, number: number): Promise<GlNote[]> {
    return get<GlNote[]>(
        { ...gl, call: afterwards(gl.call) },
        "glab api (notes)",
        withQuery(`merge_requests/${number}/notes`, { sort: "desc", order_by: "created_at", per_page: 10 }),
    );
}

/** A note made at or after `started` whose text is `body`. GitLab and this machine keep their own clocks, so a second is allowed. */
function madeSince(note: GlNote, body: string, started: string): boolean {
    return note.system !== true && (note.body ?? "").trim() === body.trim() && (note.created_at ?? "") >= started;
}

const secondsBefore = (): string => new Date(Date.now() - 1000).toISOString().slice(0, 19);

export async function planComment(
    params: { repo?: string; number?: number; body?: string },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const number = checkNumber(params.number);
    const body = checkBody(params.body);
    const gl = await glOf(params, call, home);
    return {
        preview: reviewPreview(
            `comment on merge request ${number} in ${gl.repo.name}`,
            body,
            digest("mr comment", home.host, home.path, number, body),
        ),
        run: async () => {
            const started = secondsBefore();
            const sent = await glabWrite(
                "glab api (comment)",
                home,
                "POST",
                endpoint(gl, `merge_requests/${number}/notes`),
                { body },
                run(gl),
            );
            if (sent.kind === "sent") {
                const note = answerOf<GlNote>(sent);
                const url = note?.id === undefined ? "" : `${mrUrl(home, number)}#note_${note.id}`;
                return {
                    text: `Commented on merge request !${number} in ${gl.repo.name}${url ? `: ${url}` : "."}`,
                    details: { number, url: url || undefined },
                };
            }
            return afterLostReply(
                "glab api (comment)",
                sent.why,
                async () => {
                    const found = (await recentNotes(gl, number)).find((note) => madeSince(note, body, started));
                    return found
                        ? `Commented on merge request !${number} in ${gl.repo.name}: ${mrUrl(home, number)}#note_${found.id}`
                        : undefined;
                },
                "GitLab",
            );
        },
    };
}

function checkThread(value: unknown): { number: number; discussion: string } {
    const found = parseThread(value);
    if (!found)
        throw new Error(
            "thread must be a GitLab thread id such as 42:6a9c1750b37d513a43987b574953fceb50b03ce7 (the merge request number, a colon, the discussion); pr comments lists them",
        );
    return found;
}

export async function planReply(
    params: { repo?: string; thread?: string; body?: string },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const { number, discussion } = checkThread(params.thread);
    const body = checkBody(params.body);
    const gl = await glOf(params, call, home);
    const thread = threadId(number, discussion);
    return {
        preview: reviewPreview(
            `reply in thread ${thread} of merge request ${number} in ${gl.repo.name}`,
            body,
            digest("mr reply", home.host, home.path, thread, body),
        ),
        run: async () => {
            const started = secondsBefore();
            const sent = await glabWrite(
                "glab api (reply)",
                home,
                "POST",
                endpoint(gl, `merge_requests/${number}/discussions/${discussion}/notes`),
                { body },
                run(gl),
            );
            if (sent.kind === "sent") {
                const note = answerOf<GlNote>(sent);
                return {
                    text: `Replied in thread ${thread}${note?.id === undefined ? "." : `: ${mrUrl(home, number)}#note_${note.id}`}`,
                };
            }
            return afterLostReply(
                "glab api (reply)",
                sent.why,
                async () => {
                    const now = await get<GlDiscussion>(
                        { ...gl, call: afterwards(call) },
                        "glab api (discussion)",
                        `merge_requests/${number}/discussions/${discussion}`,
                    );
                    const found = now.notes.find((note) => madeSince(note, body, started));
                    return found ? `Replied in thread ${thread}: ${mrUrl(home, number)}#note_${found.id}` : undefined;
                },
                "GitLab",
            );
        },
    };
}

/** A thread is resolved when every note that can be resolved is. */
const resolved = (discussion: GlDiscussion): boolean =>
    discussion.notes.filter((note) => note.resolvable === true).every((note) => note.resolved === true);

export async function planResolve(
    params: { repo?: string; thread?: string },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const { number, discussion } = checkThread(params.thread);
    const gl = await glOf(params, call, home);
    const thread = threadId(number, discussion);
    const now = await get<GlDiscussion>(
        gl,
        "glab api (discussion)",
        `merge_requests/${number}/discussions/${discussion}`,
    );
    if (!now.notes.some((note) => note.resolvable === true))
        throw new Error(`thread ${thread} is a plain comment, not a thread that can be resolved`);
    const already = resolved(now);
    return {
        preview: {
            summary: already
                ? `thread ${thread} is already resolved; nothing will be changed`
                : `resolve thread ${thread}`,
            fingerprint: digest("mr resolve", home.host, home.path, thread, already),
        },
        run: async () => {
            if (already) return { text: `Thread ${thread} was already resolved.` };
            const done = `Resolved thread ${thread}.`;
            const sent = await glabWrite(
                "glab api (resolve)",
                home,
                "PUT",
                endpoint(gl, `merge_requests/${number}/discussions/${discussion}`),
                { resolved: true },
                run(gl),
            );
            if (sent.kind === "sent") {
                const answer = answerOf<GlDiscussion>(sent);
                if (answer?.notes && !resolved(answer))
                    throw new Error(
                        `glab api (resolve): GitLab did not resolve thread ${thread}; pr comments shows where it stands`,
                    );
                return { text: done };
            }
            return afterLostReply(
                "glab api (resolve)",
                sent.why,
                async () =>
                    resolved(
                        await get<GlDiscussion>(
                            { ...gl, call: afterwards(call) },
                            "glab api (discussion)",
                            `merge_requests/${number}/discussions/${discussion}`,
                        ),
                    )
                        ? done
                        : undefined,
                "GitLab",
            );
        },
    };
}

export async function planReview(
    params: { repo?: string; number?: number; event?: string; body?: string },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const number = checkNumber(params.number);
    // Approval is a person's decision: this action has no way to give it.
    if (params.event !== "comment" && params.event !== "request_changes")
        throw new Error(
            "pr review sends a comment or requests changes. It never approves: approval stays with a person.",
        );
    const body = checkBody(params.body);
    const gl = await glOf(params, call, home);
    // Publishing a review publishes every draft comment the signed-in user has pending on the request, theirs included.
    const drafts = await get<unknown[]>(gl, "glab api (draft notes)", `merge_requests/${number}/draft_notes`);
    if (drafts.length > 0)
        throw new Error(
            `the signed-in GitLab user has ${drafts.length} pending draft comment${drafts.length === 1 ? "" : "s"} on merge request ${number}, and a review would publish them too; publish or delete them in GitLab first`,
        );
    const verb = params.event === "comment" ? "a review comment" : "a request for changes";
    return {
        preview: reviewPreview(
            `send ${verb} on merge request ${number} in ${gl.repo.name}`,
            body,
            digest("mr review", home.host, home.path, number, params.event, body),
        ),
        run: async () => {
            const started = secondsBefore();
            const done = `Sent ${verb} on merge request !${number} in ${gl.repo.name}.`;
            const look = async (): Promise<string | undefined> =>
                (await recentNotes(gl, number)).some((note) => madeSince(note, body, started)) ? done : undefined;
            const sent = await glabWrite(
                "glab api (review)",
                home,
                "POST",
                endpoint(gl, `merge_requests/${number}/draft_notes/bulk_publish`),
                { note: body, reviewer_state: params.event === "comment" ? "reviewed" : "requested_changes" },
                run(gl),
            );
            if (sent.kind === "lost") return afterLostReply("glab api (review)", sent.why, look, "GitLab");
            // GitLab answers with no body, so one read confirms that the review note is there before it is called sent.
            if ((await look()) === undefined)
                throw new Error(
                    `glab api (review): GitLab accepted the request, but one check does not show the review on merge request ${number}. Nothing was sent twice; look at the merge request before trying again.`,
                );
            return { text: done };
        },
    };
}

// ---- merge --------------------------------------------------------------------------------------------------------

const METHODS = ["merge", "squash", "rebase"] as const;
type Method = (typeof METHODS)[number];

const MERGE_HINTS: Readonly<Record<number, string>> = {
    405: "GitLab will not merge it now: a pipeline, an approval or an open thread is still required; pr view shows its merge status",
    409: "the head moved since you looked, so its sha no longer matches; run pr merge again to see the new preview",
    422: "GitLab could not merge the branch: a conflict, or the target moved",
};

export async function planMerge(
    params: { repo?: string; number?: number; method?: string; auto?: boolean },
    call: Call,
    home: GitlabHome,
): Promise<Planned> {
    const number = checkNumber(params.number);
    if (!METHODS.includes(params.method as Method)) throw new Error("method is required: merge, squash or rebase");
    const method = params.method as Method;
    if (method === "rebase")
        throw new Error(
            `pr merge: GitLab does not rebase as part of a merge; the project's merge method (fast-forward or semi-linear) decides. Run glab mr rebase ${number} yourself, then merge`,
        );
    const auto = params.auto === true;
    const gl = await glOf(params, call, home);
    const mr = await getMr(gl, number);
    if (mr.state !== "opened") throw new Error(`merge request ${number} is ${mr.state}, not open`);
    if (isDraft(mr)) throw new Error(`merge request ${number} is a draft; mark it ready for review first`);
    if (mr.has_conflicts === true || mr.detailed_merge_status === "conflict")
        throw new Error(
            `merge request ${number} conflicts with ${mr.target_branch}; resolve the conflicts on ${mr.source_branch} first`,
        );
    const head = mr.sha;
    // The merge is pinned to this commit. Without one there is nothing to pin it to, and it must not run unpinned.
    if (!head)
        throw new Error(`GitLab did not say which commit merge request ${number} is at, so the merge cannot be pinned`);
    const rollup = await checksOf(gl, mr);
    const checks = rollup ? count(rollup.checks) : undefined;
    const what = auto ? `turn on auto-merge (${method}) for` : `${method}-merge`;
    return {
        preview: {
            summary: `${what} merge request ${number} into ${mr.target_branch} in ${gl.repo.name}: ${mr.title} (head ${head.slice(0, 7)})`,
            body: lines(
                `${mr.title}`,
                `From ${mr.source_branch} at ${head.slice(0, 7)} into ${mr.target_branch}, by ${method}.`,
                `Checks: ${checks ? describeCounts(checks) : "no pipeline"}. Merge status: ${mr.detailed_merge_status ?? mr.merge_status ?? "unknown"}.`,
                `It merges only while the head is still ${head.slice(0, 7)}.`,
            ),
            format: "text",
            fingerprint: digest(
                "mr merge",
                home.host,
                home.path,
                number,
                mr.title,
                method,
                head,
                mr.target_branch,
                auto,
            ),
        },
        run: async () => {
            const done = auto
                ? `Auto-merge is on for merge request !${number} (${method}) in ${gl.repo.name}: it merges when its pipeline succeeds.`
                : `Merged merge request !${number} into ${mr.target_branch} (${method}) at ${head.slice(0, 7)} in ${gl.repo.name}.`;
            // `sha` makes GitLab refuse (409) when the head is no longer the commit that was shown.
            const sent = await glabWrite(
                "glab api (merge)",
                home,
                "PUT",
                endpoint(gl, `merge_requests/${number}/merge`),
                { sha: head, squash: method === "squash", ...(auto ? { auto_merge: true } : {}) },
                { ...run(gl), hints: MERGE_HINTS },
            );
            if (sent.kind === "sent") {
                const answer = answerOf<Mr>(sent);
                if (!auto && answer?.state !== undefined && answer.state !== "merged")
                    return {
                        text: `GitLab accepted the merge of !${number} in ${gl.repo.name}, but it shows ${answer.state}${answer.merge_when_pipeline_succeeds ? " and set to merge when its pipeline succeeds" : ""}; pr view shows where it stands.`,
                        details: { number, head, method },
                    };
                return { text: done, details: { number, head, method } };
            }
            return afterLostReply(
                "glab api (merge)",
                sent.why,
                async () => {
                    const now = await getMr({ ...gl, call: afterwards(call) }, number);
                    return (
                        auto
                            ? now.merge_when_pipeline_succeeds === true || now.state === "merged"
                            : now.state === "merged"
                    )
                        ? done
                        : undefined;
                },
                "GitLab",
            );
        },
    };
}
