// Ties the review together: Pi's events, the review records, the local server, and what goes to the agent. A review is
// opened by `/code-review`, by the agent's start tool, or by an offer after the agent changed files. The user comments in
// the page; the comments reach the agent as a message; the agent answers with the resolution tool; the next round shows
// what changed. Approving ends it (see approval.ts for how an approval is checked).
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ApprovalService } from "./approval.ts";
import type { ApprovalHost } from "./approval.ts";
import { headsToRecord } from "./approval-heads.ts";
import { parseCodeReviewCommand, resolveSelectionFiles } from "./command.ts";
import { filesOfDiff } from "./diff.ts";
import { REVIEW_EVENTS } from "./events.ts";
import type { ReviewApprovedEvent } from "./events.ts";
import { jigGit } from "./git.ts";
import type { Git, ReviewFileSelection } from "./git.ts";
import { openUrl as open } from "./open.ts";
import { PasskeyStore } from "./passkey/store.ts";
import { buildApprovalPrompt, buildReviewSubmissionPrompt } from "./prompts.ts";
import { ReviewServer } from "./server.ts";
import type { CommentSubmissionMode, SubmittedCommentInput } from "./server.ts";
import { SettingsStore, workspaceDirFor } from "./settings.ts";
import { formatSettingsOptions, passkeyToRemove, toggleSelectedSetting } from "./settings-options.ts";
import { hashDiff, ReviewStore } from "./store.ts";
import { activeTicket } from "./ticket.ts";
import { isHeadless, RunTracker } from "./run-tracker.ts";
import { registerReviewTools } from "./tools.ts";
import type { ApprovalMethod, ReviewRecord, ReviewSettings } from "./types.ts";
import { WorkspaceReviewSource } from "./workspace.ts";

/** What starting a review gave: its page, or the one-line reason it could not open. */
export type ReviewStart = { url: string } | { error: string };

/** How long a question in Pi waits for the user before it counts as a no. */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReviewOptions {
    /** `<agent folder>/jig-review`: the passkey store, and a folder per workspace for settings and reviews. */
    root: string;
    /** Runs git. Default: jig-core's. */
    git?: Git;
}

/** Coordinates Pi events, review state, the page's server and the agent's follow-up prompts. */
export class ReviewCoordinator {
    private currentReview?: ReviewRecord;
    /** The review the agent opened with start_interactive_code_review: the only one it is waiting on. */
    private agentRequestedReviewId?: string;
    private lastSubmissionMode: CommentSubmissionMode = "review";
    private server?: ReviewServer;
    private settings?: ReviewSettings;
    /** The latest context Pi gave: the page's approvals ask the user through it. */
    private ctx?: ExtensionContext;
    /** The question in Pi that is waiting for the user, so a shutdown can dismiss it. */
    private asking?: AbortController;
    private readonly settingsStore: SettingsStore;
    private readonly reviewStore: ReviewStore;
    private readonly workspace: WorkspaceReviewSource;
    private readonly approval: ApprovalService;
    private readonly passkeys: PasskeyStore;
    private readonly git: Git;
    private readonly tracker: RunTracker;
    private readonly pi: ExtensionAPI;

    /** `cwd` is Pi's folder: the repository, or a workspace whose repositories are reviewed together. */
    public constructor(pi: ExtensionAPI, cwd: string, options: ReviewOptions) {
        this.pi = pi;
        this.git = options.git ?? jigGit;
        this.tracker = new RunTracker(cwd, this.git);
        this.settingsStore = new SettingsStore(workspaceDirFor(options.root, cwd));
        this.reviewStore = new ReviewStore(this.settingsStore);
        this.workspace = new WorkspaceReviewSource(cwd, this.git);
        this.passkeys = new PasskeyStore(path.join(options.root, "passkeys.json"));
        this.approval = new ApprovalService(this.approvalHost(), this.passkeys, () => this.server?.origins() ?? []);
    }

    /**
     * Resolves when the git state taken at the start of the current run is done. Pi does not wait for it, since the model
     * starts at once and the agent's first change comes much later; a test that changes a file at once must.
     */
    public async runStartTaken(): Promise<void> {
        await this.tracker.startTaken();
    }

