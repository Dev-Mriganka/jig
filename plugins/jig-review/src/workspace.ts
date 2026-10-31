// One review across every repository with changes under Pi's folder. Pi often runs in a workspace folder that holds
// many repositories and worktrees, and one change often spans several of them. Each repository's diff keeps git's own
// paths, prefixed with the repository's folder, so the file tree groups by repository and a comment's location is a path
// the agent can open from Pi's folder.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { GitReviewSource, jigGit } from "./git.ts";
import type { Git, ReviewFileSelection } from "./git.ts";
import { bindingPath, readBinding } from "./ticket.ts";

export type Repository = { root: string; prefix: string };

const SKIP = new Set(["node_modules", "build", "target", "dist", "out"]);

const isRepository = (dir: string): boolean => existsSync(path.join(dir, ".git"));

function subdirectories(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
            .map((entry) => path.join(dir, entry.name));
    } catch {
        return [];
    }
}

/** How deep a workspace is searched: repo, worktrees/<repo>, worktrees/<ticket>/<repo>. */
const MAX_DEPTH = 3;

/**
 * The repositories a review covers: Pi's folder itself when it is a repository, otherwise every repository up to three
 * levels below it (so `worktrees/PROJ-123/orders-api` is found). The search stops at each repository and skips hidden
 * and build folders.
 */
