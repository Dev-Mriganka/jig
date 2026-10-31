// Defaults for `jira`. A real company puts here its Jira address, how its people sign in, and the fields its issues use.
//
// Acme is on Jira Cloud. Cloud signs in with an account's email and an API token, so `auth` is an `email` and a secret reference
// to the token (never the token). Here every developer's agent uses one shared automation account, whose token each developer keeps in
// their own password store as `acme/jira-token`. A company where each person signs in as themselves cannot default `auth`: the
// email is theirs, and `auth` replaces the company's whole, so each person writes `{ "email": ..., "token": ... }` in their own
// jig.json. A company with a sign-in service or a transport writes `{ "signIn": "..." }` or `{ "transport": "..." }` here instead.
//
// There is no place for project keys in this section: the plugin reads the project from each call. Acme's keys are in the ticket
// pattern (memory.ts), the branch rules (git.ts) and the overlay skill (skills/acme-jira).
export const jiraDefaults = {
    site: "https://acme.atlassian.net",
    auth: { email: "agent@acme.example", token: "pass:acme/jira-token" },
    // A friendly name for a field the Acme Jira calls by id, and the fields `update` may set (the default list plus that one).
    fields: { "Story Points": "customfield_10016" },
    updateFields: ["summary", "description", "labels", "priority", "assignee", "Story Points"],
    // A value `create` gives a field when the call leaves it out.
    createDefaults: { Priority: "Medium" },
    // Names that must not appear in text sent to Jira: the preview flags them.
    privateNames: ["acme.internal"],
};
