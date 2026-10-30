// The git actions that change the local repository: branch, worktree, commit, stash, sync, merge, rebase, cherry_pick and
// restore. None of them reaches GitHub except to fetch what it starts from. Nothing here resolves a conflict: merge,
// rebase and cherry_pick put the repository back as it was and say which files conflict.
import fs from "node:fs";
import path from "node:path";
import { checkBranch, checkCommitMessage, checkPaths, checkRev } from "./names.ts";
import type { Call, Planned } from "./previews.ts";
import { digest } from "./previews.ts";
import { baseBranch, DIR_NAME, isProtected, resolveRepo, workspaceRoot } from "./repo.ts";
import type { Repo } from "./repo.ts";
import {
    currentBranch,
    git,
    gitOut,
    refExists,
    requireBranch,
    revParse,
    summaryOf,
    trackedChanges,
    upstreamOf,
} from "./run.ts";
import { clip, firstLines, plural } from "./text.ts";

/** Switching or creating a branch with edits would carry them along; refuse rather than guess. */
async function requireClean(repo: Repo, doing: string, signal?: AbortSignal): Promise<void> {
    const dirty = await trackedChanges(repo.root, signal);
    if (dirty > 0)
        throw new Error(
            `${repo.name} has uncommitted changes in ${plural(dirty, "file")}; commit or stash them before ${doing}`,
        );
}

async function shortHead(repo: Repo, signal?: AbortSignal): Promise<string> {
    return (await gitOut(repo.root, ["rev-parse", "--short", "HEAD"], { signal })).trim();
}

async function fetchBranch(repo: Repo, remote: string, branch: string, signal?: AbortSignal): Promise<void> {
    const fetched = await git(repo.root, ["fetch", "--no-tags", remote, branch], { signal, network: true });
    if (fetched.code !== 0 || fetched.timedOut)
        throw new Error(
            `could not fetch ${remote}/${branch}: ${fetched.timedOut ? "timed out" : summaryOf(fetched.stderr) || "fetch failed"}`,
        );
    if (!(await refExists(repo.root, `refs/remotes/${remote}/${branch}`, signal)))
        throw new Error(`${remote}/${branch} does not exist after the fetch`);
}

/** A name that new branches must match, when `git.branchName` says so. */
function checkBranchPattern(name: string, call: Call): void {
    const pattern = call.settings.branchName;
    if (pattern !== undefined && !new RegExp(pattern).test(name))
        throw new Error(`branch name "${name}" does not match git.branchName (${pattern})`);
}

function operationOf(value: unknown, allowed: readonly string[], action: string): string {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`git ${action}: operation must be one of ${allowed.join(", ")}`);
    return value;
}

// ---- branch -------------------------------------------------------------------------------------------------------

interface BranchParams {
    repo?: string;
    operation?: string;
    branch?: string;
    base?: string;
}

