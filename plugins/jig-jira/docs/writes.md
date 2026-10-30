# Writes: previews, checks and lost replies

The rules for writes in full, and what each preview shows. Back to the
[jig-jira overview](../README.md).

## Rules in full

- **Rendered previews.** Text is Jira wiki markup, and the review screen shows
  it before it is sent: the source on the screen, `o` for the rendered page,
  and `y` to approve.
  - The page is the text as Jira will show it: headings, lists, tables, code,
    quotes, panels, colours, links, mentions, line breaks and rules.
  - What the renderer does not know stays on the page as written, so nothing the
    readers will see is hidden from you.
  - The browser only shows; approval stays in Pi.
- **Local-pointer check.** Outgoing text is checked for local paths (`/home/`,
  `/Users/`, `/root/`, `/mnt/`, `/tmp/`, `~/`, `C:\`, `file://`, and relative
  `./` and `../` paths) and for the names in `privateNames`.
  - These are flagged at the top of the preview and in its summary. They do not
    block: you decide.
  - A path inside a web address is not a pointer.
- **Invalid input is not asked about.** Every call is checked before anyone is
  asked: the action and its parameters, the issue and comment, the transition
  name, the fields `update` may set, the values the create screen allows, and
  the text limit.
  - A mistake blocks the call with a message that says what to change.
  - Nobody is asked about a call that cannot run.
- **Changed since the preview.** The plan is made again right before the write
  is sent. If what would be sent now differs from the preview you approved (a
  status moved, a comment was edited, a field changed), the write is refused:
  "changed since the preview; run it again to see the new preview".
- **No resend on timeout.** A write whose result is unknown (a timeout, a
  dropped connection, a 5xx answer) is never sent again. The issue is read once,
  and the tool says whether the write happened:

  | Write | The one read afterwards |
  |---|---|
  | `comment` | The newest 50 comments: one by the same person with the same text (see below) |
  | `edit_comment` | The comment: it holds the new text, the old text, or neither |
  | `delete_comment` | The comment: it is gone, or still there |
  | `create` | A search for the summary, created in the last 10 minutes |
  | `transition` | The issue's status |
  | `update` | The values of the fields |
  | `link` | The issue's links: one of this type to the other issue, reading the same way |
  | `unlink` | The issue's links: the link's id is gone, or still there |

  A write that Jira turned down (a 4xx answer) changed nothing and is reported
  as that. A write that never left (no sign-in) is reported as that.
- **Who is signed in.** `comment` asks `GET /myself` next to reading the issue,
  for three things: the preview says who posts, the fingerprint holds the
  account (a changed sign-in voids the approval), and the read after a lost
  reply tells your comment from another with the same text.
  - **A site with no "who am I"** (a sign-in proxy that answers 403 or 404 to
    `/myself`, or whose transport refuses it) still gets its comment.
  - **What degrades:** the preview has no "as <name>" and carries a note that
    says why; the fingerprint holds nothing of the account; and after a lost
    reply the read goes by the text alone. It can say that no comment has the
    text (it did not happen), but not that one is yours, so it says it could not
    settle it and asks you to check the issue.
  - **Any other failure of `/myself`** (a bad sign-in, a timeout, a 5xx) stops
    the comment, as before.
- **Facts.** After a write, the call's record carries the issue key, as the
  fact `issue`.

## What the previews show

| Write | Preview |
|---|---|
| `comment` | The issue and its status, who posts (when Jira says), the wiki source and the rendered page |
| `edit_comment` | The new text, as source and rendered, and the text it replaces |
| `delete_comment` | The comment's text, and that this cannot be undone |
| `transition` | The issue, its status now and after, and the transition used |
| `update` | Each field as `before → after`; a person is shown by name |
| `create` | The project and type, every field with its final value, possible duplicates, and the description |
| `link` | Both issues with their status, what `key` reads ("blocks"), the type, and what the other issue reads |
| `unlink` | The same, for the link that is found, and its id |

- **`transition`:** a name that matches no transition, or several, is refused
  with the names. A status name gets a hint at the transition that leads there.
- **`update`:** a description is shown as source and rendered, with the text it
  replaces.
- **`link`, `unlink`:** the note under the rows says what Jira receives: which
  issue is `outwardIssue` (the one that reads "blocks") and which `inwardIssue`.
  There is no text, so the dialog is enough and there is no page of its own.
- **`create`:** a priority or component is shown as the create screen spells it.
  Possible duplicates are a summary search in the project over the last 30 days,
  up to 5.

`create` reads the project's create screen, so required fields and allowed
values come from Jira and are checked before you are asked. If the create
screen cannot be read (an old Jira), the values are shown as given and Jira
checks them.
