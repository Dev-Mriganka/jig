// People in fields. Jira Cloud names a person by account id and Data Center by user name, so a person is looked up among
// the people who can be assigned, and the field is then sent in the form that Jira returned. The preview shows the
// person's name, not only an id.
import { assignableUsers } from "./api.ts";
import type { Env } from "./api.ts";
import type { Converted } from "./fields.ts";
import { InputError, shortList, userId } from "./values.ts";
import type { User } from "./values.ts";

type Scope = { key: string } | { project: string };

/** The one person who can be assigned and whom `wanted` names, by id, user name or display name. */
async function resolveUser(env: Env, scope: Scope, wanted: string): Promise<User> {
    const users = await assignableUsers(env, scope, wanted, 50);
    const byId = users.filter((user) => [user.accountId, user.username, user.key].includes(wanted));
    const matches = byId.length > 0 ? byId : users.filter((user) => user.displayName.toLowerCase() === wanted.toLowerCase());
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) return only;
    const shown = (user: User): string => `${user.displayName} (${userId(user)})`;
    const name = wanted.slice(0, 40);
    const choices = shortList(matches.map(shown), "; ", 120);
    throw new InputError(
        matches.length > 1
            ? `assignee "${name}" matches several people; use an id from assignable: ${choices}`
            : `assignee: no one who can be assigned matches "${name}"; ask assignable for the ids`,
    );
}

/** The `assignee` field: an id from `assignable`, or null to leave the issue unassigned. */
export async function assigneeValue(env: Env, scope: Scope, raw: unknown): Promise<Converted> {
    if (raw === null) return { send: null, shown: "(unassigned)" };
    if (typeof raw !== "string" || raw.trim() === "") {
        throw new InputError("assignee: must be an id from assignable, or null to unassign");
    }
    const user = await resolveUser(env, scope, raw.trim());
    return {
        send: user.accountId !== "" ? { accountId: user.accountId } : { name: user.username },
        shown: `${user.displayName} (${userId(user)})`,
    };
}