export async function planBranch(params: BranchParams, call: Call): Promise<Planned> {
    const operation = operationOf(params.operation, ["create", "switch", "delete"], "branch");
    const name = checkBranch(params.branch, "branch");
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    if (operation === "create") {
        checkBranchPattern(name, call);
        if (await isProtected(repo, name, call.settings, signal))
            throw new Error(`refusing to create protected branch ${name}`);
        if (await refExists(repo.root, `refs/heads/${name}`, signal))
            throw new Error(`branch ${name} already exists; use operation switch`);
        await requireClean(repo, `creating ${name}`, signal);
        const base =
            params.base === undefined
                ? await baseBranch(repo, call.settings, signal)
                : checkBranch(params.base, "base");
        return {
            preview: {
                summary: `create branch ${name} from the fetched ${base} in ${repo.name}`,
                fingerprint: digest("branch", repo.root, "create", name, base),
            },
            run: async () => {
                // Always cut from the freshly fetched remote base, never from a possibly stale local copy.
                await fetchBranch(repo, "origin", base, signal);
                await gitOut(repo.root, ["switch", "-c", name, "--no-track", `refs/remotes/origin/${base}`], {
                    signal,
                });
                const sha = await shortHead(repo, signal);
                return {
                    text: `Created ${name} from origin/${base} (${sha}) in ${repo.name}.`,
                    details: { branch: name, base: `origin/${base}`, head: sha },
                };
            },
        };
    }
    if (operation === "switch") {
        const current = await currentBranch(repo.root, signal);
        if (current === name)
            return {
                preview: { summary: `already on ${name} in ${repo.name}` },
                run: async () => ({ text: `Already on ${name} in ${repo.name}.` }),
            };
        await requireClean(repo, `switching to ${name}`, signal);
        const local = await refExists(repo.root, `refs/heads/${name}`, signal);
        const remote = !local && (await refExists(repo.root, `refs/remotes/origin/${name}`, signal));
        if (!local && !remote)
            throw new Error(`branch ${name} not found locally or at origin; use operation create for a new branch`);
        return {
            preview: {
                summary: `switch ${repo.name} to ${local ? "the local branch" : "a new local branch tracking origin/"}${name}`,
                fingerprint: digest("branch", repo.root, "switch", name, local),
            },
            run: async () => {
                await gitOut(
                    repo.root,
                    local ? ["switch", name] : ["switch", "-c", name, "--track", `origin/${name}`],
                    { signal },
                );
                return { text: `Switched to ${name} (${await shortHead(repo, signal)}) in ${repo.name}.` };
            },
        };
    }
    // delete
    if (await isProtected(repo, name, call.settings, signal))
        throw new Error(`refusing to delete protected branch ${name}`);
    if ((await currentBranch(repo.root, signal)) === name)
        throw new Error(`${name} is checked out; switch to another branch before deleting it`);
    if (!(await refExists(repo.root, `refs/heads/${name}`, signal)))
        throw new Error(`branch ${name} does not exist locally`);
    const tip = (await revParse(repo.root, `refs/heads/${name}`, signal)) ?? "";
    return {
        preview: {
            summary: `delete the merged branch ${name} in ${repo.name}`,
            fingerprint: digest("branch", repo.root, "delete", name, tip),
        },
        run: async () => {
            const result = await git(repo.root, ["branch", "-d", name], { signal });
            if (result.code !== 0) {
                const notMerged = /not fully merged/i.test(result.stderr);
                throw new Error(
                    notMerged
                        ? `${name} is not fully merged, so it was not deleted`
                        : `git branch failed: ${summaryOf(result.stderr)}`,
                );
            }
            return { text: `Deleted ${name} (was ${tip.slice(0, 7)}) in ${repo.name}.` };
        },
    };
}

// ---- worktree -----------------------------------------------------------------------------------------------------

interface WorktreeParams {
    repo?: string;
    operation?: string;
    dir?: string;
    branch?: string;
    base?: string;
}

interface Worktree {
    path: string;
    head: string;
    branch?: string;
}

