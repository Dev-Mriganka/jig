# The usage view

What `/lens usage` shows, which files it reads, and how another plugin names the
models in it. Back to the [jig-lens overview](../README.md).

`/lens usage` is a quick view of cost and tokens, made from Pi's own session files. It
needs no records, no import and no server, and it works for work done before Jig was
installed.

For what only Jig's records hold (rule decisions, approvals, the time you
waited, tickets and checks), use `/lens`. For more than a quick view of cost and
tokens, TokenTelemetry goes further (see [Reuse](../../../docs/reuse.md)).

```text
Usage history
[Today]  This week  Last week  30 days  All time
80,600 tokens · est. $0.41 + 1 unpriced
Models · Metric: cost · 4 usage records
anthropic / claude-opus-4-6  $0.31
gateway / gw-7f3a  $0.10
local / local-model  $0.00+
1 session files · 3 older files not read
←/→ period · v/Tab view · m metric · ↑/↓ scroll · q/Esc close
```

## The view

| Key | What it does |
|---|---|
| `←` `→` | The period: Today, This week, Last week, 30 days, All time. They wrap round |
| `v` or `Tab` | Switches between the graph and the table of models |
| `m` | Switches between cost and tokens |
| `↑` `↓` | Scrolls a list that is longer than the screen |
| `q` or `Esc` | Closes the view |

- **A period is whole days on your own clock.** A week starts on Monday. "30 days" is
  today and the 29 before it.
- **The graph** has a bar for each hour of today, each day of any other period, and
  each month of all time. The bars are scaled to the largest.
- **The table** lists each model, the most costly first by cost and the largest first
  by tokens.
- **Tokens** are everything a model counted: input, output, cache reads and cache writes.
- **An amount that is not known** is marked. Pi has no price for some models, such as a
  local one. Its tokens are counted, its cost is not guessed, and the figure says
  `est. $0.41 + 1 unpriced`, with a `+` after an amount that is therefore a lower
  bound. A cost of nothing and an unknown cost are not the same.
- **Cost is an estimate.** It is what Pi computed from its price list when the reply
  came back.

## What it reads

Only Pi's session files, under `<agent folder>/sessions`: `~/.pi/agent/sessions`, or
what `PI_CODING_AGENT_DIR` names. It opens them for reading, and nothing leaves the
machine.

- **Only the files the period needs.** A session file only grows, so one last written
  before a period began holds nothing from it. The view opens on Today, which reads a
  few files out of what can be hundreds of megabytes. Going to a longer period scans
  again, and what was already read is kept. The last row says how many files were left
  unread.
- **Each reply is counted once.** A forked session copies its parent's entries; they
  are told apart by their ids.
- **What counts:** model replies, tool results that did model work (a subagent's), a
  cache refresh, a compaction and a branch summary. A reply is filed under the model
  that answered, which can differ from the one asked.
- **Files and lines that cannot be read** are skipped, and the last row counts them.
- **It can be stopped.** Closing the view, or ending the session, stops the scan,
  and a scan that is stopped gives no partial figure.
- **It is loaded when you run the command.** A session that never runs `/lens usage`
  never loads it. It needs a terminal: without one the command says so.

## Naming the models

A provider can record a model under an id that is hard to read. Another plugin that
knows better says what to show, on Pi's event bus. This plugin does not know who sends
it, and shows what was recorded when nobody does:

```ts
pi.events.emit("jig-lens:model-names", {
  models: [{ recorded: "m-2f9c", name: "Claude Sonnet", provider: "anthropic" }],
});
```

| Field | Meaning |
|---|---|
| `recorded` | The model id as Pi recorded it in the session file. An exact match: no pattern, no case folding |
| `name` | What to show instead. One line of text, up to 80 characters |
| `provider` | Optional. What to show as the provider, up to 60 characters. Without it, the recorded one stays |

Records with different ids that have the same name and provider are shown as one row.
At most 4096 names are kept; an event past that cannot add more, though it can rename
one that is known. An event that is not in this shape is ignored, and one bad entry does
not stop the good ones next to it. Names sent before the command runs are kept.

A company plugin can use this to name the inference profiles of its model provider,
which this repository knows nothing of.

## Credit

The dashboard interaction was inspired by Thomas Mustier's usage extension
(https://github.com/tmustier/pi-extensions); its implementation is original.
