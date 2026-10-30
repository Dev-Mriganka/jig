// GitHub, through the `gh` command. gh keeps its own sign-in, so this plugin never sees a token: it starts gh from an
// argument list through jig-core, and reads what gh prints. Reads use gh's JSON output or `gh api`; a write that may have
// reached GitHub without its answer reaching us is checked once and never sent again.
//
// The repository is always named (`-R owner/name`, or a path under `repos/`), from the catalog. gh is started in no
// repository of ours, so what it reads cannot depend on the folder Pi happens to be in.
import { jig } from "../../../jig-core/src/client.ts";
import type { RunResult } from "../../../jig-core/src/contract.ts";

const T_GH_READ = 30_000;
const T_GH_WRITE = 90_000;

export interface GhOptions {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    maxBytes?: number;
}

export function gh(args: readonly string[], options: GhOptions = {}): Promise<RunResult> {
    return jig().exec.run("gh", args, {
        timeoutMs: options.timeoutMs ?? T_GH_READ,
        signal: options.signal,
        maxOutputBytes: options.maxBytes,
    });
}

/** Removes the user name and password from any URL in `text`, so no credential reaches the model or a message. */
function scrub(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");
}

/** The first few non-empty lines of gh's complaint, on one line. */
export function summaryOf(text: string, count = 3): string {
    const lines = scrub(text)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const joined = lines.slice(0, count).join("; ");
    return joined.length > 400 ? `${joined.slice(0, 400)}...` : joined;
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

// ---- gh api -------------------------------------------------------------------------------------------------------

export interface ApiResponse {
    /** The HTTP status, or 0 when no response came (the network failed, or gh could not start the request). */
    status: number;
    /** Header names in lower case. */
    headers: Record<string, string>;
    body: string;
}

/**
 * Reads the output of `gh api -i`: a status line, the headers, a blank line, then the body. A `304` has no body, and gh
 * then exits with 1 and says `gh: HTTP 304`; any other status from 300 up is the same. The status is therefore taken
 * from the status line, not from the exit code.
 */
export function parseApiOutput(result: RunResult): ApiResponse {
    const head = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(result.stdout);
    if (!head) {
        const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
        return { status: status ? Number(status) : result.code === 0 ? 200 : 0, headers: {}, body: result.stdout };
    }
    const rest = result.stdout.slice(head[0].length);
    const split = rest.search(/\r?\n\r?\n/);
    const headerText = split < 0 ? rest : rest.slice(0, split);
    const body = split < 0 ? "" : rest.slice(split).replace(/^\r?\n\r?\n/, "");
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status: Number(head[1]), headers, body };
}

interface ApiGet extends GhOptions {
    /** The ETag of the answer we already hold. GitHub then answers `304` for free when nothing changed. */
    etag?: string | undefined;
}

/** One `GET` with its status and headers. A status of 300 or more is returned, not thrown: the caller decides. */
export async function apiGet(path: string, options: ApiGet = {}): Promise<ApiResponse> {
    const args = ["api", "-i", ...(options.etag ? ["-H", `If-None-Match: ${options.etag}`] : []), path];
    const result = await gh(args, options);
    const response = parseApiOutput(result);
    if (response.status === 0) throw ghFailure(`gh api ${path}`, result);
    return response;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** The JSON of one `GET`. A status outside 200 to 299 is an error. */
export async function apiJson<T>(path: string, options: GhOptions = {}): Promise<T> {
    const response = await apiGet(path, options);
    if (response.status < 200 || response.status > 299) {
        const message = (safeJson(response.body) as { message?: string } | undefined)?.message ?? "";
        const hint = response.status === 401 ? " (gh is not signed in: run gh auth login yourself)" : "";
        throw new Error(`gh api ${path} failed: HTTP ${response.status}${message ? ` ${message}` : ""}${hint}`);
    }
    return JSON.parse(response.body) as T;
}

// ---- writes -------------------------------------------------------------------------------------------------------

/**
 * Whether a call that failed may still have reached GitHub: it timed out, or the connection broke or the server
 * answered with a gateway error after the request was sent. The caller then checks once what GitHub holds and never
 * sends the request again, because a second rerun could land twice.
 */
function mayHaveLanded(result: RunResult): boolean {
    if (result.timedOut) return true;
    if (result.code === 0) return false;
    const reasons =
        /timed? ?out|deadline exceeded|connection (?:reset|closed|aborted)|broken pipe|unexpected eof|\beof\b|hung up|tls handshake|HTTP 5\d\d|\b50[0-4]\b/i;
    return reasons.test(result.stderr);
}

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
        const seconds = Math.round((options.timeoutMs ?? T_GH_WRITE) / 1000);
        return {
            kind: "lost",
            why: result.timedOut
                ? `timed out after ${seconds} s`
                : options.signal?.aborted
                  ? "the call was cancelled"
                  : summaryOf(result.stderr),
        };
    }
    throw ghFailure(what, result);
}