function parseWorktreeList(porcelain: string): Worktree[] {
    return porcelain
        .split(/\n\s*\n/)
        .map((block) => {
            const lines = block.split("\n");
            const field = (key: string) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
            return {
                path: field("worktree") ?? "",
                head: (field("HEAD") ?? "").slice(0, 7),
                branch: field("branch")?.replace(/^refs\/heads\//, ""),
            };
        })
        .filter((tree) => tree.path !== "");
}

export async function planWorktree(params: WorktreeParams, call: Call): Promise<Planned> {
    const operation = operationOf(params.operation, ["list", "add", "remove"], "worktree");
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const trees = parseWorktreeList(await gitOut(repo.root, ["worktree", "list", "--porcelain"], { signal }));
    if (operation === "list") {
        return {
            preview: { summary: `list the work trees of ${repo.name}` },
            run: async () => ({
                text: trees.map((tree) => `${tree.path}  ${tree.branch ?? "(detached)"} ${tree.head}`).join("\n"),
            }),
        };
    }
    if (params.dir === undefined)
        throw new Error(
            `git worktree ${operation} needs dir. Usage: git worktree ${operation} {dir${operation === "add" ? ", branch, base?" : ""}, repo?}`,
        );
    if (operation === "add") {
        const name = checkBranch(params.branch, "branch");
        const dir = params.dir;
        if (!DIR_NAME.test(dir) || dir.length > 100 || dir.includes(".."))
            throw new Error(
                "git worktree add: dir must be one folder name: letters, digits, . _ and -, starting with a letter or digit",
            );
        const destination = path.join(await workspaceRoot(signal), dir);
        if (fs.existsSync(destination)) throw new Error(`${destination} already exists; pick another dir`);
        const exists = await refExists(repo.root, `refs/heads/${name}`, signal);
        let base: string | undefined;
        if (!exists) {
            checkBranchPattern(name, call);
            if (await isProtected(repo, name, call.settings, signal))
                throw new Error(`refusing to create protected branch ${name}`);
            base =
                params.base === undefined
                    ? await baseBranch(repo, call.settings, signal)
                    : checkBranch(params.base, "base");
        }
        return {
            preview: {
                summary: `add a work tree ${destination} for ${exists ? "the existing branch" : `a new branch cut from the fetched ${base}:`} ${name}`,
                fingerprint: digest("worktree", repo.root, "add", destination, name, base ?? ""),
            },
            run: async () => {
                if (base !== undefined) await fetchBranch(repo, "origin", base, signal);
                const args = exists
                    ? ["worktree", "add", destination, name]
                    : ["worktree", "add", "--no-track", "-b", name, destination, `refs/remotes/origin/${base}`];
                await gitOut(repo.root, args, { signal });
                return {
                    text: `Added the work tree ${destination} on ${name}.`,
                    details: { path: destination, branch: name },
                };
            },
        };
    }
    // remove: only a linked work tree of this repository, never the main one, never with force
    const wanted = path.isAbsolute(params.dir) ? params.dir : path.join(await workspaceRoot(signal), params.dir);
    let real: string;
    try {
        real = fs.realpathSync(wanted);
    } catch {
        throw new Error(`${wanted} does not exist`);
    }
    const linked = trees.slice(1).find((tree) => safeReal(tree.path) === real);
    if (!linked) throw new Error(`${real} is not a linked work tree of ${repo.name}; git worktree list shows them`);
    return {
        preview: {
            summary: `remove the work tree ${real} (${linked.branch ?? "detached"})`,
            fingerprint: digest("worktree", repo.root, "remove", real, linked.head),
        },
        run: async () => {
            await gitOut(repo.root, ["worktree", "remove", real], { signal });
            return { text: `Removed the work tree ${real}. Its branch ${linked.branch ?? ""} is kept.` };
        },
    };
}

function safeReal(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}

// ---- commit -------------------------------------------------------------------------------------------------------

interface CommitParams {
    repo?: string;
    paths?: string[];
    message?: string;
    amend?: boolean;
}

/** Whether any remote-tracking branch has HEAD, so amending it would rewrite what is already shared. */
async function pushedTo(repo: Repo, signal?: AbortSignal): Promise<string | undefined> {
    const out = await gitOut(repo.root, ["branch", "--remotes", "--contains", "HEAD"], { signal });
    return out
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.includes("->"));
}

