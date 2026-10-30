// The plans for the two writes on an issue itself: move it to another status, and set some of its fields.
import { getIssue, issueHead, notFoundAsInvalid, transitionsOf } from "./api.ts";
import type { Env, Transition } from "./api.ts";
import type { JiraSettings } from "./config.ts";
import { convertField, fieldIdOf, isWikiField } from "./fields.ts";
import type { Converted } from "./fields.ts";
import { transitionLine } from "./format.ts";
import { about } from "./plan.ts";
import type { CallOf, Plan } from "./plan.ts";
import { assigneeValue } from "./plan-fields.ts";
import { pointersIn, stringsIn } from "./pointers.ts";
import { comparable, describeValue, InputError, nameOf, obj, oneLine, shortList, str } from "./values.ts";

/**
 * The transition a call means: the one with that id, else the one whose name matches exactly (case apart). Otherwise an
 * InputError says what there is to choose from.
 */
export function pickTransition(transitions: Transition[], wanted: string, key: string): Transition {
    const byId = /^\d+$/.test(wanted) ? transitions.filter((transition) => transition.id === wanted) : [];
    const exact = transitions.filter((transition) => transition.name === wanted);
    const loose = transitions.filter((transition) => transition.name.toLowerCase() === wanted.toLowerCase());
    const matches = byId.length > 0 ? byId : exact.length > 0 ? exact : loose;
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) return only;
    if (matches.length > 1) {
        const choices = shortList(matches.map(transitionLine), "; ", 80);
        throw new InputError(`jira transition: "${wanted}" matches several transitions on ${key} (${choices}); pass the id`);
    }
    // A model often names the status it wants. Say which transition leads there, but do not pick it: the call must name one.
    const leading = transitions.filter((transition) => transition.to.toLowerCase() === wanted.toLowerCase());
    const [lead] = leading;
    if (leading.length === 1 && lead !== undefined) {
        throw new InputError(
            `jira transition: ${key} has no transition named "${wanted}", which is a status; ` +
                `the transition "${lead.name}" leads to it`,
        );
    }
    const names = shortList(transitions.map((transition) => transition.name)) || "none";
    throw new InputError(`jira transition: ${key} has no transition named "${wanted}"; available: ${names}`);
}

export async function planTransition(env: Env, call: CallOf<"transition">): Promise<Plan> {
    const [head, transitions] = await Promise.all([issueHead(env, call.key), transitionsOf(env, call.key)]);
    const chosen = pickTransition(transitions, call.transition, call.key);
    return {
        key: call.key,
        shown: {
            summary: `Move ${about(head)} from ${head.status} to ${chosen.to} (transition "${chosen.name}")`,
            flags: [],
            rows: [["From", head.status], ["To", chosen.to], ["Transition", `${chosen.name} [${chosen.id}]`]],
            notes: [],
            texts: [],
        },
        send: { method: "POST", path: `/issue/${call.key}/transitions`, body: { transition: { id: chosen.id } } },
        basis: { from: head.status, to: chosen.to, name: chosen.name },
        async check() {
            const now = await issueHead(env, call.key);
            if (head.status === chosen.to) {
                const text = `${call.key} was already in ${now.status} before, so its status cannot tell`;
                return { happened: undefined, text };
            }
            if (now.status === chosen.to) return { happened: true, text: `${call.key} is now in ${now.status}` };
            if (now.status === head.status) return { happened: false, text: `${call.key} is still in ${now.status}` };
            return {
                happened: undefined,
                text: `${call.key} is now in ${now.status}, which is neither ${head.status} nor ${chosen.to}`,
            };
        },
        done: () => ({
            text: `${call.key} moved from ${head.status} to ${chosen.to} (transition "${chosen.name}").`,
            key: call.key,
        }),
    };
}

