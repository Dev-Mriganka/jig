---
name: jira
description: "Reading and changing Jira issues with the jira tool: comments, transitions, fields and new issues, and the wiki markup their text uses. Use when the user names an issue key, or asks to search, comment on, update, move or create a Jira issue."
---

# Jira work

Use the `jira` tool for every Jira operation. Every write shows the user a preview and asks first.

## Read before you write

- `get` the issue first: its fields, description and latest comments. Use `comments` when the thread is longer, and `transitions` before moving the issue.
- Results cut a description at 4,000 characters and a comment at 1,500. Before you rewrite a description or a comment, read it whole with `full: true`, or the rest is lost.
- A person is given to `update` or `create` by the id that `assignable` shows. A custom field is found by name with `find_field`; give it to `update` by name or id.
- After a change, read it back with `get` (add `include` for a custom field) and compare it with what you meant.

## One transition at a time

- Call `transitions` and use the exact transition name (or its id). The name of a status is not a transition name: "Done" may be the status, and "Resolve Issue" the transition.
- Move once, read the new status in the result, and only then decide on the next move.

## Comments and descriptions

- Short and factual. Start with the answer in one or two sentences, then the evidence: what was checked, where and when (times in UTC), and the numbers.
- Anyone should understand it at the first read. Short sentences, everyday words, issue keys written out. Facts that a reader compares go in a table.
- Never paste a local path (`/home/...`, `~/...`, `./script.sh`), the name of your notes or working files, or a folder only you can open. Readers cannot follow them. Put the rows that matter in the text, or ask the user to attach the file and refer to it as `[^name.csv]`.
- Never paste a secret, a token, a password or a customer's personal data.
- The preview flags local paths and private names. Rewrite the text instead of approving it.

## Wiki markup

Text is Jira wiki markup, not Markdown. `**bold**`, backticks, `# Heading`, `[text](url)` and code fences show up literally.

| Write | You get |
|---|---|
| `h3. Heading` (`h1.` to `h6.`) | a heading |
| `*bold*`, `_italic_`, `-strike-`, `+underline+`, `{{monospace}}` | marks |
| `* item`, `** nested`, `# numbered` | lists |
| `[text\|https://example.test]`, `[https://example.test]` | a link (http, https and mailto only) |
| `[~accountid:ID]` on Jira Cloud, `[~username]` on Data Center | a mention |
| `{code:java}...{code}`, `{noformat}...{noformat}` | a block, kept as written |
| `{quote}...{quote}`, `bq. a line` | a quote |
| `{panel:title=Next steps}...{panel}` | a panel |
| `{color:red}text{color}` | a colour |
| `\|\|Name\|\|Value\|\|` then `\|a\|b\|` | a table |
| `----`, `\\` | a rule, a line break |

Traps:
- `{` and `}` open macros, even inside `{{ }}`. Write a placeholder as `<name>`, or put text with braces in `{code}`.
- A line that starts with `*`, `#` or `-` and a space is a list item.
- A `|` ends a table cell, except inside a `[link]`.

## Creating issues

- `create` needs `project`, `type` and `summary`. Ask the user for any value you would have to guess, such as the components or the priority.
- The preview shows every field with its final value and the possible duplicates. If one looks like the same issue, tell the user instead of creating another.
- The user may have listed their projects. A `create` for another project is refused with the list; use one of them, and do not look for a way around it.
- Other fields go in `fields`, by name or id.
- The user may have defaults for some fields. The preview marks them `(from your defaults)`; do not set those fields again unless the user wants a different value, and say if a default looks wrong for this issue.

## Searching

- `search` takes JQL. With no `jql` it looks in the user's listed projects, newest first, and the result names the query it ran; with none listed, a search without `jql` is refused.

## Updating fields

- `update` sets only the fields that are allowed. If one is refused, the message lists the ones that are; do not look for a way around it.
- Give a list field its whole new value: `labels` replaces the labels.

## Links between issues

- Call `link_types` for the names and phrases. `link` reads "key <phrase> to": `key: "PROJ-1"`, `to: "PROJ-2"`, `linkType: "blocks"` makes PROJ-1 block PROJ-2. The other phrase (`is blocked by`) turns it round.
- Check the direction in the preview before the user approves it: it says what each issue reads and which one Jira gets as outward.
- `unlink` takes the two issues; give `linkType` when there is more than one link between them. Read the issue's `Links:` first, so you remove the one meant.
- A link that already exists is refused. Do not look for a way around it.

## When a write gets no reply

A write is never sent twice. When its reply is lost, the tool reads the issue once and says whether the write happened. Believe it: do not repeat a write that happened. If it says the write did not happen, ask the user before you run it again.