export async function planCommit(params: CommitParams, call: Call): Promise<Planned> {
    const message = checkCommitMessage(params.message);
    const pattern = call.settings.commitMessage;
    if (pattern !== undefined && !new RegExp(pattern).test(message))
        throw new Error(`the commit message does not match git.commitMessage (${pattern})`);
    const amend = params.amend === true;
    if (params.paths === undefined && !amend)
        throw new Error("git commit needs paths. Usage: git commit {paths, message, repo?, amend?}");
    const paths = params.paths === undefined ? [] : checkPaths(params.paths);
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const branch = await requireBranch(repo.root, repo.name, "committing", signal);
    if (amend) {
        if (!(await revParse(repo.root, "HEAD", signal))) throw new Error(`${branch} has no commit to amend`);
        const remote = await pushedTo(repo, signal);
        if (remote)
            throw new Error(
                `HEAD is already pushed (${remote} has it), so amending it would rewrite shared history; make a new commit instead`,
            );
    }
    const head = (await revParse(repo.root, "HEAD", signal)) ?? "";
    const status =
        paths.length === 0
            ? ""
            : await gitOut(repo.root, ["--literal-pathspecs", "status", "--porcelain=v1", "--", ...paths], { signal });
    const files = paths.length === 0 ? "the message only" : plural(paths.length, "file");
    return {
        preview: {
            summary: `${amend ? "amend the last commit" : "commit"} ${files} on ${branch} in ${repo.name}`,
            body: [...paths.map((p) => `  ${p}`), "", message].join("\n"),
            format: "text",
            fingerprint: digest("commit", repo.root, branch, head, amend, paths, message, status),
        },
        run: async () => {
            // Literal pathspecs: a "*" or ":(magic)" entry is a file name, not a way to stage everything.
            if (paths.length > 0) await gitOut(repo.root, ["--literal-pathspecs", "add", "--", ...paths], { signal });
            const args =
                paths.length > 0
                    ? ["--literal-pathspecs", "commit", ...(amend ? ["--amend"] : []), "-m", message, "--", ...paths]
                    : ["commit", "--amend", "--only", "-m", message];
            const result = await git(repo.root, args, { signal });
            if (result.code !== 0) {
                if (/nothing (added )?to commit|no changes added/i.test(result.stdout + result.stderr))
                    throw new Error(`nothing to commit in ${paths.join(", ")}: no changes`);
                throw new Error(`git commit failed: ${summaryOf(result.stderr || result.stdout)}`);
            }
            const sha = await shortHead(repo, signal);
            const changed = (
                await gitOut(repo.root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"], { signal })
            )
                .split("\n")
                .filter(Boolean);
            const subject = message.split("\n")[0]?.slice(0, 120) ?? "";
            return {
                text: `${amend ? "Amended" : "Committed"} ${sha} on ${branch} in ${repo.name}: ${subject} (${plural(changed.length, "file")}).`,
                facts: { files: changed.length },
                details: { commit: sha, branch, files: changed },
            };
        },
    };
}

// ---- stash --------------------------------------------------------------------------------------------------------

interface StashParams {
    repo?: string;
    operation?: string;
    message?: string;
    paths?: string[];
    untracked?: boolean;
    index?: number;
}

export async function planStash(params: StashParams, call: Call): Promise<Planned> {
    const operation = operationOf(params.operation, ["push", "list", "pop", "drop"], "stash");
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const index = Math.max(0, Math.min(99, Math.trunc(params.index ?? 0)));
    const ref = `stash@{${index}}`;
    if (operation === "list") {
        return {
            preview: { summary: `list the stashes of ${repo.name}` },
            run: async () => {
                const out = await gitOut(repo.root, ["stash", "list", "--format=%gd: %cr: %gs"], { signal });
                return { text: out.trim() === "" ? "No stashes." : out.trim() };
            },
        };
    }
    if (operation === "push") {
        const paths = params.paths === undefined ? [] : checkPaths(params.paths);
        const message = params.message === undefined ? undefined : checkCommitMessage(params.message);
        return {
            preview: {
                summary: `stash ${paths.length > 0 ? plural(paths.length, "path") : "the uncommitted changes"} in ${repo.name}`,
                fingerprint: digest("stash", repo.root, "push", paths, message ?? "", params.untracked === true),
            },
            run: async () => {
                const args = [
                    "--literal-pathspecs",
                    "stash",
                    "push",
                    ...(params.untracked ? ["--include-untracked"] : []),
                    ...(message ? ["-m", message] : []),
                    "--",
                    ...paths,
                ];
                const out = (await gitOut(repo.root, args, { signal })).trim();
                return {
                    text: /no local changes/i.test(out) ? "No local changes to stash." : `${out} (in ${repo.name}).`,
                };
            },
        };
    }
    const exists = await refExists(repo.root, ref, signal);
    if (!exists) throw new Error(`there is no ${ref} in ${repo.name}`);
    const stashed = (await revParse(repo.root, ref, signal)) ?? "";
    if (operation === "pop") {
        await requireClean(repo, `popping ${ref}`, signal);
        return {
            preview: {
                summary: `apply ${ref} to ${repo.name} and drop it`,
                fingerprint: digest("stash", repo.root, "pop", ref, stashed),
            },
            run: async () => {
                const result = await git(repo.root, ["stash", "pop", ref], { signal });
                if (result.code !== 0) {
                    const conflicts = (await gitOut(repo.root, ["diff", "--name-only", "--diff-filter=U"], { signal }))
                        .split("\n")
                        .filter(Boolean);
                    throw new Error(
                        conflicts.length > 0
                            ? `popping ${ref} conflicts in ${conflicts.slice(0, 10).join(", ")}; the stash is kept and the files hold conflict markers. Fix them, or restore the paths`
                            : `git stash pop failed: ${summaryOf(result.stderr || result.stdout)}`,
                    );
                }
                return { text: `Applied ${ref} (${stashed.slice(0, 7)}) to ${repo.name} and dropped it.` };
            },
        };
    }
    return {
        preview: {
            summary: `drop ${ref} of ${repo.name}`,
            fingerprint: digest("stash", repo.root, "drop", ref, stashed),
        },
        run: async () => {
            await gitOut(repo.root, ["stash", "drop", ref], { signal });
            return {
                text: `Dropped ${ref} (${stashed.slice(0, 7)}) of ${repo.name}. git stash apply ${stashed.slice(0, 12)} brings it back.`,
            };
        },
    };
}

// ---- sync ---------------------------------------------------------------------------------------------------------

/** The remote a branch tracks, `origin` when it does not say. */
async function remoteOf(repo: Repo, branch: string, signal?: AbortSignal): Promise<string> {
    const out = await gitOut(repo.root, ["config", "--get", `branch.${branch}.remote`], { signal }).catch(() => "");
    return out.trim() || "origin";
}

export async function planSync(params: { repo?: string }, call: Call): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const branch = await requireBranch(repo.root, repo.name, "syncing", signal);
    const upstream = await upstreamOf(repo.root, signal);
    if (!upstream) throw new Error(`${branch} has no upstream; push it first`);
    const remote = await remoteOf(repo, branch, signal);
    const before = (await revParse(repo.root, "HEAD", signal)) ?? "";
    return {
        preview: {
            summary: `fetch ${remote} and fast-forward ${branch} to ${upstream} in ${repo.name} (no merge commit)`,
            fingerprint: digest("sync", repo.root, branch, before, upstream),
        },
        run: async () => {
            const fetched = await git(repo.root, ["fetch", "--no-tags", remote], { signal, network: true });
            if (fetched.code !== 0 || fetched.timedOut)
                throw new Error(
                    `fetch failed: ${fetched.timedOut ? "timed out" : summaryOf(fetched.stderr) || "unknown error"}`,
                );
            const merged = await git(repo.root, ["merge", "--ff-only", "@{upstream}"], { signal });
            if (merged.code !== 0) {
                const counts = (
                    await gitOut(repo.root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { signal })
                )
                    .trim()
                    .split(/\s+/);
                const local = merged.stderr.includes("overwritten") ? ", local changes in the way" : "";
                throw new Error(
                    `${branch} cannot fast-forward to ${upstream} (ahead ${counts[0]}, behind ${counts[1]}${local}); merge or rebase is your call`,
                );
            }
            const after = await shortHead(repo, signal);
            const was = before.slice(0, 7);
            return {
                text:
                    was === after
                        ? `${branch} is already up to date with ${upstream} in ${repo.name}.`
                        : `Fast-forwarded ${branch} ${was}..${after} from ${upstream} in ${repo.name}.`,
            };
        },
    };
}