/** The names `update` may set, as the person configured them, with the friendly names of the same fields. */
function allowedNames(settings: JiraSettings): string {
    const listed = new Set(settings.updateFields.map((name) => name.toLowerCase()));
    const ids = new Set(settings.updateFields.map((name) => fieldIdOf(name, settings.fields)));
    const friendly = Object.entries(settings.fields)
        .filter(([name, id]) => ids.has(id) && !listed.has(name.toLowerCase()))
        .map(([name]) => name);
    return shortList([...settings.updateFields, ...friendly], ", ", 90);
}

interface Change {
    name: string;
    id: string;
    converted: Converted;
    before: unknown;
}

const names = (changes: readonly Change[]): string => changes.map((change) => change.name).join(", ");

export async function planUpdate(env: Env, call: CallOf<"update">): Promise<Plan> {
    const { settings } = env;
    const allowed = new Set(settings.updateFields.map((name) => fieldIdOf(name, settings.fields)));
    const wanted: Array<{ name: string; id: string; raw: unknown }> = [];
    for (const [name, raw] of Object.entries(call.fields)) {
        const id = fieldIdOf(name, settings.fields);
        if (id === undefined || !allowed.has(id)) {
            throw new InputError(
                `jira update: "${name.slice(0, 40)}" is not a field that update may set. ` +
                    `It may set: ${allowedNames(settings)}`,
            );
        }
        if (wanted.some((entry) => entry.id === id)) throw new InputError(`jira update: ${id} is given twice`);
        wanted.push({ name, id, raw });
    }

    // The current values are read now: the preview shows what changes, and a change in them voids the approval.
    let issue;
    try {
        issue = await getIssue(env, call.key, ["summary", "status", ...wanted.map((entry) => entry.id)]);
    } catch (error) {
        throw notFoundAsInvalid(error, call.key);
    }
    const current = obj(issue.fields);

    const changes: Change[] = [];
    for (const { name, id, raw } of wanted) {
        try {
            const converted = id === "assignee"
                ? await assigneeValue(env, { key: call.key }, raw)
                : convertField(id, raw);
            changes.push({ name, id, converted, before: current[id] });
        } catch (error) {
            throw error instanceof InputError ? new InputError(`jira update: ${error.message}`) : error;
        }
    }
    const body = { fields: Object.fromEntries(changes.map((change) => [change.id, change.converted.send])) };

    // A text field such as the description is shown as text, the others as `before → after`.
    const asText = (change: Change): boolean => isWikiField(change.id) && typeof change.converted.send === "string";
    const rows = changes.filter((change) => !asText(change)).map((change): [string, string] => [
        change.name,
        `${oneLine(describeValue(change.before), 150)} → ${oneLine(change.converted.shown, 150)}`,
    ]);
    const texts = changes.filter(asText).map((change) => ({
        label: `${change.name.charAt(0).toUpperCase()}${change.name.slice(1)}`,
        source: String(change.converted.send),
        replaces: str(change.before),
    }));
    const head = { key: call.key, summary: str(current.summary), status: nameOf(current.status) };

    return {
        key: call.key,
        shown: {
            summary: `Update ${about(head)}: ${names(changes)}`,
            flags: pointersIn(stringsIn(body.fields), settings.privateNames),
            rows,
            notes: [],
            texts,
        },
        send: { method: "PUT", path: `/issue/${call.key}`, body },
        basis: { before: Object.fromEntries(changes.map((change) => [change.id, comparable(change.before)])) },
        async check() {
            const now = obj((await getIssue(env, call.key, changes.map((change) => change.id))).fields);
            const applied = changes.filter((change) => comparable(now[change.id]) === comparable(change.converted.send));
            if (applied.length === changes.length) {
                return { happened: true, text: `${call.key} holds the new value of ${names(applied)}` };
            }
            if (applied.length === 0) {
                return { happened: false, text: `${call.key} still holds the old value of ${names(changes)}` };
            }
            const left = changes.filter((change) => !applied.includes(change));
            return {
                happened: undefined,
                text: `${call.key} holds the new value of ${names(applied)} but not of ${names(left)}`,
            };
        },
        done: () => ({ text: `Updated ${call.key}: ${names(changes)}.`, key: call.key }),
    };
}
