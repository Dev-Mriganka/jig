// One repository's git state, and the diffs a review shows. Git runs through jig-core (`exec.git`): from an argument
// list, with hooks and prompts off, and refusing a repository whose own configuration would run a command.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { jig } from "../../jig-core/src/client.ts";
import { filterReviewableFiles } from "./file-filter.ts";
import type { ReviewFileScope } from "./types.ts";

export type GitResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Runs git in `repo`. Tests pass their own; the extension uses jig-core's. */
export type Git = (repo: string, args: string[], timeoutMs: number) => Promise<GitResult>;

export const jigGit: Git = (repo, args, timeoutMs) => jig().exec.git(repo, args, { timeoutMs });

export type ReviewFileSelection = {
    files?: string[];
    scope: ReviewFileScope;
    /** Limits a workspace review to the repositories in this folder, relative to Pi's folder. */
    folder?: string;
    /** Limits a review to one ticket's bound repositories. */
    ticket?: string;
    /**
     * Touched scope: each repository's HEAD when the agent's run started (repository root -> commit), so the review
     * shows what the run changed even when it also committed it. A repository not named here compares with HEAD.
     */
    since?: Record<string, string>;
    /** Touched scope, one repository: the commit its diff starts from (from `since`); HEAD when absent. */
    base?: string;
};

const T_QUICK = 5000;
const T_DIFF = 10000;

/** Reads one repository's git state and builds review diffs against HEAD, the branch's base or the run's start. */
export class GitReviewSource {
    private readonly git: Git;
    private readonly root: string;

    /** `root` is the repository's top folder; every git command runs there. */
    public constructor(root: string, git: Git = jigGit) {
        this.root = root;
        this.git = git;
    }

    private run(args: string[], timeoutMs: number): Promise<GitResult> {
        return this.git(this.root, args, timeoutMs);
    }

    public async requireGitRepo(): Promise<void> {
        const result = await this.run(["rev-parse", "--is-inside-work-tree"], T_QUICK);
        if (result.code !== 0 || result.stdout.trim() !== "true") {
            throw new Error("Interactive code review requires a git repository.");
        }
    }

    /** The full commit of HEAD. */
    public async getHeadSha(): Promise<string> {
        const result = await this.run(["rev-parse", "HEAD"], T_QUICK);
        if (result.code !== 0) throw new Error("Unable to read git HEAD SHA.");
        return result.stdout.trim();
    }

    /** The changed files of the scope that a review shows, sorted; paths are relative to the repository. */
    public async getChangedFiles(selection: ReviewFileSelection): Promise<string[]> {
        const files = Array.from(new Set(await this.getRawChangedFiles(selection)));
        const reviewable =
            selection.scope === "touched" ? await this.filterTouchedFiles(files) : await this.filterReviewableFiles(files);
        return reviewable.sort((a, b) => a.localeCompare(b));
    }

    /** The unified diff of the selection: tracked changes, then the untracked files as added files. */
    public async getDiff(selection: ReviewFileSelection): Promise<string> {
        const reviewFiles = selection.files ?? (await this.getChangedFiles(selection));
        if (reviewFiles.length === 0) return "";
        const tracked = await this.getTrackedDiff(selection.scope, reviewFiles, selection.base);
        const untracked = selection.scope === "staged" ? [] : await this.getUntrackedFiles(reviewFiles);
        const added = await Promise.all(untracked.map((file) => this.getAddedFileDiff(file)));
        return [tracked, ...added].filter((diff) => diff.trim().length > 0).join("\n");
    }