// ---- merge, rebase, cherry_pick -----------------------------------------------------------------------------------

/** The files git reports as conflicting. */
async function conflicts(repo: Repo, signal?: AbortSignal): Promise<string[]> {
    return (await git(repo.root, ["diff", "--name-only", "--diff-filter=U"], { signal })).stdout
        .split("\n")
        .filter(Boolean);
}

function listFiles(files: readonly string[]): string {
    return `${files.slice(0, 10).join(", ")}${files.length > 10 ? ", ..." : ""}`;
}

export async function planMerge(
    params: { repo?: string; branch?: string; base?: string },
    call: Call,
): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const current = await requireBranch(repo.root, repo.name, "merging", signal);
    if (params.branch !== undefined && params.base !== undefined)
        throw new Error("git merge takes branch or base: not both");
    const other = params.branch === undefined ? undefined : checkBranch(params.branch);
    const base =
        params.branch === undefined
            ? params.base === undefined
                ? await baseBranch(repo, call.settings, signal)
                : checkBranch(params.base, "base")
            : undefined;
    if ((other ?? base) === current) throw new Error(`${current} is the current branch; there is nothing to merge`);
    await requireClean(repo, `merging into ${current}`, signal);
    const before = (await revParse(repo.root, "HEAD", signal)) ?? "";
    const label = other ?? `origin/${base}`;
    return {
        preview: {
            summary: `merge ${label} into ${current} in ${repo.name}; a conflict aborts the merge`,
            fingerprint: digest("merge", repo.root, current, before, label),
        },
        run: async () => {
            let ref: string;
            if (base !== undefined) {
                await fetchBranch(repo, "origin", base, signal);
                ref = `refs/remotes/origin/${base}`;
            } else {
                const name = other as string;
                ref = (await refExists(repo.root, `refs/heads/${name}`, signal))
                    ? `refs/heads/${name}`
                    : `refs/remotes/origin/${name}`;
                if (!(await refExists(repo.root, ref, signal)))
                    throw new Error(`branch ${name} not found locally or at origin`);
            }
            if ((await git(repo.root, ["merge-base", "--is-ancestor", ref, "HEAD"], { signal })).code === 0) {
                return { text: `${current} already contains ${label} in ${repo.name}.` };
            }
            const merged = await git(repo.root, ["merge", "--no-edit", ref], { signal });
            if (merged.code !== 0) {
                const files = await conflicts(repo, signal);
                // Abort so the tree is exactly as it was; resolving is a human decision.
                await git(repo.root, ["merge", "--abort"], { signal });
                throw new Error(
                    files.length > 0
                        ? `merging ${label} into ${current} conflicts in ${plural(files.length, "file")} (${listFiles(files)}); the merge was aborted and the tree is unchanged`
                        : `merging ${label} into ${current} failed and was aborted: ${summaryOf(merged.stderr || merged.stdout)}`,
                );
            }
            return {
                text: `Merged ${label} into ${current} ${before.slice(0, 7)}..${await shortHead(repo, signal)} in ${repo.name}.`,
            };
        },
    };
}

