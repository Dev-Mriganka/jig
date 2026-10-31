// The git actions that deal with changes in the working tree: `commit` (exact paths and a message, amend only while no remote has the
// commit), `stash`, and `restore`, which discards changes and so asks.
import { checkCommitMessage, checkPaths } from "./names.ts";
import { digest } from "./previews.ts";
import type { Call, Planned } from "./previews.ts";
import { resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { git, gitOut, refExists, requireBranch, revParse, summaryOf } from "./run.ts";
import { clip, firstLines, plural } from "./text.ts";
import { operationOf, requireClean, shortHead } from "./git-guards.ts";

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
