// A worker writes only in a git worktree of its own: a new folder on a new branch, cut from the HEAD of the repository around the working
// folder. The plugin makes it through jig-core's `exec.git` (hooks off, a repository that would run a command refused), and gives the
// branch name back in the report so the parent can review and merge it.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "../../jig-core/src/contract.ts";
import { StartError } from "./launch.ts";

/** Runs git in a repository, as jig-core's `exec.git` does. */
export type Git = (root: string, args: readonly string[], signal?: AbortSignal) => Promise<RunResult>;

export interface Worktree {
    /** The new folder. */
    path: string;
    branch: string;
    /** The repository it was cut from. */
    repo: string;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

/** The branch for a child: the pattern with `{name}` filled in. */
export function branchFor(pattern: string, name: string): string {
    return pattern.replaceAll("{name}", name);
}

async function ok(git: Git, root: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
    const result = await git(root, args, signal);
    if (result.code !== 0)
        throw new StartError(`git ${args.slice(0, 2).join(" ")} failed: ${firstLine(result.stderr || result.stdout)}`);
    return result;
}

/**
 * Makes the worktree. `from` is the folder the worker is meant to work in; the repository around it is the one cut from. The folder is
 * named `<repo>-<name>` beside the repository, and the branch from the pattern; either one that exists gets the child's id added.
 */
export async function addWorktree(
    git: Git,
    from: string,
    names: { name: string; id: string; pattern: string },
    signal?: AbortSignal,
): Promise<Worktree> {
    const top = await git(from, ["rev-parse", "--show-toplevel"], signal);
    if (top.code !== 0) {
        throw new StartError(
            `a worker needs a git repository, and ${from} is not inside one: it works in a worktree of its own`,
        );
    }
    const repo = realpathSync(top.stdout.trim());
    const head = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal);
    if (head.code !== 0) throw new StartError(`${repo} has no commit yet, so a worktree cannot be cut from it`);

    let branch = branchFor(names.pattern, names.name);
    const exists = async (candidate: string): Promise<boolean> =>
        (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], signal)).code === 0;
    if (await exists(branch)) branch = `${branch}-${names.id}`;
    const valid = await git(repo, ["check-ref-format", "--branch", branch], signal);
    if (valid.code !== 0)
        throw new StartError(`agents.branch gives "${branch}", which git does not accept as a branch name`);
    if (await exists(branch)) throw new StartError(`the branch ${branch} exists already`);

    const base = `${path.basename(repo)}-${names.name}`.replace(/[^A-Za-z0-9._-]/g, "-");
    let destination = path.join(path.dirname(repo), base);
    if (existsSync(destination)) destination = `${destination}-${names.id}`;
    if (existsSync(destination)) throw new StartError(`${destination} exists already`);

    await ok(git, repo, ["worktree", "add", "-b", branch, destination, "HEAD"], signal);
    return { path: realpathSync(destination), branch, repo };
}

/**
 * Takes away a worktree and its branch that nothing happened in, after a start that failed. `worktree remove` and `branch -d` refuse when
 * there is anything to lose, and then the folder is left for the user and named in the error.
 */
export async function removeWorktree(git: Git, tree: Worktree): Promise<boolean> {
    try {
        const removed = await git(tree.repo, ["worktree", "remove", tree.path], undefined);
        if (removed.code !== 0) return false;
        await git(tree.repo, ["branch", "-d", tree.branch], undefined);
        return true;
    } catch {
        return false;
    }
}
