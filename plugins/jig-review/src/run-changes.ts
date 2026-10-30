// Which repository files changed while the agent ran, however they changed: the edit and write tools name their files,
// but bash (`sed -i`, a script, `cat > file`) does not. Git status before and after the run shows every file that
// differs, with a content fingerprint per path so a file that was already dirty and changed again still counts.
// Snapshots live in memory only, and a repository git cannot read in time is simply not covered: this is a best-effort
// net beside the exact tool events, never an error for the user.
import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { jigGit } from "./git.ts";
import type { Git } from "./git.ts";
import { findRepositories } from "./workspace.ts";
import type { Repository } from "./workspace.ts";

/** Changed path (relative to its repository) -> fingerprint of the working file. */
export type RepositorySnapshot = Map<string, string>;

/** Repository root -> its snapshot. A repository that could not be read has no entry. */
export type WorkspaceSnapshot = Map<string, RepositorySnapshot>;

/** A repository with more changed paths than this is skipped: a build or generator wrote them, not a review's worth. */
export const MAX_CHANGED_PATHS = 2000;

const STATUS_TIMEOUT_MS = 8000;
const HASH_TIMEOUT_MS = 5000;
const HASH_BATCH = 200;
const PARALLEL_REPOSITORIES = 4;

const DELETED = "deleted";

/** The repositories to look at: Pi's folder, or the ones below it. */
type Discover = (cwd: string) => Repository[];

/**
 * Snapshots the changed paths of every repository `discover` finds under Pi's folder.
 *
 * @param maxPaths Repositories listing more changed paths than this are left out.
 */
export async function snapshotWorkspace(
    cwd: string,
    discover: Discover = findRepositories,
    maxPaths: number = MAX_CHANGED_PATHS,
    git: Git = jigGit,
): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = new Map();
    const queue = [...discover(cwd)];

    const worker = async (): Promise<void> => {
        for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
            const entries = await snapshotRepository(git, repo.root, maxPaths);
            if (entries !== undefined) snapshot.set(repo.root, entries);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_REPOSITORIES, queue.length) }, worker));

    return snapshot;
}

/** Each repository's HEAD commit (root -> sha); a repository without one (no commit yet, git failing) is left out. */
export async function snapshotHeads(
    cwd: string,
    discover: Discover = findRepositories,
    git: Git = jigGit,
): Promise<Record<string, string>> {
    const heads: Record<string, string> = {};
    await Promise.all(
        discover(cwd).map(async (repo) => {
            try {
                const result = await git(repo.root, ["rev-parse", "--verify", "--quiet", "HEAD"], STATUS_TIMEOUT_MS);
                const sha = result.stdout.trim();
                if (result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) heads[repo.root] = sha;
            } catch {
                // left out: that repository's review compares with HEAD
            }
        }),
    );
    return heads;
}

/**
 * Files changed by commits made since `heads` (absolute paths): a committed file is clean before and after the run, so
 * git status never shows it. Repositories whose HEAD did not move, or that git cannot read, add nothing.
 */
export async function committedSince(heads: Record<string, string>, git: Git = jigGit): Promise<string[]> {
    const files: string[] = [];
    await Promise.all(
        Object.entries(heads).map(async ([root, start]) => {
            try {
                const now = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], STATUS_TIMEOUT_MS);
                if (now.code !== 0 || now.stdout.trim() === start) return;
                const diff = await git(root, ["diff", "--name-only", "-z", start, "HEAD"], STATUS_TIMEOUT_MS);
                if (diff.code !== 0 || diff.timedOut) return;
                const names = diff.stdout.split("\0").filter((name) => name.length > 0);
                if (names.length > MAX_CHANGED_PATHS) return;
                for (const name of names) files.push(path.join(root, name));
            } catch {
                // best effort, as for the status snapshot
            }
        }),
    );
    return files.sort();
}

/**
 * Absolute paths that are new in the status or whose fingerprint differs between the snapshots. A path gone from the
 * status was committed or reverted, which does not show it was this run (another session sharing the workspace may have
 * done it): the run's own commits are found by `committedSince`. Only repositories snapshotted both times are compared.
 */
export function changedBetween(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
    const changed: string[] = [];
    for (const [root, afterEntries] of after) {
        const beforeEntries = before.get(root);
        if (beforeEntries === undefined) continue;
        for (const [file, fingerprint] of afterEntries) {
            if (beforeEntries.get(file) !== fingerprint) changed.push(path.join(root, file));
        }
    }
    return changed.sort();
}

async function snapshotRepository(git: Git, root: string, maxPaths: number): Promise<RepositorySnapshot | undefined> {
    try {
        const status = await git(
            root,
            ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
            STATUS_TIMEOUT_MS,
        );
        if (status.code !== 0 || status.timedOut) return undefined;
        const files = parseStatus(status.stdout);
        if (files.length > maxPaths) return undefined;
        return await fingerprints(git, root, files);
    } catch {
        return undefined;
    }
}

/** The paths in `git status --porcelain=v1 -z`: "XY path" entries, a rename or copy followed by its origin path. */
export function parseStatus(output: string): string[] {
    const entries = output.split("\0");
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.length < 4) continue;
        files.push(entry.slice(3));
        if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
            const origin = entries[++i];
            if (origin) files.push(origin);
        }
    }
    return files;
}

async function fingerprints(git: Git, root: string, files: string[]): Promise<RepositorySnapshot> {
    const result: RepositorySnapshot = new Map();
    const regular: string[] = [];

    for (const file of files) {
        const kind = kindOf(path.join(root, file));
        if (kind === "directory") continue; // a nested repository or submodule: its own files are not this run's concern
        if (kind === "missing") result.set(file, DELETED);
        else if (kind === "file") regular.push(file);
        else if (kind === "link") result.set(file, `link:${linkTarget(path.join(root, file))}`);
        else result.set(file, "special"); // a fifo or socket: hashing it could block
    }

    for (let i = 0; i < regular.length; i += HASH_BATCH) {
        const batch = regular.slice(i, i + HASH_BATCH);
        const hashed = await git(root, ["hash-object", "--no-filters", "--", ...batch], HASH_TIMEOUT_MS);
        const hashes = hashed.stdout.split("\n").filter((line) => line.length > 0);
        if (hashed.code !== 0 || hashed.timedOut || hashes.length !== batch.length) throw new Error(`Cannot fingerprint files in ${root}.`);
        batch.forEach((file, index) => {
            result.set(file, hashes[index]!);
        });
    }

    return result;
}

function kindOf(file: string): "file" | "directory" | "link" | "special" | "missing" {
    try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) return "link";
        if (stat.isDirectory()) return "directory";
        return stat.isFile() ? "file" : "special";
    } catch {
        return "missing";
    }
}

function linkTarget(file: string): string {
    try {
        return readlinkSync(file);
    } catch {
        return "";
    }
}