    private async getRawChangedFiles(selection: ReviewFileSelection): Promise<string[]> {
        switch (selection.scope) {
            case "staged":
                return this.names(["diff", "--name-only", "-z", "--cached", "HEAD", "--"]);
            case "unstaged":
                return [...(await this.names(["diff", "--name-only", "-z", "--"])), ...(await this.getUntrackedFileNames())];
            case "touched":
                return selection.files ?? [];
            case "all":
                return [
                    ...(await this.names(["diff", "--name-only", "-z", "HEAD", "--"])),
                    ...(await this.getUntrackedFileNames()),
                ];
            case "branch":
                return [
                    ...(await this.names(["diff", "--name-only", "-z", await this.getBranchBase(), "--"])),
                    ...(await this.getUntrackedFileNames()),
                ];
        }
    }

    /** Where the current branch left its mainline: the merge base with develop, main or master (remote first). */
    public async getBranchBase(): Promise<string> {
        for (const ref of ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"]) {
            const exists = await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], T_QUICK);
            if (exists.code !== 0) continue;
            const base = await this.run(["merge-base", "HEAD", ref], T_QUICK);
            if (base.code === 0 && base.stdout.trim()) return base.stdout.trim();
        }
        throw new Error(`No develop, main or master branch to compare with in ${this.root}.`);
    }

    private async getTrackedDiff(scope: ReviewFileScope, files: string[], base?: string): Promise<string> {
        const from = scope === "branch" ? await this.getBranchBase() : (base ?? "HEAD");
        const result = await this.run(getDiffArgs(scope, files, from), T_DIFF);
        if (result.code !== 0) throw new Error("Unable to generate git diff for review.");
        return result.stdout;
    }

    /** File names from a command run with `-z`: separated by NUL, so a name with a space or an accent is whole. */
    private async names(args: string[]): Promise<string[]> {
        const result = await this.run(args, T_QUICK);
        if (result.code !== 0) throw new Error("Unable to list git changes for review.");
        return result.stdout.split("\0").filter((name) => name.length > 0);
    }

    private async filterTouchedFiles(files: string[]): Promise<string[]> {
        const local = files.filter((file) => !isOutsideDirectory(file));
        const outside = files.filter(isOutsideDirectory);
        return [...(await this.filterReviewableFiles(local)), ...outside];
    }

    private async filterReviewableFiles(files: string[]): Promise<string[]> {
        try {
            return filterReviewableFiles(files, await readFile(path.join(this.root, ".gitignore"), "utf8"));
        } catch {
            return filterReviewableFiles(files);
        }
    }

    private getUntrackedFileNames(): Promise<string[]> {
        return this.names(["ls-files", "-z", "--others", "--exclude-standard"]);
    }

    private async getUntrackedFiles(files: string[]): Promise<string[]> {
        const allowed = new Set(files);
        return (await this.filterReviewableFiles(await this.getUntrackedFileNames())).filter((file) => allowed.has(file));
    }

    private async getAddedFileDiff(file: string): Promise<string> {
        const result = await this.run(["diff", "--no-index", "--", "/dev/null", file], T_DIFF);
        // git exits 1 when the files differ, which an added file always does.
        if (result.code !== 0 && result.code !== 1) throw new Error(`Unable to generate added-file diff for ${file}.`);
        // The page finds a file's path in its headers; /dev/null would name no file.
        return result.stdout.replaceAll("--- /dev/null", `--- a/${file}`);
    }
}

function isOutsideDirectory(filePath: string): boolean {
    return filePath.startsWith("..") || path.isAbsolute(filePath);
}

function getDiffArgs(scope: ReviewFileScope, files: string[], base: string): string[] {
    const baseArgs = ["diff", "--no-ext-diff", "--binary", "--find-renames", "-U3"];
    switch (scope) {
        case "staged":
            return [...baseArgs, "--cached", "HEAD", "--", ...files];
        case "unstaged":
            return [...baseArgs, "--", ...files];
        // The working tree against where the run started: committed, staged and unstaged changes of the run alike.
        case "touched":
            return [...baseArgs, base, "--", ...files];
        case "all":
            return [...baseArgs, "HEAD", "--", ...files];
        case "branch":
            return [...baseArgs, base, "--", ...files];
    }
}
