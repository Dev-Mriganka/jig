// GitLab, through the `glab` command. glab keeps its own sign-in (`glab auth login`), so this plugin never sees a token: it
// starts glab from an argument list through jig-core and reads what it prints. Every call is `glab api` with an explicit host
// and project path, so what is sent is exactly what the preview said: GitLab's REST API (v4) documents each endpoint, a body
// travels as JSON on standard input, and glab's own commands (which prompt, and choose for themselves, such as turning on
// auto-merge while a pipeline runs) never decide anything. A write that may have reached GitLab without its answer reaching
// us is checked once and never sent again.
//
// glab starts git too, in the folder it runs in, and reads its configuration. jig-core vets a repository for `gh` and `git` before
// they run; it does not know glab, so `vetRepository` asks it to vet the folder with a harmless git call first.
import type { RunResult } from "../../jig-core/src/contract.ts";
import { jig } from "../../jig-core/src/client.ts";
import { parseApiOutput } from "./api-output.ts";
import type { ApiResponse } from "./api-output.ts";
import type { GitlabHome } from "./forge.ts";
import type { Sent } from "./github.ts";
import { mayHaveLanded, summaryOf } from "./run.ts";

const T_READ = 30_000;
const T_WRITE = 90_000;
const T_VET = 10_000;

export interface GlabOptions {
    /** Written for a status a caller knows how to explain, such as the 409 of a merge whose head moved. */
    hints?: Readonly<Record<number, string>> | undefined;
    cwd?: string | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    /** Written to glab's standard input, for `--input -`. */
    input?: string | undefined;
    maxBytes?: number | undefined;
}

/** What glab is told not to do: prompt, check for updates, send usage data, colour or page its output, open an editor. */
const GLAB_FIXED_ENV: Readonly<Record<string, string>> = {
    GLAB_NO_PROMPT: "1",
    GLAB_CHECK_UPDATE: "false",
    GLAB_SEND_TELEMETRY: "false",
    GLAB_NOTIFY_SKILL_UPDATES: "false",
    GLAB_SHOW_WHATS_NEW: "false",
    GLAB_COLOR: "never",
    GLAB_PAGER: "cat",
    GLAB_DISPLAY_HYPERLINKS: "false",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GCM_INTERACTIVE: "never",
};

/**
 * jig-core gives a program a minimal environment: HOME and the XDG folders, which is where glab keeps its sign-in. A sign-in
 * kept in the system keyring (glab's default where there is one) is read over the user's session bus, whose address is a path
 * and not a secret, so it is passed on as the ssh agent's socket is for git.
 */
function glabEnv(): Record<string, string> {
    const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
    return bus === undefined ? { ...GLAB_FIXED_ENV } : { ...GLAB_FIXED_ENV, DBUS_SESSION_BUS_ADDRESS: bus };
}

/**
 * jig-core refuses a repository whose own configuration would make git run a command, but only for `git` and `gh`. glab runs git
 * in its folder as well, so the folder is vetted here with a git call that reads nothing of interest. A refusal is thrown; a
 * folder that is no repository is fine.
 */
async function vetRepository(cwd: string, signal: AbortSignal | undefined): Promise<void> {
    await jig().exec.git(cwd, ["rev-parse", "--git-dir"], { timeoutMs: T_VET, signal });
}

export async function glab(args: readonly string[], options: GlabOptions = {}): Promise<RunResult> {
    const cwd = options.cwd ?? process.cwd();
    await vetRepository(cwd, options.signal);
    return jig().exec.run("glab", args, {
        cwd,
        timeoutMs: options.timeoutMs ?? T_READ,
        signal: options.signal,
        input: options.input,
        maxOutputBytes: options.maxBytes,
        env: glabEnv(),
    });
}

// ---- errors -------------------------------------------------------------------------------------------------------

const SIGN_IN =
    /glab auth login|not logged in|\b401\b|unauthorized|bad credentials|no token|authentication required|invalid token/i;

/** The HTTP status glab reports on standard error, as in `glab: 404 Not Found (HTTP 404)`; undefined when it reports none. */
export function statusOf(result: RunResult): number | undefined {
    const found = /\(HTTP (\d{3})\)|\bHTTP (\d{3})\b/.exec(result.stderr);
    return found ? Number(found[1] ?? found[2]) : undefined;
}

/** A one-line error for a failed glab call: what was run, glab's own first line of complaint, and how to mend a sign-in. */
export function glabFailure(
    what: string,
    result: RunResult,
    host?: string,
    hints: Readonly<Record<number, string>> = {},
): Error {
    const reason = result.timedOut ? "timed out" : summaryOf(result.stderr || result.stdout) || `exit ${result.code}`;
    const status = statusOf(result);
    let hint = "";
    if (SIGN_IN.test(result.stderr))
        hint = ` (glab is not signed in${host ? ` for ${host}` : ""}: run glab auth login${host ? ` --hostname ${host}` : ""} yourself)`;
    else if (status !== undefined && hints[status] !== undefined) hint = ` (${hints[status]})`;
    else if (status === 403) hint = " (GitLab refused it: your role, or the token's scope, does not allow this)";
    else if (status === 404)
        hint = " (GitLab has nothing at that address: it is gone, or the account glab is signed in as cannot see it)";
    return new Error(`${what} failed: ${reason}${hint}`);
}

