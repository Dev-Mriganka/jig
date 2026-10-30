// The git actions that reach the remote: fetch, which only reads it, and push, the one that changes it. A push shows the
// commits it will send, and sends only what was shown. A push whose reply is lost is checked once with `ls-remote` and
// never repeated.
import { announcePushed } from "./events.ts";
import { checkBranch, checkRemote } from "./names.ts";
import type { Call, Planned } from "./previews.ts";
import { digest, readOnly } from "./previews.ts";
import { isProtected, resolveRepo } from "./repo.ts";
import type { Repo } from "./repo.ts";
import {
    git,
    gitOut,
    gitTry,
    mayHaveLanded,
    refExists,
    requireBranch,
    revParse,
    summaryOf,
    T_NETWORK,
    T_PUSH,
} from "./run.ts";
import { plural } from "./text.ts";

/** The remote-tracking branches and tags, one `ref sha` line each. */
async function refSnapshot(repo: Repo, remote: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const out = await gitOut(
        repo.root,
        ["for-each-ref", "--format=%(refname) %(objectname:short)", `refs/remotes/${remote}`, "refs/tags"],
        { signal },
    );
    const refs = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
        const [ref = "", sha = ""] = line.split(" ");
        if (!ref.endsWith("/HEAD")) refs.set(ref.replace(/^refs\/(?:remotes|tags)\//, ""), sha);
    }
    return refs;
}

export function planFetch(params: { repo?: string; remote?: string }, call: Call): Planned {
    const remote = params.remote === undefined ? "origin" : checkRemote(params.remote);
    return readOnly(`git fetch ${remote} in ${params.repo ?? "here"}`, async () => {
        const repo = await resolveRepo(params.repo, call.signal);
        const before = await refSnapshot(repo, remote, call.signal);
        const result = await git(repo.root, ["fetch", "--tags", "--no-recurse-submodules", remote], {
            signal: call.signal,
            network: true,
            timeoutMs: T_NETWORK,
        });
        if (result.code !== 0 || result.timedOut)
            throw new Error(
                `git fetch failed: ${result.timedOut ? "timed out" : summaryOf(result.stderr) || `exit ${result.code}`}`,
            );
        const after = await refSnapshot(repo, remote, call.signal);
        const changes: string[] = [];
        for (const [ref, sha] of after) {
            const old = before.get(ref);
            if (old === undefined) changes.push(`new ${ref} ${sha}`);
            else if (old !== sha) changes.push(`updated ${ref} ${old}..${sha}`);
        }
        const shown = changes.slice(0, 30);
        const more = changes.length > shown.length ? `\n... ${changes.length - shown.length} more` : "";
        return {
            text:
                changes.length === 0
                    ? `Fetched ${remote} for ${repo.name}: nothing new.`
                    : `Fetched ${remote} for ${repo.name}: ${plural(changes.length, "ref")} changed.\n${shown.join("\n")}${more}`,
            facts: { refs: changes.length },
        };
    });
}

const PREVIEW_COMMITS = 20;

interface PushParams {
    repo?: string;
    branch?: string;
    remote?: string;
    force_with_lease?: boolean;
}

export async function planPush(params: PushParams, call: Call): Promise<Planned> {
    const repo = await resolveRepo(params.repo, call.signal);
    const { signal, settings } = call;
    const branch =
        params.branch === undefined
            ? await requireBranch(repo.root, repo.name, "pushing", signal)
            : checkBranch(params.branch);
    const remote = params.remote === undefined ? "origin" : checkRemote(params.remote);
    const sha = await revParse(repo.root, `refs/heads/${branch}`, signal);
    if (!sha) throw new Error(`branch ${branch} does not exist locally in ${repo.name}`);
    if (await isProtected(repo, branch, settings, signal)) {
        throw new Error(`refusing to push protected branch ${branch}; push a feature branch and open a pull request`);
    }
    if ((await gitTry(repo.root, ["remote", "get-url", remote], { signal })) === undefined)
        throw new Error(`${repo.name} has no remote called ${remote}`);
    const force = params.force_with_lease === true;
    const notThere = [`refs/heads/${branch}`, "--not", `--remotes=${remote}`];
    const pending = Number((await gitOut(repo.root, ["rev-list", "--count", ...notThere], { signal })).trim());
    const commits = (
        await gitOut(repo.root, ["log", "--format=%h %s", `-n${PREVIEW_COMMITS}`, ...notThere], { signal })
    )
        .split("\n")
        .filter(Boolean);
    const created = !(await refExists(repo.root, `refs/remotes/${remote}/${branch}`, signal));
    const short = sha.slice(0, 7);
    const body = [
        `Branch ${branch} at ${short} to ${remote}${created ? ", creating the branch there" : ""}.`,
        pending === 0
            ? `No new commits: ${remote} already has every commit of this branch.`
            : `${plural(pending, "commit")} ${remote} does not have yet:`,
        ...commits.map((commit) => `  ${commit}`),
        pending > commits.length ? `  ... ${pending - commits.length} more` : "",
        force ? "Force: --force-with-lease (refused if the remote moved since it was last fetched)." : "Force: no.",
    ]
        .filter((line) => line !== "")
        .join("\n");
    return {
        preview: {
            summary: `push ${branch} (${short}) to ${remote}: ${plural(pending, "commit")}${force ? ", with lease" : ""}`,
            body,
            format: "text",
            // The commits and the head decide it. Whatever differs at run time is something the user did not see.
            fingerprint: digest("push", repo.root, remote, branch, sha, force, commits, pending),
        },
        run: async () => {
            const args = [
                "push",
                "--no-progress",
                ...(force ? ["--force-with-lease"] : []),
                "--set-upstream",
                remote,
                `refs/heads/${branch}:refs/heads/${branch}`,
            ];
            const result = await git(repo.root, args, { signal, network: true, timeoutMs: T_PUSH });
            let landed = result.code === 0 && !result.timedOut;
            let lostWhy: string | undefined;
            if (!landed) {
                if (!mayHaveLanded(result) && !signal?.aborted)
                    throw new Error(
                        `git push failed: ${summaryOf(result.stderr || result.stdout) || `exit ${result.code}`}`,
                    );
                // The push may have landed although its reply did not reach us. One read decides; nothing is pushed twice.
                lostWhy = result.timedOut
                    ? "timed out"
                    : signal?.aborted
                      ? "the call was cancelled"
                      : summaryOf(result.stderr);
                const there = await gitTry(repo.root, ["ls-remote", remote, `refs/heads/${branch}`], {
                    signal: undefined,
                    network: true,
                    timeoutMs: T_NETWORK,
                });
                if (there === undefined)
                    throw new Error(
                        `git push: the reply was lost (${lostWhy}) and the check failed too. Run git ls-remote ${remote} before pushing again. Nothing was sent twice.`,
                    );
                if (!there.startsWith(sha))
                    throw new Error(
                        `git push: the reply was lost (${lostWhy}) and ${remote} does not have ${short}. Nothing was sent twice; push again if you still want it.`,
                    );
                landed = true;
            }
            await announcePushed({ repo, settings, branch, sha, signal });
            const note =
                lostWhy === undefined
                    ? ""
                    : ` (The reply was lost (${lostWhy}); one check shows ${remote} has it. Nothing was sent twice.)`;
            return {
                text: `Pushed ${branch} (${short}) from ${repo.name} to ${remote}${force ? " with --force-with-lease" : ""}; upstream set.${note}`,
                facts: { commits: pending },
                details: { branch, sha, pushed: pending, force },
            };
        },
    };
}
