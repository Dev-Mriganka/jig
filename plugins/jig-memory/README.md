# jig-memory: ticket folders, notes and recall

**Status: design.**

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
  session, and `/ticket KEY` sets it explicitly.
- **Notes as a message.** After a compaction, the notes come back as a
  message, never in the system prompt, so the prompt cache stays valid.
- **Reminders.** The agent is reminded to update `## Now` when many results
  arrive without a notes change.

This scope has no model-callable tools. The agent uses Pi's file tools, and
this plugin captures evidence through `jig-core`'s events.

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

## Layout (planned)

```text
jig-memory/
  src/      ticket folders, notes reminders, evidence capture; later cards and recall
  test/
```
