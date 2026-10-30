// `/code-review` arguments: settings, or a scope, a folder, or a ticket.
import type { ReviewFileSelection } from "./git.ts";
import { isTicketKey } from "./ticket.ts";
import type { ReviewFileScope } from "./types.ts";

export type CodeReviewCommand = { selection: ReviewFileSelection; subcommand: "review" } | { subcommand: "settings" };

const SCOPE_FLAGS = ["--staged", "--unstaged", "--touched", "--branch"];

/**
 * A word that is not a flag is a ticket key (`/code-review PROJ-123`: its bound repositories, the whole branch unless a
 * scope is given) or a folder (`/code-review worktrees/PROJ-123`).
 */
export function parseCodeReviewCommand(args: string): CodeReviewCommand {
    const parts = args
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0);
    if (parts[0] === "settings") return { subcommand: "settings" };

    const target = parts.find((part) => !part.startsWith("--"));
    const scoped = parts.some((part) => SCOPE_FLAGS.includes(part));
    if (target !== undefined && isTicketKey(target)) {
        return {
            selection: { scope: scoped ? requestedScope(parts) : "branch", ticket: target.toUpperCase() },
            subcommand: "review",
        };
    }
    const scope = requestedScope(parts);
    return { selection: target ? { scope, folder: target } : { scope }, subcommand: "review" };
}

/**
 * Attaches the files the agent touched to a touched-scope selection.
 *
 * @param touchedFiles Files edited by the agent in its last request.
 * @param since Each repository's HEAD when that request started, so its commits are in the review too.
 */
export function resolveSelectionFiles(
    selection: ReviewFileSelection,
    touchedFiles: string[],
    since?: Record<string, string>,
): ReviewFileSelection {
    if (selection.scope !== "touched") return selection;
    return { ...selection, files: touchedFiles, scope: "touched", ...(since ? { since } : {}) };
}

function requestedScope(parts: string[]): ReviewFileScope {
    if (parts.includes("--staged")) return "staged";
    if (parts.includes("--unstaged")) return "unstaged";
    if (parts.includes("--touched")) return "touched";
    if (parts.includes("--branch")) return "branch";
    return "all";
}
