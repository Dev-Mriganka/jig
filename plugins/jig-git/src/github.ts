// GitHub, through the `gh` command. gh keeps its own sign-in, so this plugin never sees a token: it starts gh from an
// argument list through jig-core, and reads what gh prints. Reads use gh's JSON output; a write that may have reached
// GitHub without its answer reaching us is checked once and never sent again.
import type { RunResult } from "../../jig-core/src/contract.ts";
import { jig } from "../../jig-core/src/client.ts";
import type { GitSettings } from "./config.ts";
import { githubRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { mayHaveLanded, summaryOf } from "./run.ts";
import type { Reply } from "./previews.ts";

const T_GH_READ = 30_000;
const T_GH_WRITE = 90_000;

export interface GhOptions {
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Written to gh's standard input, for `--body-file -` and `--input -`. */
    input?: string;
    maxBytes?: number;
}

export function gh(args: readonly string[], options: GhOptions = {}): Promise<RunResult> {
    return jig().exec.run("gh", args, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? T_GH_READ,
        signal: options.signal,
        input: options.input,
        maxOutputBytes: options.maxBytes,
    });
}

const SIGN_IN = /gh auth login|not logged in|HTTP 401|bad credentials|authentication required|no oauth token/i;

/** A one-line error for a failed gh call: what was run and gh's own first line of complaint. */
export function ghFailure(what: string, result: RunResult): Error {
    const reason = result.timedOut ? "timed out" : summaryOf(result.stderr || result.stdout) || `exit ${result.code}`;
    const hint = SIGN_IN.test(result.stderr) ? " (gh is not signed in: run gh auth login yourself)" : "";
    return new Error(`${what} failed: ${reason}${hint}`);
}

/** The parsed JSON of a successful gh call. Any other outcome is a one-line error naming the call. */
export function ghJson<T>(what: string, result: RunResult): T {
    if (result.code !== 0 || result.timedOut) throw ghFailure(what, result);
    try {
        return JSON.parse(result.stdout) as T;
    } catch {
        throw new Error(`${what} returned output that is not JSON`);
    }
}

/** `-R owner/name` when origin is a github.com repository, else nothing: gh then reads the repository's own remotes. */
export async function repoFlags(repo: Repo, settings: GitSettings, signal?: AbortSignal): Promise<string[]> {
    const remote = await githubRepo(repo, settings, signal);
    return remote ? ["-R", remote.slug] : [];
}

/** The `owner/name` that `gh api` paths need. */
export async function requireSlug(repo: Repo, settings: GitSettings, signal?: AbortSignal): Promise<string> {
    const remote = await githubRepo(repo, settings, signal);
    if (!remote)
        throw new Error(`origin of ${repo.name} is not a github.com repository, so GitHub cannot be asked about it`);
    return remote.slug;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** A GraphQL call. The query and its variables travel on standard input, so nothing in them is read as an option. */
export async function graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    options: GhOptions = {},
): Promise<T> {
    const result = await gh(["api", "graphql", "--input", "-"], {
        ...options,
        input: JSON.stringify({ query, variables }),
    });
    const parsed = safeJson(result.stdout) as { data?: T; errors?: { message?: string }[] } | undefined;
    if (parsed?.errors?.length) throw new Error(`GitHub: ${parsed.errors[0]?.message ?? "the query failed"}`);
    if (result.code !== 0 || result.timedOut || parsed?.data === undefined) throw ghFailure("gh api graphql", result);
    return parsed.data;
}

// ---- writes -------------------------------------------------------------------------------------------------------

export type Sent = { kind: "sent"; result: RunResult } | { kind: "lost"; why: string };

/**
 * Runs a gh command that changes something on GitHub. A definite failure throws. When the answer was lost (a timeout, a
 * broken connection, a gateway error, a cancelled call) the request may have landed, so this returns `lost` and the caller
 * checks once; it never runs the command again.
 */
export async function ghWrite(what: string, args: readonly string[], options: GhOptions = {}): Promise<Sent> {
    let result: RunResult;
    try {
        result = await gh(args, { ...options, timeoutMs: options.timeoutMs ?? T_GH_WRITE });
    } catch (error) {
        if (options.signal?.aborted) return { kind: "lost", why: "the call was cancelled" };
        throw error;
    }
    if (result.code === 0 && !result.timedOut) return { kind: "sent", result };
    if (options.signal?.aborted || mayHaveLanded(result)) {
        return {
            kind: "lost",
            why: result.timedOut
                ? `timed out after ${Math.round((options.timeoutMs ?? T_GH_WRITE) / 1000)} s`
                : options.signal?.aborted
                  ? "the call was cancelled"
                  : summaryOf(result.stderr),
        };
    }
    throw ghFailure(what, result);
}

/**
 * The answer to a write whose reply was lost: one read of GitHub, and what it showed. `look` returns the success text when
 * the change is there, and undefined when it is not. Either way nothing is sent again.
 */
export async function afterLostReply(
    what: string,
    why: string,
    look: () => Promise<string | undefined>,
): Promise<Reply> {
    let found: string | undefined;
    try {
        found = await look();
    } catch (error) {
        throw new Error(
            `${what}: the reply was lost (${why}) and the check failed too (${(error as Error).message}). Look at GitHub before trying again. Nothing was sent twice.`,
        );
    }
    if (found === undefined) {
        throw new Error(
            `${what}: the reply was lost (${why}) and one check shows it did not go through. Nothing was sent twice; run it again if you still want it.`,
        );
    }
    return {
        text: `${found}\n(The reply was lost (${why}); one check shows it went through. Nothing was sent twice.)`,
    };
}

/** The last `/pull/<number>` in gh's output: gh prints the URL of what it created. */
export function prNumberFromUrl(text: string): number | undefined {
    const matches = [...text.matchAll(/\/pull\/(\d+)\b/g)];
    const last = matches.at(-1);
    return last ? Number(last[1]) : undefined;
}

export function lastLine(text: string): string {
    return text.trim().split("\n").filter(Boolean).at(-1) ?? "";
}
