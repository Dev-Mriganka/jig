# Writes: previews, checks and lost replies

The rules for writes in full, and what each preview shows. Back to the
[jig-jira overview](../README.md).

## Rules in full

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
