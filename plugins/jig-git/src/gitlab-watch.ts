// The comment watch on GitLab: what a poll reads, and which of it is a comment to tell. What the watch does with the comments (the
// message, the batches, the end) is the same as on GitHub and lives in pr-watch.ts.
//
// A poll is up to a handful of requests through `glab api -i`:
//   - the signed-in user, once, so the agent's own notes are not told back to it;
//   - the merge request, for its state: merged or closed ends the watch;
//   - its discussions, page by page. They are the only complete source: a reply in an old thread is not a new discussion, and
//     the notes endpoint leaves out the notes inside threads. GitLab has no `updated_after` for them, so what was told is
//     remembered by id, and a reply in an old thread is found as a new note is.
// Each request sends the ETag of its last answer. GitLab answers `304` to it, but counts that against its rate limit, so the
// condition saves the transfer and not the request.
import type { GitlabHome } from "./forge.ts";
import { glabResponse, mrUrl, projectBase } from "./gitlab.ts";
import type { GlDiscussion, GlUser } from "./gitlab-pr-read.ts";
import { answerOf, fetchJson, remember } from "./watch-core.ts";
import type { Candidate, Comment, Getter, PrWatchSpec, PrWatchState, Source } from "./watch-core.ts";

/** The host a saved GitLab watch may name: a bare host name, which becomes an argument of glab. */
export const GITLAB_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** The project path a saved GitLab watch may name: two to twenty parts, as GitLab allows. */
export const GITLAB_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/){1,19}[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** Discussions are read this many pages of 100 deep. */
const MAX_PAGES = 5;

const sourceOf = (host: string): Source => ({
    name: "GitLab",
    program: "glab",
    signedOut: `glab is not signed in for ${host}: run glab auth login --hostname ${host} yourself`,
    subject: "the merge request or the project",
});

/** A bot: GitLab says so, or the name has `bot` as a word of its own, as `renovate-bot` and `project_42_bot_a1b2c3` do. */
const isBot = (user: GlUser | null | undefined): boolean =>
    user?.bot === true || /(^|[_-])bot([_-]|$)/i.test(user?.username ?? "");

/** The notes of the discussions that are comments to tell: no system note, nothing empty. */
function candidatesOf(
    spec: PrWatchSpec,
    home: GitlabHome,
    discussions: readonly GlDiscussion[],
): { review: Candidate[]; conversation: Candidate[] } {
    const review: Candidate[] = [];
    const conversation: Candidate[] = [];
    for (const discussion of discussions) {
        for (const note of discussion.notes ?? []) {
            if (note.system === true || typeof note.id !== "number" || (note.body ?? "").trim() === "") continue;
            const diff = note.type === "DiffNote";
            const place = note.position;
            const file = place?.new_path ?? place?.old_path ?? undefined;
            const line = place?.new_line ?? place?.old_line ?? undefined;
            const comment: Comment = {
                kind: diff ? "review" : "conversation",
                id: note.id,
                author: note.author?.username ?? "unknown",
                at: note.created_at ?? "",
                body: note.body ?? "",
                ...(diff && file ? { path: file } : {}),
                ...(diff && typeof line === "number" ? { line } : {}),
                thread: `${spec.number}:${discussion.id}`,
                url: `${mrUrl(home, spec.number)}#note_${note.id}`,
            };
            (diff ? review : conversation).push({ comment, bot: isBot(note.author) });
        }
    }
    return { review, conversation };
}

async function whoAmI(
    get: Getter,
    source: Source,
    state: PrWatchState,
    signal: AbortSignal,
    now: number,
): Promise<string> {
    if (state.me !== undefined) return state.me;
    const response = await get("user", { etag: undefined, signal });
    const name = (answerOf("user", response, now, source) as { username?: string } | undefined)?.username;
    if (typeof name !== "string" || name === "") throw new Error("GitLab did not say which user glab is signed in as");
    return name;
}

/**
 * One poll's reading of a merge request: its state is kept in `state.pr`, and the comments to tell are returned. The comments
 * carry their thread, so nothing more is asked for them. The state is changed in place; the caller works on a copy.
 */
export async function collectGitlab(
    spec: PrWatchSpec,
    state: PrWatchState,
    signal: AbortSignal,
    now: number,
    bots: boolean,
): Promise<Comment[]> {
    const home: GitlabHome = { forge: "gitlab", host: spec.host as string, path: spec.slug };
    const source = sourceOf(home.host);
    const get: Getter = (path, options) => glabResponse(home, path, options);
    const me = (await whoAmI(get, source, state, signal, now)).toLowerCase();
    state.me = me;

    const request = `${projectBase(home)}/merge_requests/${spec.number}`;
    const head = await fetchJson(get, request, state, signal, now, source);
    if (head.changed) {
        const raw = head.body as { state?: string; target_branch?: string; web_url?: string };
        state.pr = {
            merged: raw.state === "merged",
            closed: raw.state === "closed",
            base: raw.target_branch ?? "its base",
            url: raw.web_url ?? "",
        };
    }

    const found: Comment[] = [];
    const known = state.pages ?? 1;
    let read = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const got = await fetchJson(
            get,
            `${request}/discussions?per_page=100&page=${page}`,
            state,
            signal,
            now,
            source,
        );
        read = page;
        let more: boolean;
        if (got.changed) {
            const { review, conversation } = candidatesOf(
                spec,
                home,
                Array.isArray(got.body) ? (got.body as GlDiscussion[]) : [],
            );
            remember(state, "review", review, me, bots, found);
            remember(state, "conversation", conversation, me, bots, found);
            more = (got.headers["x-next-page"] ?? "") !== "";
        } else {
            // A 304 carries no list header, so the page count of the last full reading stands.
            more = page < known;
        }
        if (!more) break;
    }
    state.pages = read;
    return found;
}
