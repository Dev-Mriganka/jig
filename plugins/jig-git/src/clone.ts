// clone: fetch a GitHub repository into a new folder of the workspace. It runs outside the sandbox with the user's ssh key,
// so everything it may do is fixed here. The grammar of what it accepts is closed: whatever is not listed is refused, and
// the model never names a host or a transport. The URL git receives is always `git@<cloneHost>:owner/name.git`, built here.
//
// git clones into a temporary folder next to the destination, and the folder is renamed into place only when the clone
// finished and was not cancelled. A failure, a timeout or a cancel removes it, so no half-made repository is left behind.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jig } from "../../jig-core/src/client.ts";
import { checkBranch } from "./names.ts";
import type { Call, Planned } from "./previews.ts";
import { digest } from "./previews.ts";
import { DIR_NAME, workspaceRoot } from "./repo.ts";
import { scrub, summaryOf } from "./run.ts";

const CLONE_TIMEOUT_MS = 10 * 60_000;
const TEMP_PREFIX = ".jig-clone-";

interface CloneTarget {
    owner: string;
    /** The repository name without a trailing `.git`. */
    name: string;
    /** `owner/name`. */
    slug: string;
}

const FORMS = "owner/name, git@<host>:owner/name.git or https://github.com/owner/name";
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_INPUT = 300;
const MAX_DIR = 100;

/** Shows a value in a message: quoted, cut, and never with the user name and password of a URL. */
function shown(value: unknown): string {
    return JSON.stringify(scrub(String(value)).slice(0, 80));
}

function segment(value: string, what: "owner" | "name"): string {
    // The owner starts like an account name. Neither part may be an option, a dot path, or contain "..".
    const first = what === "owner" ? /^[A-Za-z0-9]/ : /^[A-Za-z0-9._]/;
    if (
        !SEGMENT.test(value) ||
        !first.test(value) ||
        value.includes("..") ||
        value === "." ||
        value === ".git" ||
        value.length > 100
    ) {
        const start = what === "owner" ? "must start with a letter or digit" : "must not start with -";
        throw new Error(
            `clone: the repository ${what} may use only letters, digits, . _ and -, ${start} and must not contain .. (got ${shown(value)})`,
        );
    }
    return value;
}

/**
 * `owner/name`, `git@<host>:owner/name(.git)` or `https://github.com/owner/name(.git)`. The host of an ssh URL must be
 * `github.com` or the configured clone host, and an https URL must name `github.com` or the clone host; it is checked and
 * then dropped. Anything else is refused.
 */
export function parseCloneRepo(input: unknown, cloneHost: string): CloneTarget {
    if (typeof input !== "string" || input.trim() === "") throw new Error(`clone needs repo: ${FORMS}`);
    const text = input.trim();
    if (text.length > MAX_INPUT || /[\s\0-\x1f\x7f]/.test(text))
        throw new Error(`clone: repo must be ${FORMS} (got ${shown(text)})`);
    const known = (host: string) => host === "github.com" || host === cloneHost;
    const notAllowed = (host: string) =>
        new Error(
            `clone: only ${cloneHost === "github.com" ? "github.com" : `github.com and ${cloneHost}`} repositories can be cloned (got host ${shown(host.split("@").pop())}); repo must be ${FORMS}`,
        );
    let rest: string;
    const https = /^https:\/\/([^/]*)\/(.*)$/.exec(text);
    const scp = /^git@([^:/]*):(.*)$/.exec(text);
    if (https) {
        if (!known(https[1] as string)) throw notAllowed(https[1] as string);
        rest = https[2] as string;
    } else if (scp) {
        if (!known(scp[1] as string)) throw notAllowed(scp[1] as string);
        rest = scp[2] as string;
    } else if (
        /[:@\\]/.test(text) ||
        text.startsWith("/") ||
        text.startsWith("~") ||
        text.startsWith(".") ||
        text.startsWith("-")
    ) {
        // A scheme, user@host, a local path or an option: none of them is a repository name.
        throw new Error(`clone: repo must be ${FORMS} (got ${shown(text)})`);
    } else {
        rest = text;
    }
    const parts = rest.split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "")
        throw new Error(`clone: repo must be ${FORMS} (got ${shown(text)})`);
    const owner = segment(parts[0] as string, "owner");
    const second = parts[1] as string;
    const name = segment(second.length > 4 && second.endsWith(".git") ? second.slice(0, -4) : second, "name");
    return { owner, name, slug: `${owner}/${name}` };
}

