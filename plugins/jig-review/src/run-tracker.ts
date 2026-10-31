// What the agent changed during a run, for the offer to review it: the files its write and edit tools touched, the files that differ in
// git from the start of the run (a change made through bash is not a tool event), and the repositories the run used. Kept apart from the
// coordinator, which decides what to do with the answer.
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isReviewableWrite } from "./code-path.ts";
import type { Git } from "./git.ts";
import { changedBetween, committedSince, snapshotHeads, snapshotWorkspace } from "./run-changes.ts";
import type { WorkspaceSnapshot } from "./run-changes.ts";
import { repositoriesUsedBy } from "./used-repos.ts";
import { findRepositories } from "./workspace.ts";
import type { Repository } from "./workspace.ts";

/** A subagent child (the parent sets PI_SUBAGENT_ID; PI_SUBAGENT_CHILD=1 is the older name) or a one-shot `pi -p` / `--mode json` run. */
export function isHeadless(ctx: Pick<ExtensionContext, "mode">): boolean {
    const { PI_SUBAGENT_CHILD, PI_SUBAGENT_ID } = process.env;
    return Boolean(PI_SUBAGENT_ID?.trim()) || PI_SUBAGENT_CHILD === "1" || ctx.mode === "print" || ctx.mode === "json";
}

function normalizeTouchedPath(value: string, cwd: string): string {
    const absolutePath = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    const relativePath = path.relative(cwd, absolutePath);
    return relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : relativePath;
}

export class RunTracker {
    private changedSinceLastOffer = false;
    private currentTouchedFiles = new Set<string>();
    private lastTouchedFiles: string[] = [];
    /** Each repository's HEAD when the last agent run started: the touched review starts there, so the run's commits show. */
    private lastRunSince?: Record<string, string>;
    /** The repositories found when the current agent run started and those its tool calls used; undefined outside a run. */
    private runRepositories?: { found: Repository[]; used: Set<string> };
    /** Git state of the repositories when the current agent run started (still being taken); undefined outside a run. */
    private runStart?: Promise<{ changes?: WorkspaceSnapshot; heads: Record<string, string> } | undefined>;
    private readonly cwd: string;
    private readonly git: Git;

    constructor(cwd: string, git: Git) {
        this.cwd = cwd;
        this.git = git;
    }

    /** True when the agent changed reviewable files since the review was last offered. */
    get changed(): boolean {
        return this.changedSinceLastOffer;
    }

    /** The offer was made (or turned down): what changed is no longer news. */
    clearChanged(): void {
        this.changedSinceLastOffer = false;
    }

    /** The files the last finished run touched. */
    get touched(): string[] {
        return this.lastTouchedFiles;
    }

    /** Each repository's HEAD when the last run started. */
    get since(): Record<string, string> | undefined {
        return this.lastRunSince;
    }

    /**
     * Resolves when the git state taken at the start of the current run is done. Pi does not wait for it, since the model
     * starts at once and the agent's first change comes much later; a test that changes a file at once must.
     */
    async startTaken(): Promise<void> {
        await this.runStart;
    }

    private isCodeWrite(value: unknown): boolean {
        if (typeof value !== "string" || value.length === 0) return false;
        return isReviewableWrite(path.isAbsolute(value) ? value : path.resolve(this.cwd, value));
    }

    private recordTouchedFile(value: unknown): void {
        if (typeof value !== "string" || value.length === 0) return;
        this.currentTouchedFiles.add(normalizeTouchedPath(value, this.cwd));
    }

    /** A tool is about to run: a write or an edit of a reviewable file counts as a change, and any tool may use a repository. */
    toolCall(toolName: string, input: Record<string, unknown>): void {
        if ((toolName === "write" || toolName === "edit") && this.isCodeWrite(input.path)) {
            this.changedSinceLastOffer = true;
            this.recordTouchedFile(input.path);
        }
        const run = this.runRepositories;
        if (run === undefined) return;
        for (const root of repositoriesUsedBy(toolName, input, run.found, this.cwd)) run.used.add(root);
    }

    /**
     * Remembers what each repository looks like before the agent runs, so files changed through bash (not only the edit
     * and write tools) are found afterwards. Best effort: a failure leaves the run without the git comparison.
     */
    startRun(ctx: Pick<ExtensionContext, "mode">): void {
        this.runRepositories = undefined;
        this.runStart = undefined;
        if (isHeadless(ctx)) return;

        // Which repositories the run will use is not known yet, so every one is snapshotted; agent_end compares only the used
        // ones. A failure leaves the run without the git comparison; the tool events still record what was edited.
        let found: Repository[];
        try {
            found = findRepositories(this.cwd);
        } catch {
            return;
        }
        this.runRepositories = { found, used: new Set() };
        this.runStart = Promise.all([
            snapshotWorkspace(this.cwd, () => found, undefined, this.git).catch(() => undefined),
            snapshotHeads(this.cwd, () => found, this.git).catch(() => ({})),
        ]).then(([changes, heads]) => ({ changes, heads }));
    }

    /** The run ended: adds the files git shows changed, and keeps the run's touched files for the offer. */
    async finishRun(ctx: Pick<ExtensionContext, "mode">): Promise<void> {
        await this.recordGitChanges(ctx);
        this.lastTouchedFiles = [...this.currentTouchedFiles];
        this.currentTouchedFiles.clear();
    }

    /**
     * Adds the reviewable files that differ from the start of the run, whichever tool changed them, in the repositories the
     * run used. Another Pi session may share the workspace and change its own repositories meanwhile.
     */
    private async recordGitChanges(ctx: Pick<ExtensionContext, "mode">): Promise<void> {
        const start = await this.runStart;
        const used = this.runRepositories?.found.filter((repo) => this.runRepositories?.used.has(repo.root)) ?? [];
        this.runStart = undefined;
        this.runRepositories = undefined;
        this.lastRunSince = start?.heads;
        const before = start?.changes;
        if (before === undefined || used.length === 0 || isHeadless(ctx)) return;

        try {
            const after = await snapshotWorkspace(this.cwd, () => used, undefined, this.git);
            const usedHeads = Object.fromEntries(
                Object.entries(start?.heads ?? {}).filter(([root]) => used.some((repo) => repo.root === root)),
            );
            const committed = await committedSince(usedHeads, this.git);
            for (const file of new Set([...changedBetween(before, after), ...committed])) {
                if (this.isCodeWrite(file)) {
                    this.changedSinceLastOffer = true;
                    this.recordTouchedFile(file);
                }
            }
        } catch {
            // Best effort, as at the start of the run.
        }
    }
}