    /** Registers event handlers, the command and the tools. Touches no files: see session_start. */
    public register(): void {
        this.pi.on("session_start", async (_event, ctx): Promise<void> => {
            this.ctx = ctx;
            await this.cleanupStaleReviews(ctx);
        });

        this.pi.on("tool_call", (event, ctx): void => {
            this.ctx = ctx;
            this.tracker.toolCall(event.toolName, event.input);
        });

        // Not awaited: the model starts at once, and the snapshot (a git status per repository) is done long before the agent's
        // first tool call can change a file. agent_end waits for it.
        this.pi.on("agent_start", (_event, ctx): void => {
            this.ctx = ctx;
            this.tracker.startRun(ctx);
        });

        this.pi.on("agent_end", async (_event, ctx): Promise<void> => {
            this.ctx = ctx;
            await this.handleAgentEnd(ctx);
        });

        this.pi.on("session_shutdown", (): void => {
            this.asking?.abort();
            this.server?.stop();
            this.ctx = undefined;
        });

        this.pi.registerCommand("code-review", {
            description: "Start, reopen, or configure the interactive browser code review",
            handler: async (args, ctx): Promise<void> => {
                this.ctx = ctx;
                await ctx.waitForIdle();
                await this.handleCodeReviewCommand(args, ctx);
            },
        });

        registerReviewTools(this.pi, {
            getCurrentReview: (): ReviewRecord | undefined => this.currentReview,
            recordResolution: async (resolution): Promise<ReviewRecord> => this.recordResolution(resolution),
            // Started here, not by sending "/code-review" as a message: Pi delivers a message's text to the model and never
            // runs it as a command, so that only ever reached the agent as words.
            startReview: (ctx) => this.startReviewForAgent(ctx),
        });
    }

    // ---- approval ---------------------------------------------------------------------------------------------------

    private approvalHost(): ApprovalHost {
        return {
            current: () => this.currentReview,
            ask: (title, message) => this.ask(title, message),
            pageApproved: async (review) => {
                this.currentReview = await this.reviewStore.markPageApproved(review);
            },
            pageDeclined: async (review) => {
                this.currentReview = await this.reviewStore.clearPageApproval(review);
            },
            approved: (review, method, fingerprint) => this.finishApproval(review, method, fingerprint),
            changed: () => this.server?.publish("review-updated"),
        };
    }

    /** A yes or no from the user, in Pi. */
    private async ask(title: string, message: string): Promise<"yes" | "no" | "unavailable"> {
        const ctx = this.ctx;
        if (ctx === undefined || !ctx.hasUI || isHeadless(ctx)) return "unavailable";
        this.asking = new AbortController();
        try {
            return (await ctx.ui.confirm(title, message, { timeout: ASK_TIMEOUT_MS, signal: this.asking.signal }))
                ? "yes"
                : "no";
        } catch {
            // The session ended or was replaced while the question was open.
            return "unavailable";
        } finally {
            this.asking = undefined;
        }
    }