/** The folder to create: one safe name, the kind `repo` accepts, so a clone can be named by every later call. */
export function checkCloneDir(dir: unknown, target: CloneTarget): string {
    const given = dir !== undefined;
    const value = given ? dir : target.name;
    if (
        typeof value !== "string" ||
        value.length > MAX_DIR ||
        !DIR_NAME.test(value) ||
        value.includes("..") ||
        value.endsWith(".git")
    ) {
        throw new Error(
            given
                ? `clone: dir must be one folder name in the workspace: letters, digits, . _ and -, starting with a letter or digit (got ${shown(dir)})`
                : `clone: ${target.slug} does not make a usable folder name; pass dir (letters, digits, . _ and -, starting with a letter or digit)`,
        );
    }
    return value;
}

/** The ssh URL git is given: always the configured host and a name already checked above. */
export function cloneUrl(target: CloneTarget, host: string): string {
    return `git@${host}:${target.owner}/${target.name}.git`;
}

/** git may use ssh and nothing else, whatever the environment or any config says. */
export function cloneArgs(url: string, temp: string, branch: string | undefined): string[] {
    return [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.ssh.allow=always",
        "clone",
        "--no-recurse-submodules",
        ...(branch === undefined ? [] : ["--branch", branch]),
        "--",
        url,
        temp,
    ];
}

