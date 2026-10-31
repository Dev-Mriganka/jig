// Which repository a call means. The workspace is the folder Pi was started in, or, when that folder is inside a
// repository, the folder that holds the repository. A call names a repository by its folder name in the workspace, or by
// an absolute path inside a work tree. Without a name, a call means the repository Pi was started in.
import fs from "node:fs";
import path from "node:path";
import type { GitSettings } from "./config.ts";
import { matchesAny } from "./config.ts";
import { git, gitTry, refExists, scrub, T_NETWORK } from "./run.ts";

export interface Repo {
    /** The real path of the work tree's root. */
    root: string;
    /** The folder name in the workspace, or the absolute path for a repository elsewhere. */
    name: string;
}

/** A folder name in the workspace. `clone` creates only these, so every cloned repository can be named in a later call. */
export const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The tools' preview() and classify() get no context, so the folder Pi runs in is remembered when a session starts and
// refreshed by every call that does carry a context.
let startDirectory = process.cwd();

export function setWorkingDirectory(dir: string): void {
    startDirectory = dir;
}

function workingDirectory(): string {
    return startDirectory;
}

function isDirectory(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/** The root of the work tree that contains `dir`, or undefined when none does. */
async function topLevel(dir: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!isDirectory(dir)) return undefined;
    const out = await gitTry(dir, ["rev-parse", "--show-toplevel"], { signal });
    if (out === undefined || out.trim() === "") return undefined;
    try {
        return fs.realpathSync(out.trim());
    } catch {
        return undefined;
    }
}

/** The repository Pi was started in, if there is one. */
export async function repoHere(signal?: AbortSignal): Promise<Repo | undefined> {
    const root = await topLevel(workingDirectory(), signal);
    return root === undefined ? undefined : { root, name: path.basename(root) };
}

/** The folder that holds the repositories a call can name. */
export async function workspaceRoot(signal?: AbortSignal): Promise<string> {
    const here = await repoHere(signal);
    const folder = here === undefined ? workingDirectory() : path.dirname(here.root);
    try {
        return fs.realpathSync(folder);
    } catch {
        return folder;
    }
}

/**
 * The repository a call means. `input` is a folder name in the workspace or an absolute path inside a work tree. Without
 * it, the repository Pi was started in.
 */
export async function resolveRepo(input: string | undefined, signal?: AbortSignal): Promise<Repo> {
    if (input === undefined || input === "") {
        const here = await repoHere(signal);
        if (here) return here;
        throw new Error(
            `repo is required: Pi was not started inside a git repository. Name a folder in ${await workspaceRoot(signal)} or give an absolute path`,
        );
    }
    if (input.includes("\0") || input.length > 1000) throw new Error("repo is not a valid name or path");
    const workspace = await workspaceRoot(signal);
    const byName = !path.isAbsolute(input);
    if (byName && !DIR_NAME.test(input)) {
        throw new Error(
            `repo "${input.slice(0, 80)}" must be a folder name in ${workspace} or an absolute path inside a git work tree`,
        );
    }
    if (!byName && input.split("/").includes(".."))
        throw new Error(`repo path must not contain "..": ${input.slice(0, 120)}`);
    const wanted = byName ? path.join(workspace, input) : input;
    let real: string;
    try {
        real = fs.realpathSync(wanted);
        if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    } catch {
        throw new Error(
            byName
                ? `repo "${input}" not found in ${workspace}`
                : `repo path ${input.slice(0, 120)} is not an existing directory`,
        );
    }
    const root = await topLevel(real, signal);
    if (root === undefined) throw new Error(`"${input.slice(0, 120)}" is not inside a git work tree`);
    if (byName && root !== real) throw new Error(`"${input}" in ${workspace} is not the root of a git repository`);
    return { root, name: byName ? input : root };
}

/** The paths of the live work trees in the output of `git worktree list --porcelain`. The main tree is included. */
export function parseWorktrees(porcelain: string): string[] {
    const paths: string[] = [];
    for (const block of porcelain.split(/\n\s*\n/)) {
        const lines = block.split("\n");
        const first = lines.find((line) => line.startsWith("worktree "));
        if (!first || lines.includes("bare") || lines.some((line) => line.startsWith("prunable"))) continue;
        paths.push(first.slice("worktree ".length));
    }
    return paths;
}