    /** Records an approval that was already checked, announces it, and tells the agent when it was waiting. */
    private async finishApproval(review: ReviewRecord, method: ApprovalMethod, fingerprint?: string): Promise<void> {
        const approvedHeads = await headsToRecord(this.workspace, review);
        const approval = { method, ...(fingerprint === undefined ? {} : { fingerprint }) };
        this.currentReview = await this.reviewStore.approve(review, approval, approvedHeads);
        const approved = this.currentReview;

        const files = filesOfDiff(approved.iterations.at(-1)?.diff ?? "");
        // When the approval vouches for commits, those are the target's repositories. Otherwise only where each repository
        // the diff touched stood, so a clean repository next to it is not named as reviewed.
        const repos =
            approvedHeads ??
            (
                await this.workspace.getHeads({ folder: approved.folder, ticket: approved.ticket }).catch(() => [])
            ).filter((head) => head.repo === "" || files.some((file) => file.startsWith(`${head.repo}/`)));
        const roots = this.rootsOf({ folder: approved.folder, ticket: approved.ticket });
        const event: ReviewApprovedEvent = {
            reviewId: approved.id,
            scope: approved.fileScope,
            ...(approved.ticket ? { ticket: approved.ticket } : {}),
            repos: repos.map((head) => ({
                repo: head.repo,
                head: head.sha,
                ...(roots.has(head.repo) ? { root: roots.get(head.repo) as string } : {}),
            })),
            covered: approvedHeads !== undefined && approvedHeads.length > 0,
            files,
            method,
        };
        try {
            this.pi.events.emit(REVIEW_EVENTS.approved, event);
        } catch {
            // A listener's failure is its own: the approval stands.
        }

        // Tell the agent only when it asked for this review and is waiting on it (a push, the next stage). A review from the
        // after-turn offer or the user's /code-review waits for nobody: a message would restart whatever the agent was doing.
        if (approved.id === this.agentRequestedReviewId) {
            this.pi.sendUserMessage(buildApprovalPrompt(approved, approvedHeads, approval), { deliverAs: "followUp" });
        }
        this.server?.publish("review-updated");
    }

    /** The folders of the repositories a target covers; none when they cannot be worked out (the event then has no `root`). */
    private rootsOf(target: { folder?: string; ticket?: string }): Map<string, string> {
        try {
            return this.workspace.rootsOf(target);
        } catch {
            return new Map();
        }
    }

    // ---- events -----------------------------------------------------------------------------------------------------

    /**
     * Tidies reviews that sessions left behind. Only an interactive session does it: a subagent child or `pi -p` runs in
     * the same folder as the session that started it, whose open review it must leave alone.
     */
    private async cleanupStaleReviews(ctx: Pick<ExtensionContext, "mode">): Promise<void> {
        if (isHeadless(ctx)) return;
        try {
            await this.reviewStore.cleanupInactiveReviews(this.currentReview?.id);
        } catch {
            // Housekeeping only: a failure must not stop the session from starting.
        }
    }

    private async handleCodeReviewCommand(args: string, ctx: ExtensionContext): Promise<ReviewStart | undefined> {
        const command = parseCodeReviewCommand(args);
        if (command.subcommand === "settings") {
            await this.configure(ctx);
            return undefined;
        }
        // A bare /code-review in a session with an active ticket reviews that ticket's branches (what its pull requests hold).
        const ticket = args.trim() === "" ? activeTicket(ctx) : undefined;
        return this.startOrOpenReview(ctx, true, ticket ? { scope: "branch", ticket } : command.selection);
    }

    private async startReviewForAgent(ctx: ExtensionContext): Promise<ReviewStart | undefined> {
        this.ctx = ctx;
        const started = await this.handleCodeReviewCommand("", ctx);
        if (started !== undefined && "url" in started) this.agentRequestedReviewId = this.currentReview?.id;
        return started;
    }

    private async recordResolution(resolution: Parameters<ReviewStore["addResolution"]>[1]): Promise<ReviewRecord> {
        if (this.currentReview === undefined) throw new Error("No active interactive review is open.");
        this.currentReview = await this.reviewStore.addResolution(this.currentReview, resolution);
        this.server?.publish("review-updated");
        return this.currentReview;
    }

    private async handleAgentEnd(ctx: ExtensionContext): Promise<void> {
        await this.tracker.finishRun(ctx);

        if (this.currentReview?.status === "awaiting-agent") {
            await this.refreshReviewAfterAgent(ctx);
            return;
        }

        const settings = await this.getSettings();
        if (!this.tracker.changed || this.currentReview?.status === "awaiting-review") return;
        this.tracker.clearChanged();

        // The offer covers what the agent just changed, not the whole branch: after a two-file edit the user wants those two
        // files. The branch review before a push is `/code-review` (with a ticket, its whole branch).
        const offer: ReviewFileSelection = { scope: "touched" };

        if (settings.autoAskReview) {
            await this.startOrOpenReview(ctx, settings.autoOpenBrowser, offer);
            return;
        }
        if (!ctx.hasUI) {
            ctx.ui.notify("The agent changed files. Run /code-review to review them.", "info");
            return;
        }
        const count = this.tracker.touched.length === 1 ? "1 file" : `${this.tracker.touched.length} files`;
        const shouldReview = await ctx.ui.confirm(
            "Review generated code?",
            `The agent changed ${count}. Start an interactive browser review of those changes?`,
        );
        if (shouldReview) await this.startOrOpenReview(ctx, settings.autoOpenBrowser, offer);
    }