export async function planRebase(params: { repo?: string; base?: string }, call: Call): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const current = await requireBranch(repo.root, repo.name, "rebasing", signal);
    if (await isProtected(repo, current, call.settings, signal))
        throw new Error(`refusing to rebase protected branch ${current}`);
    const base =
        params.base === undefined ? await baseBranch(repo, call.settings, signal) : checkBranch(params.base, "base");
    if (base === current) throw new Error(`${current} is the base; there is nothing to rebase onto`);
    await requireClean(repo, `rebasing onto ${base}`, signal);
    const before = (await revParse(repo.root, "HEAD", signal)) ?? "";
    return {
        preview: {
            summary: `rebase ${current} onto the fetched origin/${base} in ${repo.name}; a conflict aborts the rebase`,
            fingerprint: digest("rebase", repo.root, current, before, base),
        },
        run: async () => {
            await fetchBranch(repo, "origin", base, signal);
            const rebased = await git(repo.root, ["rebase", `refs/remotes/origin/${base}`], { signal });
            if (rebased.code !== 0) {
                const files = await conflicts(repo, signal);
                await git(repo.root, ["rebase", "--abort"], { signal });
                throw new Error(
                    files.length > 0
                        ? `rebasing ${current} onto origin/${base} conflicts in ${plural(files.length, "file")} (${listFiles(files)}); the rebase was aborted and the branch is unchanged`
                        : `rebasing ${current} onto origin/${base} failed and was aborted: ${summaryOf(rebased.stderr || rebased.stdout)}`,
                );
            }
            const after = await shortHead(repo, signal);
            const rewritten = before.slice(0, 7) !== after;
            const upstream = await upstreamOf(repo.root, signal);
            const note =
                rewritten && upstream ? ` History was rewritten, so pushing ${current} needs force_with_lease.` : "";
            return {
                text: rewritten
                    ? `Rebased ${current} onto origin/${base}: ${before.slice(0, 7)} is now ${after} in ${repo.name}.${note}`
                    : `${current} is already on top of origin/${base} in ${repo.name}.`,
            };
        },
    };
}