export function findRepositories(cwd: string): Repository[] {
    if (isRepository(cwd)) return [{ root: cwd, prefix: "" }];
    const found: Repository[] = [];
    const walk = (dir: string, depth: number) => {
        for (const sub of subdirectories(dir)) {
            if (isRepository(sub)) found.push({ root: sub, prefix: path.relative(cwd, sub) });
            else if (depth < MAX_DEPTH) walk(sub, depth + 1);
        }
    };
    walk(cwd, 1);
    return found.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/** A folder argument as a clean path relative to Pi's folder; undefined for the whole workspace. */
export function normalizeFolder(cwd: string, folder: string | undefined): string | undefined {
    if (!folder) return undefined;
    const relative = path.relative(cwd, path.resolve(cwd, folder));
    if (relative === "") return undefined;
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${folder} is outside ${cwd}.`);
    return relative.split(path.sep).join("/");
}

/** Repositories inside `folder`, or the one repository that contains it. */
function within(repos: Repository[], folder: string | undefined): Repository[] {
    if (!folder) return repos;
    return repos.filter(
        (repo) =>
            !repo.prefix ||
            repo.prefix === folder ||
            repo.prefix.startsWith(`${folder}/`) ||
            folder.startsWith(`${repo.prefix}/`),
    );
}

/** Prefixes the paths in a unified diff's file headers; hunk lines are left alone. */
export function prefixDiff(diff: string, prefix: string): string {
    if (!prefix) return diff;
    const p = `${prefix}/`;
    let inHeader = false;
    return diff
        .split("\n")
        .map((line) => {
            if (line.startsWith("diff --git ")) {
                inHeader = true;
                return line.replace(/^diff --git a\/(.*) b\/(.*)$/, `diff --git a/${p}$1 b/${p}$2`);
            }
            if (line.startsWith("@@")) inHeader = false;
            if (!inHeader) return line;
            return line
                .replace(/^--- a\//, `--- a/${p}`)
                .replace(/^\+\+\+ b\//, `+++ b/${p}`)
                .replace(/^(rename|copy) (from|to) /, `$1 $2 ${p}`);
        })
        .join("\n");
}

/** Which repositories a review covers: a ticket's, a folder's, or (neither given) every one in the workspace. */
export type Target = { folder?: string; ticket?: string };

type Source = Repository & { git: GitReviewSource };

/** Same surface as GitReviewSource, over the repositories a review targets. */
export class WorkspaceReviewSource {
    private readonly git: Git;
    private readonly cwd: string;
    private readonly discover: (cwd: string) => Repository[];
    private readonly env: NodeJS.ProcessEnv;

    public constructor(
        cwd: string,
        git: Git = jigGit,
        discover: (cwd: string) => Repository[] = findRepositories,
        env: NodeJS.ProcessEnv = process.env,
    ) {
        this.cwd = cwd;
        this.git = git;
        this.discover = discover;
        this.env = env;
    }

    private sources(target: Target): Source[] {
        const repos = target.ticket
            ? readBinding(target.ticket, this.cwd, this.env)
            : within(this.discover(this.cwd), normalizeFolder(this.cwd, target.folder));
        return repos.map((repo) => ({ ...repo, git: new GitReviewSource(repo.root, this.git) }));
    }

    /**
     * This repository's part of a selection. Explicit file lists are relative to Pi's folder, so only the files under
     * the repository's prefix are kept, without it. Undefined when the list names none of its files.
     */
    private scoped(repo: Repository, selection: ReviewFileSelection): ReviewFileSelection | undefined {
        const { since, ...rest } = selection;
        const own: ReviewFileSelection = since?.[repo.root] ? { ...rest, base: since[repo.root] } : rest;
        if (!own.files || !repo.prefix) return own;
        const p = `${repo.prefix}/`;
        const files = own.files.filter((file) => file.startsWith(p)).map((file) => file.slice(p.length));
        return files.length ? { ...own, files } : undefined;
    }

    /** Throws a one-line reason when the target covers no repository. */
    public async requireGitRepo(target: Target = {}): Promise<void> {
        if (this.sources(target).length > 0) return;
        if (target.ticket) {
            throw new Error(
                `No repositories for ${target.ticket}: none is bound to it (${bindingPath(target.ticket, this.env)}).`,
            );
        }
        throw new Error(
            target.folder
                ? `No git repositories found in ${target.folder}.`
                : `No git repositories found in ${this.cwd} or the folders inside it.`,
        );
    }

    /**
     * "repo@sha" for each repository the selection has files in (just the SHA when Pi's folder is the repository). The
     * selection decides, not uncommitted changes: a touched review of committed files is in a clean repository, and a
     * dirty repository the review does not show is not one of its commits.
     */
    public async getHeadSha(selection: ReviewFileSelection = { scope: "all" }): Promise<string> {
        const heads: string[] = [];
        for (const repo of this.sources(selection)) {
            try {
                const scoped = this.scoped(repo, selection);
                if (!scoped || ((await repo.git.getChangedFiles(scoped)).length === 0 && !selection.ticket)) continue;
                const sha = await repo.git.getHeadSha();
                heads.push(repo.prefix ? `${repo.prefix}@${sha.slice(0, 12)}` : sha);
            } catch {
                // left out, as in getChangedFiles
            }
        }
        return heads.join(", ") || "none";
    }

    /** The folder of every repository the target covers, by its path from Pi's folder ("" for the folder itself). */
    public rootsOf(target: Target = {}): Map<string, string> {
        return new Map(this.sources(target).map((repo) => [repo.prefix, repo.root]));
    }

    /** Full HEAD commit of every repository the target covers, with its path from Pi's folder ("" for the folder itself). */
    public async getHeads(target: Target = {}): Promise<Array<{ repo: string; sha: string }>> {
        const heads: Array<{ repo: string; sha: string }> = [];
        for (const repo of this.sources(target)) {
            try {
                heads.push({ repo: repo.prefix, sha: await repo.git.getHeadSha() });
            } catch {
                // a repository git cannot read is left out: it then counts as not covered
            }
        }
        return heads;
    }

    public async getChangedFiles(selection: ReviewFileSelection): Promise<string[]> {
        const files: string[] = [];
        for (const repo of this.sources(selection)) {
            const scoped = this.scoped(repo, selection);
            if (!scoped) continue;
            try {
                for (const file of await repo.git.getChangedFiles(scoped))
                    files.push(repo.prefix ? `${repo.prefix}/${file}` : file);
            } catch {
                // a repository git cannot read is left out rather than failing the whole review
            }
        }
        return files;
    }

    public async getDiff(selection: ReviewFileSelection): Promise<string> {
        const diffs: string[] = [];
        for (const repo of this.sources(selection)) {
            const scoped = this.scoped(repo, selection);
            if (!scoped) continue;
            try {
                const diff = await repo.git.getDiff(scoped);
                if (diff.trim()) diffs.push(prefixDiff(diff, repo.prefix));
            } catch {
                // see getChangedFiles
            }
        }
        return diffs.join("\n");
    }
}
