# jig-jira: Jira issues

**Status: design.**

## Tool: `jira`

| Action | Kind | What it does |
|---|---|---|
| `get` | read | An issue's fields, description and latest comments |
| `search` | read | Issues matching a JQL query, with paging |
| `comments` | read | The newest comments, up to 100 |
| `transitions` | read | The transitions available, with their target status |
| `changelog` | read | Status and field history |
| `attachments` | read | The list of attachments; files are not downloaded |
| `assignable` | read | Users who can take the issue |
| `find_field` | read | Field ids and names matching a text |
| `create` | write | Creates an issue. The preview shows every field with its final value and possible duplicates |
| `comment` | write | Adds a comment |
| `edit_comment` | write | Replaces a comment's text |
| `delete_comment` | write | Deletes a comment. This cannot be undone |
| `transition` | write | Moves the issue; the name must match exactly one transition |
| `update` | write | Sets allowed fields such as summary, description, labels, priority or assignee |

Writes go to `external`, so they ask you by default.

## Rules

- **Rendered previews.** Text is Jira wiki markup, and the review screen
  renders it before it is sent: `o` opens the rendered page, and `y` approves.
- **Local-pointer check.** Outgoing text is checked for local paths and private
  folder names, and these are flagged in the preview.
- **No resend on timeout.** A write whose result is unknown is never sent
  again: the issue is re-read first.

## Company part (in the company plugin)

- the Jira site;
- the sign-in: a company sign-in service, or an API token through a secret
  reference;
- default projects and field names.

## Layout (planned)

```text
jig-jira/
  src/      the tool, the preview, the wiki-markup renderer, the sign-in client
  skills/   jira/SKILL.md: comment style and conventions
  test/     against a fake Jira server
```
