# jig-memory: ticket folders, notes and recall

**Status: ticket folders built.** Cards and recall are design, under Later.

`jig-memory` keeps what the agent learns about a ticket in files that outlive
the session. Later it finds earlier tickets related to a new one.

![Three kinds of memory: ticket memory today, organizational and personal memory later, and the paths between them](../../docs/img/memory-kinds.svg)

*Three kinds of memory and the paths between them. Pi writes ticket memory as it works; later, a memory keeper writes a card at close and proposes organizational and personal facts, kept only with your yes, and recall hands Pi related cards when a new ticket starts.*

## Today's scope: ticket folders

Each ticket has a folder outside every repository:

| File | What it holds |
|---|---|
| `notes.md` | A `## Now` block (status, next step, open questions) kept under 1 KB, then decisions. Old blocks move to `history/` |
| `plan.md` | The plan `jig-flow` asks you to approve |
| `evidence/` | Tool results captured while the ticket is active, masked like everything else, with an index |
| `ticket.json` | The repositories bound to the ticket |

- **Active ticket.** Naming a ticket in a message makes it active for the
  session, and `/ticket KEY` sets it explicitly. When another ticket is already
  active, see [How it behaves](#how-it-behaves).
- **Notes as a message.** After a compaction, the notes come back as a
  message, never in the system prompt, so the prompt cache stays valid.
- **Reminders.** The agent is reminded to update `## Now` when many results
  arrive without a notes change.

This scope has no model-callable tools. The agent uses Pi's file tools, and
this plugin captures evidence through `jig-core`'s events.

## How it behaves

**Configuration.** The `memory` section of `jig.json`. `jig-core` checks it
with this plugin's rules. An error names the key, and the plugin then uses its
defaults.

| Field | Default | Meaning |
|---|---|---|
| `ticketPattern` | none | A regular expression for ticket keys, such as `[A-Z][A-Z0-9]+-\d+`. A key must not touch a letter or digit on either side. Without it, only `/ticket KEY` activates a ticket |
| `folder` | `~/.local/share/jig/tickets`, or under `XDG_DATA_HOME` | Where ticket folders live: an absolute path, or one that starts with `~/`. An empty or relative `XDG_DATA_HOME` is ignored |

**Folders.** `<folder>/<KEY>/`, with its `evidence/` and `history/`, is created
on activation with mode 0700. Files are created with mode 0600 and starting
text: a notes template, an index header, a `plan.md` heading, and a
`ticket.json` with an empty `repositories` list. A file that exists is never
overwritten. A key is a plain folder name: a letter or digit, then letters,
digits, `_`, `.` or `-`, at most 64 characters.

**Activation.** A user message that names a key activates it when no ticket is
active. When another ticket is active, the message only gets a hint, once per
ticket (`ACME-9 mentioned; /ticket ACME-9 switches`). Two keys named while none
is active make a choice, and nothing activates. `/ticket KEY` switches at once,
`/ticket` shows the active ticket, and `/ticket off` clears it. Text that an
extension sends never activates a ticket.

Every change goes to `jig-core` as `setTicket`. The active ticket is recorded in
the session with `appendEntry`, and `session_start` restores the last record on
the branch. A ticket turned off stays off. A restored ticket does not send its
notes again, because the session already holds them.

**The notes message.** When a ticket becomes active, and after each compaction,
`notes.md` is sent as a message, with the folder above it. It is appended
without starting a turn. A message over 16 KB is cut, and says where the rest
is.

**`## Now`.** When the block passes 1 KB, the lines after its first 768 bytes
move to `history/<time>.md`, where the time is the ISO time with `:` written as
`-`. The top stays, where the template keeps the status, the next step and the
open questions, and a line says which history file holds the rest. A later
move takes the lines after the top again and replaces that line.

**Reminders.** Every tool result counts, Pi's file tools included, until
`notes.md` changes. The fifteenth result carries a reminder line that names
`## Now`. A change restarts the count, and the edit that made the change does
not count.

**Evidence.** A result of any tool except Pi's `read`, `ls`, `find`, `grep`,
`write` and `edit` is evidence. Its text, as the model saw it, goes to a file
in `evidence/` of up to 8 KB; a longer text is cut and the file says so. The
index line is `- <time> | <tool> | <action> | <file>`. Of the call's input only
`action` is kept, and only when it is a word of letters, `-` or `_`, so a secret
in any other argument is never written. A result that cannot be saved is a
warning, and the tool's result is not changed.

**Known gap.** The active ticket follows the branch only at session start.
Moving to another branch with `/tree` does not change it.

## Later

- **A card per closed ticket:** problem, cause, fix, repositories, identifiers
  and error text.
- **Recall:** when a new ticket starts, related tickets are found by shared
  keys (links, identifiers, classes, error text), then by keyword search, and
  their cards arrive as a short message.
- **A memory keeper** that proposes organizational and personal facts at ticket
  close. You approve the exact text of every one.
- **Files and keyword search first.** Embeddings or a graph come only after a
  recall test built from real tickets shows misses.

![Memory in five steps: write, consolidate, index, retrieve and use, with bands for protecting every write, keeping it small and measuring recall](../../docs/img/memory-steps.svg)

*Memory in five steps, from notes while the agent works to a short message at the start of a later ticket. Lookup is keys and keyword search over plain files; embeddings or a graph wait for a measured miss.*

## Company part (in the company plugin)

- the ticket key patterns;
- where ticket folders live.

## Layout

```text
jig-memory/
  src/      index.ts (the factory), session.ts (the active ticket, its events and /ticket),
            store.ts (the ticket folder), notes.ts (the ## Now rule), evidence.ts,
            message.ts (the notes message and the reminder), clip.ts, config.ts
  test/     one file per module, and support.ts (a fake jig-core and a fake Pi)
```
