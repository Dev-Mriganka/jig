# jig-jira: Jira issues

**Status: built, not yet tried against a real Jira.** This README is the
specification the code follows. [Not verified yet](#not-verified-yet) lists
what needs a real Jira.

`jig-jira` gives the agent one tool, `jira`, over Jira's REST API version 2.
Version 2 takes wiki markup and works on Jira Cloud and on Jira Data Center.
Every write shows a rendered preview before it is sent, and `jig-core` governs
every call.

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
| `create` | write, review screen | Creates an issue. The preview shows every field with its final value and possible duplicates |
| `comment` | write, review screen | Adds a comment |
| `edit_comment` | write, review screen | Replaces a comment's text |
| `delete_comment` | write, dialog | Deletes a comment. This cannot be undone |
| `transition` | write, dialog | Moves the issue; the name must match exactly one transition |
| `update` | write, dialog; review screen when it sets the description | Sets allowed fields such as summary, description, labels, priority or assignee |

Writes go to `external` (or the environment you set), so they ask you by
default.

### Parameters

One flat set of parameters; each action takes the ones below. A call with a
missing or an unused parameter is refused with the usage line, such as `jira
comment needs text. Usage: jira comment {key, text}`.

| Action | Needs | Optional |
|---|---|---|
| `get` | `key` | `include`, `full` |
| `search` | `jql` | `limit`, `page`, `include` |
| `comments` | `key` | `limit`, `full` |
| `transitions` | `key` | |
| `changelog` | `key` | `limit` |
| `attachments` | `key` | |
| `assignable` | `key` | `query`, `limit` |
| `find_field` | `query` | |
| `create` | `project`, `type`, `summary` | `description`, `fields` |
| `comment` | `key`, `text` | |
| `edit_comment` | `key`, `commentId`, `text` | |
| `delete_comment` | `key`, `commentId` | |
| `transition` | `key`, `transition` | |
| `update` | `key`, `fields` | |

| Parameter | Meaning |
|---|---|
| `key`, `project` | An issue key such as `PROJ-123`; a project key such as `PROJ` |
| `jql`, `page` | The query. `page` is the value that the previous result gives after `More: repeat with page=` |
| `limit` | How many to return. `search` and `assignable`: 20 by default, up to 50. `comments`: 20, up to 100. `changelog`: 30, up to 100 |
| `include` | Up to 10 more fields to show, by name or id |
| `full` | Lifts the length caps on descriptions and comments. Read with it before rewriting a text |
| `query` | Part of a person's name (`assignable`) or of a field's name (`find_field`) |
| `commentId`, `text` | The number `comments` shows; the comment, in Jira wiki markup |
| `transition` | A name from `transitions` (or its id) |
| `type`, `summary`, `description` | The issue type name; a one-line title of at most 255 characters; the description, in wiki markup |
| `fields` | The fields to set, by name or id: `{"labels": ["a"], "priority": "High", "assignee": "<id from assignable>"}`. A person is given by the id `assignable` shows, or `null` to unassign |

## Rules

- **Rendered previews.** Text is Jira wiki markup, and the review screen shows
  it before it is sent: the source on the screen, `o` for the rendered page,
  and `y` to approve. The page is the text as Jira will show it: headings,
  lists, tables, code, quotes, panels, colours, links, mentions, line breaks
  and rules. What the renderer does not know stays on the page as written, so
  nothing the readers will see is hidden from you. The browser only shows;
  approval stays in Pi.
- **Local-pointer check.** Outgoing text is checked for local paths (`/home/`,
  `/Users/`, `/root/`, `/mnt/`, `/tmp/`, `~/`, `C:\`, `file://`, and relative
  `./` and `../` paths) and for the names in `privateNames`. These are flagged
  at the top of the preview and in its summary. They do not block: you decide.
  A path inside a web address is not a pointer.
- **Invalid input is not asked about.** Every call is checked before anyone is
  asked: the action and its parameters, the issue and comment, the transition
  name, the fields `update` may set, the values the create screen allows, and
  the text limit. A mistake blocks the call with a message that says what to
  change, and nobody is asked about a call that cannot run.
- **Changed since the preview.** The plan is made again right before the write
  is sent. If what would be sent now differs from the preview you approved (a
  status moved, a comment was edited, a field changed), the write is refused:
  "changed since the preview; run it again to see the new preview".
- **No resend on timeout.** A write whose result is unknown (a timeout, a
  dropped connection, a 5xx answer) is never sent again. The issue is read once,
  and the tool says whether the write happened:

  | Write | The one read afterwards |
  |---|---|
  | `comment` | The newest 50 comments: one by the same person with the same text |
  | `edit_comment` | The comment: it holds the new text, the old text, or neither |
  | `delete_comment` | The comment: it is gone, or still there |
  | `create` | A search for the summary, created in the last 10 minutes |
  | `transition` | The issue's status |
  | `update` | The values of the fields |

  A write that Jira turned down (a 4xx answer) changed nothing and is reported
  as that. A write that never left (no sign-in) is reported as that.
- **Facts.** After a write, the call's record carries the issue key, as the
  fact `issue`.

## What the previews show

| Write | Preview |
|---|---|
| `comment` | The issue and its status, who posts, the wiki source and the rendered page |
| `edit_comment` | The new text, as source and rendered, and the text it replaces |
| `delete_comment` | The comment's text, and that this cannot be undone |
| `transition` | The issue, its status now and the status after, and the transition used. A name that matches no transition, or several, is refused with the names. A status name gets a hint at the transition that leads there |
| `update` | Each field as `before → after`; a description as source and rendered, with the text it replaces. A person is shown by name |
| `create` | The project and type, every field with its final value (a priority or component as the create screen spells it), possible duplicates, and the description. Possible duplicates are a summary search in the project over the last 30 days, up to 5 |

`create` reads the project's create screen, so required fields and allowed
values come from Jira and are checked before you are asked. If the create
screen cannot be read (an old Jira), the values are shown as given and Jira
checks them.

## What the tool returns

Compact plain text for the model, one line per issue, comment or change.

| Limit | Value |
|---|---|
| A description in a result | 4,000 characters; the rest is counted, and `full` returns all of it |
| A comment in a result | 1,500 characters |
| Comments in `get` | the latest 5 |
| `find_field` | up to 25 fields |
| Text in a write | 32,767 characters, Jira's own limit; longer is refused before you are asked |
| A reply from Jira | 8 MiB |
| Timeouts | 30 seconds; 60 for `search` |

A search that names a field Jira does not know gets the closest field names
appended. Searching pages by token on Jira Cloud (`/search/jql`) and by offset
on Data Center (`/search`); the tool tries the first and remembers which one the
Jira answers.

## Configure

In `~/.pi/agent/jig.json`, under `jira`. An unknown field is an error, and the
tool then does nothing until the file is fixed (`/jig` lists the problems).

| Field | Default | Meaning |
|---|---|---|
| `site` | required | The https address of the Jira, such as `https://example.atlassian.net`. It may have a path. Plain `http` is refused |
| `auth` | required | How requests are signed in: exactly one of the four forms below |
| `updateFields` | `summary`, `description`, `labels`, `priority`, `assignee` | The fields `update` may set, by name or id. `create` may set any field on the create screen |
| `fields` | none | Friendly names for field ids, such as `"Story Points": "customfield_10016"`. They work in `fields`, `include` and `updateFields` |
| `privateNames` | none | Folder or host names to flag in outgoing text |
| `environment` | `external` | The environment name that rules and classification know this Jira by |

| `auth` | Signs in with | For |
|---|---|---|
| `{ "email": "...", "token": "<secret reference>" }` | Basic authentication with an API token | Jira Cloud |
| `{ "token": "<secret reference>" }` | A personal access token, sent as a Bearer token | Jira Data Center |
| `{ "signIn": "<service name>" }` | The headers of the company sign-in service of that name, asked for again on every request | A company's single sign-on |
| `{ "transport": "<name>" }` | The company transport of that name: every request goes through it, the tool holds no token and adds no auth header | A company that reaches Jira only through a local sign-in proxy that holds the session |

The token is a secret reference such as `pass:work/jira-token` (see
[Secrets](../../docs/secrets.md)); a token written into the file is refused,
and the error does not repeat it. A token or a header is never put in a result
or an error, and `jig-core` removes it from output as well. With a transport,
`site` still builds the URL of every request, and the answer's status, headers
and body are read as an HTTP answer is.

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

People are named differently by the two editions: Jira Cloud by account id and
Data Center by user name. `assignable` shows the id to use, and a person given to
`update` or `create` is looked up there, so the preview shows a name. In wiki
text, a mention is `[~accountid:ID]` on Cloud and `[~username]` on Data Center.

## Company part (in the company plugin)

- the Jira site;
- the sign-in: a company sign-in service, a company transport, or an API token
  through a secret reference;
- default fields: friendly names, the fields `update` may set, private names;
- the environment name, when it is not `external`.

## Not verified yet

Written from Jira's documentation and a fake Jira on this machine. Not tried
against a real Jira:
- the exact shape of the answers of both editions: `search/jql` and `search`,
  the create screen (`createmeta`), users, and comments on long threads;
- that the sign-in forms work against a real single sign-on gateway or proxy;
- how the rendered page compares with Jira's own rendering of unusual markup;
- a transition whose screen asks for a field (`resolution`, for example): the
  tool sends no field with a transition, and Jira's refusal is shown.

## Layout

```text
jig-jira/
  src/      the tool and its checks (index, tool, params, classify, config), Jira's endpoints and the request (api, http,
            create-meta), what the model reads (format, reads), writes and their previews (plan*, shown, page, writes),
            the wiki-markup renderer (wiki), the local-pointer check (pointers)
  skills/   jira/SKILL.md: comment style and conventions
  test/     against a fake Jira server on this machine and a fake jig-core
```
