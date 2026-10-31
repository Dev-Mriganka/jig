// What the comment watch of both forges shares (see pr-watch.ts): what a watch watches and remembers, the failures that go away by
// themselves, the reading of one answer from `gh api -i` or `glab api -i`, and the memory of which comments were already told.
import type { ApiResponse } from "./api-output.ts";

/** What a watch watches. Plain JSON, because it is saved with the watch. */
export interface PrWatchSpec {
    /** The project as the forge names it: `owner/name` on GitHub, the whole path with its groups on GitLab. */
    slug: string;
    number: number;
    /** `"gitlab"` for a merge request. Left out for GitHub, so the specs that were saved before GitLab are read as they were. */
    forge?: "gitlab";
    /** The host `glab` talks to on GitLab. On GitHub: the host `gh` talks to, left out for github.com, so the specs that were saved before it are read as they were. */
    host?: string;
}

export type Kind = "review" | "conversation" | "summary";

export interface Comment {
    kind: Kind;
    id: number;
    author: string;
    /** When it was made, as the forge says it. */
    at: string;
    body: string;
    path?: string;
    line?: number;
    /** A review: `COMMENTED`, `CHANGES_REQUESTED` or `APPROVED`. */
    state?: string;
    /** The thread of a comment, when it could be found. */
    thread?: string;
    url?: string;
}

/** What the watch remembers between polls. Plain JSON. */
export interface PrWatchState {
    /** The login of the authenticated user, read once. */
    me?: string;
    /** The ETag of the last answer to each request. */
    etags: Record<string, string>;
    /** The pull request as the last answer said. */
    pr?: { merged: boolean; closed: boolean; base: string; url: string };
    /** The ids already seen, which are told once or not at all. */
    seen: Record<Kind, number[]>;
    /** The newest conversation comment seen: the next request asks only for what changed after it. */
    since?: string;
    /** GitLab: how many pages of discussions the last full reading found. */
    pages?: number;
    /** Found, and not told yet because a message holds only so many. */
    waiting: Comment[];
    /** Comments that were found and are never told, counted for the next message. */
    unshown: number;
    /** Polls in a row that failed for a reason that goes away by itself. */
    softFailures: number;
    polls: number;
}

// ---- requests ---------------------------------------------------------------------------------------------------------

/** A failure that goes away by itself: a server error, a rate limit, a lost connection. */
export class Transient extends Error {
    readonly waitMs: number;
    constructor(message: string, waitMs = 0) {
        super(message);
        this.name = "Transient";
        this.waitMs = waitMs;
    }
}

/** What an error message says about the forge being asked, so GitHub and GitLab are each told in their own words. */
export interface Source {
    /** `GitHub` or `GitLab`. */
    name: string;
    /** `gh` or `glab`. */
    program: string;
    /** The line for a `401`. */
    signedOut: string;
    /** What a `404` means is gone: `the pull request or the repository`. */
    subject: string;
}

export const GITHUB: Source = {
    name: "GitHub",
    program: "gh",
    signedOut: "gh is not signed in: run gh auth login yourself",
    subject: "the pull request or the repository",
};

function messageOf(response: ApiResponse): string {
    try {
        return (JSON.parse(response.body) as { message?: string }).message ?? "";
    } catch {
        return response.status === 0 ? response.body : "";
    }
}

/** How long the forge asks us to wait: `Retry-After` in seconds, or the time its rate limit resets (GitHub and GitLab each name it). */
function askedWaitMs(response: ApiResponse, now: number): number {
    const after = Number(response.headers["retry-after"]);
    if (Number.isFinite(after) && after > 0) return after * 1000;
    const reset = Number(response.headers["x-ratelimit-reset"] ?? response.headers["ratelimit-reset"]);
    return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : 0;
}

/** The body of a successful answer, undefined for a `304`, or the error the status stands for. */
export function answerOf(path: string, response: ApiResponse, now: number, source: Source = GITHUB): unknown {
    const { status } = response;
    if (status === 304) return undefined;
    if (status >= 200 && status < 300) {
        try {
            return JSON.parse(response.body) as unknown;
        } catch {
            throw new Error(`${source.name}'s answer for ${path} is not JSON`);
        }
    }
    const message = messageOf(response);
    const said = message === "" ? "" : `: ${message.slice(0, 160)}`;
    const limited =
        status === 429 ||
        (status === 403 &&
            ((response.headers["x-ratelimit-remaining"] ?? response.headers["ratelimit-remaining"]) === "0" ||
                response.headers["retry-after"] !== undefined ||
                /rate limit|abuse|secondary/i.test(message)));
    if (status === 0 || status >= 500 || limited) {
        const why = status === 0 ? `no answer${said}` : `HTTP ${status}${said}`;
        throw new Transient(`${source.name} did not answer ${path} (${why})`, askedWaitMs(response, now));
    }
    if (status === 401) throw new Error(source.signedOut);
    if (status === 404)
        throw new Error(`${source.name} has no ${path}: ${source.subject} is gone, or ${source.program} cannot see it`);
    throw new Error(`${source.name} answered HTTP ${status} for ${path}${said}`);
}

export interface Fetched {
    /** False when the forge said nothing changed. */
    changed: boolean;
    body?: unknown;
    /** The answer's headers, in lower case. */
    headers: Record<string, string>;
}

/** One request for the program that asks: the path, the ETag of the answer already held, and the abort signal. */
export type Getter = (path: string, options: { etag: string | undefined; signal: AbortSignal }) => Promise<ApiResponse>;

export async function fetchJson(
    get: Getter,
    path: string,
    state: PrWatchState,
    signal: AbortSignal,
    now: number,
    source: Source = GITHUB,
): Promise<Fetched> {
    const response = await get(path, { etag: state.etags[path], signal });
    const body = answerOf(path, response, now, source);
    if (response.status === 304) return { changed: false, headers: response.headers };
    const etag = response.headers.etag;
    if (etag) state.etags[path] = etag;
    else delete state.etags[path];
    return { changed: true, body, headers: response.headers };
}

// ---- what was told ----------------------------------------------------------------------------------------------------

export const MAX_SEEN = 2000;

/** A comment the forge gave, and whether its author is a bot. */
export interface Candidate {
    comment: Comment;
    bot: boolean;
}

/**
 * Notes which of the `candidates` are new, in `state`, and adds those that are to be told to `found`. A comment is told once: its
 * id is kept, so an edit is not a new comment. The authenticated user's own comments are kept but not told, and so are a bot's
 * unless `bots` is true.
 */
export function remember(
    state: PrWatchState,
    kind: Kind,
    candidates: readonly Candidate[],
    me: string,
    bots: boolean,
    found: Comment[],
): void {
    const seen = new Set(state.seen[kind]);
    for (const { comment, bot } of candidates) {
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        state.seen[kind].push(comment.id);
        if (comment.author.toLowerCase() === me || (!bots && bot)) continue;
        found.push(comment);
    }
    if (state.seen[kind].length > MAX_SEEN) state.seen[kind] = state.seen[kind].slice(-MAX_SEEN);
}
