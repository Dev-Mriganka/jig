// The plans for the three writes on a comment: add, replace and delete.
import { getComment, issueHead, myself, newestComments, notFoundAsInvalid } from "./api.ts";
import type { Comment, Env } from "./api.ts";
import { JiraError } from "./http.ts";
import { about } from "./plan.ts";
import type { CallOf, Plan } from "./plan.ts";
import { pointersIn } from "./pointers.ts";
import { minute, obj, sameUser, str, userId } from "./values.ts";

/** How many of the newest comments the re-read after a lost reply looks through. */
const RECHECK_COMMENTS = 50;

export async function planComment(env: Env, call: CallOf<"comment">): Promise<Plan> {
    // Who is signed in is read before the write, because after a lost reply it may no longer be possible to ask.
    const [head, me] = await Promise.all([issueHead(env, call.key), myself(env)]);
    return {
        key: call.key,
        shown: {
            summary: `Add a comment to ${about(head)} (${head.status}), as ${me.displayName}`,
            flags: pointersIn([call.text], env.settings.privateNames),
            rows: [],
            notes: [],
            texts: [{ label: "Comment", source: call.text }],
        },
        send: { method: "POST", path: `/issue/${call.key}/comment`, body: { body: call.text } },
        basis: { as: userId(me) },
        async check() {
            const { comments } = await newestComments(env, call.key, RECHECK_COMMENTS);
            const mine = comments.filter(
                (comment) => sameUser(comment.author, me) && comment.body.trim() === call.text.trim(),
            );
            const newest = mine.at(-1);
            if (newest === undefined) {
                return {
                    happened: false,
                    text: `the newest ${RECHECK_COMMENTS} comments on ${call.key} hold none by you with this text`,
                };
            }
            const several = mine.length > 1 ? `; ${mine.length} comments by you carry this text, so check the time` : "";
            const created = `created ${minute(newest.created)}${several}`;
            return { happened: true, text: `comment ${newest.id} by you with this text is on ${call.key} (${created})` };
        },
        done(reply) {
            const id = str(obj(reply).id);
            const text = id === "" ? `Added a comment to ${call.key}.` : `Added comment ${id} to ${call.key}.`;
            return { text, key: call.key };
        },
    };
}

/** The comment a write is about. A wrong id is a mistake in the call. */
async function existingComment(env: Env, key: string, id: string): Promise<Comment> {
    try {
        return await getComment(env, key, id);
    } catch (error) {
        throw notFoundAsInvalid(error, `comment ${id} on ${key}`);
    }
}

export async function planEditComment(env: Env, call: CallOf<"edit_comment">): Promise<Plan> {
    const [head, old] = await Promise.all([issueHead(env, call.key), existingComment(env, call.key, call.commentId)]);
    return {
        key: call.key,
        shown: {
            summary: `Replace comment ${call.commentId} by ${old.author.displayName || "unknown"} on ${about(head)}`,
            flags: pointersIn([call.text], env.settings.privateNames),
            rows: [],
            notes: [],
            texts: [{ label: "New text", source: call.text, replaces: old.body }],
        },
        send: { method: "PUT", path: `/issue/${call.key}/comment/${call.commentId}`, body: { body: call.text } },
        basis: { old: old.body },
        async check() {
            const now = (await getComment(env, call.key, call.commentId)).body.trim();
            const comment = `comment ${call.commentId}`;
            if (now === call.text.trim()) return { happened: true, text: `${comment} now holds the new text` };
            if (now === old.body.trim()) return { happened: false, text: `${comment} still holds the old text` };
            return {
                happened: undefined,
                text: `${comment} holds neither the old nor the new text; someone else may have changed it`,
            };
        },
        done: () => ({ text: `Updated comment ${call.commentId} on ${call.key}.`, key: call.key }),
    };
}

export async function planDeleteComment(env: Env, call: CallOf<"delete_comment">): Promise<Plan> {
    const [head, old] = await Promise.all([issueHead(env, call.key), existingComment(env, call.key, call.commentId)]);
    return {
        key: call.key,
        shown: {
            summary: `Delete comment ${call.commentId} by ${old.author.displayName || "unknown"} on ${about(head)}. ` +
                "This cannot be undone.",
            flags: [],
            rows: [],
            notes: ["This cannot be undone. The text of the comment is below."],
            texts: [{ label: "Comment to delete", source: old.body }],
        },
        send: { method: "DELETE", path: `/issue/${call.key}/comment/${call.commentId}` },
        basis: { old: old.body, author: userId(old.author) },
        async check() {
            try {
                await getComment(env, call.key, call.commentId);
                return { happened: false, text: `comment ${call.commentId} is still on ${call.key}` };
            } catch (error) {
                // A comment that is gone answers 404. Any other failure leaves the question open.
                if (error instanceof JiraError && error.status === 404) {
                    return { happened: true, text: `comment ${call.commentId} is no longer on ${call.key}` };
                }
                throw error;
            }
        },
        done: () => ({ text: `Deleted comment ${call.commentId} from ${call.key}.`, key: call.key }),
    };
}
