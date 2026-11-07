# How it behaves

How ticket memory works in a session. Back to the
[jig-memory overview](../README.md).

## Folders

`<folder>/<KEY>/`, with its `evidence/` and `history/`, is created on activation
with mode 0700. Files are created with mode 0600 and starting text: a notes
template, an index header, a `plan.md` heading, and a `ticket.json` with an
empty `repositories` list. A file that exists is never overwritten.

Every file the plugin writes is synced to disk before it takes its name, and a
file it replaces is written beside it, synced, renamed over it, and the folder is
synced (`jig-core`'s `kit/files.ts`). A crash, even of the whole machine, leaves
the old text or the new, never an empty file.

A key is a plain folder name: a letter or digit, then letters, digits, `_`, `.`
or `-`, at most 64 characters. The words `close`, `recall` and `off` are
commands, so `/ticket` cannot activate a ticket with one of those keys.

`card.md` is made at close, not at activation (see [Cards](cards.md)). The index
`.cards.json` sits in the folder of all tickets, beside the ticket folders (see
[Recall](recall.md#the-indexes)).

## Activation

A user message that names a key activates it when no ticket is active.
- **When another ticket is active,** the message only gets a hint, once per
  ticket (`PROJ-9 mentioned; /ticket PROJ-9 switches`).
- **When two keys are named** while none is active, that is a choice, and
  nothing activates.
- **`/ticket KEY`** switches at once, `/ticket` shows the active ticket, and
  `/ticket off` clears it. `/ticket close` and `/ticket recall` are described in
  [Cards](cards.md) and [Recall](recall.md).
- **Text that an extension sends** never activates a ticket.
- **A ticket with no notes yet** also gets [recall](recall.md#when-it-runs), as a
  second message after the notes message.

Every change goes to `jig-core` as `setTicket`. The active ticket is recorded in
the session with `appendEntry`, and `session_start` restores the last record on
the branch.

A ticket turned off stays off. A restored ticket does not send its notes again,
because the session already holds them.

## The notes message

When a ticket becomes active, and after each compaction, `notes.md` is sent as a
message, with the folder and today's date above it and the
[open checks](handoff.md#open-checks) below it. It is appended without starting a
turn. A message over 16 KB is cut, and says where the rest is.

Today's date is the local date of this machine's clock, such as `2026-11-02`. A
heading the agent adds should carry it, not a date copied from an earlier heading.
The history files the plugin writes are headed with the local date and time too.

## The `## Now` block

When the block passes 1 KB, the lines after its first 768 bytes move to
`history/<time>.md`, where the time is the ISO time with `:` written as `-`. The
top stays, where the template keeps the status, the next step and the open
questions, and a line says which history file holds the rest. A later move takes
the lines after the top again and replaces that line.

## Reminders

Every tool result counts, Pi's file tools included, until the `## Now` block
changes. The fifteenth result carries a reminder line that names `## Now`,
today's date, and how many checks are open.
- **Only `## Now` counts.** An edit elsewhere in `notes.md`, such as a new
  decision, does not restart the count: `## Now` can go stale under a busy file.
- **The block** is the `## Now` heading and its lines up to the next `#` or `##`
  heading; a `###` heading inside it is part of it.
- **A change restarts the count,** and the edit that made the change does not
  count.

## Evidence

A result of any tool except Pi's `read`, `ls`, `find`, `grep`, `write` and
`edit` is evidence. Its text, as the model saw it, goes to a file in `evidence/`
of up to 8 KB; a longer text is cut and the file says so.
- **The index line** is `- <time> | <tool> | <action> | <file>`.
- **Of the call's input only `action` is kept,** and only when it is a word of
  letters, `-` or `_` of up to 32 characters that starts with a letter, so a
  secret in any other argument is never written.
- **A tool name that is not a plain name** is written as `unnamed`.
- **A result that cannot be saved** is a warning, and the tool's result is not
  changed.
- **Results of the `ticket` tool** are not saved again. Text the user pasted is
  saved by its `save_evidence` action, with the index line
  `- <time> | pasted | <label> | <file>` (see [Handoff](handoff.md#pasted-evidence)).

## Empty files

When a ticket becomes active, and when a session restores it, its folder is
searched for files that are empty (0 bytes) and were changed in the last 7 days.
Such a file is a sign that a write was cut short, for example by a shell redirect
when the machine was killed.
- **The agent gets a message, and you get a warning,** such as `These files are
  empty, possibly cut short by a crash or an unfinished write:
  remove-services/data.csv (changed 19:15). Check before using them.`
- **At most 10 files are named,** newest first, and the rest are counted.
- **Not searched:** `evidence/`, because the plugin writes those files itself,
  synced, and a tool that printed nothing is a real empty result; `.tmp` files,
  the leftovers of a write whose file is intact; and links, which are never
  followed.
- **Nothing is repaired.** Only a person knows what the file should hold.

## Known gap

The active ticket follows the branch only at session start. Moving to another
branch with `/tree` does not change it.