/** The linked work trees of a repository, other than the repository's own. */
async function linkedWorktrees(repo: Repo, signal?: AbortSignal): Promise<Repo[]> {
    const listed = await git(repo.root, ["worktree", "list", "--porcelain"], { signal });
    if (listed.code !== 0) return [];
    const found: Repo[] = [];
    for (const wanted of parseWorktrees(listed.stdout)) {
        let real: string;
        try {
            real = fs.realpathSync(wanted);
        } catch {
            continue;
        }
        if (real !== repo.root) found.push({ root: real, name: real });
    }
    return found;
}

/**
 * Every repository in the workspace: the folders directly in it that hold a `.git`, and their linked work trees. When Pi
 * was started inside a repository, that repository and its linked work trees.
 */
export async function discoverRepos(signal?: AbortSignal): Promise<Repo[]> {
    const here = await repoHere(signal);
    const found: Repo[] = [];
    if (here) {
        found.push(here);
    } else {
        const workspace = await workspaceRoot(signal);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(workspace, { withFileTypes: true });
        } catch {
            return [];
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!DIR_NAME.test(entry.name) || !fs.existsSync(path.join(workspace, entry.name, ".git"))) continue;
            try {
                found.push({ root: fs.realpathSync(path.join(workspace, entry.name)), name: entry.name });
            } catch {
                // A link that no longer leads anywhere is not a repository.
            }
        }
    }
    const seen = new Set(found.map((repo) => repo.root));
    for (const repo of [...found]) {
        for (const linked of await linkedWorktrees(repo, signal)) {
            if (!seen.has(linked.root)) {
                seen.add(linked.root);
                found.push(linked);
            }
        }
    }
    return found.slice(0, 200);
}

// ---- the remote ----------------------------------------------------------------------------------------------------

export interface Remote {
    host: string;
    owner: string;
    name: string;
    /** `owner/name`. */
    slug: string;
}

/** The host, owner and name in a remote URL: https, ssh, git or scp-style (`git@host:owner/name`). */
export function parseRemote(url: string | undefined): Remote | undefined {
    if (!url) return undefined;
    const match =
        /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
            url.trim(),
        );
    if (!match) return undefined;
    const [, host, owner, name] = match as unknown as [string, string, string, string];
    return { host, owner, name, slug: `${owner}/${name}` };
}

/** A remote's host and its whole path, for a forge that nests groups. GitLab's `platform/payments/orders-api` has three parts. */
export interface RemotePath {
    host: string;
    /** The path without a trailing `.git`: two to twenty parts, each a name GitLab allows. */
    path: string;
}

const PATH_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** GitLab allows a project in a subgroup of a subgroup, up to twenty parts. */
const MAX_PATH_PARTS = 20;

/**
 * The host and the full path of a remote URL, in the same forms as `parseRemote`, but with any number of groups. A path part
 * that could be read as an option or as a step up (`.`, `..`, `-x`) is refused, so the path is safe to put in a request.
 */
export function parseRemotePath(url: string | undefined): RemotePath | undefined {
    if (!url) return undefined;
    const match =
        /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:]([^\s?#]+?)(?:\.git)?\/?$/.exec(
            url.trim(),
        );
    if (!match) return undefined;
    const [, host, path] = match as unknown as [string, string, string];
    const parts = path.split("/");
    if (parts.length < 2 || parts.length > MAX_PATH_PARTS || !parts.every((part) => PATH_PART.test(part)))
        return undefined;
    return { host, path: parts.join("/") };
}

/**
 * origin's URL as the repository's configuration holds it, with any embedded credentials removed. `git remote get-url` is not
 * used: it applies `insteadOf` rules, and the URL a person set is the one that says which service the repository is on.
 */
export async function originUrl(repo: Repo, signal?: AbortSignal): Promise<string | undefined> {
    const out = await gitTry(repo.root, ["config", "--get", "remote.origin.url"], { signal });
    return out === undefined ? undefined : scrub(out.trim());
}