    private async startOrOpenReview(
        ctx: ExtensionContext,
        shouldOpenBrowser: boolean,
        selection: ReviewFileSelection,
    ): Promise<ReviewStart> {
        try {
            const resolvedSelection = resolveSelectionFiles(selection, this.tracker.touched, this.tracker.since);
            await this.workspace.requireGitRepo(resolvedSelection);
            await this.reviewStore.cleanupInactiveReviews(this.currentReview?.id);
            const review = await this.getReviewToOpen(resolvedSelection);
            const url = await this.ensureServer(review);

            if (shouldOpenBrowser) await open(url);
            else await this.offerBrowserOpen(ctx, url);

            ctx.ui.notify(`Interactive review ready: ${url}`, "info");
            return { url };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to start interactive review";
            ctx.ui.notify(message, "error");
            return { error: message };
        }
    }

    private async offerBrowserOpen(ctx: ExtensionContext, url: string): Promise<void> {
        ctx.ui.notify(`Interactive review URL: ${url}`, "info");
        if (!ctx.hasUI) return;
        const shouldOpen = await ctx.ui.confirm(
            "Open review in browser?",
            `Press Enter to open the review page, or cancel and open it manually: ${url}`,
        );
        if (shouldOpen) await open(url);
    }

    private async getReviewToOpen(selection: ReviewFileSelection): Promise<ReviewRecord> {
        if (
            this.currentReview === undefined ||
            this.currentReview.status === "approved" ||
            this.currentReview.status === "abandoned"
        ) {
            return this.createReview(selection);
        }
        if (this.currentReview.status === "awaiting-agent") return this.currentReview;

        const sameTarget =
            this.currentReview.fileScope === selection.scope &&
            (this.currentReview.folder ?? "") === (selection.folder ?? "") &&
            (this.currentReview.ticket ?? "") === (selection.ticket ?? "");
        if (!sameTarget) return this.replaceCurrentReview(selection);
        return (await this.isCurrentReviewStillFresh(this.currentReview, selection))
            ? this.currentReview
            : this.replaceCurrentReview(selection);
    }

    private async replaceCurrentReview(selection: ReviewFileSelection): Promise<ReviewRecord> {
        if (this.currentReview !== undefined)
            this.currentReview = await this.reviewStore.abandonOrDelete(this.currentReview);
        return this.createReview(selection);
    }

    private async isCurrentReviewStillFresh(review: ReviewRecord, selection: ReviewFileSelection): Promise<boolean> {
        const currentDiff = await this.workspace.getDiff(selection);
        return review.iterations.at(-1)?.diffHash === hashDiff(currentDiff);
    }

    private async createReview(selection: ReviewFileSelection): Promise<ReviewRecord> {
        const changedFiles = await this.workspace.getChangedFiles(selection);
        if (changedFiles.length === 0) throw new Error("No git changes found to review.");

        // The page prints the first 12 characters after "HEAD": give it a short label for multi-repository reviews and keep
        // every repository's commit for the agent's prompt.
        const heads = await this.workspace.getHeadSha(selection);
        const multi = heads.includes("@");
        const headSha = multi ? (selection.ticket ?? selection.folder ?? "workspace") : heads;
        const target = { folder: selection.folder, ticket: selection.ticket };
        const diff = await this.workspace.getDiff({
            files: changedFiles,
            scope: selection.scope,
            ...target,
            ...(selection.since ? { since: selection.since } : {}),
        });

        // Files can change and change back (or a review can find nothing left to show): never open an empty review.
        if (diff.trim() === "") throw new Error("No git changes found to review.");

        // A new review is nobody's request until the agent's start tool says so (ids are per second, so not a safe key).
        this.agentRequestedReviewId = undefined;
        this.currentReview = await this.reviewStore.create(headSha, diff, selection.scope, {
            ...target,
            ...(multi ? { heads } : {}),
        });
        return this.currentReview;
    }

