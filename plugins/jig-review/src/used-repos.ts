// Which repositories one agent run used. Several Pi sessions can share a workspace, so a repository that changed while
// this run was going is not necessarily this run's doing: only repositories the run's own tool calls point at are
// compared with git. The test is deliberately simple and conservative: a repository that no call visibly touches is left
// out, which at worst costs an offer, and never reviews another session's files.
import os from "node:os";
import path from "node:path";
import type { Repository } from "./workspace.ts";

/** `cd dir` or `git -C dir` at the start of a command or after `;`, `&&`, `||`, `|`, `(` or a newline. */
const DIRECTORY_ARGUMENT = /(?:^|[;&|(\n])\s*(?:cd|git\s+-C)\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;

/** Whether `dir` is `root` or inside it. */
function isInside(root: string, dir: string): boolean {
    const relative = path.relative(root, dir);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A path as the tool resolves it: absolute, or relative to Pi's folder, with a leading `~` as the home folder. */
function resolveFrom(cwd: string, value: string): string {
    const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
    return path.resolve(cwd, expanded);
}

function rootsContaining(repos: Repository[], dir: string): string[] {
    return repos.filter((repo) => isInside(repo.root, dir)).map((repo) => repo.root);
}

/** The repositories a bash command visibly works in: by absolute path, by `cd`, or by Pi's folder when it does not cd. */
function bashRepositories(command: string, repos: Repository[], cwd: string): string[] {
    const roots = new Set<string>();

    // A path that starts with the repository's root and ends there or at a separator: `/ws/api` is not `/ws/api-v2`.
    for (const repo of repos) {
        let from = command.indexOf(repo.root);
        while (from !== -1) {
            const previous = command[from - 1];
            const next = command[from + repo.root.length];
            if ((previous === undefined || !/[A-Za-z0-9._~/-]/.test(previous)) && (next === undefined || !/[A-Za-z0-9._~-]/.test(next))) {
                roots.add(repo.root);
                break;
            }
            from = command.indexOf(repo.root, from + 1);
        }
    }

    let changesDirectory = false;
    for (const match of command.matchAll(DIRECTORY_ARGUMENT)) {
        changesDirectory = true;
        const dir = match[1]!.replace(/^["']|["']$/g, "");
        for (const root of rootsContaining(repos, resolveFrom(cwd, dir))) roots.add(root);
    }

    if (!changesDirectory) {
        for (const root of rootsContaining(repos, cwd)) roots.add(root);
    }

    return [...roots];
}

/**
 * The roots of the repositories (from `repos`, the ones found when the run started) that one tool call used: `edit`
 * and `write` by their path, Jig's `git` tool by its `repo` parameter (a name under Pi's folder, or an absolute path),
 * `bash` by what its command text says. Other tools use none.
 */
export function repositoriesUsedBy(toolName: string, input: unknown, repos: Repository[], cwd: string): string[] {
    const params = (input ?? {}) as { path?: unknown; repo?: unknown; command?: unknown };

    if ((toolName === "edit" || toolName === "write") && typeof params.path === "string" && params.path !== "") {
        return rootsContaining(repos, resolveFrom(cwd, params.path));
    }
    if (toolName === "git" && typeof params.repo === "string" && params.repo !== "") {
        return rootsContaining(repos, resolveFrom(cwd, params.repo));
    }
    if (toolName === "bash" && typeof params.command === "string") {
        return bashRepositories(params.command, repos, cwd);
    }
    return [];
}
