// Jira's REST endpoints (version 2), one function each. They return the shapes the rest of the plugin needs, and read
// the answers so that they hold for Jira Cloud and for Jira Data Center alike.
import type { JiraSettings } from "./config.ts";
import { JiraError, LostReplyError } from "./http.ts";
import type { Http } from "./http.ts";
import { arr, InputError, int, nameOf, obj, str, userOf } from "./values.ts";
import type { Obj, User } from "./values.ts";

/** What later calls of one Pi session may reuse. */
export interface Session {
    /** Which search endpoint this Jira answers. Cloud has `/search/jql`; Data Center has only `/search`. */
    searchDialect?: "enhanced" | "classic";
    /** The field list, read once: it is the same for every issue. */
    fields?: Promise<FieldInfo[]>;
}

/** Everything one call of the tool works with. */
export interface Env {
    settings: JiraSettings;
    http: Http;
    session: Session;
}

/** A 404 on `what` is a wrong key or id, which is a mistake in the call, not a failure of Jira. */
export function notFoundAsInvalid(error: unknown, what: string): unknown {
    return error instanceof JiraError && error.status === 404
        ? new InputError(`${what} was not found, or the account cannot see it`)
        : error;
}

// ---- issues -----------------------------------------------------------------------------------------------------------

export async function getIssue(env: Env, key: string, fields: readonly string[], expand?: string): Promise<Obj> {
    const query = { fields: fields.join(","), expand };
    return obj(await env.http.request({ method: "GET", path: `/issue/${key}`, query }));
}

export interface IssueHead {
    key: string;
    summary: string;
    status: string;
}

/** The title and status of an issue, which a preview shows so the person can see which issue it is about. */
export async function issueHead(env: Env, key: string): Promise<IssueHead> {
    try {
        const issue = await getIssue(env, key, ["summary", "status"]);
        const fields = obj(issue.fields);
        return { key: str(issue.key) || key, summary: str(fields.summary), status: nameOf(fields.status) };
    } catch (error) {
        throw notFoundAsInvalid(error, key);
    }
}

export async function myself(env: Env): Promise<User> {
    return userOf(await env.http.request({ method: "GET", path: "/myself" }));
}

/** Who is signed in, or why that could not be asked. */
export type Identity = { user: User } | { user?: undefined; why: string };

/**
 * `myself`, for a write that can go on without it. Some sites reach Jira only through a sign-in proxy that has no "who
 * am I": the proxy answers 403 or 404, or its transport refuses the request. Those say the answer is not available and
 * return `why`; any other failure (a bad sign-in, a timeout, a 5xx) is raised as it always was.
 */
export async function whoAmI(env: Env): Promise<Identity> {
    try {
        return { user: await myself(env) };
    } catch (error) {
        if (error instanceof JiraError && (error.status === 403 || error.status === 404)) {
            return { why: `Jira answered ${error.status} to GET /myself` };
        }
        if (error instanceof LostReplyError && error.viaTransport) {
            return { why: "the transport did not carry GET /myself" };
        }
        throw error;
    }
}

// ---- comments ---------------------------------------------------------------------------------------------------------

export interface Comment {
    id: string;
    author: User;
    body: string;
    created: string;
    updated: string;
}

export function commentOf(value: unknown): Comment {
    const comment = obj(value);
    return {
        id: str(comment.id),
        author: userOf(comment.author),
        body: str(comment.body),
        created: str(comment.created),
        updated: str(comment.updated),
    };
}

interface CommentPage {
    comments: Comment[];
    total: number;
}

export async function commentPage(env: Env, key: string, startAt: number, maxResults: number): Promise<CommentPage> {
    const query = { startAt, maxResults };
    const page = obj(await env.http.request({ method: "GET", path: `/issue/${key}/comment`, query }));
    const comments = arr(page.comments).map(commentOf);
    return { comments, total: Math.max(int(page.total), startAt + comments.length) };
}

/** The newest `count` comments, oldest of them first. Jira lists oldest first, so a long thread needs a second request. */
export async function newestComments(env: Env, key: string, count: number): Promise<CommentPage> {
    const first = await commentPage(env, key, 0, count);
    if (first.total <= first.comments.length) return first;
    return commentPage(env, key, Math.max(0, first.total - count), count);
}