    private async ensureServer(review: ReviewRecord): Promise<string> {
        this.server ??= new ReviewServer({
            getReview: (): ReviewRecord | undefined => this.currentReview,
            getReviewById: async (id): Promise<ReviewRecord | undefined> => {
                try {
                    return await this.reviewStore.load(id);
                } catch {
                    return undefined;
                }
            },
            getReviews: (): Promise<ReviewRecord[]> => this.reviewStore.listAll(),
            getSettings: (): Promise<ReviewSettings> => this.getSettings(),
            submitComments: (comments, mode): Promise<void> => this.submitComments(comments, mode),
            updateSettings: (settings): Promise<void> => this.updateSettings(settings),
            approval: this.approval,
        });
        const baseUrl = await this.server.start();
        this.currentReview = review;
        return this.server.authorize(`${baseUrl}/review/${review.id}/files`);
    }

    private async submitComments(comments: SubmittedCommentInput[], mode: CommentSubmissionMode): Promise<void> {
        if (this.currentReview === undefined || comments.length === 0) return;
        this.lastSubmissionMode = mode;
        this.currentReview = await this.reviewStore.addSubmittedComments(this.currentReview, comments);
        const submittedIds = new Set(this.currentReview.iterations.at(-1)?.submittedCommentIds ?? []);
        const submitted = this.currentReview.comments.filter((comment) => submittedIds.has(comment.id));
        this.pi.sendUserMessage(buildReviewSubmissionPrompt(this.currentReview, submitted), { deliverAs: "followUp" });
    }

    private async updateSettings(settings: Partial<ReviewSettings>): Promise<void> {
        this.settings = { ...(await this.getSettings()), ...settings };
        await this.settingsStore.save(this.settings);
    }

    private async refreshReviewAfterAgent(ctx: ExtensionContext): Promise<void> {
        if (this.currentReview === undefined) return;
        const { fileScope: scope, folder, ticket } = this.currentReview;
        const diff = await this.workspace.getDiff({ scope, folder, ticket });
        this.currentReview = await this.reviewStore.addIteration(this.currentReview, diff);
        this.server?.publish("review-updated");

        const settings = await this.getSettings();
        if (this.lastSubmissionMode === "ask") {
            this.lastSubmissionMode = "review";
            return;
        }
        if (ctx.hasUI) {
            const shouldReview = await ctx.ui.confirm(
                "Review updated changes?",
                "The agent addressed review feedback. Reopen the browser review?",
            );
            if (shouldReview) await this.startOrOpenReview(ctx, settings.autoOpenBrowser, { scope, folder, ticket });
        } else if (settings.autoOpenBrowser) {
            await this.startOrOpenReview(ctx, true, { scope, folder, ticket });
        }
    }

    /** `/code-review settings`: toggle a setting, or remove a registered passkey. */
    private async configure(ctx: ExtensionContext): Promise<void> {
        const settings = await this.getSettings();
        const { passkeys, problems, problem } = this.approval.passkeys();
        for (const line of [...problems, ...(problem ? [problem] : [])]) ctx.ui.notify(line, "warning");
        const choice = await ctx.ui.select(
            "Interactive code review setting",
            formatSettingsOptions(settings, passkeys),
        );
        if (choice === undefined) return;

        const key = passkeyToRemove(choice, passkeys);
        if (key !== undefined) {
            const result = await this.approval.removePasskey(key.fingerprint);
            ctx.ui.notify(result.ok ? "Passkey removed." : result.message, result.ok ? "info" : "warning");
            return;
        }
        toggleSelectedSetting(settings, choice);
        await this.settingsStore.save(settings);
        this.settings = settings;
        ctx.ui.notify("Interactive code review settings saved.", "info");
    }

    private async getSettings(): Promise<ReviewSettings> {
        this.settings ??= await this.settingsStore.load();
        return this.settings;
    }
}
