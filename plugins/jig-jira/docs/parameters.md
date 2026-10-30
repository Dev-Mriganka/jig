# Parameters, and what the tool returns

The parameters of the `jira` tool, the limits on what it returns, and how
people are named. Back to the [jig-jira overview](../README.md).

## Parameters

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
| `limit` | How many to return (see below) |
| `include` | Up to 10 more fields to show, by name or id |
| `full` | Lifts the length caps on descriptions and comments. Read with it before rewriting a text |
| `query` | Part of a person's name (`assignable`) or of a field's name (`find_field`) |
| `commentId`, `text` | The number `comments` shows; the comment, in Jira wiki markup |
| `transition` | A name from `transitions` (or its id) |
| `type`, `summary`, `description` | The issue type name; a one-line title of at most 255 characters; the description, in wiki markup |
| `fields` | The fields to set, by name or id (see below) |

- **`limit`:** `search` and `assignable` return 20 by default, up to 50.
  `comments` returns 20, up to 100. `changelog` returns 30, up to 100.
- **`fields`:** an example is
  `{"labels": ["a"], "priority": "High", "assignee": "<id from assignable>"}`. A
  person is given by the id `assignable` shows, or `null` to unassign.

## Fields

A field is named in `fields` by a name the tool knows, a friendly name from the
configuration, or a field id.
- **The tool builds the value Jira expects** for `summary`, `description`,
  `labels`, `priority`, `assignee`, `components`, `fixVersions` and `parent`,
  from plain input. `labels`, `components` and `fixVersions` take up to 50
  names of up to 255 characters, and a label cannot contain a space. `parent`
  is an issue key, such as `PROJ-12`.
- **Any other field** takes its value as Jira's REST API does. It must be plain
  JSON, with at most 500 values, nested at most 6 levels.
- **Text is checked** against Jira's limit before you are asked (see the limits
  below).

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

## People

People are named differently by the two editions: Jira Cloud by account id and
Data Center by user name. `assignable` shows the id to use, and a person given to
`update` or `create` is looked up there, so the preview shows a name. In wiki
text, a mention is `[~accountid:ID]` on Cloud and `[~username]` on Data Center.
