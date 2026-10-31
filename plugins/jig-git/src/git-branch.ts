// The git actions that put work on a branch: `branch` (create from the fetched base, switch, or delete a merged branch) and `worktree`
// (list, add or remove). Nothing here reaches GitHub except to fetch what a branch starts from.
import fs from "node:fs";
import path from "node:path";
import { checkBranch } from "./names.ts";
import { digest } from "./previews.ts";
import type { Call, Planned } from "./previews.ts";
import { baseBranch, DIR_NAME, isProtected, resolveRepo, workspaceRoot } from "./repo.ts";
import { currentBranch, git, gitOut, refExists, revParse, summaryOf } from "./run.ts";
import { checkBranchPattern, fetchBranch, operationOf, requireClean, shortHead } from "./git-guards.ts";

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