/** `~/dev/x` for a path under the home directory; any other path as it is. */
function tilde(file: string): string {
    const home = os.homedir();
    return file === home ? "~" : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

function exists(file: string): boolean {
    try {
        fs.lstatSync(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error(`cannot check ${tilde(file)}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
}

/** One actionable line from git's and ssh's complaint, in fixed words around the host and repository. */
export function cloneFailure(
    stderr: string,
    host: string,
    slug: string,
    branch: string | undefined,
    temp: string,
    destination: string,
): string {
    const text = stderr.replace(/\r/g, "\n");
    if (
        /Permission denied \((?:publickey|password|keyboard-interactive|gssapi)|^\S+@\S+: Permission denied/im.test(
            text,
        )
    )
        return `SSH authentication to ${host} failed: check "ssh -T git@${host}" in your terminal`;
    if (/cannot run ssh|ssh: command not found/i.test(text)) return "ssh is not installed or not on PATH";
    if (/Host key verification failed/i.test(text))
        return `SSH does not know the host key of ${host}: run "ssh -T git@${host}" in your terminal once and accept it`;
    if (/Could not resolve hostname/i.test(text))
        return `SSH host ${host} does not resolve: it must be github.com or a Host alias in ~/.ssh/config (git.cloneHost sets it)`;
    if (/Remote branch .* not found/i.test(text)) return `${branch ?? "the branch"} does not exist in ${slug}`;
    if (/Repository not found|does not appear to be a git repository/i.test(text))
        return `${slug} was not found, or the ssh key of ${host} cannot read it`;
    if (
        /Connection (timed out|refused|reset|closed)|Network is unreachable|No route to host|Operation timed out/i.test(
            text,
        )
    )
        return `Could not reach ${host}: check the network and VPN, then retry`;
    const lines = text
        .split("\n")
        .filter(
            (line) =>
                !/^(remote: )?[A-Z][a-z]+ (objects|deltas|files)\b/.test(line.trim()) &&
                !line.startsWith("Cloning into"),
        );
    const important = lines.filter((line) => /^(fatal|error|ERROR|warning):/.test(line.trim()));
    return `git clone failed: ${summaryOf((important.length > 0 ? important : lines).join("\n").split(temp).join(destination)) || "no reason given"}`;
}

export async function planClone(
    params: { repo?: string; dir?: string; branch?: string },
    call: Call,
): Promise<Planned> {
    const host = call.settings.cloneHost;
    const target = parseCloneRepo(params.repo, host);
    const dir = checkCloneDir(params.dir, target);
    const branch = params.branch === undefined ? undefined : checkBranch(params.branch);
    const root = await workspaceRoot(call.signal);
    const destination = path.join(root, dir);
    if (exists(destination))
        throw new Error(
            `${tilde(destination)} already exists; nothing was cloned. Use that folder, or pass another dir`,
        );
    const url = cloneUrl(target, host);
    return {
        preview: {
            summary: `clone ${target.slug}${branch === undefined ? "" : ` (branch ${branch})`} into ${tilde(destination)}`,
            body: `Reads from GitHub over ssh as ${host}. Writes only the new folder, which does not exist yet. No submodules, no hooks.`,
            format: "text",
            fingerprint: digest("clone", url, dir, branch ?? "", root),
        },
        run: async () => {
            const temp = path.join(root, `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
            let placed = false;
            try {
                const socket = process.env.SSH_AUTH_SOCK;
                const result = await jig().exec.git(root, cloneArgs(url, temp, branch), {
                    timeoutMs: CLONE_TIMEOUT_MS,
                    signal: call.signal,
                    // One transport. The environment's own list wins over -c, so it is set as well. The ssh agent is
                    // passed on because jig-core gives git a minimal environment; its socket is a path, not a secret.
                    env: { GIT_ALLOW_PROTOCOL: "ssh", ...(socket === undefined ? {} : { SSH_AUTH_SOCK: socket }) },
                });
                if (result.timedOut)
                    throw new Error(
                        `git clone timed out after ${Math.round(CLONE_TIMEOUT_MS / 1000)}s; nothing was created`,
                    );
                if (call.signal?.aborted) throw new Error("git clone was aborted; nothing was created");
                if (result.code !== 0)
                    throw new Error(cloneFailure(result.stderr, host, target.slug, branch, temp, destination));
                const asked = async (args: string[]) => {
                    const answer = await jig().exec.git(temp, args, { timeoutMs: 30_000 });
                    return answer.code === 0 ? answer.stdout.trim() || undefined : undefined;
                };
                const sha = await asked(["rev-parse", "--short", "HEAD"]);
                const head = sha === undefined ? undefined : await asked(["symbolic-ref", "--short", "-q", "HEAD"]);
                // The destination was free when the plan was made; look again right before the rename.
                if (exists(destination))
                    throw new Error(`${tilde(destination)} appeared while cloning; nothing was moved in`);
                try {
                    fs.renameSync(temp, destination);
                } catch (error) {
                    throw new Error(
                        `could not move the clone into ${tilde(destination)}: ${(error as NodeJS.ErrnoException).code ?? "failed"}`,
                    );
                }
                placed = true;
                const where =
                    sha === undefined
                        ? "empty repository, no commits yet"
                        : head === undefined
                          ? `${branch ?? "detached"} detached, HEAD ${sha}`
                          : `${branch === undefined ? "default branch" : "branch"} ${head}, HEAD ${sha}`;
                return {
                    text: `Cloned ${target.slug} into ${tilde(destination)} (${where}).${sha === undefined ? "" : " Read its AGENTS.md or README before working in it."}`,
                    details: { repo: target.slug, dir, path: destination, branch: head ?? null, sha: sha ?? null },
                };
            } catch (error) {
                if (!placed) {
                    try {
                        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                    } catch {
                        throw new Error(
                            `${(error as Error).message}; could not remove ${tilde(temp)}: delete it yourself`,
                        );
                    }
                }
                throw error;
            }
        },
    };
}