export async function planCherryPick(params: { repo?: string; revs?: string[] }, call: Call): Promise<Planned> {
    if (!Array.isArray(params.revs) || params.revs.length === 0 || params.revs.length > 20)
        throw new Error("git cherry_pick needs revs: one to 20 commits. Usage: git cherry_pick {revs, repo?}");
    const revs = params.revs.map((rev) => checkRev(rev, "revs"));
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const current = await requireBranch(repo.root, repo.name, "cherry-picking", signal);
    if (await isProtected(repo, current, call.settings, signal))
        throw new Error(`refusing to cherry-pick onto protected branch ${current}`);
    await requireClean(repo, "cherry-picking", signal);
    const shas: string[] = [];
    for (const rev of revs) {
        const sha = await revParse(repo.root, rev, signal);
        if (!sha) throw new Error(`${rev} is not a commit in ${repo.name}`);
        shas.push(sha);
    }
    const before = (await revParse(repo.root, "HEAD", signal)) ?? "";
    return {
        preview: {
            summary: `cherry-pick ${plural(revs.length, "commit")} onto ${current} in ${repo.name}; a conflict aborts it`,
            body: revs.join("\n"),
            format: "text",
            fingerprint: digest("cherry_pick", repo.root, current, before, shas),
        },
        run: async () => {
            const picked = await git(repo.root, ["cherry-pick", ...shas], { signal });
            if (picked.code !== 0) {
                const files = await conflicts(repo, signal);
                await git(repo.root, ["cherry-pick", "--abort"], { signal });
                throw new Error(
                    files.length > 0
                        ? `cherry-picking onto ${current} conflicts in ${plural(files.length, "file")} (${listFiles(files)}); it was aborted and the branch is unchanged`
                        : `cherry-picking onto ${current} failed and was aborted: ${summaryOf(picked.stderr || picked.stdout)}`,
                );
            }
            return {
                text: `Cherry-picked ${plural(shas.length, "commit")} onto ${current}: ${before.slice(0, 7)}..${await shortHead(repo, signal)} in ${repo.name}.`,
            };
        },
    };
}

// ---- restore ------------------------------------------------------------------------------------------------------

export async function planRestore(params: { repo?: string; paths?: string[] }, call: Call): Promise<Planned> {
    const paths = checkPaths(params.paths);
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal } = call;
    const diff = ["--literal-pathspecs", "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color"];
    const stat = (await gitOut(repo.root, [...diff, "--stat=100", "--", ...paths], { signal })).trim();
    // The digest of the patch, not only the stat: an edit that keeps the line counts is still a different loss.
    const patch = await gitOut(repo.root, [...diff, "--", ...paths], { signal, maxBytes: 4 * 1024 * 1024 });
    return {
        preview: {
            summary: `discard the uncommitted changes in ${plural(paths.length, "path")} of ${repo.name}; they cannot be recovered`,
            body: [
                paths.map((p) => `  ${p}`).join("\n"),
                "",
                stat === "" ? "No tracked changes in these paths." : stat,
            ].join("\n"),
            format: "text",
            fingerprint: digest("restore", repo.root, paths, patch),
        },
        run: async () => {
            const result = await git(
                repo.root,
                ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths],
                { signal },
            );
            if (result.code !== 0) throw new Error(`git restore failed: ${summaryOf(result.stderr)}`);
            return {
                text: `Restored ${plural(paths.length, "path")} in ${repo.name} to HEAD.${stat === "" ? "" : `\n${clip(firstLines(stat, 20).text, 2000)}`}`,
            };
        },
    };
}
