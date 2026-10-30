// The plans for the three writes on a comment: add, replace and delete.
import { getComment, issueHead, newestComments, notFoundAsInvalid, whoAmI } from "./api.ts";
import type { Comment, Env } from "./api.ts";
import { JiraError } from "./http.ts";
import { about } from "./plan.ts";
import type { CallOf, Plan } from "./plan.ts";
import { pointersIn } from "./pointers.ts";
import { minute, obj, sameUser, str, userId } from "./values.ts";

/** How many of the newest comments the re-read after a lost reply looks through. */
const RECHECK_COMMENTS = 50;

/**
 * What a comment needs to know about who is signed in (`GET /myself`) is three things: the preview says who posts, the
 * fingerprint holds the account so that a changed sign-in voids the approval, and the check after a lost reply tells
 * the comment from someone else's with the same text. A site whose proxy has no "who am I" has none of them: the preview
 * says so, the fingerprint holds nothing of the account, and the check goes by the text alone (see `check` below).
 */
export async function planComment(env: Env, call: CallOf<"comment">): Promise<Plan> {
    // Who is signed in is read before the write, because after a lost reply it may no longer be possible to ask.
    const [head, who] = await Promise.all([issueHead(env, call.key), whoAmI(env)]);
    const me = who.user;
    const asked = `${about(head)} (${head.status})`;
    return {
        key: call.key,
        shown: {
            summary: me === undefined ? `Add a comment to ${asked}` : `Add a comment to ${asked}, as ${me.displayName}`,
            flags: pointersIn([call.text], env.settings.privateNames),
            rows: [],
            notes:
                me === undefined
                    ? [
                          `This Jira does not say who you are signed in as (${who.why}), so the preview cannot show who posts. ` +
                              "If the reply to the comment is lost, the check afterwards finds a comment by its text only.",
                      ]
                    : [],
            texts: [{ label: "Comment", source: call.text }],
        },
        send: { method: "POST", path: `/issue/${call.key}/comment`, body: { body: call.text } },
        basis: { as: me === undefined ? null : userId(me) },
        async check() {
            const { comments } = await newestComments(env, call.key, RECHECK_COMMENTS);
            const sameText = comments.filter((comment) => comment.body.trim() === call.text.trim());
            if (me === undefined) {
                // Without knowing who is signed in, a comment with this text may be anyone's: only "no such comment"
                // settles it.
                const [newest] = sameText.slice(-1);
                if (newest === undefined) {
                    return {
                        happened: false,
                        text: `the newest ${RECHECK_COMMENTS} comments on ${call.key} hold none with this text`,
                    };
                }
                return {
                    happened: undefined,
                    text:
                        `${sameText.length === 1 ? "a comment" : `${sameText.length} comments`} with this text ` +
                        `(newest ${newest.id}, created ${minute(newest.created)}) ` +
                        `${sameText.length === 1 ? "is" : "are"} on ${call.key}, but who wrote ` +
                        `${sameText.length === 1 ? "it" : "them"} cannot be told, as Jira does not say who you are`,
                };
            }
            const mine = sameText.filter((comment) => sameUser(comment.author, me));
            const newest = mine.at(-1);
            if (newest === undefined) {
                return {
                    happened: false,
                    text: `the newest ${RECHECK_COMMENTS} comments on ${call.key} hold none by you with this text`,
                };
            }
            const several =
                mine.length > 1 ? `; ${mine.length} comments by you carry this text, so check the time` : "";
            const created = `created ${minute(newest.created)}${several}`;
            return {
                happened: true,
                text: `comment ${newest.id} by you with this text is on ${call.key} (${created})`,
            };
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
            summary:
                `Delete comment ${call.commentId} by ${old.author.displayName || "unknown"} on ${about(head)}. ` +
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
