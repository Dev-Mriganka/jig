// A repository as the conditions see it: its HEAD, its checked-out branch, whether its tree is clean, and the name origin gives
// it. Every fact comes from git through jig-core (hooks off, a repository whose configuration would run a command refused).
// Also here: which bound repository a tool call acts in, which is what a hold is scoped by.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Host } from "./host.ts";

export interface RepoView {
    /** The real path of the work tree's root. */
    root: string;
    /** The folder's name. */
    name: string;
    /** The repository name origin's address gives (`orders-api`), when there is an origin. */
    remoteName?: string;
    /** `owner/name`, lower case, from origin's address. */
    slug?: string;
    /** The full commit HEAD is at. Absent when there is no commit yet. */
    head?: string;
    /** The checked-out branch. Absent when HEAD is detached. */
    branch?: string;
    /** True when the tree has no changes, tracked or untracked. */
    clean?: boolean;
    /** Why a fact is missing, when one is. */
    problem?: string;
}

const COMMIT = /^[0-9a-f]{40}$/;

/** `owner/name` and the repository name from a remote address in any of git's forms. */
export function parseRemote(url: string): { slug: string; name: string } | undefined {
    const trimmed = url
        .trim()
        .replace(/\.git$/, "")
        .replace(/\/+$/, "");
    const parts = trimmed.split(/[/:]/).filter((part) => part !== "");
    const name = parts.at(-1);
    const owner = parts.at(-2);
    if (name === undefined || owner === undefined) return undefined;
    return { slug: `${owner}/${name}`.toLowerCase(), name };
}

/** Reads a repository. Never throws: what cannot be read is left out and `problem` says why. */
export async function inspect(host: Host, root: string, signal?: AbortSignal): Promise<RepoView> {
    const view: RepoView = { root, name: path.basename(root) };
    const [head, branch, status, origin] = await Promise.all([
        attempt(host, root, ["rev-parse", "HEAD"], signal),
        attempt(host, root, ["symbolic-ref", "--short", "-q", "HEAD"], signal),
        attempt(host, root, ["status", "--porcelain"], signal),
        attempt(host, root, ["remote", "get-url", "origin"], signal),
    ]);
    if (head.ok && COMMIT.test(head.out)) view.head = head.out;
    else
        view.problem = head.ok
            ? "HEAD is not a commit"
            : head.why.includes("unknown revision") || head.why.includes("ambiguous argument")
              ? "there is no commit yet"
              : head.why;
    if (branch.ok && branch.out !== "") view.branch = branch.out;
    if (status.ok) view.clean = status.out === "";
    if (origin.ok) {
        const remote = parseRemote(origin.out);
        if (remote !== undefined) {
            view.slug = remote.slug;
            view.remoteName = remote.name;
        }
    }
    return view;
}

async function attempt(
    host: Host,
    root: string,
    args: readonly string[],
    signal?: AbortSignal,
): Promise<{ ok: true; out: string } | { ok: false; why: string }> {
    try {
        const result = await host.git(root, args, signal);
        if (result.code !== 0)
            return { ok: false, why: firstLine(result.stderr) || `git ${args[0]} exited ${result.code}` };
        return { ok: true, out: result.stdout.trim() };
    } catch (error) {
        return { ok: false, why: firstLine((error as Error).message) };
    }
}

function firstLine(text: string): string {
    return (
        text
            .trim()
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim()
            .slice(0, 200) ?? ""
    );
}

/** The short form of a commit, for messages. */
export function short(commit: string | undefined): string {
    return commit === undefined ? "no commit" : commit.slice(0, 7);
}

// ---- which repository a call acts in --------------------------------------------------------------------------------

function realOrResolved(target: string): string {
    try {
        return realpathSync(target);
    } catch {
        return path.resolve(target);
    }
}

/** The root of the work tree that holds `dir`: the nearest folder above it with a `.git`. */
export function containingRepo(dir: string): string | undefined {
    let current = realOrResolved(dir);
    for (;;) {
        if (existsSync(path.join(current, ".git"))) return current;
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

/**
 * The folder that holds the repositories a call can name, as `jig-git` works it out: the folder Pi started in, or, when that
 * is inside a repository, the folder that holds the repository.
 */
export function workspaceOf(cwd: string): string {
    const here = containingRepo(cwd);
    return realOrResolved(here === undefined ? cwd : path.dirname(here));
}

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** What a call acts on, for a hold. */
export interface CallPlace {
    tool: string;
    input: Readonly<Record<string, unknown>>;
    cwd: string;
    /** For `write` and `edit`: the absolute paths, as written and with links followed. */
    paths: readonly string[];
}

export type Scope =
    /** The call acts in this bound repository. */
    | { kind: "repository"; root: string }
    /** The tool names no repository (a deploy, say): a hold on it applies to the work as a whole. */
    | { kind: "work" }
    /** The call acts somewhere that is not a bound repository, or in a repository that cannot be worked out. */
    | { kind: "elsewhere" };

/**
 * Where a call acts. `write` and `edit` act where their paths are; `git` and `pr` act in the repository they name, or, naming
 * none, the one Pi runs in; any other tool names no repository, so it is the work's as a whole.
 */
export function scopeOf(call: CallPlace, bound: readonly string[]): Scope {
    if (call.tool === "write" || call.tool === "edit") {
        for (const candidate of call.paths) {
            const root = bound.find((root) => isInside(candidate, root));
            if (root !== undefined) return { kind: "repository", root };
        }
        return { kind: "elsewhere" };
    }
    if (call.tool === "git" || call.tool === "pr") {
        const named = call.input.repo;
        let where: string | undefined;
        if (named === undefined || named === "") where = containingRepo(call.cwd);
        else if (typeof named === "string" && !named.includes("\0")) {
            const wanted = path.isAbsolute(named) ? named : path.join(workspaceOf(call.cwd), named);
            where = existsSync(wanted) ? containingRepo(wanted) : undefined;
        }
        const root = where === undefined ? undefined : bound.find((candidate) => candidate === where);
        return root === undefined ? { kind: "elsewhere" } : { kind: "repository", root };
    }
    return { kind: "work" };
}
