// What the model reads: Jira's answers as compact plain text. One line per issue, comment or change, no tables, and long
// text cut with a note that says how to get the rest. Pure functions, no requests.
import type { Comment, SearchPage, Transition } from "./api.ts";
import { arr, day, describeValue, int, isObject, minute, nameOf, obj, oneLine, str, userOf } from "./values.ts";
import type { Obj, User } from "./values.ts";

export const DESCRIPTION_CAP = 4000;
export const COMMENT_CAP = 1500;
export const LATEST_COMMENTS = 5;

/** The text cut to `max` characters, with a note of what was left out and how to get all of it. */
export function cap(text: string, max: number, full: boolean): string {
    if (full || text.length <= max) return text;
    // A cut between the halves of an emoji would leave a broken character.
    const end = /[\ud800-\udbff]/.test(text.charAt(max - 1)) ? max - 1 : max;
    return `${text.slice(0, end)}\n[... ${text.length - end} more characters; call again with full=true for all of it]`;
}

const person = (value: unknown, missing: string): string =>
    isObject(value) ? userOf(value).displayName || missing : missing;

/** The fields `get` asks Jira for, besides any the call names. */
export const ISSUE_FIELDS = [
    "summary",
    "issuetype",
    "status",
    "priority",
    "resolution",
    "assignee",
    "reporter",
    "labels",
    "components",
    "fixVersions",
    "created",
    "updated",
    "description",
    "parent",
    "issuelinks",
    "subtasks",
    "comment",
];

function refLine(value: unknown): string {
    const issue = obj(value);
    const fields = obj(issue.fields);
    return `${str(issue.key)} (${nameOf(fields.status)}) ${oneLine(str(fields.summary), 100)}`;
}

function commentBlock(comment: Comment, max: number, full: boolean): string {
    const edited = comment.updated !== "" && comment.updated !== comment.created ? " (edited)" : "";
    const body = cap(comment.body, max, full)
        .split("\n")
        .map((line) => (line === "" ? "" : `  ${line}`))
        .join("\n");
    return `#${comment.id} ${comment.author.displayName || "unknown"}, ${day(comment.created)}${edited}\n${body}`;
}

export interface IssueView {
    comments: Comment[];
    commentTotal: number;
    full: boolean;
    /** Fields the call asked for, by the label to show and the value Jira holds. */
    extra: Array<{ label: string; value: unknown }>;
}

export function formatIssue(issue: Obj, view: IssueView): string {
    const f = obj(issue.fields);
    const resolution = nameOf(f.resolution);
    const lines = [
        [str(issue.key), nameOf(f.issuetype), nameOf(f.status), nameOf(f.priority) || "no priority"].join(" | ") +
            (resolution === "" ? "" : ` | resolved: ${resolution}`),
        str(f.summary),
        `Assignee: ${person(f.assignee, "unassigned")} | Reporter: ${person(f.reporter, "unknown")}`,
        `Created: ${day(f.created)} | Updated: ${day(f.updated)}`,
    ];
    const tags = [
        [
            "Labels",
            arr(f.labels)
                .map(str)
                .filter((label) => label !== ""),
        ],
        [
            "Components",
            arr(f.components)
                .map(nameOf)
                .filter((name) => name !== ""),
        ],
        [
            "Fix versions",
            arr(f.fixVersions)
                .map(nameOf)
                .filter((name) => name !== ""),
        ],
    ] as const;
    const present = tags
        .filter(([, names]) => names.length > 0)
        .map(([label, names]) => `${label}: ${names.join(", ")}`);
    if (present.length > 0) lines.push(present.join(" | "));
    if (isObject(f.parent)) lines.push(`Parent: ${refLine(f.parent)}`);

    const links = arr(f.issuelinks)
        .map(obj)
        .map((link) => {
            const type = obj(link.type);
            const outward = isObject(link.outwardIssue);
            const phrase = str(outward ? type.outward : type.inward) || str(type.name);
            return `- ${phrase} ${refLine(outward ? link.outwardIssue : link.inwardIssue)}`;
        });
    if (links.length > 0) lines.push("Links:", ...links);
    const subtasks = arr(f.subtasks).map(refLine);
    if (subtasks.length > 0) lines.push("Subtasks:", ...subtasks.map((line) => `- ${line}`));
    for (const { label, value } of view.extra) lines.push(`${label}: ${describeValue(value)}`);

    const description = str(f.description);
    lines.push("Description:", description === "" ? "(none)" : cap(description, DESCRIPTION_CAP, view.full));
    if (view.comments.length === 0) {
        lines.push("Comments: none");
    } else {
        const shown = view.comments.length;
        const count = shown < view.commentTotal ? `last ${shown} of ${view.commentTotal}` : String(shown);
        lines.push(
            `Comments (${count}):`,
            ...view.comments.map((comment) => commentBlock(comment, COMMENT_CAP, view.full)),
        );
    }
    return lines.join("\n");
}

