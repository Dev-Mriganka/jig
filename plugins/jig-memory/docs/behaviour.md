# How it behaves

How ticket memory works in a session. Back to the
[jig-memory overview](../README.md).

## Folders

`<folder>/<KEY>/`, with its `evidence/` and `history/`, is created on activation
with mode 0700. Files are created with mode 0600 and starting text: a notes
template, an index header, a `plan.md` heading, and a `ticket.json` with an
empty `repositories` list. A file that exists is never overwritten. A key is a
plain folder name: a letter or digit, then letters, digits, `_`, `.` or `-`, at
most 64 characters.

## Activation

A user message that names a key activates it when no ticket is active. When
another ticket is active, the message only gets a hint, once per ticket
(`PROJ-9 mentioned; /ticket PROJ-9 switches`). Two keys named while none is
active make a choice, and nothing activates. `/ticket KEY` switches at once,
`/ticket` shows the active ticket, and `/ticket off` clears it. Text that an
extension sends never activates a ticket.

Every change goes to `jig-core` as `setTicket`. The active ticket is recorded in
the session with `appendEntry`, and `session_start` restores the last record on
the branch. A ticket turned off stays off. A restored ticket does not send its
notes again, because the session already holds them.

## The notes message

When a ticket becomes active, and after each compaction, `notes.md` is sent as a
message, with the folder above it. It is appended without starting a turn. A
message over 16 KB is cut, and says where the rest is.

## The `## Now` block

When the block passes 1 KB, the lines after its first 768 bytes move to
`history/<time>.md`, where the time is the ISO time with `:` written as `-`. The
top stays, where the template keeps the status, the next step and the open
questions, and a line says which history file holds the rest. A later move takes
the lines after the top again and replaces that line.

## Reminders

Every tool result counts, Pi's file tools included, until `notes.md` changes.
The fifteenth result carries a reminder line that names `## Now`. A change
restarts the count, and the edit that made the change does not count.

## Evidence

A result of any tool except Pi's `read`, `ls`, `find`, `grep`, `write` and
`edit` is evidence. Its text, as the model saw it, goes to a file in `evidence/`
of up to 8 KB; a longer text is cut and the file says so. The index line is
`- <time> | <tool> | <action> | <file>`. Of the call's input only `action` is
kept, and only when it is a word of letters, `-` or `_` of up to 32 characters
that starts with a letter, so a secret in any other argument is never written. A
tool name that is not a plain name is written as `unnamed`. A result that cannot
be saved is a warning, and the tool's result is not changed.

## Known gap

The active ticket follows the branch only at session start. Moving to another
branch with `/tree` does not change it.
