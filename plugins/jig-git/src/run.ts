// git, through jig-core. jig-core starts git from an argument list with hooks, `core.fsmonitor` and prompts off, and
// refuses to run in a repository whose `.git/config` would run a command. This file only adds what a tool wants on top:
// one-line failures, a default timeout, and the ssh agent for calls that reach a remote.
import type { RunResult } from "../../jig-core/src/contract.ts";
import { jig } from "../../jig-core/src/client.ts";

const T_LOCAL = 30_000;
export const T_NETWORK = 60_000;
export const T_PUSH = 120_000;

interface GitOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string;
    env?: Readonly<Record<string, string>>;
    /** Output beyond this many bytes is cut. */
    maxBytes?: number;
    /** The call reaches a remote: a longer timeout, and the ssh agent so the user's keys work. */
    network?: boolean;
}

/**
 * jig-core gives git a minimal environment. A call that reaches a remote over ssh needs the agent's socket to use the
 * user's keys. The socket is a path, not a secret.
 */
function networkEnv(): Record<string, string> {
    const socket = process.env.SSH_AUTH_SOCK;
    return socket === undefined ? {} : { SSH_AUTH_SOCK: socket };
}

export function git(repo: string, args: readonly string[], options: GitOptions = {}): Promise<RunResult> {
    return jig().exec.git(repo, args, {
        timeoutMs: options.timeoutMs ?? (options.network ? T_NETWORK : T_LOCAL),
        signal: options.signal,
        input: options.input,
        maxOutputBytes: options.maxBytes,
        env: options.network ? { ...networkEnv(), ...options.env } : options.env,
    });
}

/** Removes the user name and password from any URL in `text`, so no credential reaches the model or a message. */
export function scrub(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");
}

/** The first few non-empty lines of git's or gh's complaint, on one line. */
export function summaryOf(text: string, count = 3): string {
    const lines = scrub(text)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const joined = lines.slice(0, count).join("; ");
    return joined.length > 400 ? `${joined.slice(0, 400)}...` : joined;
}

function failure(args: readonly string[], result: RunResult): Error {
    const sub = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "command";
    if (result.timedOut) return new Error(`git ${sub} timed out`);
    return new Error(`git ${sub} failed: ${summaryOf(result.stderr || result.stdout) || `exit ${result.code}`}`);
}

/** git's standard output. A failure becomes a one-line error that names the subcommand. */
export async function gitOut(repo: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
    const result = await git(repo, args, options);
    if (result.code !== 0 || result.timedOut) throw failure(args, result);
    return result.stdout;
}

/**
 * git's standard output when the command succeeded, else undefined. For questions whose answer may be "no". A refusal from
 * jig-core (a `.git/config` that would run a command) is not a "no": it is thrown, so the model is told.
 */
export async function gitTry(
    repo: string,
    args: readonly string[],
    options: GitOptions = {},
): Promise<string | undefined> {
    const result = await git(repo, args, options);
    return result.code === 0 && !result.timedOut ? result.stdout : undefined;
}

export async function revParse(repo: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const out = await gitTry(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { signal });
    return out?.trim() || undefined;
}

export async function refExists(repo: string, ref: string, signal?: AbortSignal): Promise<boolean> {
    return (await revParse(repo, ref, signal)) !== undefined;
}

/** The checked-out branch, or undefined on a detached HEAD. */
export async function currentBranch(repo: string, signal?: AbortSignal): Promise<string | undefined> {
    const out = await gitTry(repo, ["branch", "--show-current"], { signal });
    return out?.trim() || undefined;
}

/** The checked-out branch; a detached HEAD is refused, naming what the caller was about to do. */
export async function requireBranch(repo: string, name: string, doing: string, signal?: AbortSignal): Promise<string> {
    const branch = await currentBranch(repo, signal);
    if (!branch) throw new Error(`HEAD is detached in ${name}; switch to a branch before ${doing}`);
    return branch;
}

/** How many tracked files have changes. Untracked files do not count: they travel with a branch switch. */
export async function trackedChanges(repo: string, signal?: AbortSignal): Promise<number> {
    const out = await gitOut(repo, ["status", "--porcelain", "--untracked-files=no"], { signal });
    return out.split("\n").filter(Boolean).length;
}

/** The upstream of the current branch, such as `origin/feature/x`, or undefined. */
export async function upstreamOf(repo: string, signal?: AbortSignal): Promise<string | undefined> {
    const out = await gitTry(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { signal });
    return out?.trim() || undefined;
}

/**
 * Whether a call that failed may still have reached the remote: it timed out, or the connection broke or the server
 * answered with a gateway error after the request was sent. The caller then checks once what the remote holds and never
 * sends the request again, because a second push or comment could land twice.
 */
export function mayHaveLanded(result: RunResult): boolean {
    if (result.timedOut) return true;
    if (result.code === 0) return false;
    return /timed? ?out|deadline exceeded|connection (?:reset|closed|aborted)|broken pipe|unexpected eof|\beof\b|hung up|tls handshake|HTTP 5\d\d|\b50[0-4]\b/i.test(
        result.stderr,
    );
}