export function formatSearch(
    page: SearchPage,
    jql: string,
    extra: ReadonlyArray<{ id: string; label: string }>,
): string {
    const rows = page.issues.flatMap((issue) => {
        const f = obj(issue.fields);
        const columns = [
            str(issue.key),
            nameOf(f.status),
            nameOf(f.issuetype),
            nameOf(f.priority),
            person(f.assignee, "unassigned"),
            day(f.updated),
            oneLine(str(f.summary), 120),
        ];
        return [columns.join(" | "), ...extra.map(({ id, label }) => `    ${label}: ${describeValue(f[id])}`)];
    });
    const where = oneLine(jql, 160);
    if (page.issues.length === 0) return `No issues for: ${where}`;
    const first = (page.start ?? 0) + 1;
    const last = (page.start ?? 0) + page.issues.length;
    const count = `${page.issues.length} ${page.issues.length === 1 ? "issue" : "issues"}`;
    const header =
        page.total === undefined
            ? `${count}${page.next === undefined ? "" : " (more follow)"} for: ${where}`
            : `${first}-${last} of ${page.total} for: ${where}`;
    const more = page.next === undefined ? [] : [`More: repeat with page=${JSON.stringify(page.next)}`];
    return [header, ...rows, ...more].join("\n");
}

export function formatComments(key: string, comments: Comment[], total: number, full: boolean): string {
    if (comments.length === 0) return `No comments on ${key}.`;
    const header =
        comments.length < total
            ? `${key}: newest ${comments.length} of ${total} comments, newest last`
            : `${key}: ${comments.length} comments, newest last`;
    return [header, ...comments.map((comment) => commentBlock(comment, COMMENT_CAP, full))].join("\n");
}

export const transitionLine = (transition: Transition): string =>
    `${transition.name} -> ${transition.to} [${transition.id}]`;

export function formatTransitions(key: string, transitions: Transition[]): string {
    if (transitions.length === 0) return `${key} has no transitions available to this account.`;
    const lines = transitions.map((transition) => `- ${transitionLine(transition)}`);
    return [`${key} transitions (name -> status [id]):`, ...lines].join("\n");
}

/** The change history of an issue, from the `changelog` Jira sends with it: oldest first, so the newest is last. */
export function formatChangelog(key: string, changelog: Obj, limit: number): string {
    const histories = arr(changelog.histories)
        .map(obj)
        .sort((a, b) => str(a.created).localeCompare(str(b.created)));
    if (histories.length === 0) return `${key}: no changes recorded.`;
    const shown = histories.slice(-limit);
    const value = (text: unknown): string => (str(text) === "" ? "(none)" : oneLine(str(text), 60));
    const lines = shown.map((history) => {
        const changes = arr(history.items)
            .map(obj)
            .map((item) => `${str(item.field)} ${value(item.fromString)} -> ${value(item.toString)}`);
        return `${minute(history.created)} ${userOf(history.author).displayName || "unknown"}: ${changes.join("; ")}`;
    });
    const total = Math.max(int(changelog.total), histories.length);
    const header =
        shown.length < total
            ? `${key} history (newest ${shown.length} of ${total} changes, newest last):`
            : `${key} history (${shown.length} changes, newest last):`;
    // Jira sends part of a long history with the issue; the rest is not read.
    const partial = histories.length < total ? [`(Jira sent ${histories.length} of the ${total} changes)`] : [];
    return [header, ...lines, ...partial].join("\n");
}

function sizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAttachments(key: string, attachments: unknown[]): string {
    if (attachments.length === 0) return `${key} has no attachments.`;
    const rows = attachments
        .map(obj)
        .map((file) =>
            [
                str(file.id),
                str(file.filename),
                sizeText(int(file.size)),
                str(file.mimeType),
                day(file.created),
                userOf(file.author).displayName,
            ].join(" | "),
        );
    return [`${key} attachments (id | name | size | type | date | author; files are not downloaded):`, ...rows].join(
        "\n",
    );
}

export function formatUsers(key: string, users: User[], id: (user: User) => string): string {
    if (users.length === 0) return `No assignable users match for ${key}.`;
    const rows = users.map((user) => `${id(user)} | ${user.displayName}${user.active ? "" : " | inactive"}`);
    return [`Assignable users for ${key} (id | name):`, ...rows].join("\n");
}

export function formatFields(
    query: string,
    fields: ReadonlyArray<{ id: string; name: string; custom: boolean }>,
    aliases: ReadonlyArray<[string, string]>,
): string {
    const found = fields.map((field) => `${field.id}  ${field.name}${field.custom ? " (custom)" : ""}`);
    const named = aliases.map(([name, id]) => `${name} -> ${id} (a name set in the jira section)`);
    if (found.length === 0 && named.length === 0) {
        return `No field name or id contains "${query}". Try a shorter part of the name.`;
    }
    return [`Fields matching "${query}" (id  name):`, ...found, ...named].join("\n");
}
