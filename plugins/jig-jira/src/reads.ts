// The eight read actions. Each is a request or two, shaped into compact text by format.ts.
import {
    assignableUsers,
    commentOf,
    commentPage,
    fieldList,
    getIssue,
    linkTypes,
    newestComments,
    search,
    transitionsOf,
} from "./api.ts";
import type { Env, FieldInfo } from "./api.ts";
import { didYouMean, missingField } from "./field-hint.ts";
import { knownFieldId } from "./fields.ts";
import {
    formatAttachments,
    formatChangelog,
    formatComments,
    formatFields,
    formatIssue,
    formatLinkTypes,
    formatSearch,
    formatTransitions,
    formatUsers,
    ISSUE_FIELDS,
    LATEST_COMMENTS,
} from "./format.ts";
import { JiraError } from "./http.ts";
import type { Call } from "./params.ts";
import { arr, InputError, int, obj, userId } from "./values.ts";

const SEARCH_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];
const MAX_FIELD_MATCHES = 25;

/** Fields a call names, as ids with the label to show. A name that is not configured is looked up in Jira's field list. */
async function resolveInclude(env: Env, refs: readonly string[]): Promise<Array<{ id: string; label: string }>> {
    const resolved: Array<{ id: string; label: string }> = [];
    let list: FieldInfo[] | undefined;
    for (const ref of refs) {
        const known = knownFieldId(ref, env.settings.fields);
        if (known !== undefined) {
            resolved.push({ id: known, label: ref });
            continue;
        }
        list ??= await fieldList(env);
        const named = list.filter((field) => field.id === ref || field.name.toLowerCase() === ref.toLowerCase());
        const [only] = named;
        if (named.length !== 1 || only === undefined) {
            const problem =
                named.length > 1 ? `several fields are named "${ref}"; use the id` : `no field is named "${ref}"`;
            const hint = didYouMean(ref, list) ?? "find_field looks fields up by name.";
            throw new InputError(`jira: ${problem}. ${hint}`);
        }
        resolved.push({ id: only.id, label: only.id === only.name ? only.id : `${only.name} (${only.id})` });
    }
    return resolved;
}

/** A 400 that names a field Jira does not know gets the closest real field names appended. */
async function withFieldHint(env: Env, error: unknown): Promise<unknown> {
    if (!(error instanceof JiraError) || error.status !== 400) return error;
    const guess = missingField(error.message);
    if (guess === undefined) return error;
    const hint = didYouMean(guess, await fieldList(env).catch(() => []));
    return hint === undefined ? error : new JiraError(`${error.message} ${hint}`, error.status);
}

export async function runRead(env: Env, call: Call): Promise<string> {
    switch (call.action) {
        case "get": {
            const extra = await resolveInclude(env, call.include);
            const issue = await getIssue(env, call.key, [...ISSUE_FIELDS, ...extra.map(({ id }) => id)]);
            const fields = obj(issue.fields);
            const embedded = obj(fields.comment);
            const listed = arr(embedded.comments).map(commentOf);
            const total = Math.max(int(embedded.total), listed.length);
            // Jira may send only the first part of a long thread with the issue; the newest comments are then asked for.
            const comments =
                listed.length < total
                    ? (await commentPage(env, call.key, Math.max(0, total - LATEST_COMMENTS), LATEST_COMMENTS)).comments
                    : listed.slice(-LATEST_COMMENTS);
            const shown = extra.map(({ id, label }) => ({ label, value: fields[id] }));
            return formatIssue(issue, { comments, commentTotal: total, full: call.full, extra: shown });
        }
        case "search": {
            const extra = await resolveInclude(env, call.include);
            try {
                const fields = [...SEARCH_FIELDS, ...extra.map(({ id }) => id)];
                const page = await search(env, { jql: call.jql, fields, limit: call.limit, page: call.page });
                return formatSearch(page, call.jql, extra);
            } catch (error) {
                throw await withFieldHint(env, error);
            }
        }
        case "comments": {
            const { comments, total } = await newestComments(env, call.key, call.limit);
            return formatComments(call.key, comments, total, call.full);
        }
        case "transitions":
            return formatTransitions(call.key, await transitionsOf(env, call.key));
        case "changelog": {
            const issue = await getIssue(env, call.key, ["summary"], "changelog");
            return formatChangelog(call.key, obj(issue.changelog), call.limit);
        }
        case "attachments": {
            const issue = await getIssue(env, call.key, ["attachment"]);
            return formatAttachments(call.key, arr(obj(issue.fields).attachment));
        }
        case "assignable":
            return formatUsers(call.key, await assignableUsers(env, { key: call.key }, call.query, call.limit), userId);
        case "find_field": {
            const needle = call.query.toLowerCase();
            const fields = (await fieldList(env)).filter(
                (field) => field.name.toLowerCase().includes(needle) || field.id.toLowerCase() === needle,
            );
            const aliases = Object.entries(env.settings.fields).filter(
                ([name, id]) => name.toLowerCase().includes(needle) || id.toLowerCase() === needle,
            );
            return formatFields(call.query, fields.slice(0, MAX_FIELD_MATCHES), aliases);
        }
        case "link_types":
            return formatLinkTypes(await linkTypes(env));
        default:
            throw new InputError(`jira ${call.action} is a write, not a read`);
    }
}
