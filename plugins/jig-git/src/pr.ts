// The `pr` tool: pull requests and reviews on GitHub, through gh, and merge requests on GitLab, through glab. The repository's
// origin decides which, never the call. Reads are allowed. Every write asks the user first, and the text of a write is shown on
// the review screen before it is sent.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CallClass } from "../../jig-core/src/contract.ts";
import { describeActions } from "./params.ts";
import type { ActionTable } from "./params.ts";
import {
    planComment,
    planCreate,
    planEdit,
    planMerge,
    planReady,
    planReply,
    planResolve,
    planReview,
} from "./pr-write.ts";
import { planComments, planList, planView } from "./pr-read.ts";
import { homeOf, planGitlabPr } from "./gitlab-pr.ts";
import { planWatch } from "./pr-watch-tool.ts";
import type { Call, Planned } from "./previews.ts";
import { at, buildTool } from "./tool.ts";
import type { JigTool } from "./tool.ts";

export const PR_ACTIONS = {
    view: { summary: "state, review, checks and body", optional: ["repo", "number", "branch"] },
    list: {
        summary: "pull requests by state, author or branch",
        optional: ["repo", "state", "author", "branch", "limit"],
    },
    comments: {
        summary: "conversation, reviews and line comments, with thread ids",
        optional: ["repo", "number", "branch", "author", "unresolved"],
    },
    create: {
        summary: "open one from a pushed branch; returns the open one if there is one",
        required: ["title"],
        optional: ["repo", "body", "branch", "base", "draft"],
    },
    edit: {
        summary: "title, body, base, labels, reviewers",
        required: ["number"],
        optional: ["repo", "title", "body", "base", "labels", "reviewers"],
    },
    ready: { summary: "draft to ready for review", required: ["number"], optional: ["repo"] },
    comment: { summary: "a comment on the conversation", required: ["number", "body"], optional: ["repo"] },
    reply: { summary: "a reply in a review thread", required: ["thread", "body"], optional: ["repo"] },
    resolve: { summary: "resolve a review thread", required: ["thread"], optional: ["repo"] },
    review: {
        summary: "comment or request changes; never approves",
        required: ["number", "event", "body"],
        optional: ["repo"],
    },
    merge: {
        summary: "merge, squash or rebase at the head you saw; or auto-merge",
        required: ["number", "method"],
        optional: ["repo", "auto"],
    },
    watch: {
        summary: "tell me about new comments on a pull request, in the background",
        optional: ["repo", "number", "branch"],
    },
} satisfies ActionTable;

const ACTION_NAMES = Object.keys(PR_ACTIONS) as (keyof typeof PR_ACTIONS)[];

const PrParams = Type.Object(
    {
        action: StringEnum(ACTION_NAMES, { description: describeActions(PR_ACTIONS) }),
        repo: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 1000,
                description:
                    "A folder in the workspace, or an absolute path inside a work tree. Omit it for the repo Pi runs in.",
            }),
        ),
        number: Type.Optional(Type.Integer({ minimum: 1, description: "The pull request (merge request) number." })),
        branch: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description:
                    "The head branch: selects the pull request, or heads a new one. Default: the checked-out branch.",
            }),
        ),
        base: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "The base branch. Default: git.base, else the default branch.",
            }),
        ),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "One line." })),
        body: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 60_000,
                description: "Markdown. create: leave it out to be shown the template. edit: replaces the description.",
            }),
        ),
        draft: Type.Optional(Type.Boolean({ description: "create: open it as a draft." })),
        method: Type.Optional(StringEnum(["merge", "squash", "rebase"] as const, { description: "How to merge." })),
        auto: Type.Optional(Type.Boolean({ description: "merge: turn on auto-merge instead of merging now." })),
        event: Type.Optional(
            StringEnum(["comment", "request_changes"] as const, {
                description: "review: a comment, or a request for changes. Approving is not possible.",
            }),
        ),
        thread: Type.Optional(
            Type.String({ minLength: 8, maxLength: 200, description: "A review thread id, as pr comments lists it." }),
        ),
        author: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 100,
                description: "list: by this author, or @me. comments: only this person's.",
            }),
        ),
        unresolved: Type.Optional(Type.Boolean({ description: "comments: only threads that are not resolved." })),
        state: Type.Optional(
            StringEnum(["open", "closed", "merged", "all"] as const, {
                description: "list: which state. Default open.",
            }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "list: how many. Default 20." })),
        labels: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
                maxItems: 30,
                description: "edit: labels to add.",
            }),
        ),
        reviewers: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
                maxItems: 30,
                description: "edit: people or teams to request a review from. GitLab: usernames.",
            }),
        ),
    },
    { additionalProperties: false },
);

/** Reads are external reads. Every write is an external write; text that people read is shown on the review screen. */
function classifyPr(input: Readonly<Record<string, unknown>>): CallClass | undefined {
    const action = input.action;
    switch (action) {
        case "view":
        case "list":
        case "comments":
            return at(action, "external", "read");
        case "create":
        case "edit":
        case "comment":
        case "reply":
        case "review":
            return at(action, "external", "write", { approval: "review" });
        case "ready":
        case "resolve":
        case "merge":
            return at(action, "external", "write");
        // Starts a poll that only reads GitHub, as the ci tool's watch does: a local write, so it does not ask.
        case "watch":
            return at(action, "local", "write");
        default:
            return undefined;
    }
}

async function planPr(params: Readonly<Record<string, unknown>>, call: Call): Promise<Planned> {
    const home = await homeOf(params, call);
    return home.forge === "gitlab" ? planGitlabPr(params, call, home) : planGithubPr(params, call);
}

function planGithubPr(params: Readonly<Record<string, unknown>>, call: Call): Promise<Planned> | Planned {
    const p = params as never;
    switch (params.action) {
        case "view":
            return planView(p, call);
        case "list":
            return planList(p, call);
        case "comments":
            return planComments(p, call);
        case "create":
            return planCreate(p, call);
        case "edit":
            return planEdit(p, call);
        case "ready":
            return planReady(p, call);
        case "comment":
            return planComment(p, call);
        case "reply":
            return planReply(p, call);
        case "resolve":
            return planResolve(p, call);
        case "review":
            return planReview(p, call);
        case "merge":
            return planMerge(p, call);
        case "watch":
            return planWatch(p, call);
        default:
            throw new Error(`pr: unknown action ${String(params.action)}`);
    }
}

export const prTool: JigTool = buildTool({
    name: "pr",
    label: "Pull request",
    description:
        "Pull requests (GitHub, through gh) and merge requests (GitLab, through glab), by the repository's origin: view, list, comments; create, edit, ready, comment, reply, resolve, review, merge; watch for new comments. Every write asks the user first. It never approves.",
    promptSnippet: "Pull and merge requests: view, comments, watch, create, review, merge",
    promptGuidelines: [
        "Use the pr tool for pull requests and merge requests, not bash: the shell has no GitHub or GitLab sign-in. Push the branch with the git tool first.",
    ],
    parameters: PrParams,
    table: PR_ACTIONS,
    classify: classifyPr,
    plan: async (params, call) => planPr(params, call),
});
