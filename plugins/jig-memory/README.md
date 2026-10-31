# jig-memory: ticket folders, notes and recall

**Status: ticket folders, cards and recall built.** Tested against a fake `jig-core`
and a fake Pi, not yet in a real Pi session. The memory keeper is design (see
[Later](#later)).

`jig-memory` keeps what the agent learns about a [ticket](../../docs/glossary.md#tickets-and-workflows)
in files that outlive the session, sums a closed ticket up in a short
[card](../../docs/glossary.md#tickets-and-workflows), and hands the agent the
cards of related earlier tickets when a new ticket starts.

For example, naming `PROJ-123` in a message creates that ticket's folder with a
notes file, and after a compaction the notes come back to the agent as a
message. `/ticket close` leaves a card, and a later ticket that hits the same
error starts with that card in front of the agent.

![Three kinds of memory: ticket memory today, organizational and personal memory later, and the paths between them](../../docs/img/memory-kinds.svg)

*Three kinds of memory and the paths between them. Pi writes ticket memory as it works, and a card at close; recall hands Pi related cards when a new ticket starts. The organizational and personal memory, and the memory keeper that proposes it, are still design.*

## The ticket folder

Each ticket has a folder outside every repository:

| File | What it holds |
|---|---|
| `notes.md` | A `## Now` block kept under 1 KB (status, next step, open questions), then decisions |
| `plan.md` | The plan `jig-workflow` asks you to approve |
| `evidence/` | Tool results captured while the ticket is active, masked like everything else, with an index |
| `ticket.json` | The repositories bound to the ticket |
| `card.md` | The card, written at close (see [Cards](docs/cards.md)) |

The folder of all tickets also holds `.cards.json`, an index of the cards that
recall reads and rebuilds by itself. This scope has no model-callable tools. The
agent uses Pi's file tools, and this plugin captures evidence through
`jig-core`'s events.

## Commands

| Command | What it does |
|---|---|
| `/ticket KEY` | Makes the ticket active at once, and switches from another |
| `/ticket` | Shows the active ticket |
| `/ticket off` | Clears the active ticket |
| `/ticket close [KEY]` | Drafts the card, asks the agent to fill it, checks it, and closes the ticket |
| `/ticket recall [text]` | Shows the earlier tickets related to the active ticket, or to the text |

## Rules

- **Active ticket.** Naming a ticket in a message makes it active for the
  session, and `/ticket KEY` sets it explicitly. When another ticket is already
  active, the message only gets a hint (see [Activation](docs/behaviour.md#activation)).
- **Notes as a message.** After a compaction, the notes come back as a message,
  never in the system prompt, so the prompt cache stays valid.
- **Reminders.** The agent is reminded to update `## Now` when many results
  arrive without a notes change.
- **Cards.** The plugin fills the front matter from the notes and evidence; the
  agent writes Problem, Cause and Fix, each up to 400 characters, and the plugin
  rejects a card that lacks one or has one too long (see [Cards](docs/cards.md)).
- **Recall.** When a new ticket becomes active, other tickets' cards are scored by
  shared keys, identifiers and error lines, then by keyword search, and the best
  few arrive as one message (see [Recall](docs/recall.md)). Nothing arrives when
  nothing scores enough.

## Configure

In `~/.pi/agent/jig.json`, under `memory`. `jig-core` checks it with this
plugin's rules. An error names the key, and the plugin then uses its defaults.

| Field | Default | Meaning |
|---|---|---|
| `ticketPattern` | none | A regular expression for ticket keys, such as `[A-Z][A-Z0-9]+-\d+` |
| `folder` | `~/.local/share/jig/tickets` | Where ticket folders live: an absolute path, or one that starts with `~/` |
| `recall.enabled` | `true` | Run recall when a new ticket becomes active |
| `recall.max` | `3` | Most cards in one recall message, from 1 to 10 |
| `recall.minScore` | `2` | The score a card needs; see [Recall](docs/recall.md#the-threshold) |

- **`ticketPattern`:** a key must not touch a letter or digit on either side.
  Without a pattern, only `/ticket KEY` activates a ticket.
- **`folder`:** the default is under `XDG_DATA_HOME` when that is set. An empty
  or relative `XDG_DATA_HOME` is ignored.
- **`recall`:** an object. `/ticket recall` works with `enabled` false; only the
  automatic run at activation stops.

```json
{
  "memory": {
    "ticketPattern": "[A-Z][A-Z0-9]+-\\d+",
    "folder": "~/work/tickets",
    "recall": { "max": 2, "minScore": 3 }
  }
}
```

## Company part (in the company plugin)

- the ticket key patterns;
- where ticket folders live.

## Later

- **A memory keeper** that proposes organizational and personal facts at ticket
  close. You approve the exact text of every one.
- **Ticket text from `jig-jira`.** Recall uses the activating message only,
  because `jig-jira` does not publish an issue's summary and description on
  Pi's event bus. If it ever does, recall can use them too.
- **Files and keyword search first.** Embeddings or a graph come only after a
  recall test built from real tickets shows misses. The test in
  `test/recall-eval/` uses invented tickets, so it cannot show that yet.

![Memory in five steps: write, consolidate, index, retrieve and use, with bands for protecting every write, keeping it small and measuring recall](../../docs/img/memory-steps.svg)

*Memory in five steps, from notes while the agent works to a short message at the start of a later ticket. Lookup is keys and keyword search over plain files; embeddings or a graph wait for a measured miss. In this plugin the agent writes the card, not a memory keeper.*

## Layout

```text
jig-memory/
  src/      index.ts (the factory), session.ts (the active ticket, its events and /ticket),
            store.ts (the ticket folder), notes.ts (the ## Now rule), evidence.ts,
            message.ts (the notes message and the reminder), clip.ts, config.ts,
            extract.ts (keys, identifiers, error lines), card.ts (the card file),
            material.ts (what a ticket holds), cards.ts (the .cards.json index),
            bm25.ts (keyword search), recall.ts (scoring and its message), close.ts
  test/     one file per module, support.ts (a fake jig-core and a fake Pi), and
            recall-eval/ (invented cards and queries, and the recall measure)
  docs/     the detail pages below
```

## More detail

- [How it behaves](docs/behaviour.md): folders, activation, the notes message,
  the `## Now` block, reminders, evidence, and a known gap
- [Cards](docs/cards.md): the file, what the plugin fills, what the agent writes,
  how a close runs and what is rejected
- [Recall](docs/recall.md): when it runs, the score, the threshold, the message,
  the index and the recall test
