# jig-jira: Jira issues

**Status: built.** Tested against a fake Jira on this machine. Not tried against
a real Jira yet (see [Not verified yet](docs/not-verified.md)).

`jig-jira` gives the agent one tool, `jira`, over Jira's REST API version 2,
which takes wiki markup and works on Jira Cloud and on Jira Data Center. Every
write shows a rendered preview before it is sent, and `jig-core` governs every
call.

For example, `jira comment` on `PROJ-123` shows the comment as Jira will render
it, and posts it only after you press `y`.

![The same generic jira tool set up by two companies, each with its own site, sign-in, ticket key pattern and overlay skill](../../docs/img/company-plugs-in.svg)

*The same `jira` tool for two companies. The difference is configuration and knowledge, not code: each company plugin supplies its own site, sign-in, ticket key pattern and an overlay skill, which is its own rules added to this plugin's skill.*

## Tool: `jira`

`action` picks the operation. Calls run one at a time, in order.

| Action | Kind | What it does |
|---|---|---|
| `get` | read | An issue's fields, description and latest 5 comments |
| `search` | read | Issues matching a JQL query, with paging |
| `comments` | read | The newest comments, up to 100 |
| `transitions` | read | The transitions available, with their target status |
| `changelog` | read | Status and field history |
| `attachments` | read | The list of attachments; files are not downloaded |
| `assignable` | read | Users who can take the issue |
| `find_field` | read | Field ids and names matching a text |
| `create` | external write, asks on the review screen | Creates an issue; the preview shows every field and possible duplicates |
| `comment` | external write, asks on the review screen | Adds a comment |
| `edit_comment` | external write, asks on the review screen | Replaces a comment's text |
| `delete_comment` | external write, asks on a dialog | Deletes a comment. This cannot be undone |
| `transition` | external write, asks on a dialog | Moves the issue; the name must match exactly one transition |
| `update` | external write, asks on a dialog; review screen when it sets the description | Sets allowed fields such as summary, labels, priority or assignee |

Writes go to `external` (or the environment you set), so they ask you by
default. Each action's parameters, and the limits on what the tool returns, are
in [Parameters](docs/parameters.md).

## Rules

- **Rendered previews.** Text is Jira wiki markup, and the review screen shows
  it before it is sent. `o` opens the rendered page; the browser only shows,
  and approval stays in Pi.
- **Local-pointer check.** Outgoing text is checked for local paths and for the
  names in `privateNames`. They are flagged in the preview and do not block: you
  decide.
- **Invalid input is not asked about.** Every call is checked before anyone is
  asked, and a mistake blocks the call with a message that says what to change.
- **Changed since the preview.** If what would be sent differs from what you
  approved, the write is refused: "changed since the preview; run it again to
  see the new preview".
- **No resend on timeout.** A write whose result is unknown is never sent
  again. The issue is read once, and the tool says whether the write happened.
- **Facts.** After a write, the call's record carries the issue key, as the
  fact `issue`.

## Configure

In `~/.pi/agent/jig.json`, under `jira`. An unknown field is an error, and the
tool then does nothing until the file is fixed (`/jig` lists the problems).

| Field | Default | Meaning |
|---|---|---|
| `site` | required | The https address of the Jira, such as `https://example.atlassian.net` |
| `auth` | required | How requests are signed in: exactly one of the four forms below |
| `updateFields` | `summary`, `description`, `labels`, `priority`, `assignee` | The fields `update` may set, by name or id |
| `fields` | none | Friendly names for field ids, such as `"Story Points": "customfield_10016"` |
| `privateNames` | none | Folder or host names to flag in outgoing text, up to 100 |
| `environment` | `external` | The environment name that rules and classification know this Jira by |

The fields in detail are in [Configuration](docs/configuration.md).

| `auth` | Signs in with | For |
|---|---|---|
| `{ "email": "...", "token": "<secret reference>" }` | Basic authentication with an API token | Jira Cloud |
| `{ "token": "<secret reference>" }` | A personal access token, sent as a Bearer token | Jira Data Center |
| `{ "signIn": "<service name>" }` | The headers of a company sign-in service, asked for on every request | A company's single sign-on |
| `{ "transport": "<name>" }` | A company transport: every request goes through it, and the tool holds no token | A company that reaches Jira only through a local sign-in proxy |

The token is a secret reference such as `pass:work/jira-token` (see
[Secrets](../../docs/secrets.md)); a token written into the file is refused, and
the error does not repeat it.

A token or a header is never put in a result or an error, and `jig-core` removes
it from output as well. With a transport, `site` still builds the URL of every
request, and the answer's status, headers and body are read as an HTTP answer
is.

```json
{
  "jira": {
    "site": "https://example.atlassian.net",
    "auth": { "email": "jane@example.test", "token": "pass:work/jira-token" },
    "fields": { "Story Points": "customfield_10016" },
    "updateFields": ["summary", "description", "labels", "priority", "assignee", "Story Points"],
    "privateNames": ["payroll", "corp.example.net"]
  }
}
```

## Company part (in the company plugin)

- the Jira site;
- the sign-in: a company sign-in service, a company transport, or an API token
  through a secret reference;
- default fields: friendly names, the fields `update` may set, private names;
- the environment name, when it is not `external`.

## Layout

```text
jig-jira/
  src/      the tool and its checks (index, tool, params, classify, config), Jira's endpoints and request (api, http,
            create-meta), field names and values, what the model reads (format, reads), writes and their previews
            (plan*, shown, page, writes), the wiki-markup renderer (wiki), the local-pointer check (pointers)
  skills/   jira/SKILL.md: comment style and conventions
  test/     against a fake Jira server on this machine and a fake jig-core
  docs/     the detail pages below
```

## More detail

- [Parameters](docs/parameters.md): what each action needs, fields, limits on results, and people
- [Configuration](docs/configuration.md): the fields of the `jira` section in detail
- [Writes](docs/writes.md): the rules for writes in full, and what each preview shows
- [Not verified yet](docs/not-verified.md): what needs a real Jira