/** The error for an answer with a status from 300 up, read with `-i`. */
export function responseFailure(what: string, response: ApiResponse, host: string): Error {
    const message = parse<{ message?: string }>(response.body)?.message;
    const said = typeof message === "string" && message !== "" ? message : response.body;
    return glabFailure(
        what,
        { code: 1, stdout: "", stderr: `glab: ${said || "no answer"} (HTTP ${response.status})`, timedOut: false },
        host,
    );
}

function parse<T>(text: string): T | undefined {
    try {
        return JSON.parse(text) as T;
    } catch {
        return undefined;
    }
}

// ---- reads --------------------------------------------------------------------------------------------------------

/** `projects/<path>`, with the slashes of the project's path encoded as GitLab's API wants them. */
export function projectBase(home: GitlabHome): string {
    return `projects/${encodeURIComponent(home.path)}`;
}

/** A query string from the values that are set. */
export function withQuery(
    path: string,
    params: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, String(value));
    const text = query.toString();
    return text === "" ? path : `${path}?${text}`;
}

interface Request {
    method?: "GET" | "POST" | "PUT";
    /** A JSON body, sent on standard input. */
    body?: unknown;
    /** Print the status line and the headers before the body: `-i`. */
    include?: boolean;
    etag?: string | undefined;
}

/** The arguments of `glab api` for an endpoint under `https://<host>/api/v4/`. The host is always named: glab guesses it otherwise. */
export function apiArgs(home: GitlabHome, endpoint: string, request: Request = {}): string[] {
    const method = request.method ?? "GET";
    return [
        "api",
        ...(request.include ? ["-i"] : []),
        "--hostname",
        home.host,
        ...(method === "GET" ? [] : ["-X", method]),
        ...(request.etag ? ["-H", `If-None-Match: ${request.etag}`] : []),
        ...(request.body === undefined ? [] : ["--input", "-"]),
        endpoint,
    ];
}

/** The parsed JSON of a successful read. Any other outcome is a one-line error naming the call. */
export async function glabJson<T>(
    home: GitlabHome,
    what: string,
    endpoint: string,
    options: GlabOptions = {},
): Promise<T> {
    const result = await glab(apiArgs(home, endpoint), options);
    if (result.code !== 0 || result.timedOut) throw glabFailure(what, result, home.host);
    const value = parse<T>(result.stdout);
    if (value === undefined) throw new Error(`${what} returned output that is not JSON`);
    return value;
}

/**
 * One `GET` with the status and headers, optionally conditional on the ETag of the answer already held. A status of 300 or more
 * is returned, not thrown, and the caller decides. Status 0 means no answer came, and the body then says why.
 */
export async function glabResponse(
    home: GitlabHome,
    endpoint: string,
    options: GlabOptions & { etag?: string | undefined } = {},
): Promise<ApiResponse> {
    const result = await glab(apiArgs(home, endpoint, { include: true, etag: options.etag }), options);
    const response = parseApiOutput(result);
    if (response.status === 0) return { ...response, body: summaryOf(result.stderr || result.stdout) };
    return response;
}

/** Every page of a list, up to `maxPages`. `more` is true when the list goes on past the last page read. */
export async function glabPages<T>(
    home: GitlabHome,
    what: string,
    endpoint: string,
    maxPages: number,
    options: GlabOptions = {},
): Promise<{ items: T[]; more: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
        const response = await glabResponse(
            home,
            `${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}`,
            options,
        );
        if (response.status < 200 || response.status >= 300) throw responseFailure(what, response, home.host);
        const list = parse<T[]>(response.body);
        if (!Array.isArray(list)) throw new Error(`${what} returned output that is not a list`);
        items.push(...list);
        if ((response.headers["x-next-page"] ?? "") === "") return { items, more: false };
    }
    return { items, more: true };
}

// ---- writes -------------------------------------------------------------------------------------------------------

/**
 * Runs a request that changes something on GitLab, with its JSON body on standard input. A definite failure throws. When the
 * answer was lost (a timeout, a broken connection, a gateway error, a cancelled call) the request may have landed, so this
 * returns `lost` and the caller checks once; it never runs the request again.
 */
export async function glabWrite(
    what: string,
    home: GitlabHome,
    method: "POST" | "PUT",
    endpoint: string,
    body: unknown,
    options: GlabOptions = {},
): Promise<Sent> {
    const args = apiArgs(home, endpoint, { method, body });
    const input = JSON.stringify(body);
    let result: RunResult;
    try {
        result = await glab(args, { ...options, input, timeoutMs: options.timeoutMs ?? T_WRITE });
    } catch (error) {
        if (options.signal?.aborted) return { kind: "lost", why: "the call was cancelled" };
        throw error;
    }
    if (result.code === 0 && !result.timedOut) return { kind: "sent", result };
    if (options.signal?.aborted || mayHaveLanded(result)) {
        return {
            kind: "lost",
            why: result.timedOut
                ? `timed out after ${Math.round((options.timeoutMs ?? T_WRITE) / 1000)} s`
                : options.signal?.aborted
                  ? "the call was cancelled"
                  : summaryOf(result.stderr),
        };
    }
    throw glabFailure(what, result, home.host, options.hints);
}

/** The JSON a successful write answered with; undefined for an empty answer (204) or one that is not JSON. */
export function answerOf<T>(sent: Extract<Sent, { kind: "sent" }>): T | undefined {
    return parse<T>(sent.result.stdout);
}

// ---- addresses ----------------------------------------------------------------------------------------------------

/** A merge request's page on the web. */
export function mrUrl(home: GitlabHome, iid: number): string {
    return `https://${home.host}/${home.path}/-/merge_requests/${iid}`;
}