export async function getComment(env: Env, key: string, id: string): Promise<Comment> {
    return commentOf(await env.http.request({ method: "GET", path: `/issue/${key}/comment/${id}` }));
}

// ---- transitions, fields, users ---------------------------------------------------------------------------------------

export interface Transition {
    id: string;
    name: string;
    /** The status the transition leads to. */
    to: string;
}

export async function transitionsOf(env: Env, key: string): Promise<Transition[]> {
    const answer = obj(await env.http.request({ method: "GET", path: `/issue/${key}/transitions` }));
    return arr(answer.transitions).map((entry) => {
        const transition = obj(entry);
        return { id: str(transition.id), name: str(transition.name), to: nameOf(transition.to) };
    });
}

export interface FieldInfo {
    id: string;
    name: string;
    custom: boolean;
}

/** Every field of this Jira, read once per session. A failed read is not remembered. */
export function fieldList(env: Env): Promise<FieldInfo[]> {
    env.session.fields ??= env.http.request({ method: "GET", path: "/field" }).then((answer) =>
        arr(answer)
            .map(obj)
            .filter((field) => str(field.id) !== "")
            .map((field) => ({
                id: str(field.id),
                name: str(field.name) || str(field.id),
                custom: field.custom === true,
            })),
    );
    const reading = env.session.fields;
    reading.catch(() => {
        if (env.session.fields === reading) env.session.fields = undefined;
    });
    return reading;
}

/** The people who can be assigned an issue (or any issue of a project, before one exists) and match `query`. */
export async function assignableUsers(
    env: Env,
    scope: { key?: string; project?: string },
    query: string | undefined,
    limit: number,
): Promise<User[]> {
    // Cloud reads `query` and Data Center reads `username`; each ignores the other.
    const answer = await env.http.request({
        method: "GET",
        path: "/user/assignable/search",
        query: { issueKey: scope.key, project: scope.project, query, username: query, maxResults: limit },
    });
    return arr(answer).map(userOf);
}

// ---- search -----------------------------------------------------------------------------------------------------------

export interface SearchPage {
    issues: Obj[];
    /** The offset of the first issue, where the search pages by offset (Data Center). */
    start: number | undefined;
    /** Data Center counts the matches; Cloud's search does not. */
    total: number | undefined;
    /** What to pass as `page` for the next page, or undefined at the end. */
    next: string | undefined;
}

export interface SearchOptions {
    jql: string;
    fields: readonly string[];
    limit: number;
    page?: string | undefined;
}

/**
 * Issues matching a JQL query. Jira Cloud pages by token (`/search/jql`) and Data Center by offset (`/search`). The
 * token endpoint is tried first, and a 404 or 405 says this is a Data Center, which is remembered for the session.
 */
export async function search(env: Env, options: SearchOptions): Promise<SearchPage> {
    const timeoutMs = env.http.timeouts.search;
    const query = { jql: options.jql, fields: options.fields.join(","), maxResults: options.limit };
    if (env.session.searchDialect !== "classic") {
        try {
            const paged = { ...query, nextPageToken: options.page };
            const answer = obj(await env.http.request({ method: "GET", path: "/search/jql", query: paged, timeoutMs }));
            env.session.searchDialect = "enhanced";
            const token = str(answer.nextPageToken);
            const next = answer.isLast === true || token === "" ? undefined : token;
            return { issues: arr(answer.issues).map(obj), start: undefined, total: undefined, next };
        } catch (error) {
            const missing = error instanceof JiraError && (error.status === 404 || error.status === 405);
            if (!missing || env.session.searchDialect === "enhanced") throw error;
            env.session.searchDialect = "classic";
        }
    }
    const startAt = options.page === undefined ? 0 : Number(options.page);
    if (!Number.isInteger(startAt) || startAt < 0) {
        throw new InputError("jira search: page must be the page value the previous result gave");
    }
    const answer = obj(
        await env.http.request({ method: "GET", path: "/search", query: { ...query, startAt }, timeoutMs }),
    );
    const issues = arr(answer.issues).map(obj);
    const end = startAt + issues.length;
    const total = Math.max(int(answer.total), end);
    return { issues, start: startAt, total, next: end < total ? String(end) : undefined };
}
