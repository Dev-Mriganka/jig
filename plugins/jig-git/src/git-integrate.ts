// The git actions that bring other work in: `sync` (fast-forward from the upstream), `merge`, `rebase` and `cherry_pick`. Nothing here
// resolves a conflict: each puts the repository back as it was and says which files conflict.
import { checkBranch, checkRev } from "./names.ts";
import { digest } from "./previews.ts";
import type { Call, Planned } from "./previews.ts";
import { baseBranch, isProtected, resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { git, gitOut, refExists, requireBranch, revParse, summaryOf, upstreamOf } from "./run.ts";
import { plural } from "./text.ts";
import { fetchBranch, requireClean, shortHead } from "./git-guards.ts";

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
export async function conflicts(repo: Repo, signal?: AbortSignal): Promise<string[]> {
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