/** Where `gh` is told to look when origin is on github.com or an ssh alias for it. */
export const GITHUB_COM = "github.com";

/**
 * The GitHub repository behind origin, when origin is on GitHub. The configured clone host and `github.com-*` count as
 * github.com: they are ssh aliases the user chose for it. A host that `git.forges` maps to GitHub counts too, with the real
 * host its entry names (an ssh alias for github.com, or for a GitHub Enterprise Server host), else its own name.
 *
 * `host` in the answer is the host `gh` is told, which is not always the host in origin's address: git goes on using the
 * alias, and the aliases are never put in a `gh` command.
 */
export async function githubRepo(repo: Repo, settings: GitSettings, signal?: AbortSignal): Promise<Remote | undefined> {
    const remote = parseRemote(await originUrl(repo, signal));
    if (!remote) return undefined;
    const host = remote.host.toLowerCase();
    const entry = settings.forges?.[host];
    const configured = typeof entry === "string" ? entry : entry?.forge;
    if (configured === "gitlab") return undefined;
    if (configured === "github") {
        return { ...remote, host: typeof entry === "object" && entry.host !== undefined ? entry.host : host };
    }
    const isGithub =
        host === GITHUB_COM ||
        host === "ssh.github.com" ||
        host.startsWith("github.com-") ||
        host === settings.cloneHost.toLowerCase();
    return isGithub ? { ...remote, host: GITHUB_COM } : undefined;
}

// ---- branches ------------------------------------------------------------------------------------------------------

const defaults = new Map<string, string>();

/**
 * The repository's default branch. It is read from `origin/HEAD` when that is set, else asked of the remote once, else
 * guessed from `main` and `master`. Only an answer is remembered.
 */
async function defaultBranch(repo: Repo, signal?: AbortSignal): Promise<string | undefined> {
    const known = defaults.get(repo.root);
    if (known !== undefined) return known;
    let name = (await gitTry(repo.root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { signal }))
        ?.trim()
        .replace(/^origin\//, "");
    if (!name) {
        const asked = await gitTry(repo.root, ["ls-remote", "--symref", "origin", "HEAD"], {
            signal,
            network: true,
            timeoutMs: T_NETWORK,
        });
        name = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(asked ?? "")?.[1];
    }
    if (!name) {
        for (const guess of ["main", "master"]) {
            if (
                (await refExists(repo.root, `refs/remotes/origin/${guess}`, signal)) ||
                (await refExists(repo.root, `refs/heads/${guess}`, signal))
            ) {
                name = guess;
                break;
            }
        }
    }
    if (name) defaults.set(repo.root, name);
    return name;
}

/** The branch new work starts from and pull requests target: `git.base`, else the default branch. */
export async function baseBranch(repo: Repo, settings: GitSettings, signal?: AbortSignal): Promise<string> {
    const base = settings.base ?? (await defaultBranch(repo, signal));
    if (!base) throw new Error(`cannot tell the default branch of ${repo.name}; set git.base in jig.json`);
    return base;
}

/** The branches that refuse a direct push, a force push, a rebase and a cherry-pick. */
async function protectedPatterns(repo: Repo, settings: GitSettings, signal?: AbortSignal): Promise<string[]> {
    if (settings.protected !== undefined) return settings.protected;
    const name = await defaultBranch(repo, signal);
    return name === undefined ? [] : [name];
}

export async function isProtected(
    repo: Repo,
    branch: string,
    settings: GitSettings,
    signal?: AbortSignal,
): Promise<boolean> {
    return matchesAny(await protectedPatterns(repo, settings, signal), branch);
}

/** The ref to compare against: the fetched `origin/<base>` when it exists, else a local `<base>`. */
export async function baseRef(repo: Repo, base: string, signal?: AbortSignal): Promise<string> {
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
        if (await refExists(repo.root, ref, signal)) return ref;
    }
    throw new Error(`base "${base}" not found; fetch it first (git fetch)`);
}

export function shortRef(ref: string): string {
    return ref.replace(/^refs\/(?:remotes|heads)\//, "");
}

/** Forgets the default branches that were read; for tests that rebuild repositories. */
export function forgetDefaultBranches(): void {
    defaults.clear();
}
