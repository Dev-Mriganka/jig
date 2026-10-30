// The repositories the sandbox watches: the one around the working folder, the working folder itself when it is one, and
// the repositories one and two levels below it. Their hooks are locked, their configuration is audited, and their top
// level is searched for secret files.
import path from "node:path";
import type { FileView } from "./files.ts";
import { parseGitConfig } from "./gitconfig.ts";
import { ancestors } from "./pathing.ts";

export interface Repo {
    /** The working tree: the folder that holds `.git`. */
    root: string;
    /** `.git` itself, or the folder a linked worktree's `.git` file points at. */
    gitDir: string;
    /** Where hooks and `config` live: the same as `gitDir`, or the main repository's for a linked worktree. */
    commonDir: string;
    /** The files whose settings can run a program: `config`, and a linked worktree's `config.worktree`. */
    configs: string[];
}

/** Names that are never searched for repositories below the working folder: big, and not where a project keeps code. */
const SKIP = new Set(["node_modules", ".git", "target", "build", "dist", ".gradle", ".venv", "venv", "__pycache__"]);
/** The most folders looked into at each level, so a working folder of a hundred thousand files costs little. */
const MAX_ENTRIES = 500;

/** The git directories of the checkout in `dir`, or undefined when `dir` is none. */
export function repoAt(files: FileView, dir: string): Repo | undefined {
    const dotGit = path.posix.join(dir, ".git");
    const type = files.type(dotGit);
    if (type === undefined) return undefined;
    let gitDir = dotGit;
    let commonDir = dotGit;
    if (type === "file") {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(files.read(dotGit) ?? "");
        if (pointer === null) return undefined;
        gitDir = commonDir = path.posix.resolve(dir, pointer[1] as string);
        const common = files.read(path.posix.join(gitDir, "commondir"))?.trim();
        if (common !== undefined && common !== "") commonDir = path.posix.resolve(gitDir, common);
    } else if (type !== "directory" && type !== "link") {
        return undefined;
    } else {
        const real = files.real(dotGit);
        if (real !== undefined) gitDir = commonDir = real;
    }
    const configs = [path.posix.join(commonDir, "config"), path.posix.join(gitDir, "config.worktree")];
    return { root: dir, gitDir, commonDir, configs };
}

/** The repositories to watch for a working folder, nearest first. */
export function findRepos(files: FileView, cwd: string, home: string): Repo[] {
    const found = new Map<string, Repo>();
    const add = (dir: string): void => {
        if (found.has(dir)) return;
        const repo = repoAt(files, dir);
        if (repo !== undefined) found.set(dir, repo);
    };
    // The repository around the working folder, up to the home folder: a command in `repo/src` writes `repo/.git`.
    for (const dir of ancestors(cwd)) {
        if (dir === "/" || dir === home) break;
        add(dir);
    }
    // One and two levels below.
    const below = (dir: string): string[] =>
        files
            .list(dir)
            .filter((name) => !SKIP.has(name))
            .slice(0, MAX_ENTRIES)
            .map((name) => path.posix.join(dir, name))
            .filter((child) => files.type(child) === "directory");
    for (const first of below(cwd)) {
        add(first);
        for (const second of below(first)) add(second);
    }
    return [...found.values()];
}

/** The folder `core.hooksPath` names in a repository's configuration, as an absolute path, or undefined. */
export function hooksPathOf(files: FileView, repo: Repo): string | undefined {
    let named: string | undefined;
    for (const config of repo.configs) {
        const text = files.read(config);
        if (text === undefined) continue;
        for (const entry of parseGitConfig(text)) {
            if (entry.section === "core" && entry.subsection === undefined && entry.key === "hookspath") {
                named = entry.value;
            }
        }
    }
    if (named === undefined || named === "") return undefined;
    // git reads a relative path from the working tree, and `~/` as the home folder; the latter is rare, so it stays unexpanded.
    return path.posix.isAbsolute(named) ? path.posix.resolve(named) : path.posix.resolve(repo.root, named);
}
